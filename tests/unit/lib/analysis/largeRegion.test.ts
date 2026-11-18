import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS, type TAnalysisQuery } from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

// eslint-disable-next-line max-lines-per-function
it("refuses a near-global drawn region quickly, naming a cheaper choice", async () => {
  const store = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(store), { attributes: {} });
  const [nlat, nlon] = [1800, 3600];
  const axis = async (
    name: string,
    n: number,
    values: Float64Array,
    units: string
  ) => {
    const node = await zarr.create(zarr.root(store).resolve(name), {
      shape: [n],
      chunkShape: [n],
      dtype: "float64",
      dimensionNames: [name],
      attributes: { units },
    });
    await zarr.set(node as never, null, {
      data: values,
      shape: [n],
      stride: [1],
    } as never);
  };
  await axis(
    "lat",
    nlat,
    Float64Array.from({ length: nlat }, (_, i) => -89.95 + i * 0.1),
    "degrees_north"
  );
  await axis(
    "lon",
    nlon,
    Float64Array.from({ length: nlon }, (_, j) => -179.95 + j * 0.1),
    "degrees_east"
  );
  await axis("time", 2, Float64Array.from([0, 1]), "days since 2000-01-01");
  await zarr.create(zarr.root(store).resolve("f"), {
    shape: [2, nlat, nlon],
    chunkShape: [1, 180, 360],
    dtype: "float32",
    dimensionNames: ["time", "lat", "lon"],
    attributes: { units: "K" },
  });
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `big-${Math.random()}`
  );
  const context = await resolveVariableContext(
    dataset,
    "f",
    new ByteLru(8 * 2 ** 20)
  );
  // A slightly tilted near-global rectangle, as a drawn shape.
  // Points every 170° at most: a ring's edges take the short way round.
  const ring = [
    [-170, -80],
    [0, -79.5],
    [170, -79],
    [169, 80],
    [0, 79.5],
    [-171, 79],
    [-170, -80],
  ];
  const query = {
    version: 1,
    kind: ANALYSIS_KINDS.REGION_SERIES,
    source: { ref: "memory", versionStatus: "session" },
    variable: "f",
    geometry: {
      kind: "shape",
      name: "as drawn",
      polygons: [[ring]],
      digest: "tilted",
      drawn: true,
    },
    fixed: {},
  } as unknown as TAnalysisQuery;
  const started = performance.now();
  await expect(
    (async () =>
      (await planAnalysis(context, query, new ReadContext())).execute())()
  ).rejects.toThrow(/holds about [\d,]+ cells.*not tilted/);
  expect(performance.now() - started).toBeLessThan(1500);
});

// eslint-disable-next-line max-lines-per-function
it("performance review of interim30: bands every 24 rows are not refused as millions of cells", async () => {
  const store = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(store), { attributes: {} });
  const n = 2400;
  const lat = Float64Array.from({ length: n }, (_, i) => -60 + i * 0.05);
  const lon = Float64Array.from(
    { length: n },
    (_, j) => -180 + (j + 0.5) * 0.15
  );
  for (const [name, values, units] of [
    ["lat", lat, "degrees_north"],
    ["lon", lon, "degrees_east"],
  ] as const) {
    const node = await zarr.create(zarr.root(store).resolve(name), {
      shape: [n],
      chunkShape: [n],
      dtype: "float64",
      dimensionNames: [name],
      attributes: { units },
    });
    await zarr.set(node as never, null, {
      data: values,
      shape: [n],
      stride: [1],
    } as never);
  }
  const time = await zarr.create(zarr.root(store).resolve("time"), {
    shape: [1],
    chunkShape: [1],
    dtype: "float64",
    dimensionNames: ["time"],
    attributes: { units: "days since 2000-01-01" },
  });
  await zarr.set(time as never, null, {
    data: Float64Array.of(0),
    shape: [1],
    stride: [1],
  } as never);
  await zarr.create(zarr.root(store).resolve("f"), {
    shape: [1, n, n],
    chunkShape: [1, 240, 240],
    dtype: "float32",
    dimensionNames: ["time", "lat", "lon"],
    attributes: { units: "K" },
  });
  const context = await resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `bands-${Math.random()}`
    ),
    "f",
    new ByteLru(8 * 2 ** 20)
  );
  // 101 thin bands, 0.8 row spacings wide, on rows 0, 24, … 2376 and 2399:
  // the rows a stride of 24 samples.
  const rows = [...Array.from({ length: 100 }, (_, k) => 24 * k), 2399];
  const band = (i: number) => {
    const [a, b] = [lat[i] - 0.02, lat[i] + 0.02];
    return [
      [
        [-170, a],
        [0, a],
        [170, a],
        [170, b],
        [0, b],
        [-170, b],
        [-170, a],
      ],
    ];
  };
  const query = {
    version: 1,
    kind: ANALYSIS_KINDS.DISTRIBUTION,
    source: { ref: "memory", versionStatus: "session" },
    variable: "f",
    geometry: {
      kind: "shape",
      name: "bands",
      polygons: rows.map(band),
      digest: "bands",
    },
    fixed: {},
    time: { start: 0, stop: 1 },
  } as unknown as TAnalysisQuery;
  const planned = await planAnalysis(context, query, new ReadContext());
  const result = await planned.execute();
  // Every band's cells: 101 rows of the columns between ±170°.
  const columns = Array.from(lon).filter((x) => Math.abs(x) < 170).length;
  expect(result.histogram?.selectedCells).toBe(101 * columns);
});
