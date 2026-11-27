/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS, type TAnalysisQuery } from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
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
async function fixture(n: number, areaChunk: number) {
  const store = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  const m = 2 * n;
  await write(
    store,
    "lat",
    Array.from({ length: n }, (_, i) => -60 + (120 * (i + 0.5)) / n),
    [n],
    ["lat"],
    { units: "degrees_north" }
  );
  await write(
    store,
    "lon",
    Array.from({ length: m }, (_, i) => -150 + (300 * (i + 0.5)) / m),
    [m],
    ["lon"],
    { units: "degrees_east" }
  );
  await write(store, "time", [0], [1], ["time"], {
    units: "days since 2000-01-01",
  });
  const measure = await zarr.create(zarr.root(store).resolve("area"), {
    shape: [n, m],
    chunkShape: [areaChunk, areaChunk],
    dimensionNames: ["lat", "lon"],
    dtype: "float64",
    attributes: { units: "m2" },
    fillValue: 1,
  });
  const field = await zarr.create(zarr.root(store).resolve("tas"), {
    shape: [1, n, m],
    chunkShape: [1, n, n],
    dimensionNames: ["time", "lat", "lon"],
    dtype: "float64",
    attributes: { cell_measures: "area: area" },
  });
  if (n <= 128) {
    await zarr.set(measure, null, {
      data: new Float64Array(n * m).fill(1),
      stride: [m, 1],
      shape: [n, m],
    });
    await zarr.set(field, null, {
      data: new Float64Array(n * m).fill(5),
      shape: [1, n, m],
      stride: [n * m, m, 1],
    });
  }
  const ds = zarrAnalysisDatasetFromStore(
    store,
    "",
    ZARR_FORMAT.V3,
    "hold" + n
  );
  const ctx = await resolveVariableContext(ds, "tas", new ByteLru(1e6));
  const q: TAnalysisQuery = {
    version: 1,
    kind: ANALYSIS_KINDS.REGION_SERIES,
    geometry: { kind: "box", south: -80, north: 80, west: -175, east: 175 },
    fixed: {},
    source: { ref: "x", versionStatus: "best-effort" },
    variable: "tas",
  };
  return { ctx, q };
}
it("includes declared-area storage and current field storage together", async () => {
  const small = await fixture(128, 32),
    plan = await planAnalysis(small.ctx, small.q, new ReadContext());
  expect((await plan.execute()).values[0]).toBe(5);
  // The areas held while a field chunk is read: both in the estimate.
  expect(plan.estimate.workingBytes).toBeGreaterThanOrEqual(128 * 384 * 8);
  // 400 MiB of areas and a 200 MiB field chunk: refused together, even
  // once confirmed.
  const big = await fixture(5120, 512);
  await expect(
    planAnalysis(big.ctx, big.q, new ReadContext(), undefined, true)
  ).rejects.toThrow(/MiB/);
});
