/* eslint-disable camelcase, max-lines-per-function -- CF fixtures per case. */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import type { TAnalysisQuery } from "@/lib/analysis/types.ts";
import {
  resolveVariableContext,
  type TVariableContext,
} from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;

async function put(
  s: TStore,
  name: string,
  shape: number[],
  dims: string[],
  values: number[],
  attrs: Record<string, unknown> = {},
  chunkShape = shape
) {
  const a = await zarr.create(zarr.root(s).resolve(name), {
    shape,
    chunkShape,
    dimensionNames: dims,
    dtype: "float64",
    fillValue: NaN,
    attributes: attrs,
  });
  await zarr.set(a as never, null, {
    shape,
    stride: shape.map((_, i) => shape.slice(i + 1).reduce((x, y) => x * y, 1)),
    data: Float64Array.from(values),
  } as never);
}

type TMissing =
  "copies" | "originals" | "area-copies" | "area-originals" | "conflict";

/**
 * A 12-column curvilinear ring, 8 rows, with its first five columns
 * repeated after the last: 96 cells of unit area, 120 K in column 0 and
 * 0 K elsewhere (a 10 K mean). `missing` masks the field's or the area's
 * values (not the coordinates) in the repeated columns or in the originals;
 * "conflict" stores 240 K in column 0's copies. `slow` delays one of the
 * field's two chunks.
 */
async function ring(missing?: TMissing, slow?: number) {
  const [n, ny, nx] = [12, 8, 17];
  const s: TStore = new Map();
  await zarr.create(zarr.root(s), { attributes: {} });
  const [lats, lons, temps]: number[][] = [[], [], []];
  const copy = (i: number) => i >= n;
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const col = i % n;
      lats.push(-35 + 10 * j + 0.2 * Math.sin((2 * Math.PI * col) / n));
      lons.push(-165 + 30 * col + 0.2 * j);
      const masked =
        (missing === "copies" && copy(i)) || (missing === "originals" && i < 5);
      const hot = missing === "conflict" && copy(i) ? 240 : 120;
      temps.push(masked ? NaN : col === 0 ? hot : 0);
    }
  }
  const area = Array.from({ length: ny * nx }, (_, q) =>
    (missing === "area-copies" && copy(q % nx)) ||
    (missing === "area-originals" && q % nx < 5)
      ? NaN
      : 1
  );
  await put(s, "time", [1], ["time"], [0], { units: "days since 2000-01-01" });
  await put(s, "lat", [ny, nx], ["y", "x"], lats, {
    standard_name: "latitude",
    units: "degrees_north",
  });
  await put(s, "lon", [ny, nx], ["y", "x"], lons, {
    standard_name: "longitude",
    units: "degrees_east",
  });
  await put(s, "area", [ny, nx], ["y", "x"], area, {
    standard_name: "cell_area",
    units: "m2",
  });
  // The field in two column chunks: copies arrive in either order.
  await put(
    s,
    "v",
    [1, ny, nx],
    ["time", "y", "x"],
    temps,
    { units: "K", coordinates: "lat lon", cell_measures: "area: area" },
    [1, 8, 12]
  );
  const store = {
    get: async (key: string) => {
      if (key === `/v/c/0/0/${slow}`) {
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return s.get(key);
    },
  };
  const c = (await resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `copies-${missing}-${slow}`
    ),
    "v",
    new ByteLru(2 ** 20)
  )) as TVariableContext;
  const region = {
    kind: "region-series",
    version: 1,
    variable: "v",
    fixed: {},
    time: { start: 0, stop: 1 },
    geometry: { kind: "box", west: -180, east: 180, south: -85, north: 85 },
    source: { ref: "local", versionStatus: "best-effort" },
  } as TAnalysisQuery;
  const run = async (query: TAnalysisQuery) =>
    await (await planAnalysis(c, query, new ReadContext())).execute();
  return { c, region, run };
}

it("takes a repeated cell's value and area from whichever copy has it", async () => {
  for (const missing of [
    undefined,
    "copies",
    "originals",
    "area-copies",
    "area-originals",
  ] as const) {
    const { region, run } = await ring(missing);
    const series = await run(region);
    expect(series.values[0], `${missing}`).toBeCloseTo(10);
    expect(series.region!.validCells[0], `${missing}`).toBe(96);
    const spread = await run({
      ...region,
      kind: "distribution",
      timeIndex: 0,
    } as TAnalysisQuery);
    expect(spread.histogram!.mean, `${missing}`).toBeCloseTo(10);
    expect(spread.histogram!.validCells, `${missing}`).toBe(96);
    const point = await run({
      ...region,
      kind: "point-series",
      geometry: { kind: "point", lat: -5, lon: -164.4 },
    } as TAnalysisQuery);
    expect(point.values, `${missing}`).toEqual([120]);
  }
});

it("takes conflicting copies in the grid's order, in any read order", async () => {
  const means: number[] = [];
  for (const slow of [0, 1]) {
    const { region, run } = await ring("conflict", slow);
    means.push((await run(region)).values[0]);
  }
  // The kept cell is the one dropFrameDuplicates keeps: 240 K or 120 K.
  expect([10, 20]).toContain(means[0]);
  expect(means[1]).toBe(means[0]);
});

/** The ring's coordinates and unit areas, with `area` masked as `missing` says. */
async function ringGrid(s: TStore, missing?: TMissing) {
  const [n, ny, nx] = [12, 8, 17];
  await zarr.create(zarr.root(s), { attributes: {} });
  const [lats, lons]: number[][] = [[], []];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const col = i % n;
      lats.push(-35 + 10 * j + 0.2 * Math.sin((2 * Math.PI * col) / n));
      lons.push(-165 + 30 * col + 0.2 * j);
    }
  }
  await put(s, "lat", [ny, nx], ["y", "x"], lats, {
    standard_name: "latitude",
    units: "degrees_north",
  });
  await put(s, "lon", [ny, nx], ["y", "x"], lons, {
    standard_name: "longitude",
    units: "degrees_east",
  });
  const area = Array.from({ length: ny * nx }, (_, q) =>
    (missing === "area-copies" && q % nx >= n) ||
    (missing === "area-originals" && q % nx < 5)
      ? NaN
      : 1
  );
  await put(s, "area", [ny, nx], ["y", "x"], area, {
    standard_name: "cell_area",
    units: "m2",
  });
  return { n, ny, nx };
}

async function contextOf(s: TStore, name: string, key: string) {
  return (await resolveVariableContext(
    zarrAnalysisDatasetFromStore(s as never, "", ZARR_FORMAT.V3, key),
    name,
    new ByteLru(2 ** 20)
  )) as TVariableContext;
}

it("takes a repeated cell's value from whichever copy has it in every plot kind", async () => {
  const point = { kind: "point", lat: -5, lon: -164.4 };
  const path = {
    kind: "polyline",
    vertices: [
      { lat: -5, lon: -164.4 },
      { lat: -5, lon: -134.4 },
    ],
  };
  const box = { kind: "box", west: -180, east: 180, south: -85, north: 85 };
  const kinds = [
    ["point-series", point],
    ["profile", point],
    ["time-depth", point],
    ["section", path],
    ["hovmoller-path", path],
    ["region-series", box],
    ["distribution", box],
    ["hovmoller-lon", box],
    ["hovmoller-lat", box],
  ] as const;
  const outcomes: Record<string, string[]> = {};
  for (const missing of [
    undefined,
    "copies",
    "originals",
    "area-copies",
    "area-originals",
  ] as const) {
    const s: TStore = new Map();
    const { n, ny, nx } = await ringGrid(s, missing);
    await put(s, "time", [2], ["time"], [0, 1], {
      units: "days since 2000-01-01",
    });
    await put(s, "lev", [2], ["lev"], [800, 500], {
      standard_name: "air_pressure",
      units: "hPa",
      axis: "Z",
      positive: "down",
    });
    // 120 K in column 0 at 800 hPa on day 1; +10 K at 500 hPa, +3 K a day.
    const field = [0, 1, 2, 3].flatMap((q) =>
      Array.from({ length: ny * nx }, (_, c) => {
        const i = c % nx;
        const masked =
          (missing === "copies" && i >= n) ||
          (missing === "originals" && i < 5);
        return masked
          ? NaN
          : (i % n === 0 ? 120 : 0) + Math.floor(q / 2) * 3 + (q % 2) * 10;
      })
    );
    await put(
      s,
      "v",
      [2, 2, ny, nx],
      ["time", "lev", "y", "x"],
      field,
      { units: "K", coordinates: "lat lon", cell_measures: "area: area" },
      [1, 1, 8, 12]
    );
    const c = await contextOf(s, "v", `kinds-${missing}`);
    for (const [kind, geometry] of kinds) {
      const q = {
        kind,
        version: 1,
        variable: "v",
        fixed: {},
        time: { start: 0, stop: 2 },
        geometry,
        level: 0,
        timeIndex: 0,
        sectionSamples: 3,
        binDegrees: 180,
        source: { ref: "local", versionStatus: "best-effort" },
      } as TAnalysisQuery;
      const out = await (await planAnalysis(c, q, new ReadContext())).execute();
      (outcomes[kind] ??= []).push(
        JSON.stringify([out.values, out.histogram?.mean])
      );
    }
  }
  // Each kind gives the complete field's answer whichever copy is missing.
  for (const [kind, seen] of Object.entries(outcomes)) {
    expect(new Set(seen).size, `${kind}: ${seen.join(" / ")}`).toBe(1);
  }
  expect(JSON.parse(outcomes["time-depth"][0])[0]).toEqual([
    120, 130, 123, 133,
  ]);
});

it("pairs a vector's components stored on complementary copies of one cell", async () => {
  const means: number[][] = [];
  for (const complementary of [false, true]) {
    const s: TStore = new Map();
    const { n, ny, nx } = await ringGrid(s);
    await put(s, "time", [1], ["time"], [0], {
      units: "days since 2000-01-01",
    });
    const column = (q: number) => q % nx;
    // U only on the originals of the repeated columns, V only on their copies.
    const u = Array.from({ length: ny * nx }, (_, q) =>
      complementary && column(q) >= n ? NaN : column(q) % n === 0 ? 120 : 0
    );
    const v = Array.from({ length: ny * nx }, (_, q) =>
      complementary && column(q) < 5 ? NaN : 4
    );
    for (const [name, values, standard] of [
      ["u", u, "eastward_wind"],
      ["v", v, "northward_wind"],
    ] as const) {
      await put(s, name, [1, ny, nx], ["time", "y", "x"], values, {
        standard_name: standard,
        units: "m s-1",
        coordinates: "lat lon",
        cell_measures: "area: area",
      });
    }
    const key = `vector-${complementary}`;
    const [cu, cv] = [
      await contextOf(s, "u", key),
      await contextOf(s, "v", key),
    ];
    const q = {
      kind: "region-series",
      version: 1,
      variable: "u",
      fixed: {},
      time: { start: 0, stop: 1 },
      geometry: { kind: "box", west: -180, east: 180, south: -85, north: 85 },
      source: { ref: "local", versionStatus: "best-effort" },
      jointWith: "v",
    } as TAnalysisQuery;
    const out = await (
      await planAnalysis(cu, q, new ReadContext(), undefined, true, cv)
    ).execute();
    means.push([out.values[0], out.region!.validCells[0]]);
  }
  expect(means[1][0]).toBeCloseTo(10);
  expect(means[1][1]).toBe(96);
  expect(means[1]).toEqual(means[0]);
});

it("prices a distribution's selected points with its values", async () => {
  const { region, c } = await ring();
  const q = { ...region, kind: "distribution", timeIndex: 0 } as TAnalysisQuery;
  const plan = await planAnalysis(c, q, new ReadContext());
  // Besides the read's own buffers (about 13 KiB here): each of the 96 cells'
  // value, weight and centre (40 B), its mapped place (24 B), and the 136
  // points read (the 40 copies too) with their chunk groups (64 B each).
  const kept = 96 * 40 + 96 * 24 + 136 * 64;
  expect(plan.estimate.workingBytes).toBeGreaterThanOrEqual(13_000 + kept);
});
