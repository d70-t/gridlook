/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import {
  nativeCellReadsNow,
  readNativeCells,
} from "@/lib/analysis/nativeGrid.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS, type TAnalysisQuery } from "@/lib/analysis/types.ts";
import {
  resolveVariableContext,
  type TRectilinearContext,
} from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;

async function write(
  store: TStore,
  path: string,
  data: number[],
  shape: number[],
  dims: string[],
  attrs: Record<string, unknown> = {}
) {
  const array = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape: shape,
    dtype: "float64",
    dimensionNames: dims,
    attributes: attrs,
    fillValue: Number.NaN as never,
  });
  await zarr.set(array as never, null, {
    data: Float64Array.from(data),
    shape,
    stride: shape.map((_, d) => shape.slice(d + 1).reduce((a, n) => a * n, 1)),
  } as never);
}

// eslint-disable-next-line max-lines-per-function -- one fixture, built inline.
it("separates stored dtype, padded input and clipped float64 retention", async () => {
  const store = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "lat", [0, 1], [2], ["lat"], { units: "degrees_north" });
  await write(store, "lon", [0, 1, 2, 3, 4], [5], ["lon"], {
    units: "degrees_east",
  });
  await write(store, "time", [0], [1], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(
    store,
    "tas",
    Array(10).fill(7),
    [1, 2, 5],
    ["time", "lat", "lon"],
    { cell_measures: "area: area" }
  );
  await zarr.create(zarr.root(store).resolve("area"), {
    shape: [2, 5],
    chunkShape: [16777216, 1],
    dtype: "uint8",
    dimensionNames: ["lat", "lon"],
    attributes: { units: "m2" },
    fillValue: 1,
  });
  const ds = zarrAnalysisDatasetFromStore(
    store,
    "",
    ZARR_FORMAT.V3,
    "padding" + Math.random()
  );
  const ctx = await resolveVariableContext(ds, "tas", new ByteLru(1e6));
  const q: TAnalysisQuery = {
    version: 1,
    kind: ANALYSIS_KINDS.REGION_SERIES,
    geometry: { kind: "box", south: -1, north: 2, west: -1, east: 5 },
    fixed: {},
    source: { ref: "x", versionStatus: "best-effort" },
    variable: "tas",
  };
  const direct = await planAnalysis(ctx, q, new ReadContext())
    .then((p) => p.estimate)
    .catch(String);
  const cost = nativeCellReadsNow(
    (ctx.grid as TRectilinearContext).areas!.array,
    ["lat", "lon"],
    [2, 5],
    [0, 1],
    [0, 1, 2, 3, 4]
  );
  const block = await readNativeCells(
    ds,
    (ctx.grid as TRectilinearContext).areas!.array,
    ["lat", "lon"],
    [2, 5],
    [0, 1],
    [0, 1, 2, 3, 4]
  );
  expect(typeof direct).not.toBe("string");
  // Five padded uint8 chunks of 16 MiB decode one at a time; the ten cells
  // they cover are kept as float64.
  expect(cost).toMatchObject({
    reads: 5,
    bytes: 5 * 16_777_216,
    held: 10 * 8,
    input: 16_777_216,
  });
  // The stored fill is the area of the first and last cells.
  expect([block(0, 0), block(1, 4)]).toEqual([1, 1]);
});
