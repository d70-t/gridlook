import v8 from "node:v8";
import vm from "node:vm";

import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { forgetGeometries, readAllShared } from "@/lib/analysis/nativeGrid.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

const collect = (() => {
  v8.setFlagsFromString("--expose-gc");
  return vm.runInNewContext("gc") as () => void;
})();
const held = () => {
  collect();
  collect();
  return process.memoryUsage().arrayBuffers;
};

/** A source with one 16 MiB longitude array, all of it written. */
async function source() {
  const n = 2 ** 21;
  const store = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(store), { attributes: {} });
  const lon = await zarr.create(zarr.root(store).resolve("lon"), {
    shape: [n],
    chunkShape: [n],
    dtype: "float64",
    dimensionNames: ["cell"],
    attributes: { units: "degrees_east" },
    fillValue: Number.NaN as never,
  });
  await zarr.set(lon as never, null, {
    data: new Float64Array(n).fill(7),
    shape: [n],
    stride: [1],
  } as never);
  return zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `release-${Math.random()}`
  );
}

it("review of interim43: a released source keeps none of its coordinates", async () => {
  const base = held();
  const after: number[] = [];
  for (let k = 0; k < 6; k++) {
    const dataset = await source();
    const values = await readAllShared(dataset, await dataset.openArray("lon"));
    expect(values[0]).toBe(7);
    forgetGeometries(dataset.key);
    after.push(held() - base);
  }
  // No growth from one released source to the next (the one in hand is the
  // same each time).
  expect(after[5] - after[1]).toBeLessThan(4 * 2 ** 20);
});

it("review of interim43: a source still open reuses its coordinates", async () => {
  const dataset = await source();
  const array = await dataset.openArray("lon");
  await readAllShared(dataset, array);
  let reads = 0;
  const counted = {
    ...array,
    readChunk: (coords: number[], signal?: AbortSignal) => {
      reads++;
      return array.readChunk(coords, signal);
    },
  };
  await readAllShared(dataset, { ...counted, unguarded: counted });
  expect(reads).toBe(0);
  forgetGeometries(dataset.key);
});
