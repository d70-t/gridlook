import { expect, it } from "vitest";

import {
  forgetGeometries,
  readNativeCells,
} from "@/lib/analysis/nativeGrid.ts";

/**
 * A wall-clock budget, checked only on a quiet benchmark run
 * (GRIDLOOK_TIMING=1): the suite asserts results and counts, and a busy host
 * does not fail correct code.
 */
const withinBudget = (ms: number, budget: number, what = "") =>
  process.env.GRIDLOOK_TIMING === "1" && expect(ms, what).toBeLessThan(budget);

/** A 2-D array of `n` × `n` tiles, each 4 × 4, counting its reads. */
function tiled(n: number, key: string) {
  let reads = 0;
  const array = {
    key,
    shape: [4 * n, 4 * n],
    chunks: [4, 4],
    dtype: "float64",
    attrs: {},
    dimensionNames: ["y", "x"],
    fillValue: null,
    async readChunk() {
      reads++;
      await new Promise((resolve) => setTimeout(resolve, 1));
      return {
        data: new Float64Array(16).fill(1),
        shape: [4, 4],
        stride: [4, 1],
        absent: false,
      };
    },
  };
  return { array, reads: () => reads };
}

it("reads each area tile once for concurrent readers, and forgets a released source's (review of interim37)", async () => {
  const n = 6;
  const { array, reads } = tiled(n, `tiles-${Math.random()}|areas`);
  const dataset = { key: "tiles", format: 3 } as never;
  const all = Array.from({ length: 4 * n }, (_, i) => i);
  const read = () =>
    readNativeCells(dataset, array as never, ["y", "x"], array.shape, all, all);
  await Promise.all([read(), read()]);
  expect(reads()).toBe(n * n);
  // Kept: a later pass reads nothing.
  await read();
  expect(reads()).toBe(n * n);
  // Released with its source: read afresh.
  forgetGeometries(array.key.split("|")[0]);
  await read();
  expect(reads()).toBe(2 * n * n);
});

// eslint-disable-next-line max-lines-per-function -- one held read, its waiters and two releases.
it("final review of interim41: a tile read abandoned before its source's release stays uncached", async () => {
  let finish!: () => void;
  let transport: AbortSignal | undefined;
  const source = `late-${Math.random()}`;
  const array = {
    key: `${source}|areas`,
    shape: [4, 4],
    chunks: [4, 4],
    dtype: "float64",
    attrs: {},
    dimensionNames: ["y", "x"],
    fillValue: null,
    readChunk(_coords: number[], signal?: AbortSignal) {
      transport = signal;
      return new Promise((resolve) => {
        finish = () =>
          resolve({
            data: new Float64Array(16).fill(1),
            shape: [4, 4],
            stride: [4, 1],
            absent: false,
          });
      });
    },
  };
  const dataset = { key: source, format: 3 } as never;
  const cells = [0, 1, 2, 3];
  const { nativeCellReadsNow } = await import("@/lib/analysis/nativeGrid.ts");
  const waiter = new AbortController();
  const reading = readNativeCells(
    dataset,
    array as never,
    ["y", "x"],
    array.shape,
    cells,
    cells,
    waiter.signal
  ).catch((error: Error) => error.name);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Its only waiter leaves: the request itself is stopped.
  waiter.abort();
  expect(await reading).toBe("AbortError");
  expect(transport?.aborted).toBe(true);
  forgetGeometries(source);
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  const cold = () =>
    nativeCellReadsNow(array as never, ["y", "x"], array.shape, cells, cells)
      .reads;
  expect(cold()).toBe(1);
  // A peer still waiting gets its tile; released meanwhile, it is not kept.
  const peer = readNativeCells(
    dataset,
    array as never,
    ["y", "x"],
    array.shape,
    cells,
    cells
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  forgetGeometries(source);
  finish();
  expect((await peer)(1, 1)).toBe(1);
  expect(cold()).toBe(1);
});

it("final review of interim41: only the tiles under the selected cells are visited", async () => {
  // 2,048 × 2,048 tiles under a region's candidate rows and columns, two
  // selected cells at opposite corners.
  const n = 2048;
  const { array, reads } = tiled(n, `sparse-${Math.random()}|areas`);
  const dataset = { key: "sparse", format: 3 } as never;
  const all = Array.from({ length: 4 * n }, (_, i) => i);
  const last = 4 * n - 1;
  const started = performance.now();
  const at = await readNativeCells(
    dataset,
    array as never,
    ["y", "x"],
    array.shape,
    all,
    all,
    undefined,
    [0, 0, last, last]
  );
  const took = performance.now() - started;
  expect(reads()).toBe(2);
  expect(at(0, 0)).toBe(1);
  expect(at(last, last)).toBe(1);
  // Not a walk over the 4,194,304 pairs of their tile rows and columns.
  withinBudget(took, 150);
});

it("review of interim43: a one-dimensional tile abandoned before its source's release stays uncached", async () => {
  let finish!: () => void;
  let transport: AbortSignal | undefined;
  const source = `late-along-${Math.random()}`;
  const array = {
    key: `${source}|areas`,
    shape: [4],
    chunks: [4],
    dtype: "float64",
    attrs: {},
    dimensionNames: ["lat"],
    fillValue: null,
    readChunk(_coords: number[], signal?: AbortSignal) {
      transport = signal;
      return new Promise((resolve) => {
        finish = () =>
          resolve({
            data: new Float64Array(4).fill(1),
            shape: [4],
            stride: [1],
            absent: false,
          });
      });
    },
  };
  const dataset = { key: source, format: 3 } as never;
  const { readAlong, alongReadsNow } =
    await import("@/lib/analysis/nativeGrid.ts");
  const waiter = new AbortController();
  const reading = readAlong(
    dataset,
    array as never,
    [0, 1],
    waiter.signal
  ).catch((error: Error) => error.name);
  await new Promise((resolve) => setTimeout(resolve, 0));
  // Its only waiter leaves: the request is stopped too.
  waiter.abort();
  expect(await reading).toBe("AbortError");
  expect(transport?.aborted).toBe(true);
  forgetGeometries(source);
  // The transport delivers anyway: the tile stays cold.
  finish();
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(alongReadsNow(array as never, [0, 1]).reads).toBe(1);
});
