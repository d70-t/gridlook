import { expect, it, vi } from "vitest";

import type { TAnalysisArray } from "@/lib/analysis/chunkVisitor.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

// Drive a legal GC sequence without depending on when a particular engine
// delivers its finalizers. The production group reads and cache are real.
function controlledCollection() {
  const retired = new WeakSet<object>();
  const finalizers = new WeakMap<object, () => void>();
  const NativeWeakRef = WeakRef;
  vi.stubGlobal(
    "WeakRef",
    class<T extends object> extends NativeWeakRef<T> {
      override deref() {
        const value = super.deref();
        return value && !retired.has(value) ? value : undefined;
      }
    }
  );
  let latest: object | undefined;
  vi.stubGlobal(
    "FinalizationRegistry",
    class<T> {
      constructor(private readonly collect: (value: T) => void) {}
      register(owner: object, value: T) {
        latest = owner;
        finalizers.set(owner, () => this.collect(value));
      }
    }
  );
  return () => {
    expect(latest).toBeDefined();
    retired.add(latest!);
    finalizers.get(latest!)!();
    latest = undefined;
  };
}

function shardMetadata(groups: number, cells: number) {
  const bytesCodec = { name: "bytes", configuration: { endian: "little" } };
  /* eslint-disable camelcase -- Zarr v3 metadata keys. */
  return new TextEncoder().encode(
    JSON.stringify({
      zarr_format: 3,
      node_type: "array",
      shape: [groups, cells],
      data_type: "float64",
      dimension_names: ["time", "cell"],
      attributes: {},
      chunk_grid: {
        name: "regular",
        configuration: { chunk_shape: [1, cells] },
      },
      chunk_key_encoding: {
        name: "default",
        configuration: { separator: "/" },
      },
      fill_value: "NaN",
      codecs: [
        {
          name: "sharding_indexed",
          configuration: {
            chunk_shape: [1, 1],
            codecs: [bytesCodec],
            index_codecs: [bytesCodec],
          },
        },
      ],
    })
  );
  /* eslint-enable camelcase */
}

async function shardSource(groups: number, label: string) {
  const cells = 65_536;
  const metadata = shardMetadata(groups, cells);
  const offsets = new BigUint64Array(2 * cells).fill(2n ** 64n - 1n);
  offsets.set([0n, 8n]);
  const index = new Uint8Array(offsets.buffer);
  const datum = new Uint8Array(Float64Array.of(5).buffer);
  let reads = 0;
  const store = {
    get: async (key: string) => (key === "/u/zarr.json" ? metadata : undefined),
    getRange: async (_key: string, range: object) => {
      if ("suffixLength" in range) {
        reads++;
        return index.slice();
      }
      return datum.slice();
    },
  };
  const { zarrAnalysisDatasetFromStore } =
    await import("@/lib/analysis/sourceAdapter.ts");
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    label
  );
  return { arr: await dataset.openArray("u"), reads: () => reads };
}

async function readPoints(arr: TAnalysisArray, count: number) {
  for (let t = 0; t < count; t++) {
    expect((await arr.readChunk([t, 0])).data[0]).toBe(5);
  }
}

it("review48 charges surviving shard indexes exactly once after a released owner's finalizer", async () => {
  const collectReleased = controlledCollection();
  try {
    const old = await shardSource(8, "review48-finished-reader");
    await readPoints(old.arr, 8);
    collectReleased();
    const current = await shardSource(72, "review48-live-reader");
    await readPoints(current.arr, 72);
    expect(current.reads()).toBe(72);
    const before = current.reads();
    await readPoints(current.arr, 8);
    // 72 distinct 1 MiB indexes cannot all survive a 64 MiB budget.
    expect(current.reads() - before).toBeGreaterThanOrEqual(8);
  } finally {
    vi.unstubAllGlobals();
  }
}, 120_000);
