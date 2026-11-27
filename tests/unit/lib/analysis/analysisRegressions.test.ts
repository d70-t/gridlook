/* eslint-disable max-lines-per-function -- one reproducer per case. */
/* eslint-disable camelcase -- CF and Zarr metadata use snake_case keys. */
import * as healpixGeo from "healpix-geo";
import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import {
  reduceForDisplay,
  validateRestoredQuery,
} from "@/lib/analysis/analysisExport.ts";
import { ByteLru } from "@/lib/analysis/byteLru.ts";
import {
  encodeTypedDate,
  parseCalendarDate,
  parseTimeAxis,
} from "@/lib/analysis/calendar.ts";
import {
  createSortedIndex,
  INDEX_VALIDATION,
} from "@/lib/analysis/cellIndex.ts";
import {
  ReadContext,
  ReadLimiter,
  visitRuns,
} from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { emptyCounters, ANALYSIS_KINDS } from "@/lib/analysis/types.ts";
import {
  buildValueCodec,
  decodeStoredBigInt,
  decodeStoredValue,
} from "@/lib/analysis/valueDecoding.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import {
  evaluateFormula,
  FORMULA_FAMILIES,
  normalizeFormulaTerms,
} from "@/lib/analysis/vertical.ts";
import {
  locateOnAxis,
  longitudeWeights,
  publishedLevels,
  resolveHealpixFrame,
} from "@/lib/grids/analysisGrid.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;

describe("review blockers", () => {
  it("sections keep exact positions above 2^31 and 2^32 (dense order 17)", async () => {
    const store: TStore = new Map();
    const root = zarr.root(store);
    await zarr.create(root, { attributes: {} });
    const n = 12 * 4 ** 17;
    await zarr.create(root.resolve("crs"), {
      shape: [],
      chunkShape: [],
      dtype: "int8",
      attributes: {
        grid_mapping_name: "healpix",
        healpix_nside: 2 ** 17,
        healpix_order: "nest",
      },
      fillValue: 0 as never,
    });
    const depth = await zarr.create(root.resolve("depth"), {
      shape: [2],
      chunkShape: [2],
      dtype: "float64",
      dimensionNames: ["depth"],
      attributes: { units: "m", positive: "down", standard_name: "depth" },
    });
    await zarr.set(depth as never, null, {
      data: Float64Array.from([5, 15]),
      shape: [2],
      stride: [1],
    } as never);
    const temp = await zarr.create(root.resolve("temp"), {
      shape: [2, n],
      chunkShape: [2, 4096],
      dtype: "float64",
      dimensionNames: ["depth", "cell"],
      attributes: { grid_mapping: "crs" },
      fillValue: Number.NaN as never,
    });
    const cell = 11569568933;
    const start = cell - (cell % 4096);
    const data = new Float64Array(2 * 4096).fill(Number.NaN);
    data[cell - start] = 7;
    data[4096 + cell - start] = 9;
    await zarr.set(temp as never, [null, zarr.slice(start, start + 4096)], {
      data,
      shape: [2, 4096],
      stride: [4096, 1],
    } as never);
    const grid = new healpixGeo.Grid({ scheme: "nested", level: 17 });
    const [lon, lat] = grid.healpixToLonLat(new BigUint64Array([BigInt(cell)]));
    const dataset = zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      "o17"
    );
    const context = await resolveVariableContext(
      dataset,
      "temp",
      new ByteLru(1 << 20)
    );
    const tiny = 1e-6; // both samples inside the same order-17 cell
    const planned = await planAnalysis(
      context,
      {
        version: 1,
        kind: ANALYSIS_KINDS.SECTION,
        source: { ref: "m", versionStatus: "session" },
        variable: "temp",
        fixed: {},
        sectionSamples: 2,
        geometry: {
          kind: "polyline",
          vertices: [
            { lat, lon },
            { lat: lat + tiny, lon: lon + tiny },
          ],
        },
      },
      new ReadContext()
    );
    const result = await planned.execute();
    expect(result.samples!.cells).toEqual([String(cell), String(cell)]);
    expect(result.values).toEqual([7, 9, 7, 9]);
    grid.free();
  });

  it("a sorted index re-reads an evicted chunk without rejecting it", async () => {
    const ids = [0n, 1n, 2n, 3n, 4n, 5n];
    const reader = {
      length: 6,
      chunkLength: 2,
      readChunk: async (chunk: number) => ids.slice(chunk * 2, chunk * 2 + 2),
    };
    const index = createSortedIndex(
      reader,
      new ByteLru(16),
      "k",
      INDEX_VALIDATION.DECLARED
    );
    expect(await index.positionsOf([0n])).toEqual([0]);
    expect(await index.positionsOf([2n])).toEqual([2]);
    expect(await index.positionsOf([0n, 5n])).toEqual([0, 5]);
  });

  it("wrapped longitude bounds and uneven bounds-free axes", () => {
    const lon = {
      values: Float64Array.from([0, 2, 4]),
      bounds: Float64Array.from([359, 1, 1, 3, 3, 5]),
      periodic: true,
    };
    expect(locateOnAxis(lon, 0).index).toBe(0);
    expect(locateOnAxis(lon, 359.5).index).toBe(0);
    expect(locateOnAxis(lon, 180).index).toBe(-1);
    expect((longitudeWeights(lon)![0] * 180) / Math.PI).toBeCloseTo(2, 12);
    // A regional (non-periodic) longitude axis unwraps its bounds too.
    const regional = {
      values: Float64Array.from([0, 2]),
      bounds: Float64Array.from([359, 1, 1, 3]),
      periodic: false,
      longitude: true,
    };
    expect(locateOnAxis(regional, 0).index).toBe(0);
    expect(locateOnAxis(regional, -0.5).index).toBe(0);
    expect(locateOnAxis(regional, 2.5).index).toBe(1);
    expect((longitudeWeights(regional)![0] * 180) / Math.PI).toBeCloseTo(2, 12);
    const uneven = { values: Float64Array.from([0, 1, 10]), periodic: false };
    expect(locateOnAxis(uneven, 5)).toEqual({ index: 1, nearest: true });
    expect(locateOnAxis(uneven, 6)).toEqual({ index: 2, nearest: true });
    expect(locateOnAxis(uneven, 14).index).toBe(2); // last cell: half its inner spacing outward
    expect(locateOnAxis(uneven, 15).index).toBe(-1);
    const descending = {
      values: Float64Array.from([60, 30, 0]),
      periodic: false,
    };
    expect(locateOnAxis(descending, 25).index).toBe(1);
  });

  it("decimation keeps an interior gap where it occurs", () => {
    const x = Array.from({ length: 40 }, (_, i) => i);
    const y = x.map((i) => (i === 5 ? NaN : Math.sin(i)));
    const reduced = reduceForDisplay(x, y, 4);
    for (let at = 1; at < reduced.x.length; at++) {
      expect(reduced.x[at]).toBeGreaterThanOrEqual(reduced.x[at - 1]);
    }
    const gap = reduced.y.findIndex(Number.isNaN);
    expect(reduced.x[gap - 1]).toBeLessThan(5);
    expect(reduced.x[gap + 1]).toBeGreaterThan(5);
  });

  it("keeps the latest available value when a partial stream ends between display bucket boundaries", () => {
    const x = Array.from({ length: 1000 }, (_, i) => i);
    const y = Array<number>(1000).fill(Number.NaN);
    y[802] = 42;
    y[803] = 99;
    const plotted = reduceForDisplay(x, y, 200, 803);
    expect(plotted.x.at(-1)).toBe(802);
    expect(plotted.y.filter(Number.isFinite)).toEqual([42]);
  });

  it("decimation never draws a line across a missing sample", () => {
    // Gaps at bucket edges and inside buckets, single and runs.
    const n = 10_000;
    const x = Array.from({ length: n }, (_, i) => i);
    const holes = new Set([0, 1, 2499, 2500, 4000, 7777, 7778, 7779, n - 1]);
    const y = x.map((i) => (holes.has(i) ? NaN : Math.cos(i / 37)));
    const reduced = reduceForDisplay(x, y, 40);
    expect(reduced.x.length).toBeLessThan(400);
    for (let at = 1; at < reduced.x.length; at++) {
      const a = reduced.x[at - 1];
      const b = reduced.x[at];
      if (Number.isNaN(reduced.y[at - 1]) || Number.isNaN(reduced.y[at])) {
        continue;
      }
      // Two drawn neighbours never span a hole.
      for (const hole of holes) {
        expect(hole > a && hole < b).toBe(false);
      }
    }
    expect(Number.isNaN(reduced.y[reduced.y.length - 1])).toBe(true);
  });

  it("hybrid pressure terms in hPa are converted to Pa", () => {
    const units = normalizeFormulaTerms({ ap: "Pa", b: "1", ps: "hPa" });
    const p = evaluateFormula(
      FORMULA_FAMILIES.HYBRID_PRESSURE,
      {
        perLevel: { ap: Float64Array.from([0]), b: Float64Array.from([1]) },
        scalar: { ps: 1000 },
      },
      1,
      units
    );
    expect(p[0]).toBe(100000);
  });

  it("order zero and RING stay as declared", () => {
    const frame = resolveHealpixFrame({
      dggs: { name: "healpix", refinement_level: 0, indexing_scheme: "ring" },
    });
    expect(frame.options).toMatchObject({ level: 0, scheme: "ring" });
  });

  it("restored queries are validated before any read", () => {
    const base = { version: 1, fixed: {}, variable: "tas" };
    expect(
      validateRestoredQuery({
        ...base,
        kind: "section",
        geometry: { kind: "polyline", vertices: [{ lat: 0, lon: 0 }] },
      })
    ).toBe(false);
    expect(
      validateRestoredQuery({
        ...base,
        kind: "section",
        geometry: { kind: "point", lat: 0, lon: 0 },
      })
    ).toBe(false);
    expect(
      validateRestoredQuery({
        ...base,
        kind: "point-series",
        geometry: { kind: "point", lat: 95, lon: 0 },
      })
    ).toBe(false);
    expect(
      validateRestoredQuery({
        ...base,
        kind: "point-series",
        geometry: { kind: "point", lat: 45, lon: 10 },
      })
    ).toBe(true);
  });

  it("Zarr v3 storage fill zero is not a missing marker; v2 fill still is", () => {
    expect(decodeStoredValue(buildValueCodec({}, 0, "float32", 3), 0)).toBe(0);
    expect(
      decodeStoredValue(buildValueCodec({}, 0, "float32", 2), 0)
    ).toBeNaN();
    expect(
      decodeStoredValue(buildValueCodec({ _FillValue: 0 }, 0, "float32", 3), 0)
    ).toBeNaN();
    // An unwritten chunk reads as the logical fill: 0 is valid in v3, a
    // missing marker in v2.
    expect(buildValueCodec({}, 0, "float32", 3).absentValue).toBe(0);
    expect(buildValueCodec({}, 0, "float32", 2).absentValue).toBeNaN();
    expect(
      buildValueCodec({ _FillValue: 0 }, 0, "float32", 3).absentValue
    ).toBeNaN();
  });

  it("a new reader of an aborted in-flight chunk gets a fresh read", async () => {
    let reads = 0;
    const array = {
      key: "a",
      shape: [1],
      chunks: [1],
      dtype: "float64",
      attrs: {},
      dimensionNames: ["x"],
      fillValue: null,
      readChunk: async (_: number[], signal?: AbortSignal) => {
        reads++;
        await new Promise((resolve) => setTimeout(resolve, 20));
        if (signal?.aborted) {
          throw new DOMException("Aborted", "AbortError");
        }
        return {
          data: Float64Array.from([1]),
          shape: [1],
          stride: [1],
          absent: false,
        };
      },
    };
    const read = new ReadContext();
    const first = new AbortController();
    const counters = emptyCounters();
    const cancelled = read.read(array, [0], counters, first.signal);
    // Abort once the source read has started (it then ignores nothing).
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(reads).toBe(1);
    first.abort(new DOMException("Cancelled", "AbortError"));
    await expect(cancelled).rejects.toMatchObject({ name: "AbortError" });
    const chunk = await read.read(array, [0], counters);
    expect(Array.from(chunk.data as Float64Array)).toEqual([1]);
    expect(reads).toBe(2);
  });
});

describe("read limiter queue", () => {
  it("a waiter aborted right after its grant passes the slot on", async () => {
    const limiter = new ReadLimiter(1);
    let finishA!: () => void;
    const a = limiter.run(
      () => new Promise<void>((resolve) => (finishA = resolve))
    );
    const bAbort = new AbortController();
    const b = limiter.run(async () => "b", bAbort.signal);
    const c = limiter.run(async () => "c");
    await new Promise((resolve) => setTimeout(resolve, 0));
    finishA();
    // B is granted, then aborted before its task can start.
    bAbort.abort(new DOMException("Cancelled", "AbortError"));
    await a;
    await expect(b).rejects.toMatchObject({ name: "AbortError" });
    await expect(c).resolves.toBe("c");
    expect(limiter.running).toBe(0);
    expect(limiter.pending).toBe(0);
  });

  it("holds a decoded reservation until an abort-insensitive read settles", async () => {
    let finish!: () => void;
    const array = {
      key: "slow",
      shape: [1],
      chunks: [1],
      dtype: "float64",
      attrs: {},
      dimensionNames: ["x"],
      fillValue: null,
      readChunk: () =>
        new Promise<never>((resolve) => {
          finish = () =>
            resolve({
              data: Float64Array.from([1]),
              shape: [1],
              stride: [1],
              absent: false,
            } as never);
        }),
    };
    const read = new ReadContext(new ReadLimiter(4), 1024, 8);
    const controller = new AbortController();
    const visit = visitRuns(
      read,
      array as never,
      buildValueCodec({}, null, "float64"),
      [[[0, 1]]],
      () => undefined,
      emptyCounters(),
      controller.signal
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort(new DOMException("Cancelled", "AbortError"));
    await expect(visit).rejects.toMatchObject({ name: "AbortError" });
    // The source still decodes: its bytes stay reserved.
    expect(read.budget.reserved).toBe(8);
    finish();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(read.budget.reserved).toBe(0);
  });
});

describe("periodic axes in 0–360", () => {
  it("finds western longitudes on a 0..360 axis, with and without bounds", () => {
    const centres = Float64Array.from({ length: 360 }, (_, j) => j + 0.5);
    const bounded = {
      values: centres,
      bounds: Float64Array.from(
        [...centres].flatMap((c) => [c - 0.5, c + 0.5])
      ),
      periodic: true,
    };
    const bare = { values: centres, periodic: true };
    for (const axis of [bounded, bare]) {
      expect(locateOnAxis(axis, -31.1).index).toBe(328);
      expect(locateOnAxis(axis, -0.2).index).toBe(359);
      expect(locateOnAxis(axis, 359.9).index).toBe(359);
      expect(locateOnAxis(axis, 0.1).index).toBe(0);
      expect(locateOnAxis(axis, 540.25).index).toBe(180);
    }
  });
});

describe("published pyramid levels", () => {
  it("reads the levels a multiscales attribute publishes", () => {
    expect(
      publishedLevels({
        multiscales: [{ datasets: [{ path: "17" }, { path: "8" }] }],
      })
    ).toEqual(["17", "8"]);
  });
});

it("review of interim26: NetCDF's default fill is missing when no _FillValue is declared", () => {
  const unwritten = Math.fround(9.969209968386869e36);
  const netcdf = buildValueCodec({}, null, "float32", -2);
  expect(decodeStoredValue(netcdf, unwritten)).toBeNaN();
  expect(decodeStoredValue(netcdf, 10)).toBe(10);
  expect(netcdf.rule).toMatch(/NetCDF's default fill/);
  // Declared fills decide instead; bytes keep their default as a value.
  expect(
    decodeStoredValue(
      buildValueCodec({ _FillValue: -1 }, -1, "float32", -2),
      unwritten
    )
  ).toBe(unwritten);
  expect(decodeStoredValue(buildValueCodec({}, null, "int8", -2), -127)).toBe(
    -127
  );
  expect(
    decodeStoredValue(buildValueCodec({}, null, "int16", -2), -32767)
  ).toBeNaN();
  // Zarr is not NetCDF: no default fill there.
  expect(
    decodeStoredValue(buildValueCodec({}, null, "float32", 3), unwritten)
  ).toBe(unwritten);
});

it("review of interim30: 64-bit NetCDF default fills are missing, compared exactly", () => {
  const signed = buildValueCodec({}, null, "int64", -2);
  const unsigned = buildValueCodec({}, null, "uint64", -2);
  expect(decodeStoredBigInt(signed, -9223372036854775806n)).toBeNaN();
  expect(decodeStoredBigInt(unsigned, 18446744073709551614n)).toBeNaN();
  expect(decodeStoredBigInt(signed, 4n)).toBe(4);
  expect(decodeStoredBigInt(unsigned, 8n)).toBe(8);
  // A neighbouring valid integer is no fill, although both round to one
  // Number.
  expect(decodeStoredBigInt(signed, -9223372036854775805n)).toBe(
    Number(-9223372036854775805n)
  );
  expect(signed.rule).toMatch(/NetCDF's default fill/);
  // A declared fill decides instead: a positive one limits from above only.
  expect(
    decodeStoredBigInt(
      buildValueCodec({ _FillValue: 99 }, 99, "int64", -2),
      -9223372036854775806n
    )
  ).toBe(Number(-9223372036854775806n));
});

describe("review of interim26 #40: an impossible calendar date", () => {
  it("is reported, not thrown, and a valid one still encodes", () => {
    const axis = parseTimeAxis("days since 2000-01-01", "360_day");
    if ("unsupported" in axis) {
      throw new Error(axis.unsupported);
    }
    const bad = encodeTypedDate(axis, parseCalendarDate("2001-01-31")!);
    expect(bad).toEqual({
      problem: "2001-1-31 is not a date of this calendar (360_day).",
    });
    expect(encodeTypedDate(axis, parseCalendarDate("2001-01-30")!)).toEqual({
      value: 360 + 29,
    });
  });
});

it("review of interim33: `_Unsigned` int64 storage reads NetCDF's default fill as missing", () => {
  // One written value of 10 and three unwritten cells: mean 10 at 25 %.
  const codec = buildValueCodec({ _Unsigned: "true" }, null, "int64", -2);
  const cells = [
    10n,
    -9223372036854775806n,
    -9223372036854775806n,
    -9223372036854775806n,
  ];
  const values = cells.map((raw) => decodeStoredBigInt(codec, raw));
  expect(values.filter(Number.isFinite)).toEqual([10]);
  // A neighbouring stored value is a real (large unsigned) observation.
  expect(decodeStoredBigInt(codec, -9223372036854775805n)).toBe(
    Number(2n ** 64n - 9223372036854775805n)
  );
});

it("review of interim33: an exact 64-bit integer offset unpacks exactly", () => {
  const codec = buildValueCodec(
    { scale_factor: 1n, add_offset: -9007199254740993n },
    null,
    "int64",
    -2
  );
  const raw = [
    9007199254740993n,
    9007199254740994n,
    9007199254740995n,
    9007199254740996n,
  ];
  expect(raw.map((r) => decodeStoredBigInt(codec, r))).toEqual([0, 1, 2, 3]);
});
