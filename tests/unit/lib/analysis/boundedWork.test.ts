/* eslint-disable max-lines-per-function -- one reproducer per case. */
/* eslint-disable camelcase -- CF and Zarr metadata use snake_case keys. */
import * as healpixGeo from "healpix-geo";
import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import {
  timeLabelAt,
  nearestTimeIndex,
  parseCalendarDate,
} from "@/lib/analysis/calendar.ts";
import {
  createSortedIndex,
  INDEX_VALIDATION,
} from "@/lib/analysis/cellIndex.ts";
import {
  ReadContext,
  ReadLimiter,
  visitRuns,
  type TAnalysisArray,
} from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import {
  coverHealpixRegion,
  REGION_KINDS,
} from "@/lib/analysis/regionCover.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { boxContains } from "@/lib/analysis/sphere.ts";
import {
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  emptyCounters,
  type TAnalysisQuery,
  type TGeometry,
} from "@/lib/analysis/types.ts";
import { buildValueCodec } from "@/lib/analysis/valueDecoding.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;

async function write(
  store: TStore,
  path: string,
  data: ArrayLike<number> | undefined,
  shape: number[],
  dims: string[],
  options: {
    attrs?: Record<string, unknown>;
    chunks?: number[];
    dtype?: zarr.DataType;
    fill?: number;
  } = {}
) {
  const dtype = options.dtype ?? "float64";
  const array = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape: options.chunks ?? shape,
    dtype,
    dimensionNames: dims,
    attributes: options.attrs ?? {},
    fillValue: (options.fill ?? (/int/.test(dtype) ? 0 : Number.NaN)) as never,
  });
  if (data) {
    const stride = shape.map((_, d) =>
      shape.slice(d + 1).reduce((product, n) => product * n, 1)
    );
    const typed =
      dtype === "int16"
        ? Int16Array.from(data)
        : dtype === "float32"
          ? Float32Array.from(data)
          : Float64Array.from(data);
    await zarr.set(array as never, null, {
      data: typed,
      shape,
      stride,
    } as never);
  }
}

async function context(store: TStore, variable: string, name: string) {
  return resolveVariableContext(
    zarrAnalysisDatasetFromStore(store as never, "", ZARR_FORMAT.V3, name),
    variable,
    new ByteLru<BigInt64Array>(2 ** 20)
  );
}

function query(
  kind: TAnalysisQuery["kind"],
  variable: string,
  geometry: TGeometry,
  extra: Partial<TAnalysisQuery> = {}
): TAnalysisQuery {
  return {
    version: ALGORITHM_VERSION,
    kind,
    source: { ref: "memory", versionStatus: "session" },
    variable,
    geometry,
    fixed: {},
    ...extra,
  };
}

async function newStore() {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  return store;
}

describe("v5 review: bounded work", () => {
  it("a diagonal section decodes only the cells it samples", async () => {
    const store = await newStore();
    const n = 512;
    const axis = Array.from({ length: n }, (_, k) => k * 0.01);
    await write(store, "lat", axis, [n], ["lat"], {
      attrs: { units: "degrees_north" },
    });
    await write(store, "lon", axis, [n], ["lon"], {
      attrs: { units: "degrees_east" },
    });
    await write(
      store,
      "sst",
      Float64Array.from({ length: n * n }, (_, at) => at),
      [n, n],
      ["lat", "lon"]
    );
    const ctx = await context(store, "sst", "diagonal");
    const planned = await planAnalysis(
      ctx,
      query(
        ANALYSIS_KINDS.SECTION,
        "sst",
        {
          kind: "polyline",
          vertices: [
            { lat: 0, lon: 0 },
            { lat: 5.11, lon: 5.11 },
          ],
        },
        { sectionSamples: 512 }
      ),
      new ReadContext()
    );
    const result = await planned.execute();
    const cells = new Set(result.samples!.cells.filter(Boolean));
    expect(result.counters.chunkReads).toBe(1);
    expect(result.counters.visitedElements).toBe(cells.size);
    expect(result.counters.visitedElements).toBeLessThanOrEqual(512);
  });

  it("box planning grows linearly with rows", async () => {
    const store = await newStore();
    const rows = 16000;
    const lats = Array.from(
      { length: rows },
      (_, i) => -80 + (160 * (i + 0.5)) / rows
    );
    const half = 80 / rows;
    await write(store, "lat", lats, [rows], ["lat"], {
      attrs: { units: "degrees_north", bounds: "lat_bnds" },
    });
    await write(
      store,
      "lat_bnds",
      lats.flatMap((v) => [v - half, v + half]),
      [rows, 2],
      ["lat", "nv"]
    );
    await write(store, "lon", [10], [1], ["lon"], {
      attrs: { units: "degrees_east", bounds: "lon_bnds" },
    });
    await write(store, "lon_bnds", [9, 11], [1, 2], ["lon", "nv"]);
    await write(store, "time", [0], [1], ["time"], {
      attrs: { units: "days since 2000-01-01" },
    });
    await write(store, "tas", undefined, [1, rows, 1], ["time", "lat", "lon"]);
    const ctx = await context(store, "tas", "tall");
    const started = performance.now();
    const planned = await planAnalysis(
      ctx,
      query(ANALYSIS_KINDS.REGION_SERIES, "tas", {
        kind: "box",
        west: 5,
        east: 15,
        south: -79,
        north: 79,
      }),
      new ReadContext()
    );
    expect(performance.now() - started).toBeLessThan(300);
    expect(planned.estimate.chunks).toBe(1);
  });

  it("one long single chunk is admitted at its real cost", async () => {
    const store = await newStore();
    const nt = 360_000;
    await write(store, "lat", [0], [1], ["lat"], {
      attrs: { units: "degrees_north", bounds: "lat_bnds" },
    });
    await write(store, "lat_bnds", [-1, 1], [1, 2], ["lat", "nv"]);
    await write(store, "lon", [0], [1], ["lon"], {
      attrs: { units: "degrees_east", bounds: "lon_bnds" },
    });
    await write(store, "lon_bnds", [-1, 1], [1, 2], ["lon", "nv"]);
    await write(
      store,
      "time",
      Float64Array.from({ length: nt }, (_, t) => t),
      [nt],
      ["time"],
      { attrs: { units: "hours since 2000-01-01" } }
    );
    await write(store, "tas", undefined, [nt, 1, 1], ["time", "lat", "lon"]);
    const ctx = await context(store, "tas", "long");
    const planned = await planAnalysis(
      ctx,
      query(ANALYSIS_KINDS.REGION_SERIES, "tas", {
        kind: "box",
        west: -0.5,
        east: 0.5,
        south: -0.5,
        north: 0.5,
      }),
      new ReadContext()
    );
    expect(planned.estimate.chunks).toBe(1);
    expect(planned.estimate.workingBytes).toBeLessThan(64 * 2 ** 20);
  });

  it("decoded chunks held at once stay within the page budget", async () => {
    const chunkLength = 524_288;
    const array: TAnalysisArray = {
      key: "budget",
      shape: [16 * chunkLength],
      chunks: [chunkLength],
      dtype: "float32",
      attrs: {},
      dimensionNames: ["x"],
      fillValue: null,
      readChunk: async () => ({
        data: new Float32Array(chunkLength),
        shape: [chunkLength],
        stride: [1],
        absent: false,
      }),
    };
    const read = new ReadContext(new ReadLimiter(4), 0, 8 * 2 ** 20);
    const counters = emptyCounters();
    let visited = 0;
    await visitRuns(
      read,
      array,
      buildValueCodec({}, null, "float32", 3),
      [[[0, 16 * chunkLength]]],
      () => visited++,
      counters
    );
    expect(visited).toBe(16 * chunkLength);
    expect(read.budget.peak).toBeLessThanOrEqual(8 * 2 ** 20);
    expect(read.budget.reserved).toBe(0);
  });

  it("an execution cancelled before it starts reads nothing", async () => {
    const store = await newStore();
    await write(store, "lat", [0], [1], ["lat"], {
      attrs: { units: "degrees_north" },
    });
    await write(store, "lon", [0], [1], ["lon"], {
      attrs: { units: "degrees_east" },
    });
    await write(
      store,
      "time",
      Float64Array.from({ length: 44 }, (_, t) => t),
      [44],
      ["time"],
      { attrs: { units: "days since 2000-01-01" } }
    );
    await write(
      store,
      "tas",
      Float64Array.from({ length: 44 }, (_, t) => t),
      [44, 1, 1],
      ["time", "lat", "lon"],
      { chunks: [4, 1, 1] }
    );
    const ctx = await context(store, "tas", "aborted");
    let reads = 0;
    const original = ctx.array.readChunk.bind(ctx.array);
    ctx.array.readChunk = (coords, signal) => {
      reads++;
      return original(coords, signal);
    };
    const planned = await planAnalysis(
      ctx,
      query(ANALYSIS_KINDS.POINT_SERIES, "tas", {
        kind: "point",
        lat: 0,
        lon: 0,
      }),
      new ReadContext()
    );
    const controller = new AbortController();
    controller.abort();
    await expect(planned.execute(controller.signal)).rejects.toMatchObject({
      name: "AbortError",
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(reads).toBe(0);
  });
});

describe("v5 review: scientific correctness", () => {
  it("broadcasts a time-only surface pressure over columns", async () => {
    const store = await newStore();
    await write(store, "lat", [0], [1], ["lat"], {
      attrs: { units: "degrees_north" },
    });
    await write(store, "lon", [0], [1], ["lon"], {
      attrs: { units: "degrees_east" },
    });
    await write(store, "time", [0, 1], [2], ["time"], {
      attrs: { units: "days since 2000-01-01" },
    });
    await write(store, "lev", [0.5, 1], [2], ["lev"], {
      attrs: {
        standard_name: "atmosphere_hybrid_sigma_pressure_coordinate",
        formula_terms: "ap: ap b: b ps: ps",
        positive: "down",
      },
    });
    await write(store, "ap", [0, 0], [2], ["lev"], { attrs: { units: "Pa" } });
    await write(store, "b", [0.1, 1], [2], ["lev"], { attrs: { units: "1" } });
    await write(store, "ps", [100000, 90000], [2], ["time"], {
      attrs: { units: "Pa" },
    });
    await write(
      store,
      "ta",
      [100, 110, 189, 270],
      [2, 2, 1, 1],
      ["time", "lev", "lat", "lon"]
    );
    const ctx = await context(store, "ta", "hybrid");
    const planned = await planAnalysis(
      ctx,
      query(
        ANALYSIS_KINDS.PROFILE,
        "ta",
        { kind: "point", lat: 0, lon: 0 },
        {
          time: { start: 1, stop: 2 },
        }
      ),
      new ReadContext()
    );
    // Field chunks and formula-term chunks are both in the estimate.
    expect(planned.estimate.chunks).toBe(4);
    const result = await planned.execute();
    expect(result.values).toEqual([189, 270]);
    expect(result.vertical!.values).toEqual([9000, 90000]);
  });

  it("refuses a formula term whose own chunk exceeds the limit, before reading", async () => {
    const store = await newStore();
    await write(store, "lat", [0], [1], ["lat"], {
      attrs: { units: "degrees_north" },
    });
    await write(store, "lon", [0], [1], ["lon"], {
      attrs: { units: "degrees_east" },
    });
    await write(store, "time", [0, 1], [2], ["time"], {
      attrs: { units: "days since 2000-01-01" },
    });
    await write(store, "lev", [0.5, 1], [2], ["lev"], {
      attrs: {
        standard_name: "atmosphere_hybrid_sigma_pressure_coordinate",
        formula_terms: "ap: ap b: b ps: ps",
        positive: "down",
      },
    });
    await write(store, "ap", [0, 0], [2], ["lev"], { attrs: { units: "Pa" } });
    await write(store, "b", [0.1, 1], [2], ["lev"], { attrs: { units: "1" } });
    // A 512 MiB Float64 chunk declared for a two-value term (never written).
    await write(store, "ps", undefined, [2], ["time"], {
      attrs: { units: "Pa" },
      chunks: [2 ** 26],
    });
    await write(
      store,
      "ta",
      [1, 2, 3, 4],
      [2, 2, 1, 1],
      ["time", "lev", "lat", "lon"]
    );
    const ctx = await context(store, "ta", "huge-term");
    await expect(
      planAnalysis(
        ctx,
        query(
          ANALYSIS_KINDS.PROFILE,
          "ta",
          { kind: "point", lat: 0, lon: 0 },
          {
            time: { start: 1, stop: 2 },
          }
        ),
        new ReadContext()
      )
    ).rejects.toThrow(/formula term ps .*512 MiB/);
  });

  it("broadcasts spatially uniform ocean terms", async () => {
    const store = await newStore();
    await write(store, "lat", [0, 1], [2], ["lat"], {
      attrs: { units: "degrees_north" },
    });
    await write(store, "lon", [0], [1], ["lon"], {
      attrs: { units: "degrees_east" },
    });
    await write(store, "time", [0, 1], [2], ["time"], {
      attrs: { units: "days since 2000-01-01" },
    });
    await write(store, "sigma", [-0.5, -1], [2], ["sigma"], {
      attrs: {
        standard_name: "ocean_sigma_coordinate",
        formula_terms: "sigma: sigma eta: eta depth: depth",
        positive: "up",
      },
    });
    await write(store, "eta", [0, 2], [2], ["time"], { attrs: { units: "m" } });
    await write(store, "depth", [100], [1], ["one"], { attrs: { units: "m" } });
    await write(
      store,
      "thetao",
      Float64Array.from({ length: 8 }, (_, at) => at),
      [2, 2, 2, 1],
      ["time", "sigma", "lat", "lon"]
    );
    const ctx = await context(store, "thetao", "sigma");
    const planned = await planAnalysis(
      ctx,
      query(
        ANALYSIS_KINDS.PROFILE,
        "thetao",
        { kind: "point", lat: 1, lon: 0 },
        {
          time: { start: 1, stop: 2 },
        }
      ),
      new ReadContext()
    );
    const result = await planned.execute();
    // z = eta + sigma * (depth + eta) with eta = 2, depth = 100
    expect(result.vertical!.values).toEqual([2 - 0.5 * 102, 2 - 102]);
  });

  it("an ocean sigma field omitting eta uses zero for it (CF), not model levels", async () => {
    const store = await newStore();
    await write(store, "lat", [0], [1], ["lat"], {
      attrs: { units: "degrees_north" },
    });
    await write(store, "lon", [0], [1], ["lon"], {
      attrs: { units: "degrees_east" },
    });
    await write(store, "sigma", [-1, 0], [2], ["sigma"], {
      attrs: {
        standard_name: "ocean_sigma_coordinate",
        formula_terms: "sigma: sigma depth: depth",
        positive: "up",
      },
    });
    await write(store, "depth", [100], [1], ["one"], { attrs: { units: "m" } });
    await write(store, "thetao", [5, 6], [2, 1, 1], ["sigma", "lat", "lon"]);
    const ctx = await context(store, "thetao", "sigma-no-eta");
    const planned = await planAnalysis(
      ctx,
      query(ANALYSIS_KINDS.PROFILE, "thetao", {
        kind: "point",
        lat: 0,
        lon: 0,
      }),
      new ReadContext()
    );
    const result = await planned.execute();
    expect(result.vertical!.physical).toBe(true);
    expect(result.vertical!.values).toEqual([-100, 0]);
  });

  it("a named but missing eta still downgrades with its reason", async () => {
    const store = await newStore();
    await write(store, "lat", [0], [1], ["lat"], {
      attrs: { units: "degrees_north" },
    });
    await write(store, "lon", [0], [1], ["lon"], {
      attrs: { units: "degrees_east" },
    });
    await write(store, "sigma", [-1, 0], [2], ["sigma"], {
      attrs: {
        standard_name: "ocean_sigma_coordinate",
        formula_terms: "sigma: sigma eta: zeta depth: depth",
      },
    });
    await write(store, "depth", [100], [1], ["one"], { attrs: { units: "m" } });
    await write(store, "thetao", [5, 6], [2, 1, 1], ["sigma", "lat", "lon"]);
    const ctx = await context(store, "thetao", "sigma-named-eta");
    expect(ctx.vertical!.kind).not.toBe("formula");
    expect(ctx.vertical!.note).toMatch(/eta/);
  });

  it("an unwritten chunk reads as the logical fill value", async () => {
    const array: TAnalysisArray = {
      key: "absent",
      shape: [4],
      chunks: [2],
      dtype: "float32",
      attrs: {},
      dimensionNames: ["x"],
      fillValue: 0,
      readChunk: async (coords) => ({
        data:
          coords[0] === 0 ? Float32Array.from([42, 0]) : new Float32Array(2),
        shape: [2],
        stride: [1],
        absent: coords[0] === 1,
      }),
    };
    const values: number[] = [];
    for (const format of [3, 2]) {
      values.length = 0;
      await visitRuns(
        new ReadContext(),
        { ...array, key: `absent${format}` },
        buildValueCodec({}, 0, "float32", format),
        [[[0, 4]]],
        (_, index, value) => (values[index[0]] = value),
        emptyCounters()
      );
      expect(values).toEqual(
        format === 3 ? [42, 0, 0, 0] : [42, NaN, NaN, NaN]
      );
    }
  });

  it("decodes packed coordinates and times", async () => {
    const store = await newStore();
    await write(store, "lat", [0, 20], [2], ["lat"], {
      dtype: "int16",
      attrs: { units: "degrees_north", scale_factor: 0.5 },
    });
    await write(store, "lon", [0], [1], ["lon"], {
      attrs: { units: "degrees_east" },
    });
    await write(store, "time", [0, 48], [2], ["time"], {
      dtype: "int16",
      attrs: { units: "hours since 2000-01-01", scale_factor: 0.5 },
    });
    await write(store, "tas", [1, 2, 3, 4], [2, 2, 1], ["time", "lat", "lon"]);
    const ctx = await context(store, "tas", "packed");
    expect(timeLabelAt(ctx.time, 1)).toBe("2000-01-02 00:00:00");
    const planned = await planAnalysis(
      ctx,
      query(ANALYSIS_KINDS.POINT_SERIES, "tas", {
        kind: "point",
        lat: 10,
        lon: 0,
      }),
      new ReadContext()
    );
    const result = await planned.execute();
    expect(result.values).toEqual([2, 4]);
    expect(timeLabelAt(result.time, 1)).toBe("2000-01-02 00:00:00");
  });

  it("finds equivalent longitudes on a regional 0–360 axis", async () => {
    const store = await newStore();
    await write(store, "lat", [0], [1], ["lat"], {
      attrs: { units: "degrees_north" },
    });
    await write(store, "lon", [300, 301], [2], ["lon"], {
      attrs: { units: "degrees_east" },
    });
    await write(store, "time", [0], [1], ["time"], {
      attrs: { units: "days since 2000-01-01" },
    });
    await write(store, "tas", [7, 8], [1, 1, 2], ["time", "lat", "lon"]);
    const ctx = await context(store, "tas", "regional");
    for (const lon of [300, -60]) {
      const planned = await planAnalysis(
        ctx,
        query(ANALYSIS_KINDS.POINT_SERIES, "tas", {
          kind: "point",
          lat: 0,
          lon,
        }),
        new ReadContext()
      );
      expect((await planned.execute()).values).toEqual([7]);
    }
  });

  it("does not treat rotated-pole axes as geographic", async () => {
    const store = await newStore();
    await write(store, "rlat", [0, 1], [2], ["rlat"], {
      attrs: { units: "degrees", standard_name: "grid_latitude" },
    });
    await write(store, "rlon", [0, 1], [2], ["rlon"], {
      attrs: { units: "degrees", standard_name: "grid_longitude" },
    });
    await write(store, "tas", [1, 2, 3, 4], [2, 2], ["rlat", "rlon"]);
    const ctx = await context(store, "tas", "rotated");
    expect(ctx.capabilities[ANALYSIS_KINDS.SECTION]).toMatchObject({
      available: false,
      reason: expect.stringMatching(/rotated/),
    });
  });

  it("one waiter's cancel does not fail another reading the same index chunk", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const index = createSortedIndex(
      {
        length: 4,
        chunkLength: 4,
        readChunk: async (_, signal) => {
          await gate;
          if (signal?.aborted) {
            throw new DOMException("Aborted", "AbortError");
          }
          return [10n, 20n, 30n, 40n];
        },
      },
      new ByteLru<BigInt64Array>(2 ** 16),
      "waiters",
      INDEX_VALIDATION.FULL
    );
    const first = new AbortController();
    const a = index
      .positionsOf([20n], first.signal)
      .catch((e: Error) => e.name);
    const b = index.positionsOf([30n]);
    first.abort();
    release();
    expect(await a).toBe("AbortError");
    expect(await b).toEqual([2]);
  });

  it("validates typed dates and resolves ties to the earlier time", () => {
    expect(parseCalendarDate("2020-06-01 25:00")).toBeUndefined();
    expect(parseCalendarDate("2020-13-01")).toBeUndefined();
    expect(parseCalendarDate("2020-06-01 23:59")).toBeDefined();
    // Descending axis: 10 and 20 are equally near 15; 10 is earlier.
    expect(nearestTimeIndex([30, 20, 10], 15)).toBe(2);
    expect(nearestTimeIndex([10, 20, 30], 15)).toBe(0);
  });

  it("HEALPix region membership matches a brute-force oracle at poles and the seam", async () => {
    const wgs84 = { semi_major_axis: 6378137, semi_minor_axis: 6356752.314245 };
    for (const ellipsoid of [undefined, wgs84]) {
      const grid = new healpixGeo.Grid({
        scheme: "nested",
        level: 5,
        ...(ellipsoid ? { ellipsoid } : {}),
      } as never);
      const all = BigUint64Array.from({ length: 12 * 4 ** 5 }, (_, at) =>
        BigInt(at)
      );
      const centres = grid.healpixToLonLat(all);
      for (const box of [
        { west: -30, east: 30, south: 80, north: 90 },
        { west: 170, east: -170, south: -20, north: 20 },
        { west: 0, east: 359, south: -90, north: -75 },
      ]) {
        const cover = await coverHealpixRegion(grid, {
          kind: REGION_KINDS.BOX,
          box,
        });
        const covered = new Set<number>();
        for (const [from, to] of cover.ranges) {
          for (let id = from; id < to; id++) {
            covered.add(Number(id));
          }
        }
        const expected = new Set<number>();
        for (let at = 0; at < all.length; at++) {
          if (boxContains(box, centres[2 * at + 1], centres[2 * at])) {
            expected.add(at);
          }
        }
        expect([...covered].sort((a, b) => a - b)).toEqual(
          [...expected].sort((a, b) => a - b)
        );
      }
      grid.free();
    }
  });
});

describe("formula curtain downloads (v7 review)", () => {
  for (const dimension of ["lev", "z"]) {
    it(`exports the model coordinate and per-column pressure (level dimension "${dimension}")`, async () => {
      const { exportModel } =
        await import("@/lib/analysis/scientificExport.ts");
      const store = await newStore();
      await write(store, "lat", [0, 1, 2], [3], ["lat"], {
        attrs: { units: "degrees_north" },
      });
      await write(store, "lon", [0], [1], ["lon"], {
        attrs: { units: "degrees_east" },
      });
      await write(store, dimension, [0.5, 1], [2], [dimension], {
        attrs: {
          standard_name: "atmosphere_hybrid_sigma_pressure_coordinate",
          formula_terms: "ap: ap b: b ps: ps",
          positive: "down",
        },
      });
      await write(store, "ap", [0, 0], [2], [dimension], {
        attrs: { units: "Pa" },
      });
      await write(store, "b", [0.1, 1], [2], [dimension], {
        attrs: { units: "1" },
      });
      await write(store, "ps", [100000, 98000, 97000], [3, 1], ["lat", "lon"], {
        attrs: { units: "Pa" },
      });
      await write(
        store,
        "ta",
        [1, 2, 3, 4, 5, 6],
        [2, 3, 1],
        [dimension, "lat", "lon"]
      );
      const ctx = await context(store, "ta", `curtain-${dimension}`);
      const planned = await planAnalysis(
        ctx,
        query(
          ANALYSIS_KINDS.SECTION,
          "ta",
          {
            kind: "polyline",
            vertices: [
              { lat: 0, lon: 0 },
              { lat: 2, lon: 0 },
            ],
          },
          { sectionSamples: 3 }
        ),
        new ReadContext()
      );
      const result = await planned.execute();
      const model = exportModel(result);
      const names = model.arrays.map((a) => a.name);
      expect(new Set(names).size).toBe(names.length);
      const level = model.arrays.find((a) => a.name === dimension)!;
      expect(Array.from(level.data as Float64Array)).toEqual([0.5, 1]);
      expect(level.attrs.units).toBeUndefined();
      const position = model.arrays.find(
        (a) => a.name === `${dimension}_position`
      )!;
      expect(position.attrs.units).toBe("Pa");
      expect(Array.from(position.data as Float64Array)).toEqual([
        10000, 100000, 9800, 98000, 9700, 97000,
      ]);
      const field = model.arrays.find((a) => a.attrs.gridlook_source_variable)!;
      expect(String(field.attrs.coordinates)).toContain(
        `${dimension}_position`
      );
    });
  }
});

describe("CF coordinates and packed values in a Zarr source", () => {
  it("uses auxiliary time(record), radian centres and inherited bounds, and masks a finite sentinel in area means", async () => {
    const store = await newStore();
    const rad = Math.PI / 180;
    for (const [name, centres, edges] of [
      ["lat", [0, 45], [-22.5, 22.5, 22.5, 67.5]],
      ["lon", [0, 90], [-45, 45, 45, 135]],
    ] as const) {
      await write(
        store,
        name,
        centres.map((v) => rad * v),
        [2],
        [name],
        { attrs: { units: "radians", bounds: name + "_bounds" } }
      );
      await write(
        store,
        name + "_bounds",
        edges.map((v) => rad * v),
        [2, 2],
        [name, "nv"]
      );
    }
    await write(store, "time", [0, 1], [2], ["record"], {
      attrs: { standard_name: "time", units: "days since 2000-01-01" },
    });
    await write(
      store,
      "tas",
      [-9999, 2, 2, 2, 3, 3, 3, 3],
      [2, 2, 2],
      ["record", "lat", "lon"],
      { attrs: { coordinates: "time", _FillValue: "AAAAAICHw8A=" } }
    );
    const ctx = await context(store, "tas", "named-time-radians");
    expect(ctx.time?.dimension).toBe("record");
    expect(ctx.others).toHaveLength(0);
    const point = await planAnalysis(
      ctx,
      query(ANALYSIS_KINDS.POINT_SERIES, "tas", {
        kind: "point",
        lat: 45,
        lon: 90,
      }),
      new ReadContext()
    );
    expect((await point.execute()).values).toEqual([2, 3]);
    const box = await planAnalysis(
      ctx,
      query(ANALYSIS_KINDS.REGION_SERIES, "tas", {
        kind: "box",
        south: -30,
        north: 68,
        west: -46,
        east: 136,
      }),
      new ReadContext()
    );
    const result = await box.execute();
    expect(result.values[0]).toBeCloseTo(2);
    expect(result.values[1]).toBeCloseTo(3);
  });

  it("does not offer time plots for an invalid coordinate", async () => {
    const store = await newStore();
    await write(store, "lat", [0], [1], ["lat"]);
    await write(store, "lon", [0], [1], ["lon"]);
    await write(store, "time", [0, NaN, 2], [3], ["time"], {
      attrs: { units: "days since 2000-01-01" },
    });
    await write(store, "tas", [4, 5, 6], [3, 1, 1], ["time", "lat", "lon"]);
    const ctx = await context(store, "tas", "missing-time");
    expect(ctx.capabilities[ANALYSIS_KINDS.POINT_SERIES]).toEqual({
      available: false,
      reason: expect.stringContaining("invalid timestamps"),
    });
    expect(ctx.others).toContainEqual({ axis: 0, dimension: "time", size: 3 });
  });

  it.each([true, false])(
    "resolves a dimensionless named sigma coordinate with complete formula %s",
    async (complete) => {
      const store = await newStore();
      await write(store, "lat", [0], [1], ["lat"]);
      await write(store, "lon", [0], [1], ["lon"]);
      await write(store, "sigma", [-1, 0], [2], ["layer_id"], {
        attrs: {
          units: "1",
          standard_name: "ocean_sigma_coordinate",
          formula_terms: "sigma: sigma eta: eta depth: depth",
        },
      });
      if (complete) {
        await write(store, "eta", [0], [1, 1], ["lat", "lon"], {
          attrs: { units: "m" },
        });
        await write(store, "depth", [50], [1, 1], ["lat", "lon"], {
          attrs: { units: "m" },
        });
      }
      await write(store, "tas", [4, 5], [2, 1, 1], ["layer_id", "lat", "lon"], {
        attrs: { coordinates: "sigma" },
      });
      const ctx = await context(store, "tas", "aux-sigma-" + complete);
      expect(ctx.vertical?.kind).toBe(complete ? "formula" : "model");
      expect(ctx.vertical?.units).toBe(complete ? "m" : undefined);
      expect(ctx.vertical?.values).toEqual([-1, 0]);
      if (complete) {
        const planned = await planAnalysis(
          ctx,
          query(ANALYSIS_KINDS.PROFILE, "tas", {
            kind: "point",
            lat: 0,
            lon: 0,
          }),
          new ReadContext()
        );
        expect((await planned.execute()).vertical!.values).toEqual([-50, 0]);
      }
    }
  );
});
