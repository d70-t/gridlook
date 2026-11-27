/**
 * Pricing what is left to read with one tile cached costs about the cache, not
 * every pair of tiles.
 */
import { expect, it, vi } from "vitest";
import * as zarr from "zarrita";

import {
  nativeCellReadsNow,
  readNativeCells,
} from "@/lib/analysis/nativeGrid.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

it("prices the outstanding tiles without visiting every pair", async () => {
  const store = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(store), { attributes: {} });
  await zarr.create(zarr.root(store).resolve("area"), {
    shape: [200, 100],
    chunkShape: [1, 1],
    dtype: "float64",
    dimensionNames: ["y", "x"],
    attributes: { units: "m2" },
    fillValue: 1 as never,
  });
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `warm-${Math.random()}`
  );
  const area = await dataset.openArray("area");
  const dims = ["y", "x"];
  const shape = [200, 100];
  await readNativeCells(dataset, area, dims, shape, [0], [0]);
  const rows = Array.from({ length: 200 }, (_, i) => i);
  const cols = Array.from({ length: 100 }, (_, j) => j);
  const lookups = vi.spyOn(Map.prototype, "has");
  const cost = nativeCellReadsNow(area, dims, shape, rows, cols);
  const calls = lookups.mock.calls.length;
  lookups.mockRestore();
  expect(cost.reads).toBe(19_999);
  expect(calls).toBeLessThan(100);
});
