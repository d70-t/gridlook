/* eslint-disable camelcase -- CF and Zarr metadata use snake_case keys. */
import * as healpixGeo from "healpix-geo";
import { beforeAll, describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { timeLabelAt } from "@/lib/analysis/calendar.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { getCountryRings } from "@/lib/analysis/countryAtlas.ts";
import {
  countryContains,
  prepareCountry,
} from "@/lib/analysis/countryRegion.ts";
import { createPartialAssembler } from "@/lib/analysis/partialUpdates.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import {
  zarrAnalysisDatasetFromStore,
  type TAnalysisDataset,
} from "@/lib/analysis/sourceAdapter.ts";
import {
  ANALYSIS_KINDS,
  type TAnalysisQuery,
  type TGeometry,
  type TPartialUpdate,
} from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

// Synthetic reference data: value(t, k, cell) = 1000 t + 10 k + (cell mod 97),
// with explicit missing cells. Expected answers below are computed directly
// from this formula and from healpix-geo cell centres, not by the code under
// test.
const ORDER = 3;
const NCELL = 12 * 4 ** ORDER;
const NT = 6;
const NK = 3;
const FILL = -9999;
const grid = new healpixGeo.Grid({ scheme: "nested", level: ORDER });
const centres = grid.healpixToLonLat(
  new BigUint64Array(NCELL).map((_, at) => BigInt(at))
);

const isMissing = (t: number, cell: number) => t === 2 && cell % 13 === 0;
const value = (t: number, k: number, cell: number) =>
  1000 * t + 10 * k + (cell % 97);
const stored = (cell: number) => cell % 7 !== 3; // packed layout keeps these
const PACKED = Array.from({ length: NCELL }, (_, at) => at).filter(stored);

type TStore = Map<string, Uint8Array>;

async function array(
  store: TStore,
  path: string,
  shape: number[],
  chunks: number[],
  dims: string[],
  attrs: Record<string, unknown>,
  dtype: zarr.DataType = "float64"
) {
  return zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape: chunks,
    dtype,
    dimensionNames: dims,
    attributes: attrs,
    fillValue: (dtype === "int64" || dtype === "int8"
      ? 0
      : Number.NaN) as never,
  });
}

async function writeField(
  target: zarr.Array<zarr.DataType, TStore>,
  cells: number[]
) {
  const data = new Float64Array(NT * NK * cells.length);
  let at = 0;
  for (let t = 0; t < NT; t++) {
    for (let k = 0; k < NK; k++) {
      for (const cell of cells) {
        data[at++] = isMissing(t, cell) ? FILL : value(t, k, cell);
      }
    }
  }
  await zarr.set(target as never, null, {
    data,
    shape: [NT, NK, cells.length],
    stride: [NK * cells.length, cells.length, 1],
  } as never);
}

// eslint-disable-next-line max-lines-per-function
async function buildStore() {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  for (const [group, calendar] of [
    ["dense", "noleap"],
    ["packed", "360_day"],
    ["sigma", "standard"],
  ] as const) {
    const attrs =
      group === "packed"
        ? {
            dggs: {
              name: "healpix",
              refinement_level: ORDER,
              indexing_scheme: "nested",
              coordinate: "cell_ids",
              spatial_dimension: "cell",
            },
          }
        : {};
    await zarr.create(zarr.root(store).resolve(group), { attributes: attrs });
    const time = await array(store, `${group}/time`, [NT], [NT], ["time"], {
      units: "days since 2000-01-01",
      calendar,
      standard_name: "time",
    });
    await zarr.set(time as never, null, {
      data: Float64Array.from([0, 31, 59, 90, 120, 151]),
      shape: [NT],
      stride: [1],
    } as never);
    if (group !== "packed") {
      const crs = await array(
        store,
        `${group}/crs`,
        [],
        [],
        [],
        {
          grid_mapping_name: "healpix",
          healpix_nside: 2 ** ORDER,
          healpix_order: "nest",
        },
        "int8"
      );
      void crs;
    }
  }
  const depth = await array(store, "dense/depth", [NK], [NK], ["depth"], {
    units: "m",
    positive: "down",
    standard_name: "depth",
  });
  await zarr.set(depth as never, null, {
    data: Float64Array.from([5, 15, 25]),
    shape: [NK],
    stride: [1],
  } as never);
  const dense = await array(
    store,
    "dense/tas",
    [NT, NK, NCELL],
    [4, 2, 100],
    ["time", "depth", "cell"],
    { grid_mapping: "crs", units: "K", _FillValue: FILL }
  );
  await writeField(
    dense,
    Array.from({ length: NCELL }, (_, at) => at)
  );

  const level = await array(store, "packed/level", [NK], [NK], ["level"], {
    name: "level",
  });
  await zarr.set(level as never, null, {
    data: Float64Array.from([0, 1, 2]),
    shape: [NK],
    stride: [1],
  } as never);
  const ids = await array(
    store,
    "packed/cell_ids",
    [PACKED.length],
    [64],
    ["cell"],
    {},
    "int64"
  );
  await zarr.set(ids as never, null, {
    data: BigInt64Array.from(PACKED.map(BigInt)),
    shape: [PACKED.length],
    stride: [1],
  } as never);
  const packed = await array(
    store,
    "packed/tas",
    [NT, NK, PACKED.length],
    [3, 3, 64],
    ["time", "level", "cell"],
    { units: "K", _FillValue: FILL }
  );
  await writeField(packed, PACKED);

  // ocean_s_coordinate_g2 terms; temp reuses the analytic field
  const s = [-0.75, -0.45, -0.15];
  const C = [-0.6, -0.3, -0.05];
  for (const [name, values] of [
    ["s_rho", s],
    ["Cs_r", C],
  ] as const) {
    const attrs =
      name === "s_rho"
        ? {
            standard_name: "ocean_s_coordinate_g2",
            formula_terms: "s: s_rho C: Cs_r eta: zeta depth: h depth_c: hc",
          }
        : {};
    const a = await array(store, `sigma/${name}`, [NK], [NK], ["s_rho"], attrs);
    await zarr.set(a as never, null, {
      data: Float64Array.from(values),
      shape: [NK],
      stride: [1],
    } as never);
  }
  const hc = await array(store, "sigma/hc", [], [], [], {});
  await zarr.set(hc as never, null, 10 as never);
  const h = await array(store, "sigma/h", [NCELL], [NCELL], ["cell"], {});
  await zarr.set(h as never, null, {
    data: Float64Array.from({ length: NCELL }, (_, c) => 100 + c),
    shape: [NCELL],
    stride: [1],
  } as never);
  const zeta = await array(
    store,
    "sigma/zeta",
    [NT, NCELL],
    [NT, 256],
    ["time", "cell"],
    {}
  );
  await zarr.set(zeta as never, null, {
    data: Float64Array.from(
      { length: NT * NCELL },
      (_, at) => 0.01 * Math.floor(at / NCELL)
    ),
    shape: [NT, NCELL],
    stride: [NCELL, 1],
  } as never);
  const temp = await array(
    store,
    "sigma/temp",
    [NT, NK, NCELL],
    [2, 3, 128],
    ["time", "s_rho", "cell"],
    { grid_mapping: "crs", _FillValue: FILL }
  );
  await writeField(
    temp,
    Array.from({ length: NCELL }, (_, at) => at)
  );
  return store;
}

const SOURCE = { ref: "memory://synthetic", versionStatus: "session" as const };

function query(
  kind: TAnalysisQuery["kind"],
  variable: string,
  geometry: TGeometry,
  extra: Partial<TAnalysisQuery> = {}
): TAnalysisQuery {
  return {
    version: 1,
    kind,
    source: SOURCE,
    variable,
    geometry,
    fixed: {},
    ...extra,
  };
}

let dataset: TAnalysisDataset;
let read: ReadContext;
const indexCache = new ByteLru<BigInt64Array>(32 * 2 ** 20);

async function run(q: TAnalysisQuery, context = read, signal?: AbortSignal) {
  const variableContext = await resolveVariableContext(
    dataset,
    q.variable,
    indexCache
  );
  const planned = await planAnalysis(variableContext, q, context);
  return { estimate: planned.estimate, result: await planned.execute(signal) };
}

function centre(cell: number) {
  return {
    lat: centres[2 * cell + 1],
    lon: ((centres[2 * cell] + 180) % 360) - 180,
  };
}

beforeAll(async () => {
  const store = await buildStore();
  dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    "memory"
  );
  read = new ReadContext();
});

// eslint-disable-next-line max-lines-per-function
describe("point series through the real readers", () => {
  it("dense: containing cell, CF masks, valid zeros and noleap labels", async () => {
    const cell = 0; // value(0, 0, 0) is a valid zero; missing at t=2 (0 mod 13)
    const { result } = await run(
      query(
        ANALYSIS_KINDS.POINT_SERIES,
        "dense/tas",
        { kind: "point", ...centre(cell) },
        { level: 1 }
      )
    );
    expect(result.cell!.id).toBe("0");
    expect(result.values).toEqual([10, 1010, NaN, 3010, 4010, 5010]);
    expect(timeLabelAt(result.time, 2)).toBe("2000-03-01 00:00:00");
    const zero = await run(
      query(
        ANALYSIS_KINDS.POINT_SERIES,
        "dense/tas",
        { kind: "point", ...centre(cell) },
        { level: 0, time: { start: 0, stop: 1 } }
      )
    );
    expect(zero.result.values).toEqual([0]);
  });

  it("packed sorted: stored cells match dense; absent cells are honest gaps", async () => {
    const cell = 500; // stored (500 mod 7 = 3? no: 500 mod 7 = 3)
    const present = stored(cell) ? cell : cell + 1;
    const { result } = await run(
      query(
        ANALYSIS_KINDS.POINT_SERIES,
        "packed/tas",
        { kind: "point", ...centre(present) },
        { level: 2 }
      )
    );
    expect(result.values).toEqual(
      Array.from({ length: NT }, (_, t) => value(t, 2, present))
    );
    expect(timeLabelAt(result.time, 2)).toBe("2000-02-30 00:00:00"); // 360_day
    const absent = PACKED.length && NCELL - 1 - ((NCELL - 1 - 3) % 7);
    expect(stored(absent)).toBe(false);
    const gap = await run(
      query(ANALYSIS_KINDS.POINT_SERIES, "packed/tas", {
        kind: "point",
        ...centre(absent),
      })
    );
    expect(result.cell?.stored).toBe(true);
    expect(gap.result.cell?.stored).toBe(false);
    expect(gap.result.values.every(Number.isNaN)).toBe(true);
    expect(gap.result.notes.join(" ")).toMatch(/not stored.*no nearby cell/);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("region series", () => {
  const box = {
    kind: "box" as const,
    west: -40,
    east: 40,
    south: -30,
    north: 30,
  };
  const inBox = Array.from({ length: NCELL }, (_, c) => c).filter((c) => {
    const { lat, lon } = centre(c);
    return (
      lat >= box.south && lat <= box.north && lon >= box.west && lon <= box.east
    );
  });

  it("dense: equal-area mean and coverage per timestep", async () => {
    const { result, estimate } = await run(
      query(ANALYSIS_KINDS.REGION_SERIES, "dense/tas", box, { level: 0 })
    );
    expect(estimate.modest).toBe(true);
    expect(result.region!.totalCells).toBe(String(inBox.length));
    for (let t = 0; t < NT; t++) {
      const valid = inBox.filter((c) => !isMissing(t, c));
      const mean =
        valid.reduce((sum, c) => sum + value(t, 0, c), 0) / valid.length;
      expect(result.values[t]).toBeCloseTo(mean, 10);
      expect(result.region!.coverage[t]).toBeCloseTo(
        valid.length / inBox.length,
        12
      );
    }
  });

  it("dense: an imported shape (with a hole) averages the cells inside it", async () => {
    // Edges off the cell centres; a hole in the middle.
    const [w, e, sth, nth] = [-40.3, 39.7, -30.3, 29.7];
    const outer = [
      [w, sth],
      [e, sth],
      [e, nth],
      [w, nth],
      [w, sth],
    ];
    const hole = [
      [-10.3, -10.3],
      [-10.3, 9.7],
      [9.7, 9.7],
      [9.7, -10.3],
      [-10.3, -10.3],
    ];
    const shape = {
      kind: "shape" as const,
      name: "test shape",
      polygons: [[outer, hole]],
      digest: "test-shape-1",
    };
    const { result } = await run(
      query(ANALYSIS_KINDS.REGION_SERIES, "dense/tas", shape, { level: 0 })
    );
    const inside = Array.from({ length: NCELL }, (_, c) => c).filter((c) => {
      const { lat, lon } = centre(c);
      const inOuter = lat > sth && lat < nth && lon > w && lon < e;
      const inHole = lat > -10.3 && lat < 9.7 && lon > -10.3 && lon < 9.7;
      return inOuter && !inHole;
    });
    expect(result.region!.totalCells).toBe(String(inside.length));
    for (let t = 0; t < NT; t++) {
      const valid = inside.filter((c) => !isMissing(t, c));
      const mean =
        valid.reduce((sum, c) => sum + value(t, 0, c), 0) / valid.length;
      expect(result.values[t]).toBeCloseTo(mean, 10);
    }
  });

  it("dense: the area's spread (σ, min, max) per timestep", async () => {
    const { result } = await run(
      query(ANALYSIS_KINDS.REGION_SERIES, "dense/tas", box, { level: 0 })
    );
    const spread = result.region!.spread!;
    for (let t = 0; t < NT; t++) {
      const values = inBox
        .filter((c) => !isMissing(t, c))
        .map((c) => value(t, 0, c));
      const mean = values.reduce((sum, v) => sum + v, 0) / values.length;
      const variance =
        values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / values.length;
      // Equal-area cells: the weighted σ is the population σ.
      expect(spread.std[t]).toBeCloseTo(Math.sqrt(variance), 8);
      expect(spread.min[t]).toBe(Math.min(...values));
      expect(spread.max[t]).toBe(Math.max(...values));
    }
  });

  it("packed: absent qualifying cells count in the denominator", async () => {
    const { result } = await run(
      query(ANALYSIS_KINDS.REGION_SERIES, "packed/tas", box, { level: 0 })
    );
    const present = inBox.filter(stored);
    expect(result.region!.storedCells).toBe(present.length);
    expect(result.region!.footprintCoverage).toBeCloseTo(
      present.length / inBox.length,
      12
    );
    const valid = present.filter((c) => !isMissing(0, c));
    expect(result.values[0]).toBeCloseTo(
      valid.reduce((s, c) => s + value(0, 0, c), 0) / valid.length,
      10
    );
    expect(result.region!.coverage[0]).toBeLessThan(1);
  });

  it("reuses packed country spans without reusing time and level selections", async () => {
    const qGeometry = {
      kind: "country",
      id: "124",
      resolution: "110m",
    } as const;
    const outline = prepareCountry(
      await getCountryRings(qGeometry.id, qGeometry.resolution)
    );
    const ids = Array.from({ length: NCELL }, (_, i) => i).filter((id) => {
      const { lat, lon } = centre(id);
      return countryContains(outline, lat, lon);
    });
    const present = ids.filter(stored);
    const { result } = await run(
      query(ANALYSIS_KINDS.REGION_SERIES, "packed/tas", qGeometry, { level: 0 })
    );
    expect(result.region!.storedCells).toBe(present.length);
    expect(result.region!.totalCells).toBe(String(ids.length));
    const { result: later } = await run(
      query(ANALYSIS_KINDS.DISTRIBUTION, "packed/tas", qGeometry, {
        time: { start: 3, stop: 4 },
        level: 2,
      })
    );
    expect(later.histogram!.mean).toBeCloseTo(
      present.reduce((s, c) => s + value(3, 2, c), 0) / present.length,
      10
    );
  });

  it("explains a region holding no cell centre", async () => {
    const tiny = {
      kind: "box" as const,
      west: 1,
      east: 1.001,
      south: 1,
      north: 1.001,
    };
    const { result } = await run(
      query(ANALYSIS_KINDS.REGION_SERIES, "dense/tas", tiny)
    );
    expect(result.values.every(Number.isNaN)).toBe(true);
    expect(result.notes.join(" ")).toMatch(/No cell centre/);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("profiles and sections", () => {
  it("profile on a direct depth axis", async () => {
    const { result } = await run(
      query(
        ANALYSIS_KINDS.PROFILE,
        "dense/tas",
        { kind: "point", ...centre(40) },
        { time: { start: 3, stop: 4 } }
      )
    );
    expect(result.values).toEqual([
      value(3, 0, 40),
      value(3, 1, 40),
      value(3, 2, 40),
    ]);
    expect(result.vertical!.values).toEqual([5, 15, 25]);
    expect(result.vertical!.physical).toBe(true);
  });

  it("section with ocean_s_coordinate_g2, repeated cells and gaps", async () => {
    const path = {
      kind: "polyline" as const,
      vertices: [
        { lat: 10, lon: 10 },
        { lat: 10, lon: 60 },
      ],
    };
    const { result } = await run(
      query(ANALYSIS_KINDS.SECTION, "sigma/temp", path, {
        time: { start: 1, stop: 2 },
        sectionSamples: 200,
      })
    );
    const samples = result.samples!;
    expect(samples.distances).toHaveLength(200);
    // ~0.25° spacing over ~7° cells: neighbouring samples repeat their cell
    expect(new Set(samples.cells).size).toBeLessThan(40);
    const at = 57;
    const cell = Number(samples.cells[at]);
    expect(result.values[at * NK + 1]).toBe(value(1, 1, cell));
    const eta = 0.01;
    const depth = 100 + cell;
    const S = (10 * -0.45 + depth * -0.3) / (10 + depth);
    expect(result.columnVertical![at * NK + 1]).toBeCloseTo(
      eta + (eta + depth) * S,
      10
    );
    expect(samples.distances.at(-1)).toBeGreaterThan(samples.distances[0]);
  });

  it("interim49: a formula section counts its chunks, drawing nothing yet", async () => {
    const q = query(
      ANALYSIS_KINDS.SECTION,
      "sigma/temp",
      {
        kind: "polyline" as const,
        vertices: [
          { lat: 10, lon: 10 },
          { lat: 10, lon: 60 },
        ],
      },
      { time: { start: 1, stop: 2 }, sectionSamples: 200 }
    );
    const ctx = await resolveVariableContext(dataset, q.variable, indexCache);
    const planned = await planAnalysis(ctx, q, read);
    const updates: TPartialUpdate[] = [];
    const result = await planned.execute(undefined, {
      onPartial: (u) => updates.push(u),
      publishEveryMs: 1e-9,
    });
    expect(result.columnVertical).toBeDefined();
    expect(updates.length).toBeGreaterThan(0);
    for (const u of updates) {
      expect(u.partial.chunks && u.partial.countOnly).toBe(true);
      expect(u.cells).toBeUndefined();
      expect(u.partial.done).toBeLessThan(u.partial.total);
      expect(u.partial.total).toBe(planned.estimate.chunks);
    }
  });
});

// eslint-disable-next-line max-lines-per-function
describe("logical order-17 source with few stored chunks", () => {
  // eslint-disable-next-line max-lines-per-function
  it("resolves high cell ids without allocating the global axis", async () => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    const n = 12 * 4 ** 17; // 2.06e11 cells: never allocated
    await array(
      store,
      "crs",
      [],
      [],
      [],
      {
        grid_mapping_name: "healpix",
        healpix_nside: 2 ** 17,
        healpix_order: "nest",
      },
      "int8"
    );
    const t = await array(store, "time", [2], [2], ["time"], {
      units: "hours since 2020-01-01",
      calendar: "proleptic_gregorian",
    });
    await zarr.set(t as never, null, {
      data: Float64Array.from([0, 6]),
      shape: [2],
      stride: [1],
    } as never);
    const tas = await array(store, "tas", [2, n], [1, 4096], ["time", "cell"], {
      grid_mapping: "crs",
    });
    const g17 = new healpixGeo.Grid({ scheme: "nested", level: 17 });
    const id = g17.lonLatToHealpix(new Float64Array([10, 45]))[0];
    expect(id).toBeGreaterThan(2n ** 32n);
    const start = Number(id) - (Number(id) % 4096);
    const data = Float64Array.from(
      { length: 2 * 4096 },
      (_, at) => (at < 4096 ? 1 : 2) * ((start + (at % 4096)) % 97)
    );
    await zarr.set(tas as never, [null, zarr.slice(start, start + 4096)], {
      data,
      shape: [2, 4096],
      stride: [4096, 1],
    } as never);
    const big = zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      "big"
    );
    const context = await resolveVariableContext(big, "tas", indexCache);
    const readContext = new ReadContext();
    const planned = await planAnalysis(
      context,
      query(ANALYSIS_KINDS.POINT_SERIES, "tas", {
        kind: "point",
        lat: 45,
        lon: 10,
      }),
      readContext
    );
    expect(planned.estimate.chunks).toBe(2);
    const result = await planned.execute();
    const expected = Number(id % 97n);
    expect(result.values).toEqual([expected, 2 * expected]);
    expect(result.cell!.id).toBe(id.toString());
    expect(result.counters.chunkReads).toBe(2);
    // An absent chunk elsewhere is missing (NaN fill), not zero.
    const far = await planAnalysis(
      context,
      query(ANALYSIS_KINDS.POINT_SERIES, "tas", {
        kind: "point",
        lat: -45,
        lon: -100,
      }),
      readContext
    );
    expect((await far.execute()).values.every(Number.isNaN)).toBe(true);
    g17.free();
  });
});

describe("cancellation and shared work", () => {
  it("a cancelled run rejects; a duplicate subscriber still completes", async () => {
    const shared = new ReadContext();
    const q = query(ANALYSIS_KINDS.REGION_SERIES, "dense/tas", {
      kind: "box",
      west: -180,
      east: 180,
      south: -90,
      north: 90,
    });
    const context = await resolveVariableContext(
      dataset,
      q.variable,
      indexCache
    );
    const first = await planAnalysis(context, q, shared);
    const second = await planAnalysis(context, q, shared);
    const controller = new AbortController();
    const cancelled = first.execute(controller.signal);
    const kept = second.execute();
    controller.abort(new DOMException("Cancelled", "AbortError"));
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const result = await kept;
    expect(result.values[0]).toBeCloseTo(
      Array.from({ length: NCELL }, (_, c) => value(0, 0, c)).reduce(
        (a, b) => a + b,
        0
      ) / NCELL,
      9
    );
  });
});

// eslint-disable-next-line max-lines-per-function
describe("missing segments and rectilinear grids", () => {
  it("a section over a packed level keeps absent cells as gaps", async () => {
    const path = {
      kind: "polyline" as const,
      vertices: [
        { lat: -20, lon: 100 },
        { lat: 30, lon: 140 },
      ],
    };
    const { result } = await run(
      query(ANALYSIS_KINDS.SECTION, "packed/tas", path, { sectionSamples: 300 })
    );
    const cells = result.samples!.cells;
    const gaps = cells
      .map((cell, s) => (cell === "" ? s : -1))
      .filter((s) => s >= 0);
    expect(gaps.length).toBeGreaterThan(0);
    for (const s of gaps) {
      expect(result.values.slice(s * NK, s * NK + NK).every(Number.isNaN)).toBe(
        true
      );
    }
    expect(result.notes.join(" ")).toMatch(/gaps/);
  });

  // eslint-disable-next-line max-lines-per-function
  it("area-weighted box mean from bounds; no bounds explains the prerequisite", async () => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    const lats = [-75, -45, -15, 15, 45, 75];
    const lons = [0, 45, 90, 135, 180, 225, 270, 315];
    const lat = await array(store, "lat", [6], [6], ["lat"], {
      units: "degrees_north",
      bounds: "lat_bnds",
    });
    await zarr.set(lat as never, null, {
      data: Float64Array.from(lats),
      shape: [6],
      stride: [1],
    } as never);
    const latB = await array(
      store,
      "lat_bnds",
      [6, 2],
      [6, 2],
      ["lat", "nv"],
      {}
    );
    await zarr.set(latB as never, null, {
      data: Float64Array.from(lats.flatMap((v) => [v - 15, v + 15])),
      shape: [6, 2],
      stride: [2, 1],
    } as never);
    const lon = await array(store, "lon", [8], [8], ["lon"], {
      units: "degrees_east",
      bounds: "lon_bnds",
    });
    await zarr.set(lon as never, null, {
      data: Float64Array.from(lons),
      shape: [8],
      stride: [1],
    } as never);
    const lonB = await array(
      store,
      "lon_bnds",
      [8, 2],
      [8, 2],
      ["lon", "nv"],
      {}
    );
    await zarr.set(lonB as never, null, {
      data: Float64Array.from(lons.flatMap((v) => [v - 22.5, v + 22.5])),
      shape: [8, 2],
      stride: [2, 1],
    } as never);
    const time = await array(store, "time", [2], [2], ["time"], {
      units: "days since 2000-01-01",
    });
    await zarr.set(time as never, null, {
      data: Float64Array.from([0, 1]),
      shape: [2],
      stride: [1],
    } as never);
    const tas = await array(
      store,
      "tas",
      [2, 6, 8],
      [1, 3, 4],
      ["time", "lat", "lon"],
      {}
    );
    const field = (t: number, i: number, j: number) => 1000 * t + 10 * i + j;
    await zarr.set(tas as never, null, {
      data: Float64Array.from({ length: 96 }, (_, at) =>
        field(Math.floor(at / 48), Math.floor(at / 8) % 6, at % 8)
      ),
      shape: [2, 6, 8],
      stride: [48, 8, 1],
    } as never);
    const rect = zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      "rect"
    );
    const context = await resolveVariableContext(rect, "tas", indexCache);
    // Box across the antimeridian/0° seam: lon 300..50 contains centres 315, 0, 45.
    const box = {
      kind: "box" as const,
      west: 300,
      east: 50,
      south: -20,
      north: 50,
    };
    const planned = await planAnalysis(
      context,
      query(ANALYSIS_KINDS.REGION_SERIES, "tas", box),
      new ReadContext()
    );
    const result = await planned.execute();
    let sum = 0;
    let weight = 0;
    for (const i of [2, 3, 4]) {
      const w =
        Math.sin(((lats[i] + 15) * Math.PI) / 180) -
        Math.sin(((lats[i] - 15) * Math.PI) / 180);
      for (const j of [7, 0, 1]) {
        sum += w * field(1, i, j);
        weight += w;
      }
    }
    expect(result.values[1]).toBeCloseTo(sum / weight, 10);
    expect(result.region!.totalCells).toBe("9");
    const point = await planAnalysis(
      context,
      query(ANALYSIS_KINDS.POINT_SERIES, "tas", {
        kind: "point",
        lat: 50,
        lon: -50,
      }),
      new ReadContext()
    );
    const located = await point.execute();
    expect(located.cell!.selection).toMatch(/bounds/);
    expect(located.values).toEqual([field(0, 4, 7), field(1, 4, 7)]);

    // Without bounds: a regular grid is weighted by edges halfway between
    // centres, labelled approximate; an irregular one is refused before any
    // data read.
    const bareOf = async (latValues: readonly number[]) => {
      const bare: TStore = new Map();
      await zarr.create(zarr.root(bare), { attributes: {} });
      for (const [name, values] of [
        ["lat", latValues],
        ["lon", lons],
        ["time", [0, 1]],
      ] as const) {
        const a = await array(
          bare,
          name,
          [values.length],
          [values.length],
          [name],
          name === "time" ? { units: "days since 2000-01-01" } : {}
        );
        await zarr.set(a as never, null, {
          data: Float64Array.from(values),
          shape: [values.length],
          stride: [1],
        } as never);
      }
      await array(
        bare,
        "tas",
        [2, 6, 8],
        [1, 3, 4],
        ["time", "lat", "lon"],
        {}
      );
      return resolveVariableContext(
        zarrAnalysisDatasetFromStore(bare as never, "", ZARR_FORMAT.V3, "bare"),
        "tas",
        indexCache
      );
    };
    const regular = await bareOf(lats);
    expect(regular.capabilities[ANALYSIS_KINDS.REGION_SERIES]).toEqual({
      available: true,
    });
    expect(
      (regular.grid as { approximateBounds?: boolean }).approximateBounds
    ).toBe(true);
    const bareContext = await bareOf([-80, -50, -15, 15, 50, 80]);
    expect(bareContext.capabilities[ANALYSIS_KINDS.REGION_SERIES]).toEqual({
      available: false,
      reason: expect.stringMatching(/cell bounds/),
    });
    expect(
      bareContext.capabilities[ANALYSIS_KINDS.POINT_SERIES].available
    ).toBe(true);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("streaming series", () => {
  it("publishes each part as it is read; parts follow time chunks", async () => {
    const partials: {
      values: number[];
      partial?: { done: number; total: number };
    }[] = [];
    const context = await resolveVariableContext(
      dataset,
      "dense/tas",
      indexCache
    );
    const planned = await planAnalysis(
      context,
      query(
        ANALYSIS_KINDS.POINT_SERIES,
        "dense/tas",
        { kind: "point", ...centre(5) },
        { level: 0 }
      ),
      new ReadContext()
    );
    const final = await planned.execute(undefined, {
      onPartial: createPartialAssembler((partial) =>
        partials.push({ ...partial, values: partial.values.slice() })
      ),
    });
    // dense/tas has time chunks of 4: parts [0, 4) and [4, 6). The window
    // gets the empty frame first, before any part is read.
    expect(partials).toHaveLength(2);
    expect(partials[0].partial).toEqual({ done: 0, total: 2, readUntil: 0 });
    expect(partials[0].values.every(Number.isNaN)).toBe(true);
    expect(partials[1].partial).toEqual({ done: 1, total: 2, readUntil: 4 });
    expect(partials[1].values.slice(0, 4)).toEqual(
      [0, 1, 2, 3].map((t) => value(t, 0, 5))
    );
    expect(partials[1].values.slice(4).every(Number.isNaN)).toBe(true);
    expect(final.partial).toBeUndefined();
    expect(final.values).toEqual([0, 1, 2, 3, 4, 5].map((t) => value(t, 0, 5)));
  });

  it("an area series streams its means and coverage, pending times unknown", async () => {
    const partials: {
      values: number[];
      region?: { coverage: number[]; std: number[] };
    }[] = [];
    const context = await resolveVariableContext(
      dataset,
      "dense/tas",
      indexCache
    );
    const box = {
      kind: "box" as const,
      west: -40,
      east: 40,
      south: -30,
      north: 30,
    };
    const planned = await planAnalysis(
      context,
      query(ANALYSIS_KINDS.REGION_SERIES, "dense/tas", box, { level: 0 }),
      new ReadContext()
    );
    const final = await planned.execute(undefined, {
      onPartial: createPartialAssembler((partial) =>
        partials.push({
          values: partial.values.slice(),
          region: {
            coverage: partial.region!.coverage.slice(),
            std: partial.region!.spread!.std.slice(),
          },
        })
      ),
    });
    expect(partials).toHaveLength(2);
    expect(partials[0].region!.coverage.every(Number.isNaN)).toBe(true);
    expect(partials[1].values.slice(0, 4)).toEqual(final.values.slice(0, 4));
    expect(partials[1].region!.coverage.slice(4).every(Number.isNaN)).toBe(
      true
    );
    expect(final.region!.coverage.every((c) => c > 0)).toBe(true);
    // The spread streams with the means.
    expect(partials[0].region!.std.every(Number.isNaN)).toBe(true);
    expect(partials[1].region!.std.slice(0, 4)).toEqual(
      final.region!.spread!.std.slice(0, 4)
    );
    expect(partials[1].region!.std.slice(4).every(Number.isNaN)).toBe(true);
  });
});
