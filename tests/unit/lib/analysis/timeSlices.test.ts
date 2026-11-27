/* eslint-disable camelcase -- CF and Zarr metadata use snake_case keys. */
/**
 * Date ranges in several stored slices (25 Nov): a file storing Jan 1,
 * Jan 4, Jan 2, Jan 3 holds Jan 1 to Jan 3 in the slices [0, 1) and
 * [2, 4). The plot reads those three dates, not Jan 4, through the real
 * readers.
 */
import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { createPartialAssembler } from "@/lib/analysis/partialUpdates.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import {
  rowCount,
  rowIndices,
  rowsBefore,
  selectionOf,
} from "@/lib/analysis/timeRows.ts";
import {
  ANALYSIS_KINDS,
  type TAnalysisQuery,
  type TAnalysisResult,
  type TGeometry,
  type TPartialUpdate,
} from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

const ORDER = 1;
const NCELL = 12 * 4 ** ORDER;
/** Days since 2000-01-01 as stored: Jan 1, Jan 4, Jan 2, Jan 3. */
const DAYS = [0, 3, 1, 2];
const value = (day: number, cell: number) => 100 * day + cell;

async function buildStore(days = DAYS, timeChunk = 1) {
  const store = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(store), { attributes: {} });
  const time = await zarr.create(zarr.root(store).resolve("time"), {
    shape: [days.length],
    chunkShape: [days.length],
    dtype: "float64",
    dimensionNames: ["time"],
    attributes: { units: "days since 2000-01-01", calendar: "standard" },
  });
  await zarr.set(time as never, null, {
    data: Float64Array.from(days),
    shape: [days.length],
    stride: [1],
  } as never);
  const crs = await zarr.create(zarr.root(store).resolve("crs"), {
    shape: [],
    chunkShape: [],
    dtype: "int8",
    attributes: {
      grid_mapping_name: "healpix",
      healpix_nside: 2 ** ORDER,
      healpix_order: "nest",
    },
  });
  void crs;
  // One date a chunk: each date read is one chunk read.
  const tas = await zarr.create(zarr.root(store).resolve("tas"), {
    shape: [days.length, NCELL],
    chunkShape: [timeChunk, NCELL],
    dtype: "float64",
    dimensionNames: ["time", "cell"],
    fillValue: Number.NaN as never,
    attributes: { grid_mapping: "crs", units: "K" },
  });
  const data = new Float64Array(days.length * NCELL);
  days.forEach((day, t) => {
    for (let cell = 0; cell < NCELL; cell++) {
      data[t * NCELL + cell] = value(day, cell);
    }
  });
  await zarr.set(tas as never, null, {
    data,
    shape: [days.length, NCELL],
    stride: [NCELL, 1],
  } as never);
  return store;
}

const store = await buildStore();
const indexCache = new ByteLru<BigInt64Array>(2 ** 20);

async function run(
  geometry: TGeometry,
  time: TAnalysisQuery["time"],
  kind: TAnalysisQuery["kind"] = ANALYSIS_KINDS.POINT_SERIES
) {
  // A dataset of its own each run: no chunk read is served from another.
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `slices-${Math.random()}`
  );
  const context = await resolveVariableContext(dataset, "tas", indexCache);
  const query: TAnalysisQuery = {
    version: 1,
    kind,
    source: { ref: "memory://slices", versionStatus: "session" },
    variable: "tas",
    geometry,
    fixed: {},
    time,
  };
  const planned = await planAnalysis(context, query, new ReadContext());
  const partials: TAnalysisResult[] = [];
  const result = await planned.execute(undefined, {
    onPartial: createPartialAssembler((partial) => partials.push(partial)),
  });
  return { estimate: planned.estimate, result, partials };
}

const POINT: TGeometry = { kind: "point", lat: 41.81, lon: 45 };
const JAN_1_TO_3 = {
  start: 0,
  stop: 4,
  runs: [
    [0, 1],
    [2, 4],
  ],
} as NonNullable<TAnalysisQuery["time"]>;

// eslint-disable-next-line max-lines-per-function -- groups the date-range integration fixtures.
describe("a date range in two stored slices", () => {
  it("applies the output limit to the complete sliced plan", async () => {
    const dataset = zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      "metadata-limit"
    );
    const context = await resolveVariableContext(dataset, "tas", indexCache);
    // Only the metadata is needed: 4,000,001 selected rows, one skipped.
    const n = 4_000_002;
    context.time = { ...context.time!, raw: new Array<number>(n) };
    context.array = { ...context.array, shape: [n, NCELL], chunks: [128, 1] };
    const q: TAnalysisQuery = {
      version: 1,
      kind: ANALYSIS_KINDS.POINT_SERIES,
      geometry: POINT,
      fixed: {},
      variable: "tas",
      source: { ref: "memory://limit", versionStatus: "session" },
      time: { start: 0, stop: n },
    };
    await expect(planAnalysis(context, q, new ReadContext())).rejects.toThrow(
      /4,000,000/
    );
    q.time!.runs = [
      [0, 2_000_000],
      [2_000_001, n],
    ];
    await expect(planAnalysis(context, q, new ReadContext())).rejects.toThrow(
      /4,000,000/
    );
  });

  it("sends a single full base for a sliced point stream", async () => {
    const dataset = zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      "stream-bases"
    );
    const context = await resolveVariableContext(dataset, "tas", indexCache);
    const make = async (time: TAnalysisQuery["time"]) => {
      const q: TAnalysisQuery = {
        version: 1,
        kind: ANALYSIS_KINDS.POINT_SERIES,
        geometry: POINT,
        fixed: {},
        variable: "tas",
        source: { ref: "memory://bases", versionStatus: "session" },
        time,
      };
      const planned = await planAnalysis(context, q, new ReadContext());
      const bases: number[] = [];
      const result = await planned.execute(undefined, {
        onPartial: (u) => {
          if (u.base) {
            bases.push(u.base.values.length);
          }
        },
      });
      return { bases, result };
    };
    const contiguous = await make({ start: 0, stop: 3 });
    expect(contiguous.bases).toEqual([3]);
    const sliced = await make(JAN_1_TO_3);
    expect(sliced.result.values).toHaveLength(3);
    expect(sliced.bases).toEqual([3]);
  });

  it("is found from the dates: Jan 1 to Jan 3 is [0, 1) and [2, 4)", () => {
    expect(selectionOf(DAYS, 0, 2, 0, 4)).toEqual(JAN_1_TO_3);
    // Stored together: one slice, as before.
    expect(selectionOf(DAYS, 1, 2, 0, 4)).toEqual({ start: 2, stop: 4 });
    expect(rowCount(JAN_1_TO_3)).toBe(3);
    expect(rowIndices(JAN_1_TO_3)).toEqual([0, 2, 3]);
    expect(rowsBefore(JAN_1_TO_3, 3)).toBe(2);
  });

  it("reads only Jan 1, Jan 2 and Jan 3 at a point", async () => {
    const { estimate, result, partials } = await run(POINT, JAN_1_TO_3);
    const cell = Number(result.cell!.id);
    expect(result.time!.raw).toEqual([0, 1, 2]);
    expect(result.values).toEqual([0, 1, 2].map((d) => value(d, cell)));
    expect(result.query.time).toEqual(JAN_1_TO_3);
    // Three chunks priced and read, not Jan 4's as well.
    expect(estimate.chunks).toBe(3);
    expect(result.counters.chunkReads).toBe(3);
    // Every streamed state holds the three dates, Jan 4 never.
    expect(partials.length).toBeGreaterThan(0);
    for (const partial of partials) {
      expect(partial.time!.raw).toEqual([0, 1, 2]);
      expect(partial.values).toHaveLength(3);
    }
    // A value streamed is the final one (the last part is the result).
    for (const partial of partials) {
      partial.values.forEach((v, row) =>
        expect(Number.isNaN(v) || v === result.values[row]).toBe(true)
      );
    }
    expect(
      partials.some((p) => p.values.some((v) => v === value(1, cell)))
    ).toBe(true);
  });

  it("gives the same dates read from the end", async () => {
    const { result } = await run(POINT, { ...JAN_1_TO_3, fromEnd: true });
    const cell = Number(result.cell!.id);
    expect(result.time!.raw).toEqual([0, 1, 2]);
    expect(result.values).toEqual([0, 1, 2].map((d) => value(d, cell)));
  });
});

describe("a date range in two stored slices, more plots", () => {
  it("averages an area over the three dates only", async () => {
    const box: TGeometry = {
      kind: "box",
      west: -180,
      east: 180,
      south: -90,
      north: 90,
    };
    const { result } = await run(box, JAN_1_TO_3, ANALYSIS_KINDS.REGION_SERIES);
    expect(result.time!.raw).toEqual([0, 1, 2]);
    // Equal-area HEALPix cells: the mean of the cell numbers is 23.5.
    result.values.forEach((v, row) =>
      expect(v).toBeCloseTo(100 * row + (NCELL - 1) / 2, 9)
    );
    expect(result.region!.coverage).toHaveLength(3);
  });

  it("refuses slices that are not whole, ascending and apart", async () => {
    await expect(
      run(POINT, {
        start: 0,
        stop: 4,
        runs: [
          [2, 4],
          [0, 1],
        ],
      })
    ).rejects.toThrow(/slices/);
  });
});

describe("a date range in slices outside the plot", () => {
  it("keeps its slices in a link, which an older build does not open", async () => {
    const { decodeSession, encodeSession } =
      await import("@/lib/analysis/sessionLink.ts");
    const query = {
      version: 1 as const,
      kind: ANALYSIS_KINDS.POINT_SERIES,
      variable: "tas",
      geometry: POINT,
      fixed: {},
      time: JAN_1_TO_3,
    };
    const value = encodeSession({ plots: [{ query }] });
    // Version 4: builds before it would read Jan 4 as well.
    expect(value.startsWith("4.")).toBe(true);
    expect(decodeSession(value).plots[0].query.time).toEqual(JAN_1_TO_3);
    // One slice: the link stays version 2, as before.
    const plain = encodeSession({
      plots: [{ query: { ...query, time: { start: 2, stop: 4 } } }],
    });
    expect(plain.startsWith("2.")).toBe(true);
    // Slices out of order, overlapping or beyond the range are refused.
    for (const runs of [
      [
        [2, 4],
        [0, 1],
      ],
      [
        [0, 2],
        [1, 4],
      ],
      [
        [0, 1],
        [2, 5],
      ],
    ] as [number, number][][]) {
      const bad = encodeSession({
        plots: [{ query: { ...query, time: { start: 0, stop: 4, runs } } }],
      });
      expect(decodeSession(bad).plots).toHaveLength(0);
    }
  });

  it("names each row's stored index in the CSV", async () => {
    const { resultTable } = await import("@/lib/analysis/analysisExport.ts");
    const { result } = await run(POINT, JAN_1_TO_3);
    const table = resultTable(result);
    const rows = Array.from({ length: table.rowCount }, (_, at) =>
      table.row(at)
    );
    // time_index: 0, 2, 3 (Jan 4, index 1, is not read).
    expect(rows.map((row) => row[0])).toEqual([0, 2, 3]);
    expect(rows.map((row) => row[1])).toEqual([0, 1, 2]);
  });
});

it("prices a fragmented point selection from one field chunk only once", async () => {
  const n = 513;
  const days = Array.from({ length: 2 * n }, (_, i) =>
    i % 2 === 0 ? i / 2 : n + Math.floor(i / 2)
  );
  const source = await buildStore(days, days.length);
  const dataset = zarrAnalysisDatasetFromStore(
    source as never,
    "",
    ZARR_FORMAT.V3,
    "one-chunk-many-slices"
  );
  const context = await resolveVariableContext(dataset, "tas", indexCache);
  const time = selectionOf(days, 0, n - 1, 0, days.length);
  expect(time.runs).toHaveLength(n);
  const query: TAnalysisQuery = {
    version: 1,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    geometry: POINT,
    variable: "tas",
    fixed: {},
    source: { ref: "memory://one-chunk", versionStatus: "session" },
    time,
  };
  const planned = await planAnalysis(context, query, new ReadContext());
  const result = await planned.execute();
  expect(result.values).toHaveLength(n);
  expect(result.counters.chunkReads).toBe(1);
  console.info("Fragmented selection", {
    quotedChunks: planned.estimate.chunks,
    quotedBytes: planned.estimate.decodedBytes,
    modest: planned.estimate.modest,
    dataChunksRead: result.counters.chunkReads,
    actualDecodedBytes: result.counters.decodedBytes,
    chunkCacheHits: result.counters.cacheHits,
  });
  expect(planned.estimate.chunks).toBe(result.counters.chunkReads);
});

it("review of interim45: quotes every reread when the shared chunk cannot stay cached", async () => {
  const n = 513;
  const days = Array.from({ length: 2 * n }, (_, i) =>
    i % 2 === 0 ? i / 2 : n + Math.floor(i / 2)
  );
  const source = await buildStore(days, days.length);
  const dataset = zarrAnalysisDatasetFromStore(
    source as never,
    "",
    ZARR_FORMAT.V3,
    "one-chunk-many-slices"
  );
  const context = await resolveVariableContext(dataset, "tas", indexCache);
  const time = selectionOf(days, 0, n - 1, 0, days.length);
  expect(time.runs).toHaveLength(n);
  const query: TAnalysisQuery = {
    version: 1,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    geometry: POINT,
    variable: "tas",
    fixed: {},
    source: { ref: "memory://one-chunk", versionStatus: "session" },
    time,
  };
  const planned = await planAnalysis(
    context,
    query,
    new ReadContext(undefined, 1024)
  );
  const result = await planned.execute();
  expect(result.values).toHaveLength(n);
  expect(planned.estimate.chunks).toBe(n);
});

// eslint-disable-next-line max-lines-per-function
it("independent review of interim45: 512 slices publish a few updates, and a stop keeps what was read", async () => {
  const n = 512;
  const days = Array.from({ length: 2 * n }, (_, i) =>
    i % 2 === 0 ? i / 2 : n + Math.floor(i / 2)
  );
  const source = await buildStore(days, 2);
  const dataset = zarrAnalysisDatasetFromStore(
    source as never,
    "",
    ZARR_FORMAT.V3,
    "many-slices-updates"
  );
  const context = await resolveVariableContext(dataset, "tas", indexCache);
  const query: TAnalysisQuery = {
    version: 1,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    geometry: POINT,
    variable: "tas",
    fixed: {},
    source: { ref: "memory://updates", versionStatus: "session" },
    time: selectionOf(days, 0, n - 1, 0, days.length),
  };
  let updates = 0;
  const planned = await planAnalysis(context, query, new ReadContext());
  const result = await planned.execute(undefined, {
    publishEveryMs: 60_000,
    onPartial: () => updates++,
  });
  expect(result.values.filter(Number.isFinite)).toHaveLength(n);
  expect(updates).toBeLessThanOrEqual(2);
  // Stopped part-way: the last update holds every slice finished before.
  const controller = new AbortController();
  let last: TPartialUpdate | undefined;
  let reads = 0;
  const stopping = zarrAnalysisDatasetFromStore(
    {
      get: async (key: string) => {
        if (key.startsWith("/tas/c/") && ++reads === 40) {
          controller.abort(new DOMException("Stopped", "AbortError"));
        }
        return source.get(key);
      },
    } as never,
    "",
    ZARR_FORMAT.V3,
    "many-slices-stop"
  );
  const again = await resolveVariableContext(stopping, "tas", indexCache);
  const plan = await planAnalysis(again, query, new ReadContext());
  await expect(
    plan.execute(controller.signal, {
      publishEveryMs: 60_000,
      onPartial: (update) => (last = update),
    })
  ).rejects.toThrow();
  const kept = last?.base?.values.filter(Number.isFinite).length ?? 0;
  expect(kept).toBeGreaterThanOrEqual(30);
});

it("interim48: slices read while updates wait are shown when the wait ends, before a held read", async () => {
  const n = 8;
  const days = Array.from({ length: 2 * n }, (_, i) =>
    i % 2 === 0 ? i / 2 : n + Math.floor(i / 2)
  );
  const source = await buildStore(days, 1);
  let reads = 0;
  let release!: () => void;
  const held = new Promise<void>((resolve) => (release = resolve));
  const dataset = zarrAnalysisDatasetFromStore(
    {
      get: async (key: string) => {
        if (key.startsWith("/tas/c/") && ++reads === 4) {
          await held;
        }
        return source.get(key);
      },
    } as never,
    "",
    ZARR_FORMAT.V3,
    "held-fourth-slice"
  );
  const context = await resolveVariableContext(dataset, "tas", indexCache);
  const query: TAnalysisQuery = {
    version: 1,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    geometry: POINT,
    variable: "tas",
    fixed: {},
    source: { ref: "memory://held", versionStatus: "session" },
    time: selectionOf(days, 0, n - 1, 0, days.length),
  };
  let last: TPartialUpdate | undefined;
  const plan = await planAnalysis(context, query, new ReadContext());
  const running = plan.execute(undefined, {
    publishEveryMs: 50,
    onPartial: (update) => (last = update.base ? update : last),
  });
  await new Promise((resolve) => setTimeout(resolve, 200));
  // Three slices read, the fourth held: all three are on screen.
  expect(last?.base?.values.filter(Number.isFinite)).toHaveLength(3);
  release();
  await running;
});
