import { expect, it } from "vitest";

import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

/* eslint-disable camelcase -- Zarr v3 metadata uses snake_case keys. */
function shardMetadata(groups: number) {
  return new TextEncoder().encode(
    JSON.stringify({
      zarr_format: 3,
      node_type: "array",
      shape: [groups, 65536],
      data_type: "float64",
      dimension_names: ["time", "cell"],
      chunk_grid: { name: "regular", configuration: { chunk_shape: [1, 64] } },
      chunk_key_encoding: {
        name: "default",
        configuration: { separator: "/" },
      },
      fill_value: "NaN",
      attributes: {},
      codecs: [
        {
          name: "sharding_indexed",
          configuration: {
            chunk_shape: [1, 1],
            codecs: [{ name: "bytes", configuration: { endian: "little" } }],
            index_codecs: [
              { name: "bytes", configuration: { endian: "little" } },
            ],
          },
        },
      ],
    })
  );
}
/* eslint-enable camelcase */

it("review47 shard-index bookkeeping scales with new shards, independent of sparse group order", async () => {
  const groups = 256;
  const metadata = shardMetadata(groups);
  const offsets = new BigUint64Array(2 * 64).fill(2n ** 64n - 1n);
  offsets.set([0n, 8n]);
  const index = new Uint8Array(offsets.buffer);
  const datum = new Uint8Array(Float64Array.of(5).buffer);
  const dataset = zarrAnalysisDatasetFromStore(
    {
      get: async (key: string) =>
        key === "/u/zarr.json" ? metadata : undefined,
      getRange: async (_key: string, range: object) =>
        "suffixLength" in range ? index.slice() : datum.slice(),
    } as never,
    "",
    ZARR_FORMAT.V3,
    "review47-sparse"
  );
  const arr = await dataset.openArray("u");
  const iterate = Map.prototype[Symbol.iterator];
  let visited = 0;
  Map.prototype[Symbol.iterator] = function* (this: Map<unknown, unknown>) {
    for (const row of iterate.call(this)) {
      if (
        row[1] instanceof WeakRef &&
        typeof row[0] === "string" &&
        /^\d+\|\d+$/.test(row[0])
      ) {
        visited++;
      }
      yield row;
    }
  } as typeof iterate;
  try {
    for (let t = 0; t < groups; t++) {
      expect((await arr.readChunk([t, 0])).data[0]).toBe(5);
    }
  } finally {
    Map.prototype[Symbol.iterator] = iterate;
  }
  // There is never an eviction: only 256 KiB of decoded indices.
  expect(visited).toBeLessThan(groups * 8);
}, 30_000);
