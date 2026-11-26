/* eslint-disable camelcase -- Zarr metadata uses snake_case keys. */
import { writeFileSync } from "node:fs";

import { describe, expect, it } from "vitest";
import type * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import {
  openZarrAnalysisDataset,
  zarrAnalysisDatasetFromStore,
  type TAnalysisDataset,
} from "@/lib/analysis/sourceAdapter.ts";
import {
  ANALYSIS_KINDS,
  type TAnalysisQuery,
  type TGeometry,
} from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

// Workload benchmark. Skipped unless GRIDLOOK_BENCH=1:
//
//   GRIDLOOK_BENCH=1 npx vitest run tests/benchmark
//   GRIDLOOK_BENCH=1 GRIDLOOK_BENCH_LATENCY_MS=20 npx vitest run tests/benchmark
//   GRIDLOOK_BENCH=1 GRIDLOOK_BENCH_REMOTE=<zarr url> GRIDLOOK_BENCH_VARIABLE=0/temp \
//     GRIDLOOK_BENCH_LAT=43.3 GRIDLOOK_BENCH_LON=5.2 npx vitest run tests/benchmark
//
// The synthetic store synthesizes chunks on request (value = 1000 t + 10 k +
// cell mod 97), in RiOMar's layout: [time 2208, level 40, cell] float64 with
// [24, 40, 64] chunks, packed sorted cell ids at order 13. Results are written
// to GRIDLOOK_BENCH_OUT (default bench-results.json).
const ENABLED = process.env.GRIDLOOK_BENCH === "1";
const LATENCY_MS = Number(process.env.GRIDLOOK_BENCH_LATENCY_MS ?? 0);
const ORDER = 13;
const NT = 2208;
const NK = 40;
const CHUNKS = [24, 40, 64];
// A compact patch of 4544 stored cells (like RiOMar), starting at a deep id.
const FIRST = 12 * 4 ** ORDER - 4 ** ORDER * 4;
const CELLS = Array.from({ length: 4544 }, (_, at) => FIRST + at);

const encoder = new TextEncoder();
function json(value: unknown) {
  return encoder.encode(JSON.stringify(value));
}

function arrayMeta(
  shape: number[],
  chunks: number[],
  dtype: string,
  dims: string[],
  attributes: Record<string, unknown>,
  fill: unknown
) {
  return json({
    zarr_format: 3,
    node_type: "array",
    shape,
    data_type: dtype,
    chunk_grid: { name: "regular", configuration: { chunk_shape: chunks } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: fill,
    codecs: [{ name: "bytes", configuration: { endian: "little" } }],
    attributes,
    dimension_names: dims,
  });
}

function syntheticChunk(coords: number[]) {
  const [ct, ck, cc] = coords;
  const out = new Float64Array(CHUNKS[0] * CHUNKS[1] * CHUNKS[2]);
  let at = 0;
  for (let t = 0; t < CHUNKS[0]; t++) {
    for (let k = 0; k < CHUNKS[1]; k++) {
      for (let c = 0; c < CHUNKS[2]; c++) {
        const cell = CELLS[cc * CHUNKS[2] + c] ?? 0;
        out[at++] =
          1000 * (ct * CHUNKS[0] + t) + 10 * (ck * CHUNKS[1] + k) + (cell % 97);
      }
    }
  }
  return new Uint8Array(out.buffer);
}

const delay = () =>
  LATENCY_MS
    ? new Promise((resolve) => setTimeout(resolve, LATENCY_MS))
    : undefined;

// eslint-disable-next-line max-lines-per-function
function syntheticStore(): zarr.AsyncReadable & {
  requests: number;
  chunkStarts: number[];
} {
  const meta: Record<string, Uint8Array> = {
    "/zarr.json": json({
      zarr_format: 3,
      node_type: "group",
      attributes: {
        dggs: {
          name: "healpix",
          refinement_level: ORDER,
          indexing_scheme: "nested",
          coordinate: "cell_ids",
          spatial_dimension: "cell",
        },
      },
    }),
    "/temp/zarr.json": arrayMeta(
      [NT, NK, CELLS.length],
      CHUNKS,
      "float64",
      ["time_counter", "s_rho", "cell"],
      {},
      "NaN"
    ),
    "/cell_ids/zarr.json": arrayMeta(
      [CELLS.length],
      [CELLS.length],
      "int64",
      ["cell"],
      {},
      0
    ),
    "/cell_ids/c/0": new Uint8Array(
      BigInt64Array.from(CELLS.map(BigInt)).buffer
    ),
    "/time_counter/zarr.json": arrayMeta(
      [NT],
      [NT],
      "float64",
      ["time_counter"],
      {
        units: "seconds since 2000-01-01",
        calendar: "gregorian",
        standard_name: "time",
      },
      "NaN"
    ),
    "/time_counter/c/0": new Uint8Array(
      Float64Array.from({ length: NT }, (_, t) => 3600 * t).buffer
    ),
    "/s_rho/zarr.json": arrayMeta([NK], [NK], "float64", ["s_rho"], {}, "NaN"),
    // Map-chunked: one time step per chunk, as model output often is.
    "/sst/zarr.json": arrayMeta(
      [NT, CELLS.length],
      [1, CELLS.length],
      "float64",
      ["time_counter", "cell"],
      {},
      "NaN"
    ),
    "/s_rho/c/0": new Uint8Array(
      Float64Array.from({ length: NK }, (_, k) => -1 + (k + 0.5) / NK).buffer
    ),
  };
  const store = {
    requests: 0,
    /** Start times of field-chunk reads, to count reads after a cancel. */
    chunkStarts: [] as number[],
    async get(key: zarr.AbsolutePath) {
      store.requests++;
      if (key.startsWith("/temp/c/") || key.startsWith("/sst/c/")) {
        store.chunkStarts.push(performance.now());
      }
      await delay();
      if (meta[key]) {
        return meta[key];
      }
      const map = /^\/sst\/c\/(\d+)\/0$/.exec(key);
      if (map) {
        const t = Number(map[1]);
        return new Uint8Array(
          Float64Array.from(CELLS, (cell) => t + (cell % 97) / 100).buffer
        );
      }
      const match = /^\/temp\/c\/(\d+)\/(\d+)\/(\d+)$/.exec(key);
      return match ? syntheticChunk(match.slice(1).map(Number)) : undefined;
    },
  };
  return store;
}

type TRecord = Record<string, string | number>;
const records: TRecord[] = [];

async function measure(
  name: string,
  dataset: TAnalysisDataset,
  query: TAnalysisQuery,
  read: ReadContext,
  indexCache: ByteLru<BigInt64Array>
) {
  const started = performance.now();
  const context = await resolveVariableContext(
    dataset,
    query.variable,
    indexCache
  );
  const planned = await planAnalysis(context, query, read);
  const planMs = performance.now() - started;
  // When the first values could be drawn (a streaming plot's first part).
  let firstValues: number | undefined;
  const start = query.time?.start ?? 0;
  const result = await planned.execute(undefined, {
    onPartial: (update) => {
      if (firstValues === undefined && update.partial.readUntil > start) {
        firstValues = performance.now() - started;
      }
    },
    publishEveryMs: 250,
  });
  const total = performance.now() - started;
  const c = result.counters;
  const record = {
    workload: name,
    endToEndMs: Math.round(total),
    firstValuesMs: Math.round(firstValues ?? total),
    planMs: Math.round(planMs),
    plannedChunks: c.plannedChunks,
    chunkReads: c.chunkReads,
    cacheHits: c.cacheHits,
    sharedReads: c.sharedReads,
    decodedMiB: +(c.decodedBytes / 2 ** 20).toFixed(1),
    indexChunkReads: c.indexChunkReads,
    geometryMs: Math.round(c.geometryMs),
    summedReadMs: Math.round(c.readMs),
    reduceMs: Math.round(c.reduceMs),
    peakAccumulatorKiB: +(c.peakAccumulatorBytes / 1024).toFixed(1),
    trackedCacheMiB: +(read.chunkCache.bytes / 2 ** 20).toFixed(1),
    outputValues: result.values.length,
  };
  records.push(record);
  return result;
}

function q(
  kind: TAnalysisQuery["kind"],
  geometry: TGeometry,
  extra: Partial<TAnalysisQuery> = {}
): TAnalysisQuery {
  return {
    version: 1,
    kind,
    source: { ref: "synthetic", versionStatus: "session" },
    variable: process.env.GRIDLOOK_BENCH_VARIABLE ?? "temp",
    geometry,
    fixed: {},
    ...extra,
  };
}

// eslint-disable-next-line max-lines-per-function
describe.skipIf(!ENABLED)("analysis workloads", () => {
  it(
    "records latency and work for the reference workloads",
    { timeout: 600_000 },
    // eslint-disable-next-line max-lines-per-function
    async () => {
      const remote = process.env.GRIDLOOK_BENCH_REMOTE;
      const indexCache = new ByteLru<BigInt64Array>(32 * 2 ** 20);
      const synthetic = syntheticStore();
      const dataset = remote
        ? await openZarrAnalysisDataset(
            { store: remote, dataset: "" },
            ZARR_FORMAT.V3
          )
        : zarrAnalysisDatasetFromStore(
            synthetic,
            "",
            ZARR_FORMAT.V3,
            "synthetic"
          );
      // Field-chunk reads expected on the synthetic layout (24 steps per
      // time chunk, one 64-cell chunk per point, 8 for the reference path).
      const expectReads = (
        result: { counters: { chunkReads: number } },
        n: number
      ) => {
        if (!remote) {
          expect(result.counters.chunkReads).toBe(n);
        }
      };
      const probe = await resolveVariableContext(
        dataset,
        q(ANALYSIS_KINDS.POINT_SERIES, { kind: "point", lat: 0, lon: 0 })
          .variable,
        indexCache
      );
      const grid = probe.grid as {
        grid?: { healpixToLonLat(ids: BigUint64Array): Float64Array };
      };
      const centre =
        grid.grid?.healpixToLonLat(new BigUint64Array([BigInt(CELLS[2272])])) ??
        new Float64Array([0, 0]);
      const lat = Number(process.env.GRIDLOOK_BENCH_LAT ?? centre[1]);
      const lon = Number(process.env.GRIDLOOK_BENCH_LON ?? centre[0]);
      const point = { kind: "point" as const, lat, lon };
      const box = (half: number) => ({
        kind: "box" as const,
        west: lon - half,
        east: lon + half,
        south: lat - half,
        north: lat + half,
      });
      const poly = (half: number) => ({
        kind: "polygon" as const,
        vertices: [
          { lat: lat - half, lon },
          { lat, lon: lon + half },
          { lat: lat + half, lon },
          { lat, lon: lon - half },
        ],
      });
      const path = (half: number) => ({
        kind: "polyline" as const,
        vertices: [
          { lat: lat - half, lon: lon - half },
          { lat: lat + half, lon: lon + half },
        ],
      });
      const cold = () => new ReadContext();

      const warm = cold();
      expectReads(
        await measure(
          "point series, 256 steps (cold)",
          dataset,
          q(ANALYSIS_KINDS.POINT_SERIES, point, {
            time: { start: 0, stop: 256 },
          }),
          warm,
          indexCache
        ),
        11
      );
      expectReads(
        await measure(
          "point series, 256 steps (warm)",
          dataset,
          q(ANALYSIS_KINDS.POINT_SERIES, point, {
            time: { start: 0, stop: 256 },
          }),
          warm,
          indexCache
        ),
        0
      );
      expectReads(
        await measure(
          `point series, ${NT} steps (cold)`,
          dataset,
          q(ANALYSIS_KINDS.POINT_SERIES, point),
          cold(),
          indexCache
        ),
        92
      );
      for (const half of [0.05, 0.2]) {
        await measure(
          `box ±${half}°, 256 steps (cold)`,
          dataset,
          q(ANALYSIS_KINDS.REGION_SERIES, box(half), {
            time: { start: 0, stop: 256 },
          }),
          cold(),
          indexCache
        );
        await measure(
          `polygon ±${half}°, 256 steps (cold)`,
          dataset,
          q(ANALYSIS_KINDS.REGION_SERIES, poly(half), {
            time: { start: 0, stop: 256 },
          }),
          cold(),
          indexCache
        );
      }
      await measure(
        "profile (cold)",
        dataset,
        q(ANALYSIS_KINDS.PROFILE, point, { time: { start: 100, stop: 101 } }),
        cold(),
        indexCache
      );
      for (const samples of [200, 2000]) {
        expectReads(
          await measure(
            `section ${samples} samples (cold)`,
            dataset,
            q(ANALYSIS_KINDS.SECTION, path(0.2), {
              time: { start: 100, stop: 101 },
              sectionSamples: samples,
            }),
            cold(),
            indexCache
          ),
          8
        );
      }

      // A map-chunked variable: every time step is its own stored chunk.
      // Synthetic only: a remote store has no "sst" of that layout.
      if (!remote) {
        expectReads(
          await measure(
            "map-chunked point series, 720 steps (cold)",
            dataset,
            {
              ...q(ANALYSIS_KINDS.POINT_SERIES, point, {
                time: { start: 0, stop: 720 },
              }),
              variable: "sst",
            },
            cold(),
            indexCache
          ),
          720
        );
      }

      // Space–time plots: every level at a point, a band, a path at one level,
      // and a distribution.
      await measure(
        "time–depth, 256 steps (cold)",
        dataset,
        q(ANALYSIS_KINDS.TIME_DEPTH, point, { time: { start: 0, stop: 256 } }),
        cold(),
        indexCache
      );
      await measure(
        "Hovmöller lon × time ±0.2°, 256 steps (cold)",
        dataset,
        q(ANALYSIS_KINDS.HOVMOLLER_LON, box(0.2), {
          time: { start: 0, stop: 256 },
        }),
        cold(),
        indexCache
      );
      await measure(
        "distance × time, 200 samples, 256 steps (cold)",
        dataset,
        q(ANALYSIS_KINDS.HOVMOLLER_PATH, path(0.2), {
          time: { start: 0, stop: 256 },
          sectionSamples: 200,
        }),
        cold(),
        indexCache
      );
      await measure(
        "distribution ±0.2° (cold)",
        dataset,
        q(ANALYSIS_KINDS.DISTRIBUTION, box(0.2), {
          time: { start: 100, stop: 101 },
        }),
        cold(),
        indexCache
      );

      // Three windows at once on the page-wide limiter.
      const shared = cold();
      const started = performance.now();
      await Promise.all([
        measure(
          "concurrent: point series",
          dataset,
          q(ANALYSIS_KINDS.POINT_SERIES, point, {
            time: { start: 0, stop: 256 },
          }),
          shared,
          indexCache
        ),
        measure(
          "concurrent: box ±0.05°",
          dataset,
          q(ANALYSIS_KINDS.REGION_SERIES, box(0.05), {
            time: { start: 0, stop: 256 },
          }),
          shared,
          indexCache
        ),
        measure(
          "concurrent: section 200",
          dataset,
          q(ANALYSIS_KINDS.SECTION, path(0.2), {
            time: { start: 0, stop: 1 },
            sectionSamples: 200,
          }),
          shared,
          indexCache
        ),
      ]);
      records.push({
        workload: "three concurrent windows, wall clock",
        endToEndMs: Math.round(performance.now() - started),
      });

      // Cancellation after the first part is shown: time until the run
      // rejects, and field reads started after the cancel.
      const context = await resolveVariableContext(
        dataset,
        q(ANALYSIS_KINDS.REGION_SERIES, box(0.2)).variable,
        indexCache
      );
      const planned = await planAnalysis(
        context,
        q(ANALYSIS_KINDS.REGION_SERIES, box(0.2)),
        cold()
      );
      const controller = new AbortController();
      let cancelAt = Number.POSITIVE_INFINITY;
      let readBeforeCancel = 0;
      const startsBefore = synthetic.chunkStarts.length;
      const outcome = await planned
        .execute(controller.signal, {
          // After the first part with data, not the empty announcement.
          onPartial: (update) => {
            if (!controller.signal.aborted && update.partial.done > 0) {
              readBeforeCancel = synthetic.chunkStarts.length - startsBefore;
              cancelAt = performance.now();
              controller.abort(new DOMException("Cancelled", "AbortError"));
            }
          },
        })
        .catch((error: Error) => error);
      const settledAt = performance.now();
      // Let any straggling dispatch show itself before counting.
      await new Promise((resolve) => setTimeout(resolve, 50 + 2 * LATENCY_MS));
      const readsAfterCancel = synthetic.chunkStarts.filter(
        (at) => at > cancelAt
      ).length;
      records.push({
        workload: "cancel full-length box ±0.2° after its first part",
        endToEndMs: Math.round(settledAt - cancelAt),
        readsStartedAfterCancel: remote ? "n/a" : readsAfterCancel,
        readsDispatchedBeforeCancel: remote ? "n/a" : readBeforeCancel,
        outcome:
          outcome instanceof Error || outcome instanceof DOMException
            ? outcome.name
            : "completed before cancel",
      });
      expect((outcome as Error).name).toBe("AbortError");
      if (!remote) {
        expect(readsAfterCancel).toBe(0);
      }

      const out = process.env.GRIDLOOK_BENCH_OUT ?? "bench-results.json";
      const environment = {
        source:
          remote ?? "synthetic in-process store (chunks synthesized on read)",
        latencyMs: remote ? "network" : LATENCY_MS,
        node: process.version,
        platform: `${process.platform} ${process.arch}`,
        layout: remote
          ? "remote"
          : `float64 [${NT}, ${NK}, ${CELLS.length}] chunks [${CHUNKS}] packed order ${ORDER}`,
      };
      writeFileSync(out, JSON.stringify({ environment, records }, null, 2));
      console.table(records);
    }
  );
});
