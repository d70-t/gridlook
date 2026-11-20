/* eslint-disable max-lines-per-function -- each plot builds its own fixture. */
/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
import * as healpixGeo from "healpix-geo";
import { describe, expect, it, vi } from "vitest";
import * as zarr from "zarrita";

import {
  decodeQueriesFromUrl,
  encodeQueriesForUrl,
  resultTable,
  resultToCsv,
} from "@/lib/analysis/analysisExport.ts";
import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import * as countryAtlas from "@/lib/analysis/countryAtlas.ts";
import { percentileAt } from "@/lib/analysis/distributionStats.ts";
import { AnalysisInputError } from "@/lib/analysis/operations.ts";
import { createPartialAssembler } from "@/lib/analysis/partialUpdates.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { exportModel } from "@/lib/analysis/scientificExport.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { binEdges, binOfValue } from "@/lib/analysis/spaceTimeOperations.ts";
import { boxContains } from "@/lib/analysis/sphere.ts";
import {
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  type TAnalysisQuery,
  type TAnalysisResult,
  type TGeometry,
} from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { locateOnAxis, longitudeWeights } from "@/lib/grids/analysisGrid.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;
const NT = 12;
const NK = 3;
const LATS = [-15, -5, 5, 15];
const LONS = [0, 10, 20, 30, 40, 350];
const field = (t: number, k: number, i: number, j: number) =>
  100 * t + 10 * k + i + 0.1 * j;

async function write(
  store: TStore,
  path: string,
  data: number[],
  shape: number[],
  dims: string[],
  attrs: Record<string, unknown> = {},
  chunks?: number[]
) {
  const array = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape: chunks ?? shape,
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

async function rectilinear() {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "lat", LATS, [4], ["lat"], {
    units: "degrees_north",
    bounds: "lat_bnds",
  });
  await write(
    store,
    "lat_bnds",
    LATS.flatMap((v) => [v - 5, v + 5]),
    [4, 2],
    ["lat", "nv"]
  );
  await write(store, "lon", LONS, [6], ["lon"], {
    units: "degrees_east",
    bounds: "lon_bnds",
  });
  await write(
    store,
    "lon_bnds",
    LONS.flatMap((v) => [v - 5, v + 5]),
    [6, 2],
    ["lon", "nv"]
  );
  await write(
    store,
    "time",
    Array.from({ length: NT }, (_, t) => t),
    [NT],
    ["time"],
    {
      units: "days since 2000-01-01",
    }
  );
  await write(store, "depth", [5, 15, 25], [3], ["depth"], {
    units: "m",
    positive: "down",
    standard_name: "depth",
  });
  const data: number[] = [];
  for (let t = 0; t < NT; t++) {
    for (let k = 0; k < NK; k++) {
      for (let i = 0; i < 4; i++) {
        for (let j = 0; j < 6; j++) {
          data.push(
            t === 3 && i === 1 && j === 0 ? Number.NaN : field(t, k, i, j)
          );
        }
      }
    }
  }
  await write(
    store,
    "thetao",
    data,
    [NT, NK, 4, 6],
    ["time", "depth", "lat", "lon"],
    {
      units: "degC",
    },
    [4, NK, 2, 3]
  );
  return resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `st-${Math.random()}`
    ),
    "thetao",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
}

function q(
  kind: TAnalysisQuery["kind"],
  geometry: TGeometry,
  extra: Partial<TAnalysisQuery> = {}
): TAnalysisQuery {
  return {
    version: ALGORITHM_VERSION,
    kind,
    source: { ref: "memory", versionStatus: "session" },
    variable: "thetao",
    geometry,
    fixed: {},
    ...extra,
  };
}

async function run(
  context: Awaited<ReturnType<typeof rectilinear>>,
  query: TAnalysisQuery
) {
  const planned = await planAnalysis(context, query, new ReadContext());
  return planned.execute();
}

const latWeight = (i: number) =>
  Math.sin(((LATS[i] + 5) * Math.PI) / 180) -
  Math.sin(((LATS[i] - 5) * Math.PI) / 180);

describe("time–depth", () => {
  it("a time column equals the profile; a depth row equals the series", async () => {
    const context = await rectilinear();
    expect(context.capabilities[ANALYSIS_KINDS.TIME_DEPTH].available).toBe(
      true
    );
    const point = { kind: "point" as const, lat: 5, lon: 20 };
    const grid = await run(context, q(ANALYSIS_KINDS.TIME_DEPTH, point));
    expect(grid.shape).toEqual([NT, NK]);
    expect(grid.axis!.values).toEqual([5, 15, 25]);
    const profile = await run(
      context,
      q(ANALYSIS_KINDS.PROFILE, point, { time: { start: 7, stop: 8 } })
    );
    expect(grid.values.slice(7 * NK, 8 * NK)).toEqual(profile.values);
    const series = await run(
      context,
      q(ANALYSIS_KINDS.POINT_SERIES, point, { level: 2 })
    );
    expect(
      Array.from({ length: NT }, (_, t) => grid.values[t * NK + 2])
    ).toEqual(series.values);
    expect(resultToCsv(grid).trim().split("\n")).toHaveLength(NT * NK + 1);
  });

  it("streams rows of levels in time order", async () => {
    const context = await rectilinear();
    const shown: TAnalysisResult[] = [];
    const planned = await planAnalysis(
      context,
      q(ANALYSIS_KINDS.TIME_DEPTH, { kind: "point", lat: 5, lon: 20 }),
      new ReadContext()
    );
    const final = await planned.execute(undefined, {
      onPartial: createPartialAssembler((partial) =>
        shown.push({ ...partial, values: partial.values.slice() })
      ),
    });
    // The empty frame, then the first two of three parts.
    expect(shown.length).toBe(3);
    expect(shown[0].partial!.readUntil).toBe(0);
    const until = shown[1].partial!.readUntil * NK;
    expect(shown[1].values.slice(0, until)).toEqual(
      final.values.slice(0, until)
    );
    expect(shown[1].values.slice(until).every(Number.isNaN)).toBe(true);
  });
});

describe("Hovmöller", () => {
  it("longitude × time: area-weighted latitude-band means, west to east across 0°", async () => {
    const context = await rectilinear();
    const band = {
      kind: "box" as const,
      west: 345,
      east: 25,
      south: -10,
      north: 10,
    };
    const result = await run(
      context,
      q(ANALYSIS_KINDS.HOVMOLLER_LON, band, { level: 1 })
    );
    // Columns 350°, 0°, 10°, 20° in that order; rows −5° and 5° (equal weights).
    expect(result.axis!.values).toEqual([350, 360, 370, 380]);
    expect(result.shape).toEqual([NT, 4]);
    const mean = (t: number, j: number) => {
      const rows = [1, 2];
      const valid = rows.filter((i) => !(t === 3 && i === 1 && j === 0));
      const w = valid.reduce((s, i) => s + latWeight(i), 0);
      return (
        valid.reduce((s, i) => s + latWeight(i) * field(t, 1, i, j), 0) / w
      );
    };
    const cols = [5, 0, 1, 2];
    for (const t of [0, 3, 11]) {
      cols.forEach((j, bin) => {
        expect(result.values[t * 4 + bin]).toBeCloseTo(mean(t, j), 9);
      });
    }
    // A masked cell halves the valid area of its bin at that time.
    expect(result.cellCoverage![3 * 4 + 1]).toBeCloseTo(0.5, 9);
    expect(result.axis!.reduction).toMatch(/mean over 10.0° S–10.0° N/);
  });

  it("latitude × time: sector means at each latitude", async () => {
    const context = await rectilinear();
    const sector = {
      kind: "box" as const,
      west: 5,
      east: 25,
      south: -20,
      north: 20,
    };
    const result = await run(
      context,
      q(ANALYSIS_KINDS.HOVMOLLER_LAT, sector, { level: 0 })
    );
    expect(result.axis!.values).toEqual(LATS);
    // Columns 10° and 20° have equal widths: plain mean.
    expect(result.values[2 * 4 + 3]).toBeCloseTo(
      (field(2, 0, 3, 1) + field(2, 0, 3, 2)) / 2,
      9
    );
  });

  it("distance × time: one date reproduces the path plot", async () => {
    const context = await rectilinear();
    const path = {
      kind: "polyline" as const,
      vertices: [
        { lat: -15, lon: 0 },
        { lat: 15, lon: 30 },
      ],
    };
    const hov = await run(
      context,
      q(ANALYSIS_KINDS.HOVMOLLER_PATH, path, { level: 2, sectionSamples: 9 })
    );
    const ns = hov.axis!.values.length;
    expect(hov.shape).toEqual([NT, ns]);
    const section = await run(
      context,
      q(ANALYSIS_KINDS.SECTION, path, {
        time: { start: 5, stop: 6 },
        sectionSamples: 9,
      })
    );
    const curtain = section.values.filter((_, at) => at % NK === 2);
    expect(hov.values.slice(5 * ns, 6 * ns)).toEqual(curtain);
    expect(hov.axis!.values).toEqual(section.samples!.distances);
  });

  it("HEALPix bins by centre longitude, equal areas, matching brute force", async () => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    const order = 3;
    const n = 12 * 4 ** order;
    await write(store, "crs", [0], [1], ["one"], {
      grid_mapping_name: "healpix",
      healpix_nside: 2 ** order,
      healpix_order: "nest",
    });
    await write(store, "time", [0, 1], [2], ["time"], {
      units: "days since 2000-01-01",
    });
    const grid = new healpixGeo.Grid({ scheme: "nested", level: order });
    const centres = grid.healpixToLonLat(
      BigUint64Array.from({ length: n }, (_, at) => BigInt(at))
    );
    const value = (t: number, cell: number) => t * 1000 + centres[2 * cell];
    await write(
      store,
      "tos",
      Array.from({ length: 2 * n }, (_, at) =>
        value(Math.floor(at / n), at % n)
      ),
      [2, n],
      ["time", "cell"],
      { grid_mapping: "crs" }
    );
    const context = await resolveVariableContext(
      zarrAnalysisDatasetFromStore(
        store as never,
        "",
        ZARR_FORMAT.V3,
        "hp-hov"
      ),
      "tos",
      new ByteLru<BigInt64Array>(2 ** 20)
    );
    const band = {
      kind: "box" as const,
      west: 0,
      east: 90,
      south: -20,
      north: 20,
    };
    const planned = await planAnalysis(
      context,
      {
        ...q(ANALYSIS_KINDS.HOVMOLLER_LON, band, { binDegrees: 15 }),
        variable: "tos",
      },
      new ReadContext()
    );
    const result = await planned.execute();
    expect(result.axis!.values).toEqual([7.5, 22.5, 37.5, 52.5, 67.5, 82.5]);
    for (let bin = 0; bin < 6; bin++) {
      const members: number[] = [];
      for (let cell = 0; cell < n; cell++) {
        const lonC = centres[2 * cell];
        if (
          boxContains(band, centres[2 * cell + 1], lonC) &&
          Math.min(5, Math.floor(lonC / 15)) === bin
        ) {
          members.push(cell);
        }
      }
      const expected =
        members.reduce((s, c) => s + value(1, c), 0) / members.length;
      expect(result.values[6 + bin]).toBeCloseTo(expected, 9);
    }
    grid.free();
  });
});

describe("country plots", () => {
  it("explains both plot types when a country has no cell centre on this grid", async () => {
    const context = await rectilinear();
    const germany = { kind: "country", id: "276", resolution: "110m" } as const;
    for (const kind of [
      ANALYSIS_KINDS.REGION_SERIES,
      ANALYSIS_KINDS.DISTRIBUTION,
    ]) {
      const result = await run(context, q(kind, germany));
      expect(result.values.every(Number.isNaN)).toBe(true);
      expect(result.notes.join(" ")).toMatch(
        /No grid cell centre falls inside this country/
      );
    }
  });

  it("reuses the mask between series and distribution but honors time, level and resolution", async () => {
    const context = await rectilinear();
    const square = (x: number) => [
      [x - 1, 4],
      [x + 1, 4],
      [x + 1, 6],
      [x - 1, 6],
      [x - 1, 4],
    ];
    const rings = vi
      .spyOn(countryAtlas, "getCountryRings")
      .mockImplementation(async (_id, res) =>
        res === "50m" ? [[square(10)], [square(30)]] : [[square(30)]]
      );
    const geometry = {
      kind: "country",
      id: "test",
      resolution: "50m",
    } as const;
    try {
      const series = await run(
        context,
        q(ANALYSIS_KINDS.REGION_SERIES, geometry, {
          time: { start: 0, stop: 2 },
          level: 0,
        })
      );
      expect(series.values[0]).toBeCloseTo(
        (field(0, 0, 2, 1) + field(0, 0, 2, 3)) / 2
      );
      expect(series.values[1]).toBeCloseTo(
        (field(1, 0, 2, 1) + field(1, 0, 2, 3)) / 2
      );
      const later = { time: { start: 5, stop: 6 }, level: 2 };
      const dist = await run(
        context,
        q(ANALYSIS_KINDS.DISTRIBUTION, geometry, later)
      );
      expect(dist.histogram!.mean).toBeCloseTo(
        (field(5, 2, 2, 1) + field(5, 2, 2, 3)) / 2
      );
      expect(dist.histogram!.selectedCells).toBe(2);
      expect(rings).toHaveBeenCalledTimes(1);
      const fine = await run(
        context,
        q(
          ANALYSIS_KINDS.DISTRIBUTION,
          { ...geometry, resolution: "10m" },
          later
        )
      );
      expect(fine.histogram!.selectedCells).toBe(1);
      expect(fine.histogram!.mean).toBeCloseTo(field(5, 2, 2, 3));
      expect(rings).toHaveBeenCalledTimes(2);
    } finally {
      rings.mockRestore();
    }
  });
});

describe("distribution", () => {
  it("shares of valid area by value; the mean equals the area mean", async () => {
    const context = await rectilinear();
    const box = {
      kind: "box" as const,
      west: -5,
      east: 45,
      south: -20,
      north: 20,
    };
    const result = await run(
      context,
      q(ANALYSIS_KINDS.DISTRIBUTION, box, {
        level: 1,
        time: { start: 3, stop: 4 },
        valueBins: 10,
      })
    );
    const shares = result.values;
    expect(shares.reduce((s, v) => s + v, 0)).toBeCloseTo(1, 12);
    const h = result.histogram!;
    expect(h.edges.length).toBe(shares.length + 1);
    // One masked cell of 20 selected cells (5 columns × 4 rows).
    expect(h.selectedCells).toBe(20);
    expect(h.validCells).toBe(19);
    const area = await run(
      context,
      q(ANALYSIS_KINDS.REGION_SERIES, box, {
        level: 1,
        time: { start: 3, stop: 4 },
      })
    );
    expect(h.mean).toBeCloseTo(area.values[0], 9);
    expect(h.validFraction).toBeCloseTo(area.region!.coverage[0], 9);
    // The summary: percentiles in order within the range, a curve over it.
    const summary = h.summary!;
    const [p2, p25, p50, p75, p97] = [2.5, 25, 50, 75, 97.5].map((p) =>
      percentileAt(summary.percentiles, p)
    );
    expect(p2).toBeGreaterThanOrEqual(h.edges[0]);
    expect(p2 <= p25 && p25 <= p50 && p50 <= p75 && p75 <= p97).toBe(true);
    expect(p97).toBeLessThanOrEqual(h.edges[h.edges.length - 1]);
    expect(summary.std).toBeGreaterThan(0);
    expect(summary.density!.x[0]).toBe(h.edges[0]);
    // Its cells for a map: every selected cell at its centre, the masked
    // one missing, inside the box.
    const field = result.field!;
    expect(field.values).toHaveLength(20);
    expect(field.values.filter(Number.isNaN)).toHaveLength(1);
    expect(field.lat.every((lat) => lat >= -20 && lat <= 20)).toBe(true);
    expect(
      field.lon.every(
        (lon) =>
          ((lon + 540) % 360) - 180 >= -5 && ((lon + 540) % 360) - 180 <= 45
      )
    ).toBe(true);
  });
});

describe("shared links", () => {
  it("reopen every space–time plot and refuse bad parameters", () => {
    const box: TGeometry = {
      kind: "box",
      west: 170,
      east: -170,
      south: -5,
      north: 5,
    };
    const path: TGeometry = {
      kind: "polyline",
      vertices: [
        { lat: 0, lon: 0 },
        { lat: 1, lon: 1 },
      ],
    };
    const point: TGeometry = { kind: "point", lat: 1, lon: 2 };
    const queries = [
      q(ANALYSIS_KINDS.TIME_DEPTH, point),
      q(ANALYSIS_KINDS.HOVMOLLER_LON, box, { binDegrees: 2.5 }),
      q(ANALYSIS_KINDS.HOVMOLLER_LAT, box),
      q(ANALYSIS_KINDS.HOVMOLLER_PATH, path, { sectionSamples: 64 }),
      q(ANALYSIS_KINDS.DISTRIBUTION, box, { valueBins: 40 }),
    ];
    const restored = decodeQueriesFromUrl(encodeQueriesForUrl(queries)!);
    expect(restored.map((query) => query.kind)).toEqual(
      queries.map((query) => query.kind)
    );
    expect(restored[1].binDegrees).toBe(2.5);
    expect(restored[4].valueBins).toBe(40);
    const bad = [
      q(ANALYSIS_KINDS.HOVMOLLER_LON, point),
      q(ANALYSIS_KINDS.HOVMOLLER_LAT, box, { binDegrees: -1 }),
      q(ANALYSIS_KINDS.DISTRIBUTION, box, { valueBins: 5000 }),
    ];
    expect(decodeQueriesFromUrl(encodeQueriesForUrl(bad)!)).toEqual([]);
  });

  it("keeps a valid plot beside one restored with time: null (v8 review)", () => {
    const point: TGeometry = { kind: "point", lat: 0, lon: 0 };
    const good = q(ANALYSIS_KINDS.POINT_SERIES, point);
    const broken = {
      ...q(ANALYSIS_KINDS.POINT_SERIES, point),
      time: null,
      fixed: null,
    } as unknown as TAnalysisQuery;
    const restored = decodeQueriesFromUrl(encodeQueriesForUrl([good, broken])!);
    expect(restored).toHaveLength(1);
    expect(restored[0].kind).toBe(ANALYSIS_KINDS.POINT_SERIES);
  });
});

describe("latitude–pressure section", () => {
  it("averages the sector at each latitude and level, at one date", async () => {
    const context = await rectilinear();
    expect(context.capabilities[ANALYSIS_KINDS.LAT_VERTICAL].available).toBe(
      true
    );
    const box: TGeometry = {
      kind: "box",
      west: -5,
      east: 35,
      south: -20,
      north: 20,
    };
    const result = await run(
      context,
      q(ANALYSIS_KINDS.LAT_VERTICAL, box, { time: { start: 2, stop: 3 } })
    );
    expect(result.shape).toEqual([4, NK]);
    expect(result.axis!.values).toEqual(LATS);
    expect(result.axis!.bounds).toEqual([-20, -10, 0, 10, 20]);
    expect(result.vertical!.values).toEqual([5, 15, 25]);
    expect(result.vertical!.positive).toBe("down");
    expect(result.time!.raw).toEqual([2]);
    for (let i = 0; i < 4; i++) {
      for (let k = 0; k < NK; k++) {
        // Mean of 0.1 j over the four columns inside the sector: 0.15.
        expect(result.values[i * NK + k]).toBeCloseTo(
          field(2, k, i, 0) + 0.15,
          10
        );
      }
    }
    const model = exportModel(result);
    expect(model.dims.map(([d]) => d)).toEqual(["lat", "depth", "nv"]);
    expect(model.arrays.find((a) => a.name === "lat_bnds")!.data.length).toBe(
      8
    );
    expect(resultTable(result).rowCount).toBe(4 * NK);
  });

  it("is refused for a variable without levels, with a reason", async () => {
    const context = await rectilinear();
    const flat = { ...context, vertical: undefined };
    await expect(
      planAnalysis(
        flat as never,
        q(ANALYSIS_KINDS.LAT_VERTICAL, {
          kind: "box",
          west: 0,
          east: 10,
          south: 0,
          north: 10,
        }),
        new ReadContext()
      )
    ).rejects.toThrow(/no vertical dimension/);
  });
});

describe("longitude–depth section", () => {
  it("averages the band at each longitude and level, at one date", async () => {
    const context = await rectilinear();
    expect(context.capabilities[ANALYSIS_KINDS.LON_VERTICAL].available).toBe(
      true
    );
    const box: TGeometry = {
      kind: "box",
      west: -5,
      east: 35,
      south: -20,
      north: 20,
    };
    const result = await run(
      context,
      q(ANALYSIS_KINDS.LON_VERTICAL, box, { time: { start: 2, stop: 3 } })
    );
    expect(result.axis!.dimension).toBe("longitude");
    expect(result.axis!.units).toBe("degrees_east");
    const nb = result.axis!.values.length;
    expect(result.shape).toEqual([nb, NK]);
    // Each longitude bin holds one column j; latitudes average to i = 1.5
    // (symmetric about the equator, so the area weights cancel).
    let compared = 0;
    for (let b = 0; b < nb; b++) {
      const j = LONS.indexOf(result.axis!.values[b]);
      if (j < 0) {
        continue;
      }
      compared++;
      for (let k = 0; k < NK; k++) {
        expect(result.values[b * NK + k]).toBeCloseTo(
          field(2, k, 0, j) + 1.5,
          10
        );
      }
    }
    expect(compared).toBe(4);
    const model = exportModel(result);
    expect(model.dims.map(([d]) => d)).toEqual(["lon", "depth", "nv"]);
    const values = model.arrays.find((a) => a.name === "thetao")!;
    expect(values.attrs.cell_methods).toBe("latitude: mean (area-weighted)");
    expect(resultTable(result).header.slice(0, 2)).toEqual([
      "lon_bin",
      "lon (degrees_east)",
    ]);
  });
});

describe("sparse bin reductions (v7 review)", () => {
  async function wide(nt: number, nlon: number, chunks: number[]) {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    const lon = Array.from(
      { length: nlon },
      (_, j) => (j + 0.5) * (360 / nlon)
    );
    await write(store, "lat", [0], [1], ["lat"], {
      units: "degrees_north",
      bounds: "lat_bnds",
    });
    await write(store, "lat_bnds", [-1, 1], [1, 2], ["lat", "nv"]);
    await write(store, "lon", lon, [nlon], ["lon"], {
      units: "degrees_east",
      bounds: "lon_bnds",
    });
    await write(
      store,
      "lon_bnds",
      lon.flatMap((v) => [v - 180 / nlon, v + 180 / nlon]),
      [nlon, 2],
      ["lon", "nv"]
    );
    await write(
      store,
      "time",
      Array.from({ length: nt }, (_, t) => t),
      [nt],
      ["time"],
      { units: "days since 2000-01-01" }
    );
    await write(
      store,
      "thetao",
      Array.from({ length: nt * nlon }, (_, at) => at % nlon),
      [nt, 1, nlon],
      ["time", "lat", "lon"],
      {},
      chunks
    );
    return resolveVariableContext(
      zarrAnalysisDatasetFromStore(
        store as never,
        "",
        ZARR_FORMAT.V3,
        `sparse-${Math.random()}`
      ),
      "thetao",
      new ByteLru<BigInt64Array>(2 ** 20)
    );
  }
  const band: TGeometry = {
    kind: "box",
    west: 0,
    east: 360,
    south: -1,
    north: 1,
  };

  it("one cell per chunk: work and memory follow the touched bins", async () => {
    const context = await wide(2, 4096, [1, 1, 1]);
    const planned = await planAnalysis(
      context,
      q(ANALYSIS_KINDS.HOVMOLLER_LON, band),
      new ReadContext()
    );
    expect(planned.estimate.workingBytes).toBeLessThan(64 * 2 ** 20);
    const started = performance.now();
    const result = await planned.execute();
    expect(performance.now() - started).toBeLessThan(3000);
    expect(result.values.slice(0, 4)).toEqual([0, 1, 2, 3]);
    expect(result.values[2 * 4096 - 1]).toBe(4095);
  });

  it("admits 600 times × 1,024 columns stored one column per chunk", async () => {
    const context = await wide(600, 1024, [600, 1, 1]);
    const planned = await planAnalysis(
      context,
      q(ANALYSIS_KINDS.HOVMOLLER_LON, band, { time: { start: 0, stop: 600 } }),
      new ReadContext()
    );
    expect(planned.estimate.workingBytes).toBeLessThan(128 * 2 ** 20);
  });
});

describe("long time axes stream without formatting them first", () => {
  it("a 200,000-date series sends one base and starts reading at once", async () => {
    const nt = 200_000;
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    await write(store, "lat", [0], [1], ["lat"], { units: "degrees_north" });
    await write(store, "lon", [0], [1], ["lon"], { units: "degrees_east" });
    await write(
      store,
      "time",
      Array.from({ length: nt }, (_, t) => t),
      [nt],
      ["time"],
      { units: "hours since 2000-01-01", calendar: "standard" }
    );
    await write(
      store,
      "thetao",
      Array.from({ length: nt }, (_, t) => t % 7),
      [nt, 1, 1],
      ["time", "lat", "lon"],
      {},
      [10_000, 1, 1]
    );
    const context = await resolveVariableContext(
      zarrAnalysisDatasetFromStore(
        store as never,
        "",
        ZARR_FORMAT.V3,
        `long-${Math.random()}`
      ),
      "thetao",
      new ByteLru<BigInt64Array>(2 ** 20)
    );
    const planned = await planAnalysis(
      context,
      q(
        ANALYSIS_KINDS.POINT_SERIES,
        { kind: "point", lat: 0, lon: 0 },
        {
          time: { start: 0, stop: nt },
        }
      ),
      new ReadContext()
    );
    let bases = 0;
    let firstDelta = -1;
    const started = performance.now();
    let firstUpdate = -1;
    const result = await planned.execute(undefined, {
      onPartial: (update) => {
        if (firstUpdate < 0) {
          firstUpdate = performance.now() - started;
        }
        if (update.base) {
          bases++;
        } else if (firstDelta < 0) {
          firstDelta = update.offset;
        }
      },
    });
    expect(bases).toBe(1);
    expect(firstDelta).toBe(0);
    expect(firstUpdate).toBeLessThan(150);
    expect(result.time!).not.toHaveProperty("labels");
    expect(result.values[nt - 1]).toBe((nt - 1) % 7);
  });
});

describe("oversampled paths (v6 review)", () => {
  it("plans 20,000 samples inside one cell in linear time", async () => {
    const context = await rectilinear();
    const path: TGeometry = {
      kind: "polyline",
      vertices: [
        { lat: 1, lon: 1 },
        { lat: 1.5, lon: 1.5 },
      ],
    };
    const started = performance.now();
    const planned = await planAnalysis(
      context,
      q(ANALYSIS_KINDS.HOVMOLLER_PATH, path, {
        level: 0,
        sectionSamples: 20_000,
      }),
      new ReadContext()
    );
    expect(performance.now() - started).toBeLessThan(400);
    const result = await planned.execute();
    expect(result.shape).toEqual([NT, 20_000]);
    // Every sample of the one cell carries its value at every time.
    expect(result.values[0]).toBe(result.values[19_999]);
    expect(result.values.filter(Number.isNaN).length).toBe(0);
  });
});

describe("bounded bins (v6 review P0)", () => {
  it("terminates on adjacent Float64 values and keeps the maximum in the last bin", () => {
    const low = 1e9;
    const high = 1e9 + 2 ** -23;
    const edges = binEdges(low, high, 30);
    expect(edges.length).toBeGreaterThanOrEqual(2);
    expect(edges.length).toBeLessThanOrEqual(31);
    edges.forEach((e, i) => i && expect(e).toBeGreaterThan(edges[i - 1]));
    expect(binOfValue(edges, high)).toBe(edges.length - 2);
    expect(binOfValue(edges, low)).toBe(0);
    for (const [a, b] of [
      [5, 5],
      [0, 0],
      [-3, 2],
      [Number.MIN_VALUE, 4 * Number.MIN_VALUE],
      [-1e300, 1e300],
    ]) {
      const e = binEdges(a, b, 30);
      expect(e.length).toBeLessThanOrEqual(32);
      e.forEach((x, i) => i && expect(x).toBeGreaterThan(e[i - 1]));
      expect(binOfValue(e, b)).toBe(e.length - 2);
      expect(e[0]).toBeLessThanOrEqual(a);
    }
  });

  it("refuses a tiny bin width before allocating", async () => {
    const context = await rectilinear();
    const started = performance.now();
    await expect(
      planAnalysis(
        context,
        q(
          ANALYSIS_KINDS.HOVMOLLER_LON,
          { kind: "box", west: 0, east: 20, south: -10, north: 10 },
          { binDegrees: 1e-7 }
        ),
        new ReadContext()
      )
    ).rejects.toThrow(AnalysisInputError);
    expect(performance.now() - started).toBeLessThan(200);
  });

  it("clips bins to the box and honours the width on a regular grid", async () => {
    const context = await rectilinear();
    const sector = await run(
      context,
      q(
        ANALYSIS_KINDS.HOVMOLLER_LAT,
        { kind: "box", west: 0, east: 40, south: 10, north: 20 },
        { binDegrees: 40, level: 0 }
      )
    );
    expect(sector.axis!.values).toEqual([15]);
    expect(sector.axis!.bounds).toEqual([10, 20]);
    const box = {
      kind: "box" as const,
      west: 0,
      east: 40,
      south: -20,
      north: 20,
    };
    const fine = await run(
      context,
      q(ANALYSIS_KINDS.HOVMOLLER_LON, box, { binDegrees: 1, level: 0 })
    );
    const coarse = await run(
      context,
      q(ANALYSIS_KINDS.HOVMOLLER_LON, box, { binDegrees: 20, level: 0 })
    );
    expect(fine.axis!.values).toHaveLength(40);
    expect(coarse.axis!.values).toEqual([10, 30]);
    // A zero-width box is refused; ±180 is the whole circle.
    await expect(
      planAnalysis(
        context,
        q(ANALYSIS_KINDS.HOVMOLLER_LON, {
          kind: "box",
          west: 20,
          east: 20,
          south: -20,
          north: 20,
        }),
        new ReadContext()
      )
    ).rejects.toThrow(AnalysisInputError);
    const all = await run(
      context,
      q(
        ANALYSIS_KINDS.HOVMOLLER_LON,
        { kind: "box", west: -180, east: 180, south: -20, north: 20 },
        { level: 0 }
      )
    );
    expect(all.axis!.values).toHaveLength(6);
  });
});

describe("histogram edges (v7 review)", () => {
  it("never exceed the requested bins and stay finite", () => {
    for (const [low, high] of [
      [0, 10],
      [0, 200],
      [-1, 1],
      [0.1, 0.30000000000000004],
      [1e-9, 1],
      [-Number.MAX_VALUE, Number.MAX_VALUE],
    ]) {
      for (const n of [1, 2, 7, 10, 30, 200]) {
        const edges = binEdges(low, high, n);
        expect(edges.length - 1).toBeLessThanOrEqual(n);
        expect(edges.every(Number.isFinite)).toBe(true);
        expect(edges[0]).toBeLessThanOrEqual(low);
        expect(edges[edges.length - 1]).toBeGreaterThanOrEqual(high);
        expect(binOfValue(edges, high)).toBe(edges.length - 2);
      }
    }
    for (const value of [Number.MAX_VALUE, -Number.MAX_VALUE]) {
      const edges = binEdges(value, value, 30);
      expect(edges.every(Number.isFinite)).toBe(true);
      expect(binOfValue(edges, value)).toBe(0);
    }
  });
});

describe("fractional time indices (v7 review)", () => {
  it("are refused on restore and by the planner, before any read", async () => {
    const box: TGeometry = {
      kind: "box",
      west: 0,
      east: 30,
      south: -20,
      north: 20,
    };
    for (const time of [
      { start: 0.5, stop: 1.5 },
      { start: 0, stop: 1.5 },
      { start: 2, stop: 1 },
      { start: -1, stop: 1 },
    ]) {
      const query = q(ANALYSIS_KINDS.LAT_VERTICAL, box, { time });
      expect(decodeQueriesFromUrl(encodeQueriesForUrl([query])!)).toEqual([]);
      await expect(
        planAnalysis(await rectilinear(), query, new ReadContext())
      ).rejects.toThrow(/time range/);
    }
  });
});

describe("bins stay on the grid's own cells (v7 review)", () => {
  it("a box wider than a regional grid gives bins only where cells are", async () => {
    const context = await rectilinear();
    const wide: TGeometry = {
      kind: "box",
      west: -5,
      east: 35,
      south: -70,
      north: 70,
    };
    const native = await run(context, q(ANALYSIS_KINDS.HOVMOLLER_LAT, wide));
    expect(native.axis!.bounds).toEqual([-20, -10, 0, 10, 20]);
    const binned = await run(
      context,
      q(ANALYSIS_KINDS.HOVMOLLER_LAT, wide, { binDegrees: 20 })
    );
    expect(binned.axis!.bounds).toEqual([-20, -10, 10, 20]);
    expect(binned.axis!.values).toEqual([-15, 0, 15]);
    const section = await run(
      context,
      q(ANALYSIS_KINDS.LAT_VERTICAL, wide, { time: { start: 0, stop: 1 } })
    );
    expect(section.axis!.bounds).toEqual([-20, -10, 0, 10, 20]);
  });

  it("a full-circle longitude cell keeps its width", () => {
    const lon = {
      values: Float64Array.from([180]),
      bounds: Float64Array.from([0, 360]),
      periodic: true,
      longitude: true,
    };
    expect(longitudeWeights(lon)![0]).toBeCloseTo(2 * Math.PI, 12);
    expect(locateOnAxis(lon, 10).index).toBe(0);
  });
});

describe("performance review of interim30: earlier dates read from their end", () => {
  const point = { kind: "point" as const, lat: 5, lon: 20 };
  const box = {
    kind: "box" as const,
    west: 0,
    east: 30,
    south: -10,
    north: 10,
  };
  for (const [kind, geometry, width] of [
    [ANALYSIS_KINDS.TIME_DEPTH, point, NK],
    [ANALYSIS_KINDS.POINT_SERIES, point, 1],
    [ANALYSIS_KINDS.REGION_SERIES, box, 1],
  ] as const) {
    it(`${kind}: the last part first, and the same result`, async () => {
      const context = await rectilinear();
      const extra = kind === ANALYSIS_KINDS.TIME_DEPTH ? {} : { level: 1 };
      const forward = await run(
        context,
        q(kind, geometry, { ...extra, time: { start: 0, stop: NT } })
      );
      const shown: TAnalysisResult[] = [];
      const planned = await planAnalysis(
        context,
        q(kind, geometry, {
          ...extra,
          time: { start: 0, stop: NT, fromEnd: true },
        }),
        new ReadContext()
      );
      const final = await planned.execute(undefined, {
        onPartial: createPartialAssembler((partial) =>
          shown.push({ ...partial, values: partial.values.slice() })
        ),
      });
      expect(final.values).toEqual(forward.values);
      // The empty frame, then the last part, then the last two.
      expect(shown.map((s) => s.partial!.readFrom)).toEqual([12, 8, 4]);
      const from = 8 * width;
      expect(shown[1].values.slice(from)).toEqual(forward.values.slice(from));
      expect(shown[1].values.slice(0, from).every(Number.isNaN)).toBe(true);
      expect(shown[1].values).toHaveLength(NT * width);
    });
  }
});

it("keeps the two known pressure rows visible in a time-depth plot with one missing hybrid coefficient", async () => {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "lat", [0], [1], ["lat"], { units: "degrees_north" });
  await write(store, "lon", [0], [1], ["lon"], { units: "degrees_east" });
  await write(store, "time", [0, 1], [2], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(store, "lev", [1, 2, 3], [3], ["lev"], {
    standard_name: "atmosphere_hybrid_sigma_pressure_coordinate",
    formula_terms: "ap: ap b: b ps: ps",
    positive: "down",
    units: "1",
    axis: "Z",
  });
  await write(store, "ap", [100000, NaN, 70000], [3], ["lev"], { units: "Pa" });
  await write(store, "b", [0, 0, 0], [3], ["lev"], { units: "1" });
  await write(store, "ps", [100000], [1, 1], ["lat", "lon"], { units: "Pa" });
  await write(
    store,
    "ta",
    [281, 270, 260, 282, 271, 261],
    [2, 3, 1, 1],
    ["time", "lev", "lat", "lon"],
    { units: "K" }
  );
  const context = await resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      "review36-hybrid-gap"
    ),
    "ta",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
  const result = await run(
    context,
    q(
      ANALYSIS_KINDS.TIME_DEPTH,
      { kind: "point", lat: 0, lon: 0 },
      { variable: "ta" }
    )
  );
  expect(result.values).toEqual([281, 270, 260, 282, 271, 261]);
  const table = resultTable(result);
  expect([table.row(0)[3], table.row(2)[3]]).toEqual([100000, 70000]);
  const { heatmapSpec } = await import("@/ui/analysis/plotFigure.ts");
  const { axisCells, extent } = await import("@/ui/analysis/heatmapRaster.ts");
  const heat = heatmapSpec(result)!;
  const cells = axisCells(heat.axis.values, heat.axis.bounds);
  const scale = extent(cells);
  expect(scale.low).toBeLessThanOrEqual(70000);
  expect(scale.high).toBeGreaterThanOrEqual(100000);
  for (const row of [0, 2]) {
    expect(cells.lo[row]).toBeLessThanOrEqual(heat.axis.values[row]);
    expect(cells.hi[row]).toBeGreaterThanOrEqual(heat.axis.values[row]);
  }
});

it("interim48: a 270° source column centred at 45° keeps its bin in a longitude Hovmöller", async () => {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "lat", [-10, 10], [2], ["lat"], {
    units: "degrees_north",
    bounds: "lat_bnds",
  });
  await write(store, "lat_bnds", [-20, 0, 0, 20], [2, 2], ["lat", "nv"]);
  await write(store, "lon", [45, 315], [2], ["lon"], {
    units: "degrees_east",
    bounds: "lon_bnds",
  });
  await write(store, "lon_bnds", [0, 270, 270, 360], [2, 2], ["lon", "nv"]);
  await write(store, "time", [0, 1], [2], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(
    store,
    "ta",
    [100, 0, 100, 0, 100, 0, 100, 0],
    [2, 2, 2],
    ["time", "lat", "lon"],
    { units: "K" }
  );
  const context = await resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `st270-${Math.random()}`
    ),
    "ta",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
  const result = await run(context, {
    ...q(ANALYSIS_KINDS.HOVMOLLER_LON, {
      kind: "box",
      south: -20,
      north: 20,
      west: 0,
      east: 360,
    }),
    variable: "ta",
    time: { start: 0, stop: 2 },
  });
  expect(result.values).toEqual([100, 0, 100, 0]);
  expect(result.axis?.bounds).toEqual([0, 270, 360]);
});
