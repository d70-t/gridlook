import { describe, expect, it } from "vitest";

import { chunkFolder } from "@/lib/analysis/spaceTimeOperations";

describe("per-chunk accumulators hold touched bins only (v8 review)", () => {
  it("32 sites alternating between distant bins cost two slots", () => {
    const width = 3600;
    const rows = 4;
    const sum = new Float64Array(rows * width);
    const weight = new Float64Array(rows * width);
    const fold = chunkFolder([0, rows], rows, width, 0, sum, weight);
    for (let site = 0; site < 32; site++) {
      for (let t = 0; t < rows; t++) {
        fold.add(0, t, site % 2 ? width - 1 : 0, 1, site);
      }
    }
    const live = fold.liveValues();
    // Two slots × four rows × two values (capacity at most doubled), not
    // the 3,600-bin span between them.
    expect(live).toBeLessThanOrEqual(2 * 2 * rows * 2);
    fold.done(0);
    expect(weight[0]).toBe(16);
    expect(sum[width - 1] / weight[width - 1]).toBe(16);
    expect(sum[0] / weight[0]).toBe(15);
  });

  it("folds in chunk order whatever order chunks finish", () => {
    const width = 10;
    const make = () => ({
      sum: new Float64Array(width),
      weight: new Float64Array(width),
    });
    const [a, b] = [make(), make()];
    const fa = chunkFolder([0, 1], 1, width, 0, a.sum, a.weight);
    const fb = chunkFolder([0, 1], 1, width, 0, b.sum, b.weight);
    const values = [0.1, 1e16, -1e16, 0.2];
    values.forEach((v, k) => {
      fa.add(k, 0, 3, 1, v);
      fb.add(k, 0, 3, 1, v);
    });
    [0, 1, 2, 3].forEach((k) => fa.done(k));
    [3, 1, 2, 0].forEach((k) => fb.done(k));
    expect(b.sum[3]).toBe(a.sum[3]);
  });
});

describe("an empty point selection (v8 review)", () => {
  it("plans zero groups and issues no field reads", async () => {
    const { ReadContext, visitRuns } =
      await import("@/lib/analysis/chunkVisitor.ts");
    const { emptyCounters } = await import("@/lib/analysis/types.ts");
    const keys: number[][] = [];
    const array = {
      key: "empty",
      shape: [2, 48],
      chunks: [1, 16],
      dtype: "float64",
      attrs: {},
      dimensionNames: ["time", "cell"],
      fillValue: Number.NaN,
      readChunk(coords: number[]) {
        keys.push(coords);
        return Promise.reject(new Error("no read expected"));
      },
    };
    const counters = emptyCounters();
    const visited = await visitRuns(
      new ReadContext(),
      array as never,
      { decode: (v: number) => v } as never,
      [[[0, 2]], [[0, 48]]],
      () => undefined,
      counters,
      undefined,
      undefined,
      { dims: [1], positions: new Int32Array(0) }
    );
    expect(visited).toBe(0);
    expect(counters.plannedChunks).toBe(0);
    expect(keys).toEqual([]);
  });
});

describe("exact storage addresses beyond 2^31 chunks (v9 review)", () => {
  it("reads order-21 cell 17,592,186,064,896 from chunk 4,294,967,301, not its alias 5", async () => {
    const { ReadContext, visitRuns } =
      await import("@/lib/analysis/chunkVisitor.ts");
    const { emptyCounters } = await import("@/lib/analysis/types.ts");
    const { buildValueCodec } = await import("@/lib/analysis/valueDecoding.ts");
    const cells = 12 * 4 ** 21;
    const target = 17_592_186_064_896;
    const keys: number[][] = [];
    const array = {
      key: "order21",
      shape: [1, cells],
      chunks: [1, 4096],
      dtype: "float64",
      attrs: {},
      dimensionNames: ["time", "cell"],
      fillValue: Number.NaN,
      readChunk(coords: number[]) {
        keys.push([...coords]);
        // The aliased chunk holds 71, the true one 901.
        const value = coords[1] === 4_294_967_301 ? 901 : 71;
        return Promise.resolve({
          data: new Float64Array(4096).fill(value),
          shape: [1, 4096],
          stride: [4096, 1],
        });
      },
    };
    const seen: number[] = [];
    await visitRuns(
      new ReadContext(),
      array as never,
      buildValueCodec({}, Number.NaN, "float64", 3),
      [[[0, 1]], [[target, target + 1]]],
      (_, __, value) => seen.push(value as number),
      emptyCounters(),
      undefined,
      undefined,
      { dims: [1], positions: Float64Array.from([target]) }
    );
    expect(keys).toEqual([[0, 4_294_967_301]]);
    expect(seen).toEqual([901]);
  });
});

describe("owner-scoped cache eviction (v9 review)", () => {
  it("releasing source generation 1 keeps generation 10's chunks", async () => {
    const { ReadContext } = await import("@/lib/analysis/chunkVisitor.ts");
    const { emptyCounters } = await import("@/lib/analysis/types.ts");
    const read = new ReadContext();
    const array = (key: string) => ({
      key,
      shape: [4],
      chunks: [4],
      dtype: "float64",
      attrs: {},
      dimensionNames: ["x"],
      fillValue: Number.NaN,
      readChunk: () =>
        Promise.resolve({
          data: new Float64Array(4),
          shape: [4],
          stride: [1],
        }),
    });
    const one = array("store|data|1|v");
    const ten = array("store|data|10|v");
    await read.read(one as never, [0], emptyCounters());
    await read.read(ten as never, [0], emptyCounters());
    read.clearSource("store|data|1");
    const counters = emptyCounters();
    await read.read(ten as never, [0], counters);
    expect(counters.cacheHits).toBe(1);
    const again = emptyCounters();
    await read.read(one as never, [0], again);
    expect(again.cacheHits).toBe(0);
  });
});
