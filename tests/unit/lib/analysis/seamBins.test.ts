/* eslint-disable max-lines-per-function -- each case builds its own fixture. */
/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import {
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  type TAnalysisQuery,
} from "@/lib/analysis/types.ts";
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
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((product, n) => product * n, 1)
  );
  await zarr.set(array as never, null, {
    data: Float64Array.from(data),
    shape,
    stride,
  } as never);
}

/** One latitude row, the given longitude cells, two dates; value = column. */
async function grid(lons: number[], bounds?: [number, number][]) {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "lat", [0], [1], ["lat"], {
    units: "degrees_north",
    bounds: "lat_bnds",
  });
  await write(store, "lat_bnds", [-10, 10], [1, 2], ["lat", "nv"]);
  await write(store, "lon", lons, [lons.length], ["lon"], {
    units: "degrees_east",
    ...(bounds ? { bounds: "lon_bnds" } : {}),
  });
  if (bounds) {
    await write(
      store,
      "lon_bnds",
      bounds.flat(),
      [lons.length, 2],
      ["lon", "nv"]
    );
  }
  await write(store, "time", [0, 1], [2], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(
    store,
    "v",
    [0, 1].flatMap(() => lons.map((_, j) => j)),
    [2, 1, lons.length],
    ["time", "lat", "lon"]
  );
  return resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `seam-${Math.random()}`
    ),
    "v",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
}

async function hovmoller(
  ctx: Awaited<ReturnType<typeof grid>>,
  west: number,
  east: number
) {
  const query: TAnalysisQuery = {
    version: ALGORITHM_VERSION,
    kind: ANALYSIS_KINDS.HOVMOLLER_LON,
    source: { ref: "memory", versionStatus: "session" },
    variable: "v",
    geometry: { kind: "box", west, east, south: -10, north: 10 },
    fixed: {},
  };
  const planned = await planAnalysis(ctx, query, new ReadContext());
  return planned.execute();
}

describe("full-turn and tiny longitude selections (v8 review)", () => {
  it("six 60° cells centred on the requested seam keep 360° of whole cells", async () => {
    const lons = [0, 60, 120, 180, 240, 300];
    const ctx = await grid(
      lons,
      lons.map((c) => [c - 30, c + 30])
    );
    const result = await hovmoller(ctx, 0, 360);
    const edges = result.axis!.bounds!;
    expect(edges[edges.length - 1] - edges[0]).toBeCloseTo(360, 9);
    expect(result.axis!.values).toHaveLength(6);
    expect(result.values.slice(0, 6)).toEqual([0, 1, 2, 3, 4, 5]);
  });

  it("six 60° cells on [0°, 360°), full width from −180°", async () => {
    const lons = [30, 90, 150, 210, 270, 330];
    const ctx = await grid(
      lons,
      lons.map((c) => [c - 30, c + 30])
    );
    const result = await hovmoller(ctx, -180, 180);
    const edges = result.axis!.bounds!;
    expect(edges[edges.length - 1] - edges[0]).toBeCloseTo(360, 9);
    expect(result.axis!.values).toHaveLength(6);
  });

  it("a single cell published as [−180°, 180°] covers the whole turn", async () => {
    const ctx = await grid([0], [[-180, 180]]);
    const result = await hovmoller(ctx, 0, 360);
    const edges = result.axis!.bounds!;
    expect(edges[edges.length - 1] - edges[0]).toBeCloseTo(360, 9);
    expect(result.values.slice(0, 1)).toEqual([0]);
  });

  it("a full turn written 170°..530° on fractional seams keeps all six columns (v9 review)", async () => {
    const lons = [2.18, 62.18, 122.18, 182.18, 242.18, 302.18];
    const ctx = await grid(
      lons,
      lons.map((c) => [c - 30, c + 30])
    );
    const result = await hovmoller(ctx, 170, 530);
    const edges = result.axis!.bounds!;
    expect(result.axis!.values).toHaveLength(6);
    expect(edges[edges.length - 1] - edges[0]).toBeCloseTo(360, 9);
  });

  it("explicit 90° sectors stay anchored at the requested west edge (v9 review)", async () => {
    const lons = [0, 60, 120, 180, 240, 300];
    const ctx = await grid(
      lons,
      lons.map((c) => [c - 30, c + 30])
    );
    const query: TAnalysisQuery = {
      version: ALGORITHM_VERSION,
      kind: ANALYSIS_KINDS.HOVMOLLER_LON,
      source: { ref: "memory", versionStatus: "session" },
      variable: "v",
      geometry: { kind: "box", west: 0, east: 360, south: -10, north: 10 },
      fixed: {},
      binDegrees: 90,
    };
    const result = await (
      await planAnalysis(ctx, query, new ReadContext())
    ).execute();
    expect(result.axis!.bounds).toEqual([0, 90, 180, 270, 360]);
    // Column indices: sectors hold centres 0° and 60°, 120°, 180° and
    // 240°, 300° (means of longitudes 30°, 120°, 210°, 300°).
    expect(result.values.slice(0, 4)).toEqual([0.5, 2, 3.5, 5]);
  });

  it("a 10⁻¹⁴° box never selects a column 180° away", async () => {
    const ctx = await grid(
      [10, 190],
      [
        [5, 15],
        [185, 195],
      ]
    );
    const result = await hovmoller(ctx, 10, 10 + 1e-14);
    const picked = result.values
      .slice(0, result.axis!.values.length)
      .filter((v) => !Number.isNaN(v));
    expect(picked).not.toContain(1);
  });
});

/** n latitude rows on [−90°, 90°], one longitude cell, two dates. */
async function rows(lats: number[], half: number) {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "lat", lats, [lats.length], ["lat"], {
    units: "degrees_north",
    bounds: "lat_bnds",
  });
  await write(
    store,
    "lat_bnds",
    lats.flatMap((v) => [Math.max(-90, v - half), Math.min(90, v + half)]),
    [lats.length, 2],
    ["lat", "nv"]
  );
  await write(store, "lon", [0], [1], ["lon"], {
    units: "degrees_east",
    bounds: "lon_bnds",
  });
  await write(store, "lon_bnds", [-180, 180], [1, 2], ["lon", "nv"]);
  await write(store, "time", [0, 1], [2], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(
    store,
    "v",
    [0, 1].flatMap(() => lats),
    [2, lats.length, 1],
    ["time", "lat", "lon"]
  );
  return resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `rows-${Math.random()}`
    ),
    "v",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
}

async function latHovmoller(
  ctx: Awaited<ReturnType<typeof rows>>,
  south: number,
  north: number,
  binDegrees: number
) {
  const query: TAnalysisQuery = {
    version: ALGORITHM_VERSION,
    kind: ANALYSIS_KINDS.HOVMOLLER_LAT,
    source: { ref: "memory", versionStatus: "session" },
    variable: "v",
    geometry: { kind: "box", west: -180, east: 180, south, north },
    fixed: {},
    binDegrees,
  };
  const planned = await planAnalysis(ctx, query, new ReadContext());
  return planned.execute();
}

describe("bin planning (v8 review)", () => {
  it("150,000 latitude rows into four bins plan without a RangeError", async () => {
    const n = 150_000;
    const step = 180 / n;
    const lats = Array.from({ length: n }, (_, i) => -90 + (i + 0.5) * step);
    const ctx = await rows(lats, step / 2);
    const result = await latHovmoller(ctx, -90, 90, 45);
    expect(result.axis!.values).toHaveLength(4);
    // An area-weighted mean of latitudes in the southernmost bin.
    expect(result.values[0]).toBeGreaterThan(-90);
    expect(result.values[0]).toBeLessThan(-45);
  });

  it("an empty 80°–81° band keeps its positive-width bins, empty", async () => {
    const ctx = await rows([0, 10], 5);
    const result = await latHovmoller(ctx, 80, 81, 0.25);
    const edges = result.axis!.bounds!;
    expect(edges.length - 1).toBe(4);
    for (let k = 1; k < edges.length; k++) {
      expect(edges[k]).toBeGreaterThan(edges[k - 1]);
    }
    expect(result.values.every((v) => Number.isNaN(v))).toBe(true);
  });

  it("a box [5°, 5° + 2⁻⁴⁷] holding a real row gives one bin", async () => {
    const ctx = await rows([5], 1);
    const result = await latHovmoller(ctx, 5, 5 + 2 ** -47, 1);
    expect(result.axis!.values).toHaveLength(1);
    expect(result.values[0]).toBe(5);
  });
});

describe("time bounds in their own units (v8 review)", () => {
  it("days-since bounds beside an hours-since coordinate are converted", async () => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    await write(store, "lat", [0], [1], ["lat"], { units: "degrees_north" });
    await write(store, "lon", [0], [1], ["lon"], { units: "degrees_east" });
    await write(store, "time", [12, 36], [2], ["time"], {
      units: "hours since 2000-01-01",
      calendar: "noleap",
      bounds: "time_bnds",
    });
    await write(store, "time_bnds", [1, 2, 2, 3], [2, 2], ["time", "nv"], {
      units: "days since 1999-12-31",
      calendar: "noleap",
    });
    await write(store, "v", [1, 2], [2, 1, 1], ["time", "lat", "lon"]);
    const ctx = await resolveVariableContext(
      zarrAnalysisDatasetFromStore(
        store as never,
        "",
        ZARR_FORMAT.V3,
        `tb-${Math.random()}`
      ),
      "v",
      new ByteLru<BigInt64Array>(2 ** 20)
    );
    expect(ctx.time?.bounds).toEqual([0, 24, 24, 48]);
  });
});

describe("bounds in other units (v9 review)", () => {
  async function openCtx(store: TStore) {
    return resolveVariableContext(
      zarrAnalysisDatasetFromStore(
        store as never,
        "",
        ZARR_FORMAT.V3,
        `bu-${Math.random()}`
      ),
      "v",
      new ByteLru<BigInt64Array>(2 ** 20)
    );
  }

  it("pressure levels in hPa with bounds in Pa get bounds in hPa", async () => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    await write(store, "lat", [0], [1], ["lat"], { units: "degrees_north" });
    await write(store, "lon", [0], [1], ["lon"], { units: "degrees_east" });
    await write(store, "plev", [850, 500], [2], ["plev"], {
      units: "hPa",
      positive: "down",
      standard_name: "air_pressure",
      bounds: "plev_bnds",
    });
    await write(
      store,
      "plev_bnds",
      [100000, 70000, 70000, 30000],
      [2, 2],
      ["plev", "nv"],
      { units: "Pa" }
    );
    await write(store, "v", [1, 2], [2, 1, 1], ["plev", "lat", "lon"]);
    const ctx = await openCtx(store);
    expect(ctx.vertical?.bounds).toEqual([1000, 700, 700, 300]);
  });

  it("time bounds in an undecodable calendar are dropped, not read as raw hours", async () => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    await write(store, "lat", [0], [1], ["lat"], { units: "degrees_north" });
    await write(store, "lon", [0], [1], ["lon"], { units: "degrees_east" });
    await write(store, "time", [12, 36], [2], ["time"], {
      units: "hours since 2000-01-01",
      calendar: "standard",
      bounds: "time_bnds",
    });
    await write(store, "time_bnds", [0, 1, 1, 2], [2, 2], ["time", "nv"], {
      units: "days since 2000-01-01",
      calendar: "martian_sols",
    });
    await write(store, "v", [1, 2], [2, 1, 1], ["time", "lat", "lon"]);
    const ctx = await openCtx(store);
    expect(ctx.time?.bounds).toBeUndefined();
  });
});

describe("shared axes across descriptions (v9 review)", () => {
  it("six variables described at once read their 12-chunk time axis once", async () => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    await write(store, "lat", [0], [1], ["lat"], { units: "degrees_north" });
    await write(store, "lon", [0], [1], ["lon"], { units: "degrees_east" });
    const time = await zarr.create(zarr.root(store).resolve("time"), {
      shape: [12],
      chunkShape: [1],
      dtype: "float64",
      dimensionNames: ["time"],
      attributes: { units: "days since 2000-01-01" },
    });
    await zarr.set(time as never, null, {
      data: Float64Array.from({ length: 12 }, (_, i) => i),
      shape: [12],
      stride: [1],
    } as never);
    for (let v = 0; v < 6; v++) {
      await write(
        store,
        `v${v}`,
        Array.from({ length: 12 }, () => v),
        [12, 1, 1],
        ["time", "lat", "lon"]
      );
    }
    let timeReads = 0;
    const get = store.get.bind(store);
    store.get = (key: string) => {
      if (/^\/?time\/c/.test(key)) {
        timeReads++;
      }
      return get(key);
    };
    const dataset = zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `axes-${Math.random()}`
    );
    const cache = new ByteLru<BigInt64Array>(2 ** 20);
    const contexts = await Promise.all(
      Array.from({ length: 6 }, (_, v) =>
        resolveVariableContext(dataset, `v${v}`, cache)
      )
    );
    expect(contexts.every((c) => c.time?.raw.length === 12)).toBe(true);
    expect(timeReads).toBe(12);
  });
});
