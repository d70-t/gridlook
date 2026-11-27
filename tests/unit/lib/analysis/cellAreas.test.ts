/* eslint-disable camelcase -- CF and Zarr metadata use snake_case keys. */
/**
 * Expected answers are computed here from the stored values, not by the code
 * under test.
 */
import { describe, expect, it, vi } from "vitest";
import * as zarr from "zarrita";

import { AnalysisRunner } from "@/lib/analysis/analysisRunner.ts";
import { ByteLru } from "@/lib/analysis/byteLru.ts";
import {
  cmip6FixedStore,
  declaredMeasure,
  midpointBounds,
} from "@/lib/analysis/cellAreas.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import {
  zarrAnalysisDatasetFromStore,
  type TAnalysisDataset,
} from "@/lib/analysis/sourceAdapter.ts";
import {
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  type TAnalysisQuery,
  type TGeometry,
} from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;

const LATS = [-90, -60, -30, 0, 30, 60, 90];
const LONS = [0, 45, 90, 135, 180, 225, 270, 315];
const NT = 2;
const DATA_URL =
  "https://storage.googleapis.com/cmip6/CMIP6/PMIP/IPSL/IPSL-CM6A-LR/midHolocene/r1i1p1f3/Amon/tas/gr/v20180926/";
const FIXED_URL =
  "https://storage.googleapis.com/cmip6/CMIP6/PMIP/IPSL/IPSL-CM6A-LR/midHolocene/r1i1p1f3/fx/areacella/gr/v20180926/";

const tasAt = (t: number, i: number, j: number) => 270 + t + i + j / 10;
/** Not a row factor times a column factor; one cell without an area. */
const areaAt = (i: number, j: number) =>
  i === 3 && j === 2 ? Number.NaN : (1 + i) * (1 + (j % 3)) * 1e10 + j * 1e8;

async function write(
  store: TStore,
  path: string,
  dims: string[],
  shape: number[],
  values: ArrayLike<number>,
  attrs: Record<string, unknown> = {},
  chunkShape = shape
) {
  const node = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape,
    dtype: "float64",
    dimensionNames: dims,
    attributes: attrs,
    fillValue: Number.NaN as never,
  });
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((p, n) => p * n, 1)
  );
  await zarr.set(node as never, null, {
    data: Float64Array.from(values),
    shape,
    stride,
  } as never);
}

async function axes(
  store: TStore,
  lats = LATS,
  lons = LONS,
  lonBounds?: number[]
) {
  await write(store, "lat", ["lat"], [lats.length], lats, {
    units: "degrees_north",
  });
  await write(store, "lon", ["lon"], [lons.length], lons, {
    units: "degrees_east",
    ...(lonBounds ? { bounds: "lon_bnds" } : {}),
  });
  if (lonBounds) {
    await write(store, "lon_bnds", ["lon", "nv"], [lons.length, 2], lonBounds, {
      units: "degrees_east",
    });
  }
}

function areaValues(order: "latlon" | "lonlat") {
  return order === "latlon"
    ? LATS.flatMap((_, i) => LONS.map((__, j) => areaAt(i, j)))
    : LONS.flatMap((_, j) => LATS.map((__, i) => areaAt(i, j)));
}

/** The temperature store, and (optionally) its fixed-field sibling. */
// eslint-disable-next-line max-lines-per-function
async function sources(
  options: {
    colocated?: boolean;
    units?: string;
    order?: "latlon" | "lonlat";
    siblingLats?: number[];
    dataLons?: number[];
    siblingLons?: number[];
    sibling?: boolean;
    dataLonBounds?: number[];
    siblingLonBounds?: number[];
  } = {}
) {
  const order = options.order ?? "latlon";
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), {
    attributes: options.colocated ? {} : { external_variables: "areacella" },
  });
  await axes(store, LATS, options.dataLons, options.dataLonBounds);
  await write(store, "time", ["time"], [NT], [0, 31], {
    units: "days since 1850-01-01",
  });
  await write(
    store,
    "tas",
    ["time", "lat", "lon"],
    [NT, LATS.length, LONS.length],
    Array.from({ length: NT * LATS.length * LONS.length }, (_, at) =>
      tasAt(
        Math.floor(at / (LATS.length * LONS.length)),
        Math.floor(at / LONS.length) % LATS.length,
        at % LONS.length
      )
    ),
    { units: "K", cell_measures: "area: areacella" }
  );
  const areaStore: TStore = new Map();
  const target = options.colocated ? store : areaStore;
  if (!options.colocated) {
    await zarr.create(zarr.root(areaStore), { attributes: {} });
    await axes(
      areaStore,
      options.siblingLats,
      options.siblingLons ?? options.dataLons,
      options.siblingLonBounds
    );
  }
  await write(
    target,
    "areacella",
    order === "latlon" ? ["lat", "lon"] : ["lon", "lat"],
    order === "latlon"
      ? [LATS.length, LONS.length]
      : [LONS.length, LATS.length],
    areaValues(order),
    { units: options.units ?? "m2", standard_name: "cell_area" }
  );
  const opened: string[] = [];
  const sibling = zarrAnalysisDatasetFromStore(
    areaStore as never,
    "",
    ZARR_FORMAT.V3,
    "fx"
  );
  const dataset: TAnalysisDataset = {
    ...zarrAnalysisDatasetFromStore(store as never, "", ZARR_FORMAT.V3, "tas"),
    location: DATA_URL,
    async openStore(url) {
      opened.push(url);
      if (options.sibling === false) {
        throw Object.assign(new Error("404 Not Found"), {
          name: "NotFoundError",
        });
      }
      return sibling;
    },
  };
  return { dataset, opened, areaStore };
}

const indexCache = new ByteLru<BigInt64Array>(8 * 2 ** 20);
const query = (
  kind: TAnalysisQuery["kind"],
  geometry: TGeometry
): TAnalysisQuery => ({
  version: 1,
  kind,
  source: { ref: "memory://ipsl", versionStatus: "session" as const },
  variable: "tas",
  geometry,
  fixed: {},
});

// Rows 2–4 (30° S–30° N), columns 1–2 (45° E, 90° E): six cells, one of
// them (3, 2) without a valid area.
const BOX: TGeometry = {
  kind: "box",
  west: 30,
  east: 100,
  south: -40,
  north: 40,
};
const SELECTED = [2, 3, 4].flatMap((i) => [1, 2].map((j) => [i, j]));

function expectedMean(t: number) {
  let sum = 0;
  let weight = 0;
  for (const [i, j] of SELECTED) {
    const area = areaAt(i, j);
    if (area > 0) {
      sum += tasAt(t, i, j) * area;
      weight += area;
    }
  }
  return sum / weight;
}

// eslint-disable-next-line max-lines-per-function
describe("v29: declared cell areas", () => {
  it("finds the CMIP6 fixed field beside the store", () => {
    expect(declaredMeasure({ cell_measures: "area: areacella" })).toBe(
      "areacella"
    );
    expect(cmip6FixedStore(DATA_URL, "tas", "areacella")).toBe(FIXED_URL);
    // Only for a store named after the variable, and a known measure.
    expect(cmip6FixedStore(DATA_URL, "pr", "areacella")).toBeUndefined();
    expect(cmip6FixedStore(DATA_URL, "tas", "volume")).toBeUndefined();
    expect(
      cmip6FixedStore("https://example.org/data.zarr", "tas", "areacella")
    ).toBeUndefined();
  });

  it("weights a box mean by the model's areas (not separable, one invalid)", async () => {
    const { dataset, opened } = await sources();
    const context = await resolveVariableContext(dataset, "tas", indexCache);
    expect(context.capabilities[ANALYSIS_KINDS.REGION_SERIES]).toEqual({
      available: true,
    });
    expect(opened).toEqual([FIXED_URL]);
    const planned = await planAnalysis(
      context,
      query(ANALYSIS_KINDS.REGION_SERIES, BOX),
      new ReadContext()
    );
    const result = await planned.execute();
    expect(result.values[0]).toBeCloseTo(expectedMean(0), 9);
    expect(result.values[1]).toBeCloseTo(expectedMean(1), 9);
    expect(result.region!.weighting).toMatch(/areacella \(m2, https:/);
    expect(result.region!.weighting).toMatch(
      /1 cell in the region's rows and columns has no valid area/
    );
    // The arithmetic mean is a different number (a negative control).
    const plain =
      SELECTED.reduce((s, [i, j]) => s + tasAt(0, i, j), 0) / SELECTED.length;
    expect(Math.abs(result.values[0] - plain)).toBeGreaterThan(1e-3);
  });

  it("weights a polygon, a distribution and a band the same way", async () => {
    const { dataset } = await sources({ order: "lonlat" });
    const context = await resolveVariableContext(dataset, "tas", indexCache);
    const polygon: TGeometry = {
      kind: "polygon",
      vertices: [
        { lat: -40, lon: 30 },
        { lat: -40, lon: 100 },
        { lat: 40, lon: 100 },
        { lat: 40, lon: 30 },
      ],
    };
    const series = await (
      await planAnalysis(
        context,
        query(ANALYSIS_KINDS.REGION_SERIES, polygon),
        new ReadContext()
      )
    ).execute();
    expect(series.values[0]).toBeCloseTo(expectedMean(0), 9);
    const distribution = await (
      await planAnalysis(
        context,
        {
          ...query(ANALYSIS_KINDS.DISTRIBUTION, BOX),
          time: { start: 0, stop: 1 },
        },
        new ReadContext()
      )
    ).execute();
    expect(distribution.histogram!.mean).toBeCloseTo(expectedMean(0), 9);
    // Latitude × time, one bin per row: row 2's mean over columns 1–2.
    const band = await (
      await planAnalysis(
        context,
        query(ANALYSIS_KINDS.HOVMOLLER_LAT, BOX),
        new ReadContext()
      )
    ).execute();
    const row = (i: number) =>
      [1, 2].reduce((s, j) => s + tasAt(0, i, j) * areaAt(i, j), 0) /
      [1, 2].reduce((s, j) => s + areaAt(i, j), 0);
    expect(band.values[0]).toBeCloseTo(row(2), 9);
  });

  it("uses areas in the dataset itself first", async () => {
    const { dataset, opened } = await sources({ colocated: true });
    const context = await resolveVariableContext(dataset, "tas", indexCache);
    const result = await (
      await planAnalysis(
        context,
        query(ANALYSIS_KINDS.REGION_SERIES, BOX),
        new ReadContext()
      )
    ).execute();
    expect(opened).toEqual([]);
    expect(result.values[0]).toBeCloseTo(expectedMean(0), 9);
    expect(result.region!.weighting).toMatch(/in the dataset/);
  });

  it("accepts the same country cells when fixed-field longitudes differ by one turn", async () => {
    const west = Array.from(
      { length: LONS.length },
      (_, column) => -140 + column * 8
    );
    const series = async (siblingLons: number[]) => {
      const { dataset } = await sources({ dataLons: west, siblingLons });
      const context = await resolveVariableContext(dataset, "tas", indexCache);
      const q = query(ANALYSIS_KINDS.REGION_SERIES, {
        kind: "country",
        id: "124",
        resolution: "50m",
      });
      const plan = await planAnalysis(context, q, new ReadContext());
      const result = await plan.execute();
      expect(result.region?.storedCells).toBe(5);
      return result.values;
    };
    const signed = await series(west);
    expect(signed[0]).toBeCloseTo(275.3092214663643, 9);
    expect(await series(west.map((lon) => lon + 360))).toEqual(signed);
  });

  it("refuses areas of another grid or in other units, with the reason", async () => {
    const shifted = await sources({
      siblingLats: LATS.map((v, i) => (i === 3 ? 1 : v)),
    });
    const other = await resolveVariableContext(
      shifted.dataset,
      "tas",
      indexCache
    );
    // Checked when an area plot is planned.
    await expect(
      planAnalysis(
        other,
        query(ANALYSIS_KINDS.REGION_SERIES, BOX),
        new ReadContext()
      )
    ).rejects.toThrow(/other latitudes or longitudes/);
    // Not an area.
    const seconds = await sources({ colocated: true, units: "s" });
    const units = await resolveVariableContext(
      seconds.dataset,
      "tas",
      indexCache
    );
    expect(units.capabilities[ANALYSIS_KINDS.DISTRIBUTION]).toEqual({
      available: false,
      reason: expect.stringMatching(/not an area/),
    });
  });

  it("without the fixed field, a regular grid gets labelled approximate areas", async () => {
    const { dataset, opened } = await sources({ sibling: false });
    const context = await resolveVariableContext(dataset, "tas", indexCache);
    expect(opened).toEqual([FIXED_URL]);
    const result = await (
      await planAnalysis(
        context,
        query(ANALYSIS_KINDS.REGION_SERIES, BOX),
        new ReadContext()
      )
    ).execute();
    expect(result.region!.weighting).toMatch(/approximate spherical/);
  });

  it("gives polar cells centred on the pole a real area", () => {
    const bounds = midpointBounds(LATS, true)!;
    expect([bounds[0], bounds[1]]).toEqual([-90, -75]);
    expect([bounds[12], bounds[13]]).toEqual([75, 90]);
    // Irregular (Gaussian-like) latitudes get no assumed edges.
    expect(midpointBounds([-80, -50, -15, 15, 50, 80], true)).toBeUndefined();
  });
});

// eslint-disable-next-line max-lines-per-function
describe("review of interim10: each variable's own cell measure", () => {
  const areaB = (_: number, j: number) => (j === 2 ? 9 : 1);

  /** tas weighted by areacella; tas2 (same values) by its own areab. */
  // eslint-disable-next-line max-lines-per-function
  async function withSecond() {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    await axes(store);
    await write(store, "time", ["time"], [NT], [0, 31], {
      units: "days since 1850-01-01",
    });
    const values = Array.from(
      { length: NT * LATS.length * LONS.length },
      (_, at) =>
        tasAt(
          Math.floor(at / (LATS.length * LONS.length)),
          Math.floor(at / LONS.length) % LATS.length,
          at % LONS.length
        )
    );
    const dims = ["time", "lat", "lon"];
    const shape = [NT, LATS.length, LONS.length];
    await write(store, "tas", dims, shape, values, {
      units: "K",
      cell_measures: "area: areacella",
    });
    await write(store, "tas2", dims, shape, values, {
      units: "K",
      cell_measures: "area: areab",
    });
    await write(
      store,
      "areacella",
      ["lat", "lon"],
      [LATS.length, LONS.length],
      areaValues("latlon"),
      {
        units: "m2",
        standard_name: "cell_area",
      }
    );
    await write(
      store,
      "areab",
      ["lat", "lon"],
      [LATS.length, LONS.length],
      LATS.flatMap((_, i) => LONS.map((__, j) => areaB(i, j))),
      { units: "m2", standard_name: "cell_area" }
    );
    return zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      "two"
    );
  }
  const mean = (t: number, area: (i: number, j: number) => number) => {
    let [sum, weight] = [0, 0];
    for (const [i, j] of SELECTED) {
      if (area(i, j) > 0) {
        sum += tasAt(t, i, j) * area(i, j);
        weight += area(i, j);
      }
    }
    return sum / weight;
  };
  const shape = (digest: string): TGeometry => ({
    kind: "shape",
    name: "box",
    digest,
    polygons: [
      [
        [
          [30, -40],
          [100, -40],
          [100, 40],
          [30, 40],
          [30, -40],
        ],
      ],
    ],
  });
  async function meanOf(
    dataset: TAnalysisDataset,
    variable: string,
    digest: string
  ) {
    const context = await resolveVariableContext(dataset, variable, indexCache);
    const planned = await planAnalysis(
      context,
      { ...query(ANALYSIS_KINDS.REGION_SERIES, shape(digest)), variable },
      new ReadContext()
    );
    return (await planned.execute()).values[0];
  }

  it("gives each its own mean, in either order", async () => {
    const dataset = await withSecond();
    const [a, b] = [mean(0, areaAt), mean(0, areaB)];
    expect(Math.abs(a - b)).toBeGreaterThan(1e-3); // a real difference
    expect(await meanOf(dataset, "tas", "ab")).toBeCloseTo(a, 9);
    expect(await meanOf(dataset, "tas2", "ab")).toBeCloseTo(b, 9);
    expect(await meanOf(dataset, "tas2", "ba")).toBeCloseTo(b, 9);
    expect(await meanOf(dataset, "tas", "ba")).toBeCloseTo(a, 9);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("review of interim10: cell areas read where the region is", () => {
  // eslint-disable-next-line max-lines-per-function
  it("reads one area chunk for a one-cell box", async () => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    await axes(store);
    await write(store, "time", ["time"], [NT], [0, 31], {
      units: "days since 1850-01-01",
    });
    const dims = ["time", "lat", "lon"];
    const shape = [NT, LATS.length, LONS.length];
    const values = Array.from(
      { length: NT * LATS.length * LONS.length },
      () => 1
    );
    await write(store, "tas", dims, shape, values, {
      units: "K",
      cell_measures: "area: areacella",
    });
    // Areas in one-cell chunks: 56 of them.
    await write(
      store,
      "areacella",
      ["lat", "lon"],
      [LATS.length, LONS.length],
      areaValues("latlon"),
      { units: "m2", standard_name: "cell_area" },
      [1, 1]
    );
    const reads: string[] = [];
    const counted = {
      get: async (key: string) => {
        if (/^\/areacella\/c\//.test(key)) {
          reads.push(key);
        }
        return store.get(key);
      },
    };
    const dataset = zarrAnalysisDatasetFromStore(
      counted as never,
      "",
      ZARR_FORMAT.V3,
      `one-${Math.random()}`
    );
    const context = await resolveVariableContext(dataset, "tas", indexCache);
    // The cell at 0°, 45°E only.
    const one: TGeometry = {
      kind: "box",
      west: 40,
      east: 50,
      south: -5,
      north: 5,
    };
    const planned = await planAnalysis(
      context,
      query(ANALYSIS_KINDS.REGION_SERIES, one),
      new ReadContext()
    );
    await planned.execute();
    expect(reads).toHaveLength(1);
  });
});

describe("review of interim10: long regular axes", () => {
  it("finds midpoint bounds of 150,000 and 2,000,000 longitudes", () => {
    for (const n of [150_000, 2_000_000]) {
      const lon = Float64Array.from(
        { length: n },
        (_, j) => -180 + (j + 0.5) * (360 / n)
      );
      const bounds = midpointBounds(Array.from(lon), false);
      expect(bounds?.length).toBe(2 * n);
    }
  });
});

describe("review #15: a 1-D area measure is read along its axis", () => {
  it("weighs one cell of a 10,000 × 20,000 grid without spreading the measure", async () => {
    const { cellWeights } = await import("@/lib/analysis/cellAreas.ts");
    const [nlat, nlon] = [10_000, 20_000];
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    const rowArea = (i: number) => (i === 7 ? 0 : 1e6 * (1 + i));
    await write(
      store,
      "area",
      ["lat"],
      [nlat],
      Array.from({ length: nlat }, (_, i) => rowArea(i)),
      { units: "m2" }
    );
    const dataset = zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      "rows"
    );
    const axis = (n: number) => ({
      values: Float64Array.from({ length: n }, (_, k) => k),
    });
    const before = process.memoryUsage().arrayBuffers;
    const weights = await cellWeights(
      {
        lat: axis(nlat) as never,
        lon: axis(nlon) as never,
        areas: {
          name: "area",
          origin: "the data store",
          units: "m2",
          array: await dataset.openArray("area"),
          dataset,
          dims: ["lat", "lon"],
        },
      },
      [7, 4321],
      [12_345]
    );
    // 1.6 GB before: the row vector was spread over every cell.
    expect(process.memoryUsage().arrayBuffers - before).toBeLessThan(2 ** 26);
    expect(weights.at(4321, 12_345)).toBe(rowArea(4321));
    expect(weights.separable?.lat(4321)).toBe(rowArea(4321));
    // Row 7 has no area: its selected cell is counted.
    expect(weights.invalid).toBe(1);
    // Two rows' values read, not the whole axis.
    expect(weights.at(7, 12_345)).toBe(0);
  });
});

async function countryWithChunkedCellAreas(n = 48) {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  const lat = Array.from({ length: n }, (_, i) => 45.25 + (12 * i) / n);
  const lon = Array.from({ length: n }, (_, i) => 4.25 + (12 * i) / n);
  await write(store, "lat", ["lat"], [n], lat, { units: "degrees_north" });
  await write(store, "lon", ["lon"], [n], lon, { units: "degrees_east" });
  await write(store, "time", ["time"], [1], [0], {
    units: "days since 2001-01-01",
  });
  await write(
    store,
    "tas",
    ["time", "lat", "lon"],
    [1, n, n],
    Array(n * n).fill(4),
    {
      cell_measures: "area: area",
    }
  );
  await write(
    store,
    "area",
    ["lat", "lon"],
    [n, n],
    Array(n * n).fill(1),
    { units: "m2" },
    [1, 1]
  );
  return store;
}

it("estimates a large country area-weight read before fetching its chunks", async () => {
  const store = await countryWithChunkedCellAreas();
  let areaReads = 0;
  const counted = {
    get(key: string) {
      if (key.startsWith("/area/c/")) {
        areaReads++;
      }
      return store.get(key);
    },
  };
  const dataset = zarrAnalysisDatasetFromStore(
    counted as never,
    "",
    ZARR_FORMAT.V3,
    `country-areas-${Math.random()}`
  );
  const ctx = await resolveVariableContext(dataset, "tas", indexCache);
  const country = { kind: "country", id: "276", resolution: "50m" } as const;
  const planned = await planAnalysis(
    ctx,
    query(ANALYSIS_KINDS.REGION_SERIES, country),
    new ReadContext()
  );
  expect(areaReads).toBe(0);
  expect(planned.estimate.modest).toBe(false);
  const result = await planned.execute();
  expect(result.region?.storedCells).toBe(733);
  expect(result.values[0]).toBeCloseTo(4);
});

// eslint-disable-next-line max-lines-per-function
it("review of interim30: area(lat) in one-value chunks reads the selected rows' chunks only", async () => {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  const nlat = 8192;
  const lats = Array.from(
    { length: nlat },
    (_, i) => -90 + (180 * (i + 0.5)) / nlat
  );
  await write(store, "time", ["time"], [2], [0, 1], {
    units: "days since 2000-01-01",
  });
  await write(store, "lat", ["lat"], [nlat], lats, { units: "degrees_north" });
  await write(store, "lon", ["lon"], [4], [0, 90, 180, 270], {
    units: "degrees_east",
  });
  await write(
    store,
    "area",
    ["lat"],
    [nlat],
    lats.map(() => 1),
    { units: "m2" },
    [1]
  );
  await write(
    store,
    "tas",
    ["time", "lat", "lon"],
    [2, nlat, 4],
    Array.from({ length: 2 * nlat * 4 }, () => 12),
    { units: "K", cell_measures: "area: area" },
    [2, nlat, 4]
  );
  let areaReads = 0;
  const counted = {
    get(key: string) {
      if (key.startsWith("/area/c/")) {
        areaReads++;
      }
      return store.get(key);
    },
  };
  const dataset = zarrAnalysisDatasetFromStore(
    counted as never,
    "",
    ZARR_FORMAT.V3,
    `area-lat-${Math.random()}`
  );
  const ctx = await resolveVariableContext(
    dataset,
    "tas",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
  const near = lats[4000];
  const planned = await planAnalysis(
    ctx,
    {
      version: ALGORITHM_VERSION,
      kind: ANALYSIS_KINDS.REGION_SERIES,
      source: { ref: "memory", versionStatus: "session" },
      variable: "tas",
      fixed: {},
      geometry: {
        kind: "box",
        south: near - 1e-4,
        north: near + 1e-4,
        west: -10,
        east: 10,
      },
      time: { start: 0, stop: 2 },
    } as TAnalysisQuery,
    new ReadContext()
  );
  expect(planned.estimate.modest).toBe(true);
  expect(Array.from((await planned.execute()).values)).toEqual([12, 12]);
  expect(areaReads).toBe(1);
});

/** A grid of `n` × `n` cells whose declared areas are stored in `chunk`s. */
// eslint-disable-next-line max-lines-per-function
async function declaredAreaGrid(
  n: number,
  chunk: number[],
  written = true,
  nt = 1
) {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  const axis = (from: number, span: number) =>
    Array.from({ length: n }, (_, i) => from + (span * (i + 0.5)) / n);
  await write(store, "lat", ["lat"], [n], axis(-90, 180), {
    units: "degrees_north",
  });
  await write(store, "lon", ["lon"], [n], axis(0, 360), {
    units: "degrees_east",
  });
  await write(
    store,
    "time",
    ["time"],
    [nt],
    Array.from({ length: nt }, (_, t) => t),
    { units: "days since 2001-01-01" }
  );
  // One date a chunk.
  await write(
    store,
    "tas",
    ["time", "lat", "lon"],
    [nt, n, n],
    Array(nt * n * n).fill(1),
    { units: "K", cell_measures: "area: area" },
    [1, n, n]
  );
  if (written) {
    await write(
      store,
      "area",
      ["lat", "lon"],
      [n, n],
      Array(n * n).fill(1),
      { units: "m2" },
      chunk
    );
  } else {
    // Declared only: its chunks are never written (nor read).
    await zarr.create(zarr.root(store).resolve("area"), {
      shape: [n, n],
      chunkShape: chunk,
      dtype: "float64",
      dimensionNames: ["lat", "lon"],
      attributes: { units: "m2" },
      fillValue: Number.NaN as never,
    });
  }
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `declared-${Math.random()}`
  );
  return resolveVariableContext(dataset, "tas", indexCache);
}

it("keeps the hard limits on declared area reads when Locate cells was confirmed", async () => {
  const globe: TGeometry = {
    kind: "box",
    south: -90,
    north: 90,
    west: 0,
    east: 360,
  };
  // 91 × 91 one-cell chunks: 8,281 reads, past the 8,192 ceiling.
  const fragmented = await declaredAreaGrid(91, [1, 1]);
  for (const confirmed of [false, true]) {
    await expect(
      planAnalysis(
        fragmented,
        query(ANALYSIS_KINDS.REGION_SERIES, globe),
        new ReadContext(),
        undefined,
        confirmed
      )
    ).rejects.toThrow(/8,281 stored chunks.*at most 8,192/);
  }
  // One padded chunk declared 8192 × 8192 float64: 512 MiB.
  const padded = await declaredAreaGrid(2, [8192, 8192], false);
  await expect(
    planAnalysis(
      padded,
      query(ANALYSIS_KINDS.REGION_SERIES, globe),
      new ReadContext(),
      undefined,
      true
    )
  ).rejects.toThrow(/512 MiB.*at most 256 MiB per chunk/);
});

it("states a finite working size while asking before many declared area reads", async () => {
  const globe: TGeometry = {
    kind: "box",
    south: -90,
    north: 90,
    west: 0,
    east: 360,
  };
  const many = await declaredAreaGrid(64, [1, 1]);
  const planned = await planAnalysis(
    many,
    query(ANALYSIS_KINDS.REGION_SERIES, globe),
    new ReadContext()
  );
  expect(planned.estimate.needsConfirmation).toBe(true);
  expect(Number.isFinite(planned.estimate.workingBytes)).toBe(true);
});

it("counts declared area chunks read while planning with the field chunks", async () => {
  // 64 one-cell area chunks, then 500 dates of one chunk each: 564 reads.
  const grid = await declaredAreaGrid(8, [1, 1], true, 500);
  const planned = await planAnalysis(
    grid,
    {
      ...query(ANALYSIS_KINDS.REGION_SERIES, {
        kind: "box",
        south: -90,
        north: 90,
        west: 0,
        east: 360,
      }),
      time: { start: 0, stop: 500 },
    },
    new ReadContext()
  );
  expect(planned.estimate.chunks).toBe(500);
  expect(planned.estimate.geometryReads).toBe(64);
  expect(planned.estimate.modest).toBe(false);
});

it("weighs every cell by a declared scalar area (review of interim33)", async () => {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "lat", ["lat"], [2], [-45, 45], {
    units: "degrees_north",
  });
  await write(store, "lon", ["lon"], [2], [90, 270], { units: "degrees_east" });
  await write(store, "time", ["time"], [1], [0], {
    units: "days since 2001-01-01",
  });
  await write(store, "tas", ["time", "lat", "lon"], [1, 2, 2], [2, 2, 8, 8], {
    units: "K",
    cell_measures: "area: area",
  });
  const area = await zarr.create(zarr.root(store).resolve("area"), {
    shape: [],
    chunkShape: [],
    dtype: "float64",
    dimensionNames: [],
    attributes: { units: "m2" },
    fillValue: Number.NaN as never,
  });
  await zarr.set(area as never, null, 1 as never);
  const ctx = await resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `scalar-${Math.random()}`
    ),
    "tas",
    indexCache
  );
  const planned = await planAnalysis(
    ctx,
    query(ANALYSIS_KINDS.REGION_SERIES, {
      kind: "box",
      south: -90,
      north: 90,
      west: 0,
      east: 360,
    }),
    new ReadContext()
  );
  expect((await planned.execute()).values).toEqual([5]);
});

it("admits a country when the area chunks under its selected centres fit the limit", async () => {
  const n = 134;
  const store = await countryWithChunkedCellAreas(n);
  const { getCountryRings } = await import("@/lib/analysis/countryAtlas.ts");
  const { prepareCountry, countryContains } =
    await import("@/lib/analysis/countryRegion.ts");
  const country = prepareCountry(await getCountryRings("276", "50m"));
  let inside = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (countryContains(country, 45.25 + (12 * i) / n, 4.25 + (12 * j) / n)) {
        inside++;
      }
    }
  }
  expect(inside).toBe(5723);
  const ds = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    "country-compact-areas"
  );
  const ctx = await resolveVariableContext(ds, "tas", indexCache);
  const q = query(ANALYSIS_KINDS.REGION_SERIES, {
    kind: "country",
    id: "276",
    resolution: "50m",
  });
  const p = await planAnalysis(ctx, q, new ReadContext());
  expect(p.estimate.geometryReads).toBeLessThanOrEqual(8192);
});

it("keeps a point series readable during an outage of its separate area store", async () => {
  const { dataset } = await sources();
  const point = async (source: TAnalysisDataset) => {
    const ctx = await resolveVariableContext(source, "tas", indexCache);
    const q = query(ANALYSIS_KINDS.POINT_SERIES, {
      kind: "point",
      lat: 0,
      lon: 90,
    });
    const planned = await planAnalysis(ctx, q, new ReadContext());
    return (await planned.execute()).values;
  };
  const expected = [tasAt(0, 3, 2), tasAt(1, 3, 2)];
  expect(await point(dataset)).toEqual(expected);
  const unavailable = {
    ...dataset,
    async openStore() {
      throw new Error("503 Service Unavailable");
    },
  };
  expect(await point(unavailable)).toEqual(expected);
});

it("review37: an unavailable colocated area leaves the point series readable", async () => {
  const { dataset } = await sources({ colocated: true });
  const failing = {
    ...dataset,
    async openArray(name: string) {
      if (name === "areacella") {
        throw new Error("503 Service Unavailable");
      }
      return dataset.openArray(name);
    },
  };
  const run = async (source: TAnalysisDataset) => {
    const ctx = await resolveVariableContext(source, "tas", indexCache);
    const q = query(ANALYSIS_KINDS.POINT_SERIES, {
      kind: "point",
      lat: 0,
      lon: 90,
    });
    return (await (await planAnalysis(ctx, q, new ReadContext())).execute())
      .values;
  };
  const expected = [tasAt(0, 3, 2), tasAt(1, 3, 2)];
  expect(await run(dataset)).toEqual(expected);
  await expect(run(failing)).resolves.toEqual(expected);
});

it("review37: retries a temporarily unavailable fixed-field coordinate", async () => {
  const { dataset } = await sources();
  const sibling = await dataset.openStore!(FIXED_URL);
  let fail = true;
  const intermittent = {
    ...dataset,
    async openStore() {
      return {
        ...sibling,
        async openArray(name: string) {
          if (name === "lat" && fail) {
            throw new Error("503 Service Unavailable");
          }
          return sibling.openArray(name);
        },
      };
    },
  };
  const runner = new AnalysisRunner();
  vi.spyOn(
    runner as unknown as { dataset(): Promise<TAnalysisDataset> },
    "dataset"
  ).mockResolvedValue(intermittent);
  const src = {
    store: DATA_URL,
    dataset: "",
    format: ZARR_FORMAT.V3,
    key: "review37-fx",
  };
  // Checked when an area plot is planned, so the 503 is said there, and not
  // kept.
  const context = await runner.context(src, "tas");
  const region = query(ANALYSIS_KINDS.REGION_SERIES, BOX);
  await expect(
    planAnalysis(context, region, new ReadContext())
  ).rejects.toThrow(/could not be read: 503/);
  fail = false;
  const result = await (
    await planAnalysis(context, region, new ReadContext())
  ).execute();
  expect(result.values[0]).toBeCloseTo(expectedMean(0));
});

it("review37: prices the stored area chunks under this country before requesting confirmation", async () => {
  const store = await countryWithChunkedCellAreas(13);
  let reads = 0;
  const dataset = zarrAnalysisDatasetFromStore(
    {
      get(key: string) {
        if (key.startsWith("/area/c/")) {
          reads++;
        }
        return store.get(key);
      },
    } as never,
    "",
    ZARR_FORMAT.V3,
    "review37-price"
  );
  const ctx = await resolveVariableContext(dataset, "tas", indexCache);
  const q = query(ANALYSIS_KINDS.REGION_SERIES, {
    kind: "country",
    id: "276",
    resolution: "50m",
  });
  const p = await planAnalysis(ctx, q, new ReadContext());
  const result = await p.execute();
  expect(result.region?.storedCells).toBe(reads);
  expect(reads).toBeLessThanOrEqual(64);
  expect(p.estimate.geometryReads).toBe(reads);
});

it("refuses a fixed field whose cells have other bounds than the data's (review of interim37)", async () => {
  const edges = LONS.flatMap((lon) => [lon - 22.5, lon + 22.5]);
  const shifted = edges.slice();
  shifted[1] = shifted[2] = 30; // the first two cells' shared edge moved
  // Checked when an area plot is planned.
  const region = async (siblingLonBounds: number[]) => {
    const { dataset } = await sources({
      dataLonBounds: edges,
      siblingLonBounds,
    });
    const ctx = await resolveVariableContext(dataset, "tas", indexCache);
    return planAnalysis(
      ctx,
      query(ANALYSIS_KINDS.REGION_SERIES, BOX),
      new ReadContext()
    ).then(
      () => "",
      (error: Error) => error.message
    );
  };
  expect(await region(edges)).toBe("");
  // A whole turn apart is the same cells.
  expect(await region(edges.map((e) => e + 360))).toBe("");
  expect(await region(shifted)).toMatch(/other latitudes or longitudes/);
});

it("takes any area unit for weights and refuses others (review of interim37)", async () => {
  const { isAreaUnit } = await import("@/lib/analysis/unitConvert.ts");
  for (const units of ["m2", "km2", "km^2", "cm**2", "square kilometres"]) {
    expect(isAreaUnit(units)).toBe(true);
  }
  for (const units of ["s", "m", "", "m2 s-1"]) {
    expect(isAreaUnit(units)).toBe(false);
  }
  const region = async (units: string) => {
    const { dataset } = await sources({ units });
    const ctx = await resolveVariableContext(dataset, "tas", indexCache);
    return ctx.capabilities[ANALYSIS_KINDS.REGION_SERIES];
  };
  expect((await region("km2")).available).toBe(true);
  const seconds = await region("s");
  expect(seconds.available).toBe(false);
  expect(seconds.reason).toMatch(/not an area/);
});

it("review41: equivalent sibling bounds inherit their radian coordinate units", async () => {
  const edges = LONS.flatMap((lon) => [lon - 22.5, lon + 22.5]);
  const { dataset, areaStore } = await sources({
    dataLonBounds: edges,
    siblingLonBounds: edges,
  });
  const radians = (v: number) => (v * Math.PI) / 180;
  await write(areaStore, "lon", ["lon"], [LONS.length], LONS.map(radians), {
    units: "radians",
    bounds: "lon_bnds",
  });
  await write(
    areaStore,
    "lon_bnds",
    ["lon", "nv"],
    [LONS.length, 2],
    edges.map(radians),
    {}
  );
  const ctx = await resolveVariableContext(dataset, "tas", indexCache);
  const result = await (
    await planAnalysis(
      ctx,
      query(ANALYSIS_KINDS.REGION_SERIES, BOX),
      new ReadContext()
    )
  ).execute();
  expect(result.values[0]).toBeCloseTo(expectedMean(0));
});

it("review41: a missing edge outside the selection leaves local declared areas usable", async () => {
  const edges = LONS.flatMap((lon) => [lon - 22.5, lon + 22.5]);
  edges[edges.length - 1] = NaN; // Far outside the selected 45 E and 90 E cells.
  const { dataset } = await sources({
    dataLonBounds: edges,
    siblingLonBounds: edges,
  });
  const ctx = await resolveVariableContext(dataset, "tas", indexCache);
  const result = await (
    await planAnalysis(
      ctx,
      query(ANALYSIS_KINDS.REGION_SERIES, BOX),
      new ReadContext()
    )
  ).execute();
  expect(result.values[0]).toBeCloseTo(expectedMean(0));
});

// eslint-disable-next-line max-lines-per-function -- constructs and measures a multi-store Zarr fixture.
it("review41: a point time series skips the separate area's coordinate chunks", async () => {
  const n = 96;
  const store: TStore = new Map(),
    fixed: TStore = new Map();
  for (const target of [store, fixed]) {
    await zarr.create(zarr.root(target), { attributes: {} });
    for (const [dim, units] of [
      ["lat", "degrees_north"],
      ["lon", "degrees_east"],
    ]) {
      await write(
        target,
        dim,
        [dim],
        [n],
        Array.from({ length: n }, (_, i) => i / 2),
        { units },
        [target === store ? n : 1]
      );
    }
  }
  await write(store, "time", ["time"], [1], [0], {
    units: "days since 1850-01-01",
  });
  await write(
    store,
    "tas",
    ["time", "lat", "lon"],
    [1, n, n],
    Array(n * n).fill(7),
    { cell_measures: "area: areacella" }
  );
  await write(
    fixed,
    "areacella",
    ["lat", "lon"],
    [n, n],
    Array(n * n).fill(1),
    { units: "m2" }
  );
  let reads = 0;
  const sibling = zarrAnalysisDatasetFromStore(
    {
      get(key: string) {
        if (/^\/(lat|lon)\/c\//.test(key)) {
          reads++;
        }
        return fixed.get(key);
      },
    } as never,
    "",
    ZARR_FORMAT.V3,
    "review41-point-fx"
  );
  const dataset = {
    ...zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      "review41-point-data"
    ),
    location: DATA_URL,
    async openStore() {
      return sibling;
    },
  };
  const ctx = await resolveVariableContext(dataset, "tas", indexCache);
  const p = await planAnalysis(
    ctx,
    query(ANALYSIS_KINDS.POINT_SERIES, { kind: "point", lat: 20, lon: 30 }),
    new ReadContext()
  );
  expect((await p.execute()).values).toEqual([7]);
  expect(reads).toBe(0);
});

// eslint-disable-next-line max-lines-per-function -- constructs and measures a multi-store Zarr fixture.
it("review41: the working limit counts cached area tiles retained during weighing", async () => {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  const rows = 16 * 512,
    cols = 17 * 512;
  await write(
    store,
    "lat",
    ["lat"],
    [rows],
    Array.from({ length: rows }, (_, i) => -90 + ((i + 0.5) * 180) / rows),
    { units: "degrees_north" }
  );
  await write(
    store,
    "lon",
    ["lon"],
    [cols],
    Array.from({ length: cols }, (_, i) => -180 + ((i + 0.5) * 360) / cols),
    { units: "degrees_east" }
  );
  await write(store, "time", ["time"], [1], [0], {
    units: "days since 1850-01-01",
  });
  await zarr.create(zarr.root(store).resolve("tas"), {
    shape: [1, rows, cols],
    chunkShape: [1, 512, 512],
    dtype: "float32",
    dimensionNames: ["time", "lat", "lon"],
    attributes: { cell_measures: "area: area" },
    fillValue: 1 as never,
  });
  await zarr.create(zarr.root(store).resolve("area"), {
    shape: [rows, cols],
    chunkShape: [512, 512],
    dtype: "float64",
    dimensionNames: ["lat", "lon"],
    attributes: { units: "m2" },
    fillValue: 1 as never,
  });
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    "review41-warm"
  );
  const ctx = await resolveVariableContext(dataset, "tas", indexCache);
  const q = query(ANALYSIS_KINDS.REGION_SERIES, {
    kind: "box",
    west: -180,
    east: 180,
    south: -90,
    north: 90,
  });
  // The cold control refuses 272 tiles (544 MiB), 546 MiB with the last tile's
  // source. Warm 16 (32 MiB), using the production area reader, without
  // allocating the large box.
  await expect(planAnalysis(ctx, q, new ReadContext())).rejects.toThrow(
    /546 MiB of cell areas/
  );
  if (ctx.grid.kind !== "rectilinear" || !ctx.grid.areas) {
    throw Error("fixture grid");
  }
  const { readNativeCells } = await import("@/lib/analysis/nativeGrid.ts");
  const a = ctx.grid.areas;
  await readNativeCells(
    a.dataset,
    a.array,
    a.dims,
    [rows, cols],
    [0],
    Array.from({ length: 16 }, (_, i) => 512 * i)
  );
  // Warm tiles are held too: still 546 MiB with the last source.
  await expect(planAnalysis(ctx, q, new ReadContext())).rejects.toThrow(
    /546 MiB of cell areas/
  );
}, 60000);

// eslint-disable-next-line max-lines-per-function
it("independent review of interim45: sibling bounds are compared as pairs, at the cells' own scale", async () => {
  const planned = async (
    lons: number[],
    dataLonBounds: number[],
    siblingLonBounds: number[],
    geometry: TGeometry = BOX
  ) => {
    const { dataset } = await sources({
      dataLons: lons,
      dataLonBounds,
      siblingLonBounds,
    });
    const ctx = await resolveVariableContext(dataset, "tas", indexCache);
    return planAnalysis(
      ctx,
      query(ANALYSIS_KINDS.REGION_SERIES, geometry),
      new ReadContext()
    ).then(
      () => "",
      (error: Error) => error.message
    );
  };
  const edges = LONS.flatMap((lon) => [lon - 22.5, lon + 22.5]);
  // A wide sibling cell [190°, −22.5°] is not the field's [−22.5°, 22.5°]:
  // both its edges lie west of 0° by the shortest turn.
  const wide = edges.slice();
  [wide[0], wide[1]] = [190, -22.5];
  expect(await planned(LONS, edges, wide)).toMatch(
    /other latitudes or longitudes/
  );
  // The same pair reversed, or a turn away, is the same cell.
  const reversed = edges.slice();
  [reversed[0], reversed[1]] = [22.5, -22.5];
  expect(await planned(LONS, edges, reversed)).toBe("");
  expect(
    await planned(
      LONS,
      edges,
      edges.map((e) => e + 360)
    )
  ).toBe("");
  // One-microdegree cells: an internal edge moved from 0.50 to 0.95 µ°.
  const tiny = LONS.map((_, j) => j * 1e-6);
  const tinyEdges = tiny.flatMap((lon) => [lon - 0.5e-6, lon + 0.5e-6]);
  const moved = tinyEdges.slice();
  moved[1] = moved[2] = 0.95e-6;
  const all: TGeometry = {
    kind: "box",
    south: -90,
    north: 90,
    west: -1,
    east: 1,
  };
  expect(await planned(tiny, tinyEdges, tinyEdges, all)).toBe("");
  expect(await planned(tiny, tinyEdges, moved, all)).toMatch(
    /other latitudes or longitudes/
  );
  const west = (v: number) => (v >= 180 ? v - 360 : v);
  const seam = LONS.map((_, j) => west(180 + j * 1e-6));
  const seamEdges = LONS.flatMap((_, j) => [
    west(180 + j * 1e-6 - 0.5e-6),
    west(180 + j * 1e-6 + 0.5e-6),
  ]);
  const shifted = seamEdges.slice();
  shifted[0] = west(180 - 0.5e-6 + 0.45e-6);
  expect(await planned(seam, seamEdges, seamEdges, all)).toBe("");
  expect(await planned(seam, seamEdges, shifted, all)).toMatch(
    /other latitudes or longitudes/
  );
});

it("independent review of interim45: names the axis whose edges were inferred", async () => {
  const edges = LONS.flatMap((lon) => [lon - 22.5, lon + 22.5]);
  // Longitude bounds published, latitude bounds not, and no cell areas.
  const { dataset } = await sources({ dataLonBounds: edges, sibling: false });
  const ctx = await resolveVariableContext(dataset, "tas", indexCache);
  const point = await (
    await planAnalysis(
      ctx,
      query(ANALYSIS_KINDS.POINT_SERIES, { kind: "point", lat: 1, lon: 46 }),
      new ReadContext()
    )
  ).execute();
  const selection = point.cell?.selection ?? "";
  expect(selection).toMatch(
    /latitude edges halfway between centres \(no latitude bounds published; longitude bounds published\)/
  );
  expect(selection).not.toMatch(/no bounds published/);
});
