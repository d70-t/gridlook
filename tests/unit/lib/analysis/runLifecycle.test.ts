/* eslint-disable max-lines-per-function -- each gate builds its own fixture. */
import { describe, expect, it, vi } from "vitest";
import * as zarr from "zarrita";

import { AnalysisRunner } from "@/lib/analysis/analysisRunner.ts";
import { ByteLru } from "@/lib/analysis/byteLru.ts";
import {
  countRunChunks,
  ReadContext,
  type TAnalysisArray,
} from "@/lib/analysis/chunkVisitor.ts";
import { streamParts } from "@/lib/analysis/operations.ts";
import { createPartialAssembler } from "@/lib/analysis/partialUpdates.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { polygonContains, preparePolygon } from "@/lib/analysis/sphere.ts";
import {
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  emptyCounters,
  type TAnalysisQuery,
  type TAnalysisResult,
  type TGeometry,
} from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;

const field = (t: number, i: number, j: number) => 1000 * t + 10 * i + j;

async function write(
  store: TStore,
  path: string,
  data: Float64Array,
  shape: number[],
  chunks: number[],
  dims: string[],
  attrs: Record<string, unknown> = {}
) {
  const array = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape: chunks,
    dtype: "float64",
    dimensionNames: dims,
    attributes: attrs,
    fillValue: Number.NaN as never,
  });
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((product, n) => product * n, 1)
  );
  await zarr.set(array as never, null, { data, shape, stride } as never);
}

/** A bounded lat/lon grid with field(t, i, j) and the given chunking. */
async function rectilinear(
  nt: number,
  nlat: number,
  nlon: number,
  chunks: number[]
) {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  const dlat = 180 / nlat;
  const dlon = 360 / nlon;
  const lats = Array.from({ length: nlat }, (_, i) => -90 + dlat * (i + 0.5));
  const lons = Array.from({ length: nlon }, (_, j) => dlon * (j + 0.5));
  await write(store, "lat", Float64Array.from(lats), [nlat], [nlat], ["lat"], {
    units: "degrees_north",
    bounds: "lat_bnds",
  });
  await write(
    store,
    "lat_bnds",
    Float64Array.from(lats.flatMap((v) => [v - dlat / 2, v + dlat / 2])),
    [nlat, 2],
    [nlat, 2],
    ["lat", "nv"]
  );
  await write(store, "lon", Float64Array.from(lons), [nlon], [nlon], ["lon"], {
    units: "degrees_east",
    bounds: "lon_bnds",
  });
  await write(
    store,
    "lon_bnds",
    Float64Array.from(lons.flatMap((v) => [v - dlon / 2, v + dlon / 2])),
    [nlon, 2],
    [nlon, 2],
    ["lon", "nv"]
  );
  await write(
    store,
    "time",
    Float64Array.from({ length: nt }, (_, t) => t),
    [nt],
    [nt],
    ["time"],
    { units: "days since 2000-01-01" }
  );
  const data = new Float64Array(nt * nlat * nlon);
  for (let t = 0; t < nt; t++) {
    for (let i = 0; i < nlat; i++) {
      for (let j = 0; j < nlon; j++) {
        data[(t * nlat + i) * nlon + j] = field(t, i, j);
      }
    }
  }
  await write(store, "tas", data, [nt, nlat, nlon], chunks, [
    "time",
    "lat",
    "lon",
  ]);
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `rect-${nt}-${nlat}-${nlon}-${chunks.join("x")}`
  );
  const context = await resolveVariableContext(
    dataset,
    "tas",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
  return { context, lats, lons, dlat };
}

function query(
  kind: TAnalysisQuery["kind"],
  geometry: TGeometry,
  time?: { start: number; stop: number }
): TAnalysisQuery {
  return {
    version: ALGORITHM_VERSION,
    kind,
    source: { ref: "memory", versionStatus: "session" },
    variable: "tas",
    geometry,
    time,
    fixed: {},
  };
}

/** Area-weighted mean over cells chosen by `inside`, from first principles. */
function oracleMean(
  t: number,
  lats: number[],
  lons: number[],
  dlat: number,
  inside: (lat: number, lon: number) => boolean
) {
  let sum = 0;
  let weight = 0;
  const cells: [number, number][] = [];
  lats.forEach((lat, i) => {
    const w =
      Math.sin(((lat + dlat / 2) * Math.PI) / 180) -
      Math.sin(((lat - dlat / 2) * Math.PI) / 180);
    lons.forEach((lon, j) => {
      if (inside(lat, lon)) {
        sum += w * field(t, i, j);
        weight += w;
        cells.push([i, j]);
      }
    });
  });
  return { mean: sum / weight, cells };
}

describe("bounded, single-owner runs", () => {
  it("area means hold one batch of chunk-interval sums, however long the series", async () => {
    const box = {
      kind: "box" as const,
      west: 10,
      east: 350,
      south: -60,
      north: 60,
    };
    const peaks: number[] = [];
    for (const nt of [48, 192]) {
      const { context, lats, lons, dlat } = await rectilinear(
        nt,
        16,
        32,
        [8, 2, 2]
      );
      const planned = await planAnalysis(
        context,
        query(ANALYSIS_KINDS.REGION_SERIES, box),
        new ReadContext()
      );
      const result = await planned.execute();
      for (const t of [0, nt - 1]) {
        const { mean } = oracleMean(
          t,
          lats,
          lons,
          dlat,
          (lat, lon) => lat >= -60 && lat <= 60 && lon >= 10 && lon <= 350
        );
        // Summation order differs from the oracle: compare relatively.
        expect(Math.abs(result.values[t] - mean) / mean).toBeLessThan(1e-12);
      }
      expect(result.counters.peakAccumulatorBytes).toBeGreaterThan(0);
      // four parts in flight × 16 chunk jobs × 8 times × 3 Float64 sums
      expect(result.counters.peakAccumulatorBytes).toBeLessThanOrEqual(
        4 * 16 * 8 * 24
      );
      expect(planned.estimate.workingBytes).toBeGreaterThanOrEqual(
        result.counters.peakAccumulatorBytes
      );
      peaks.push(result.counters.peakAccumulatorBytes);
    }
    // Four times the time steps, same bound.
    expect(peaks[1]).toBeLessThanOrEqual(4 * 16 * 8 * 24);
  });

  it("a narrow diagonal polygon reads only chunks that hold its cells", async () => {
    const { context, lats, lons, dlat } = await rectilinear(
      8,
      32,
      64,
      [8, 2, 2]
    );
    const vertices = [
      { lat: -40, lon: 20 },
      { lat: -38, lon: 20 },
      { lat: 40, lon: 100 },
      { lat: 38, lon: 100 },
    ];
    const polygon = preparePolygon(vertices);
    const { mean, cells } = oracleMean(5, lats, lons, dlat, (lat, lon) =>
      polygonContains(polygon, lat, lon)
    );
    expect(cells.length).toBeGreaterThan(4);
    const touched = new Set(
      cells.map(([i, j]) => `${Math.floor(i / 2)},${Math.floor(j / 2)}`)
    );
    const rows = cells.map(([i]) => Math.floor(i / 2));
    const cols = cells.map(([, j]) => Math.floor(j / 2));
    const enclosing =
      (Math.max(...rows) - Math.min(...rows) + 1) *
      (Math.max(...cols) - Math.min(...cols) + 1);
    const planned = await planAnalysis(
      context,
      query(ANALYSIS_KINDS.REGION_SERIES, { kind: "polygon", vertices }),
      new ReadContext()
    );
    const result = await planned.execute();
    expect(result.values[5]).toBeCloseTo(mean, 9);
    expect(result.region!.totalCells).toBe(String(cells.length));
    expect(planned.estimate.chunks).toBe(touched.size);
    expect(result.counters.chunkReads).toBe(touched.size);
    expect(touched.size).toBeLessThan(enclosing / 2);
  });

  it("refuses an oversized chunk before reading, and counts chunks without listing them", async () => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    await write(store, "lat", Float64Array.from([0, 1]), [2], [2], ["lat"], {
      units: "degrees_north",
    });
    await write(store, "lon", Float64Array.from([0, 1]), [2], [2], ["lon"], {
      units: "degrees_east",
    });
    await write(store, "time", Float64Array.from([0, 1]), [2], [2], ["time"], {
      units: "days since 2000-01-01",
    });
    await zarr.create(zarr.root(store).resolve("tas"), {
      shape: [2, 2, 2],
      chunkShape: [8192, 2048, 2048],
      dtype: "float64",
      dimensionNames: ["time", "lat", "lon"],
      attributes: {},
      fillValue: Number.NaN as never,
    });
    const context = await resolveVariableContext(
      zarrAnalysisDatasetFromStore(store as never, "", ZARR_FORMAT.V3, "huge"),
      "tas",
      new ByteLru<BigInt64Array>(2 ** 20)
    );
    const read = new ReadContext();
    await expect(
      planAnalysis(
        context,
        query(ANALYSIS_KINDS.POINT_SERIES, { kind: "point", lat: 0, lon: 0 }),
        read
      )
    ).rejects.toThrow(/smaller chunks/);
    expect(read.chunkCache.bytes).toBe(0);
    // A full dense order-17 sphere at 4,096 cells per chunk, times 10 steps.
    expect(countRunChunks([[[0, 12 * 4 ** 17]], [[0, 10]]], [4096, 1])).toBe(
      50_331_648 * 10
    );
    expect(
      countRunChunks(
        [
          [
            [0, 5],
            [3, 9],
            [20, 21],
          ],
        ],
        [4]
      )
    ).toBe(4);
  });

  it("point series read ahead under the reader limit and show parts in time order", async () => {
    const { context } = await rectilinear(48, 4, 4, [4, 4, 4]);
    let active = 0;
    let peak = 0;
    const original = context.array.readChunk.bind(context.array);
    context.array.readChunk = async (coords, signal) => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      try {
        return await original(coords, signal);
      } finally {
        active--;
      }
    };
    const shown: TAnalysisResult[] = [];
    const planned = await planAnalysis(
      context,
      query(ANALYSIS_KINDS.POINT_SERIES, { kind: "point", lat: 30, lon: 100 }),
      new ReadContext()
    );
    const final = await planned.execute(undefined, {
      onPartial: createPartialAssembler((partial) =>
        shown.push({ ...partial, values: partial.values.slice() })
      ),
    });
    expect(peak).toBeGreaterThan(1);
    expect(peak).toBeLessThanOrEqual(4);
    // The empty frame, then one update per part (one time chunk each).
    expect(shown).toHaveLength(12);
    expect(shown[0].partial!.readUntil).toBe(0);
    expect(shown[0].values.every(Number.isNaN)).toBe(true);
    shown.slice(1).forEach((partial, at) => {
      const readUntil = partial.partial!.readUntil;
      expect(readUntil).toBe(4 * (at + 1));
      expect(partial.values.slice(0, readUntil)).toEqual(
        final.values.slice(0, readUntil)
      );
      expect(partial.values.slice(readUntil).every(Number.isNaN)).toBe(true);
    });
    // The time axis is sent with the first part only.
    expect(final.values.every(Number.isFinite)).toBe(true);
  });

  it("a pause stops new reads after the parts already in flight", async () => {
    const { context } = await rectilinear(48, 4, 4, [4, 4, 4]);
    let reads = 0;
    const original = context.array.readChunk.bind(context.array);
    context.array.readChunk = (coords, signal) => {
      reads++;
      return original(coords, signal);
    };
    let resume!: () => void;
    let paused = true;
    const planned = await planAnalysis(
      context,
      query(ANALYSIS_KINDS.POINT_SERIES, { kind: "point", lat: 30, lon: 100 }),
      new ReadContext()
    );
    const running = planned.execute(undefined, {
      waitIfPaused: () =>
        paused
          ? new Promise<void>((resolve) => {
              resume = () => {
                paused = false;
                resolve();
              };
            })
          : Promise.resolve(),
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    // Paused after the first part: only the eight parts read ahead started.
    expect(reads).toBeLessThanOrEqual(8);
    resume();
    const result = await running;
    expect(reads).toBe(12);
    expect(result.values.every(Number.isFinite)).toBe(true);
  });
});

describe("progress while reading", () => {
  it("publishes at most once per interval, and never holds a read part back longer", async () => {
    const gates = Array.from({ length: 4 }, () => {
      let open!: () => void;
      const promise = new Promise<void>((resolve) => (open = resolve));
      return { promise, open };
    });
    const shown: string[] = [];
    const wait = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));
    const running = streamParts(
      4,
      4,
      undefined,
      (part) => gates[part].promise,
      async (part, publish) => {
        shown.push(`${part}${publish ? "" : " (held)"}`);
      },
      40
    );
    gates[0].open();
    gates[1].open();
    await wait(5);
    // Part 0 is shown at once; part 1 comes within the interval: held.
    expect(shown).toEqual(["0", "1 (held)"]);
    // Part 2 is slow: part 1 is published when the interval has passed.
    await wait(80);
    expect(shown).toEqual(["0", "1 (held)", "1"]);
    gates[2].open();
    gates[3].open();
    await running;
    // The last part is always published.
    expect(shown.at(-1)).toBe("3");
  });

  it("separates fetching stored bytes from decoding them", async () => {
    const { context } = await rectilinear(48, 4, 4, [4, 4, 4]);
    const planned = await planAnalysis(
      context,
      query(ANALYSIS_KINDS.POINT_SERIES, { kind: "point", lat: 30, lon: 100 }),
      new ReadContext()
    );
    const { counters } = await planned.execute();
    expect(counters.chunkReads).toBe(12);
    // 12 stored float64 chunks of 4 × 4 × 4 values.
    expect(counters.fetchedBytes).toBe(12 * 4 * 4 * 4 * 8);
    expect(counters.fetchMs).toBeGreaterThanOrEqual(0);
    expect(counters.fetchMs).toBeLessThanOrEqual(counters.readMs);
  });
});

function hangingArray(chunks: number): TAnalysisArray & { started: number } {
  const array = {
    key: "hang",
    shape: [chunks],
    chunks: [1],
    dtype: "float64",
    attrs: {},
    dimensionNames: ["x"],
    fillValue: null,
    started: 0,
    readChunk: (_coords: number[], signal?: AbortSignal) => {
      array.started++;
      return new Promise<never>((_resolve, reject) =>
        signal?.addEventListener("abort", () =>
          reject(new DOMException("Aborted", "AbortError"))
        )
      );
    },
  };
  return array;
}

describe("reader and runner accounting", () => {
  it("counts reads when they start and decoded bytes once per read", async () => {
    const read = new ReadContext();
    const array = hangingArray(16);
    const counters = emptyCounters();
    const controller = new AbortController();
    const reads = Array.from({ length: 16 }, (_, at) =>
      read.read(array, [at], counters, controller.signal).catch(() => "x")
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    controller.abort();
    await Promise.all(reads);
    expect(array.started).toBe(4);
    expect(counters.chunkReads).toBe(4);

    const shared = {
      ...hangingArray(1),
      key: "shared",
      readChunk: async () => ({
        data: Float64Array.from([1]),
        shape: [1],
        stride: [1],
        absent: false,
      }),
    };
    const a = emptyCounters();
    const b = emptyCounters();
    await Promise.all([read.read(shared, [0], a), read.read(shared, [0], b)]);
    expect(a.chunkReads + b.chunkReads).toBe(1);
    expect(a.decodedBytes + b.decodedBytes).toBe(8);
    expect(b.sharedReads).toBe(1);
  });

  it("leaves no pending run after a failed plan, a cancel while planning or a release", async () => {
    const source = {
      key: "s1",
      store: "memory://none",
      dataset: "",
      format: ZARR_FORMAT.V3,
    };
    const q = query(ANALYSIS_KINDS.POINT_SERIES, {
      kind: "point",
      lat: 0,
      lon: 0,
    });
    const runner = new AnalysisRunner();
    const context = vi.spyOn(runner, "context");

    context.mockRejectedValueOnce(new Error("The store could not be opened."));
    await expect(runner.plan("r1", source, q)).rejects.toThrow(/opened/);
    expect(runner.memory().pendingRuns).toBe(0);

    context.mockReturnValue(new Promise(() => undefined));
    const planning = runner.plan("r2", source, q);
    runner.cancel("r2");
    await expect(planning).rejects.toMatchObject({ name: "AbortError" });
    expect(runner.memory().pendingRuns).toBe(0);

    const released = runner.plan("r3", source, q);
    await runner.release(source.key);
    await expect(released).rejects.toMatchObject({ name: "AbortError" });
    expect(runner.memory().pendingRuns).toBe(0);
  });
});

it("a read asked for after its run was cancelled never reaches the source", async () => {
  const read = new ReadContext();
  const array = hangingArray(1);
  const controller = new AbortController();
  controller.abort();
  await expect(
    read.read(array, [0], emptyCounters(), controller.signal)
  ).rejects.toMatchObject({ name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(array.started).toBe(0);
});
