import {
  AnalysisInputError,
  AnalysisSizeError,
  tooManyValues,
} from "./analysisErrors.ts";
import { ByteLru } from "./byteLru.ts";
import {
  cellWeights,
  distinctOf,
  inferredEdges,
  weightingLabel,
} from "./cellAreas.ts";
import {
  chunkByteSize,
  countRunChunks,
  MAX_PLANNED_CHUNKS,
  throwIfAborted,
  visitRuns,
  yieldIfBusy,
  type TAnalysisArray,
  type TPointSelection,
  type ReadContext,
  type TIndexRuns,
  pointSelectionBytes,
  runSelectionBytes,
  MAX_STORED_CHUNK_BYTES,
} from "./chunkVisitor.ts";
import {
  COUNTRY_ATLAS_VERSION,
  getCountriesRings,
  getCountryRings,
} from "./countryAtlas.ts";
import { countryHasLongitude, prepareCountry } from "./countryRegion.ts";
import { toSafeNumber } from "./healpixIds.ts";
import { idEncoding } from "./identifiers.ts";
import {
  jointArray,
  jointAlignment,
  partnerRuns,
  partnerHeldBytes,
} from "./jointComponents.ts";
import {
  locateNative,
  nativeCellId,
  alongReadsNow,
  nativeAreas,
  nativeCellReadsAt,
  nativeCellReadsNow,
  nativeMembers,
  nativePositions,
  type TNativeContext,
  type TNativeRegion,
} from "./nativeGrid.ts";
import {
  cellsNear,
  coverHealpixRegion,
  regionContains,
  REGION_KINDS,
  type TRegion,
} from "./regionCover.ts";
import { frameRule } from "./screenFrame.ts";
import { SharedReads } from "./sharedRead.ts";
import { openReferenced } from "./sourceAdapter.ts";
import {
  DRAWING_SPHERE_RADIUS_METERS,
  polylineLengthMeters,
  preparePolygon,
  preparePath,
  samplePolyline,
  validateBox,
  boxContains,
  polygonExtent,
  type TLatLon,
} from "./sphere.ts";
import {
  ANALYSIS_KINDS,
  emptyCounters,
  GEOMETRY_KINDS,
  MAX_WORKING_BYTES,
  type TAnalysisQuery,
  type TAnalysisKind,
  type TAnalysisResult,
  type TCountryGeometry,
  type TShapeGeometry,
  type TGeometry,
  SAMPLE_STATUS,
  SECTION_MODES,
  type TPartialUpdate,
  type TPlanEstimate,
  type TSampleStatus,
  type TWorkCounters,
  countryIds,
  MAX_OUTPUT_VALUES,
} from "./types.ts";
import { buildValueCodec, type TValueCodec } from "./valueDecoding.ts";
import {
  ANALYSIS_GRID_KINDS,
  isPhysicalVertical,
  type TRectilinearContext,
  type TVariableContext,
} from "./variableContext.ts";
import {
  evaluateFormula,
  formulaUnitProblem,
  normalizeFormulaTerms,
  VERTICAL_KINDS,
} from "./vertical.ts";

import { cellInterval, locateOnAxis } from "@/lib/grids/analysisGrid.ts";

export { AnalysisInputError } from "./analysisErrors.ts";

/** Streaming hooks: partial results between parts, and a pause gate. */
type TRunHooks = {
  onPartial?: (update: TPartialUpdate) => void;
  waitIfPaused?: (signal?: AbortSignal) => Promise<void>;
  /**
   * Coalesce updates while later parts are already read: at most one update
   * per this many milliseconds then. Data is never held back while the next
   * part is still being read. 0 (the default) publishes every part.
   */
  publishEveryMs?: number;
};

/** A planned operation: an estimate now, the reads only on `execute`. */
export type TPlannedAnalysis = {
  estimate: TPlanEstimate;
  execute(signal?: AbortSignal, hooks?: TRunHooks): Promise<TAnalysisResult>;
};

// A part is one time chunk (more only beyond this many parts), so the figure
// grows with every chunk read.
const MAX_STREAM_PARTS = 512;
/** A cross-section's progress: at most one update this often (ms). */
const SECTION_PUBLISH_MS = 200;
// Parts read ahead of the one being shown (all through the reader's limit).
const POINT_LOOKAHEAD = 8;
export const REGION_LOOKAHEAD = 4;

/**
 * Split a time range into parts on time-chunk boundaries (one time chunk
 * each, up to MAX_STREAM_PARTS), so every chunk is read in exactly one part.
 */
function timeParts(context: TVariableContext, start: number, stop: number) {
  const chunk = context.array.chunks[context.time!.axis];
  const first = Math.floor(start / chunk);
  const chunks = Math.ceil(stop / chunk) - first;
  const perPart = Math.max(1, Math.ceil(chunks / MAX_STREAM_PARTS));
  const parts: [number, number][] = [];
  for (let at = start; at < stop;) {
    const end = Math.min(stop, (Math.floor(at / chunk) + perPart) * chunk);
    parts.push([at, end]);
    at = end;
  }
  return parts;
}

/** The parts in reading order: from the last back when `fromEnd`. */
export function readingParts(
  context: TVariableContext,
  start: number,
  stop: number,
  fromEnd: boolean | undefined
) {
  const parts = timeParts(context, start, stop);
  return fromEnd ? parts.reverse() : parts;
}

/** The longest part, in time steps (for memory estimates). */
export function longestPart(
  context: TVariableContext,
  start: number,
  stop: number
) {
  return Math.max(0, ...timeParts(context, start, stop).map(([a, b]) => b - a));
}

/** Whether `ms` pass before `promise` settles (true: the time ran out). */
async function timesOut(promise: Promise<unknown>, ms: number) {
  if (ms <= 0) {
    return true;
  }
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(true), ms);
  });
  try {
    return await Promise.race([
      promise.then(
        () => false,
        () => false
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Read parts with up to `lookahead` in flight and hand them on in time
 * order. `shown(part, publish)` publishes at most once per `publishEveryMs`;
 * a part shown without publishing is published again (`shown(part, true)`)
 * as soon as that interval has passed while the next part is still being
 * read, so nothing read is held back longer than the interval. A pause
 * (inside `shown`) stops new dispatch; parts already in flight finish. A
 * failure or cancel stops the parts in flight.
 */

export async function streamParts(
  count: number,
  lookahead: number,
  signal: AbortSignal | undefined,
  readPart: (part: number, signal: AbortSignal) => Promise<unknown>,
  shown: (part: number, publish: boolean) => Promise<void>,
  publishEveryMs = 0
) {
  // A run cancelled before it starts reads nothing (an abort listener added
  // after the abort would never fire).
  throwIfAborted(signal);
  const local = new AbortController();
  const forward = () => local.abort(signal?.reason);
  signal?.addEventListener("abort", forward, { once: true });
  const inFlight = new Map<number, Promise<unknown>>();
  let next = 0;
  let published = Number.NEGATIVE_INFINITY;
  let unpublished = -1;
  try {
    for (let part = 0; part < count; part++) {
      while (next < count && next < part + lookahead) {
        const reading = readPart(next, local.signal);
        // Awaited in order below; this only keeps an early failure handled.
        reading.catch(() => undefined);
        inFlight.set(next++, reading);
      }
      const reading = inFlight.get(part)!;
      if (
        unpublished >= 0 &&
        (await timesOut(
          reading,
          published + publishEveryMs - performance.now()
        ))
      ) {
        // The next part is slow: show what was read before waiting on.
        published = performance.now();
        await shown(unpublished, true);
        unpublished = -1;
      }
      await reading;
      inFlight.delete(part);
      const now = performance.now();
      const publish = part + 1 >= count || now - published >= publishEveryMs;
      published = publish ? now : published;
      unpublished = publish ? -1 : part;
      await shown(part, publish);
    }
  } finally {
    signal?.removeEventListener("abort", forward);
    if (inFlight.size) {
      local.abort(new DOMException("Cancelled", "AbortError"));
    }
  }
}

export const MODEST_BYTES = 64 * 2 ** 20;
export const MODEST_CHUNKS = 512;
/** What a modest plot may hold besides shared native geometry. */
const MODEST_WORKING_BYTES = 96 * 2 ** 20;
const DEFAULT_SECTION_SAMPLES = 400;
const MAX_SECTION_SAMPLES = 20000;
// Admission limits: larger work is refused before anything is allocated.
const MAX_CHUNK_BYTES = MAX_STORED_CHUNK_BYTES;

/** Most coordinate/topology chunks read to build a native geometry. */
export const MAX_GEOMETRY_READS = 8192;
/** More cold coordinate reads than this wait for the user's go-ahead. */
export const COLD_GEOMETRY_CONFIRM = 64;
// The page-wide decoded-byte budget (ReadContext) and visitRuns' batch size.
const DECODED_BUDGET_BYTES = 32 * 2 ** 20;
export const JOBS_PER_BATCH = 16;

export function selectionRuns(
  context: TVariableContext,
  query: TAnalysisQuery
) {
  const runs: TIndexRuns[] = context.dims.map(() => [[0, 1]]);
  for (const { axis, dimension, size } of context.others) {
    const index = query.fixed[dimension] ?? 0;
    if (!Number.isInteger(index) || index < 0 || index >= size) {
      throw new AnalysisInputError(
        `Index ${index} of ${dimension} is outside 0..${size - 1}.`
      );
    }
    runs[axis] = [[index, index + 1]];
  }
  return runs;
}

export function timeRange(context: TVariableContext, query: TAnalysisQuery) {
  const time = context.time!;
  const start = query.time?.start ?? 0;
  const stop = query.time?.stop ?? time.raw.length;
  // Whole, half-open indices only: a fractional index would mix dates.
  if (
    !Number.isInteger(start) ||
    !Number.isInteger(stop) ||
    !(start >= 0 && stop <= time.raw.length && stop > start)
  ) {
    // Into steps whose timestamps a live store has not written yet.
    if (
      time.unpublished &&
      start >= 0 &&
      stop > time.raw.length &&
      stop <= time.raw.length + time.unpublished
    ) {
      throw new AnalysisInputError(
        `The time coordinate has missing or invalid timestamps from step ${time.raw.length} (not published yet); steps 0..${time.raw.length - 1} can be read.`
      );
    }
    throw new AnalysisInputError(
      `The time range ${start}..${stop} is outside 0..${time.raw.length}.`
    );
  }
  return { start, stop };
}

export function levelIndex(context: TVariableContext, query: TAnalysisQuery) {
  const vertical = context.vertical;
  if (!vertical) {
    return undefined;
  }
  const level = query.level ?? 0;
  if (
    !Number.isInteger(level) ||
    level < 0 ||
    level >= vertical.values.length
  ) {
    throw new AnalysisInputError(
      `Level ${level} is outside 0..${vertical.values.length - 1}.`
    );
  }
  return level;
}

/** Decoded bytes of one stored chunk of an array. */
const arrayChunkBytes = chunkByteSize;

export function chunkBytesOf(context: TVariableContext) {
  return arrayChunkBytes(context.array);
}

export function mib(bytes: number) {
  return `${(bytes / 2 ** 20).toFixed(bytes < 10 * 2 ** 20 ? 1 : 0)} MiB`;
}

/** A stored chunk's size, small ones in KiB: the preview prices by it. */
function chunkSize(bytes: number) {
  return bytes < 2 ** 20
    ? `${Math.max(0.1, Math.round(bytes / 102.4) / 10)} KiB`
    : mib(bytes);
}

export function count(n: number) {
  return n.toLocaleString("en-US");
}

// A series decoding more than this per value is said to be layout-bound.
const LAYOUT_NOTE_BYTES_PER_VALUE = 256 * 2 ** 10;

/**
 * Why a series at one place reads slowly: every value comes from a whole
 * stored chunk, which is fetched and decompressed in full.
 */
export function layoutNote(
  context: TVariableContext,
  chunks: number,
  values: number
) {
  const chunkBytes = chunkBytesOf(context);
  const decoded = chunks * chunkBytes;
  if (!values || decoded / values < LAYOUT_NOTE_BYTES_PER_VALUE) {
    return undefined;
  }
  const time = context.time;
  const perChunk = time ? context.array.chunks[time.axis] : 1;
  return `Each stored chunk holds ${count(perChunk)} time step${perChunk === 1 ? "" : "s"} of a large area (${context.array.chunks.join(" × ")} values, ${mib(chunkBytes)} decoded). To read ${count(values)} time steps at one place, ${count(chunks)} whole chunk${chunks === 1 ? " is" : "s are"} fetched and decompressed: ${mib(decoded)} in all. Data chunked along time would read much faster.`;
}

/** Plots that weigh cells by their areas (the others locate cells). */
export const AREA_WEIGHTED_KINDS: TAnalysisKind[] = [
  ANALYSIS_KINDS.REGION_SERIES,
  ANALYSIS_KINDS.DISTRIBUTION,
  ANALYSIS_KINDS.HOVMOLLER_LON,
  ANALYSIS_KINDS.HOVMOLLER_LAT,
  ANALYSIS_KINDS.LAT_VERTICAL,
  ANALYSIS_KINDS.LON_VERTICAL,
];

/**
 * Declared 2-D cell areas a rectilinear area plot reads to weigh its
 * cells, counted before any is read: the stored chunks over the region's
 * candidate rows and columns (an upper bound), and their decoded size.
 */
// eslint-disable-next-line max-lines-per-function
export async function declaredAreaReads(
  context: TVariableContext,
  query: TAnalysisQuery,
  signal?: AbortSignal
) {
  const { grid } = context;
  const geometry = query.geometry;
  if (
    grid.kind !== ANALYSIS_GRID_KINDS.RECTILINEAR ||
    !grid.areas ||
    grid.areas.array.dimensionNames.length === 0 ||
    !AREA_WEIGHTED_KINDS.includes(query.kind) ||
    !(
      [
        GEOMETRY_KINDS.BOX,
        GEOMETRY_KINDS.POLYGON,
        GEOMETRY_KINDS.COUNTRY,
        GEOMETRY_KINDS.SHAPE,
      ] as string[]
    ).includes(geometry.kind)
  ) {
    return { reads: 0, bytes: 0, held: 0 };
  }
  // A kept mask holds the weights already: nothing is read for them.
  if (
    (geometry.kind === GEOMETRY_KINDS.COUNTRY ||
      geometry.kind === GEOMETRY_KINDS.SHAPE) &&
    countryMasks.get(maskKey(context, geometry) || "")
  ) {
    return { reads: 0, bytes: 0, held: 0 };
  }
  const region: TRegion =
    geometry.kind === GEOMETRY_KINDS.COUNTRY ||
    geometry.kind === GEOMETRY_KINDS.SHAPE
      ? {
          kind: REGION_KINDS.COUNTRY,
          country: await loadCountryRegion(geometry, signal),
        }
      : toRegion(geometry);
  // The hard limits hold for a confirmed read too, checked on the declared
  // chunk before any is read.
  const chunkBytes = chunkByteSize(grid.areas.array);
  if (chunkBytes > MAX_CHUNK_BYTES) {
    throw new AnalysisInputError(
      `One stored chunk of this grid's declared cell areas decodes to ${mib(chunkBytes)} (its declared chunk shape, padding included); plots read at most ${mib(MAX_CHUNK_BYTES)} per chunk. Points still work (they need no areas).`
    );
  }
  const { rows, cols } = rectilinearCandidates(grid, region);
  const along = grid.areas.dims.indexOf(grid.areas.array.dimensionNames[0]);
  const shape = [grid.lat.values.length, grid.lon.values.length];
  let cost =
    grid.areas.array.dimensionNames.length === 1
      ? alongReadsNow(grid.areas.array, along === 0 ? rows : cols)
      : nativeCellReadsNow(
          grid.areas.array,
          grid.areas.dims,
          shape,
          rows,
          cols
        );
  // A drawn region or country reads only the chunks under its cells, so those
  // are what is counted: the price shown is the read made.
  if (cost.reads > 1 && region.kind !== REGION_KINDS.BOX) {
    const members = await polygonMembers(
      grid,
      region,
      { rows, cols },
      () => 1,
      signal
    );
    // Along one axis: the members' own rows (or columns), as they are read.
    const [ownRows, ownCols] = distinctOf(members.positions);
    cost =
      grid.areas.array.dimensionNames.length === 2
        ? nativeCellReadsAt(
            grid.areas.array,
            grid.areas.dims,
            shape,
            members.positions
          )
        : alongReadsNow(grid.areas.array, along === 0 ? ownRows : ownCols);
  }
  if (cost.reads > MAX_GEOMETRY_READS) {
    throw new AnalysisInputError(
      `Weighing these cells would first read ${count(cost.reads)} stored chunks of their declared areas; plots read at most ${count(MAX_GEOMETRY_READS)}. Points still work (they need no areas).`
    );
  }
  return cost;
}

/**
 * Corner areas loaded on demand (outlines too large to hold): admitted for area
 * plots only, their reads counted with the cold coordinate reads; a point or
 * path reads no corner at all.
 */
export function cornerAreaReads(
  context: TVariableContext,
  kind: TAnalysisKind
) {
  const { grid } = context;
  const areas =
    grid.kind === ANALYSIS_GRID_KINDS.NATIVE ? grid.cornerAreas : undefined;
  if (!areas || !AREA_WEIGHTED_KINDS.includes(kind)) {
    return 0;
  }
  const reads = areas.readsNow();
  if (!reads) {
    return 0;
  }
  // With the coordinates still to read, both count against one limit.
  const cold =
    grid.kind === ANALYSIS_GRID_KINDS.NATIVE && !grid.geometryReady()
      ? grid.geometryReadsNow()
      : 0;
  if (reads + cold > MAX_GEOMETRY_READS) {
    throw new AnalysisInputError(
      `Weighing cells on this grid would first read ${count(reads + cold)} stored chunks (${count(reads)} of cell areas or corners${cold ? `, ${count(cold)} of coordinates` : ""}); plots read at most ${count(MAX_GEOMETRY_READS)}. Points and paths still work (they need the centres only).`
    );
  }
  if (areas.chunkBytes > MAX_CHUNK_BYTES) {
    throw new AnalysisInputError(
      `One stored chunk of this grid's cell corners decodes to ${mib(areas.chunkBytes)}; plots read at most ${mib(MAX_CHUNK_BYTES)} per chunk. A copy with smaller corner chunks is needed for area plots.`
    );
  }
  if (areas.bytes > MAX_WORKING_BYTES) {
    throw new AnalysisInputError(
      `Reading this grid's cell areas from its corners needs about ${mib(areas.bytes)} in memory; plots use at most ${mib(MAX_WORKING_BYTES)}.`
    );
  }
  return reads;
}

/**
 * A native grid's geometry is admitted from its arrays' own shapes before
 * any planner may load it (locators load it while planning).
 */
export function admitNativeGeometry(context: TVariableContext) {
  const { grid } = context;
  if (grid.kind !== ANALYSIS_GRID_KINDS.NATIVE || grid.geometryReady()) {
    return;
  }
  if (grid.geometryChunkBytes > MAX_CHUNK_BYTES) {
    throw new AnalysisInputError(
      `One stored chunk of this grid's coordinates or topology decodes to ${mib(grid.geometryChunkBytes)} (its declared chunk shape, padding included); plots read at most ${mib(MAX_CHUNK_BYTES)} per chunk. A copy with smaller coordinate chunks is needed.`
    );
  }
  const reads = grid.geometryReadsNow();
  if (reads > MAX_GEOMETRY_READS) {
    throw new AnalysisInputError(
      `Locating cells on this grid would first read ${count(reads)} stored coordinate chunks; plots read at most ${count(MAX_GEOMETRY_READS)}. A copy with larger coordinate chunks is needed.`
    );
  }
  if (grid.geometryBytes > MAX_WORKING_BYTES) {
    throw new AnalysisInputError(
      `This grid's coordinates and cell outlines need about ${mib(grid.geometryBytes)} in memory; plots use at most ${mib(MAX_WORKING_BYTES)}.`
    );
  }
}

/** Refuse work that cannot fit, with a way to make it smaller. */
export function admit(
  chunkBytes: number,
  chunks: number,
  outputValues: number,
  workingBytes: number
) {
  if (chunks > 0 && chunkBytes > MAX_CHUNK_BYTES) {
    throw new AnalysisInputError(
      `One stored chunk of this variable decodes to ${mib(chunkBytes)}; plots read at most ${mib(MAX_CHUNK_BYTES)} per chunk. A copy of the data with smaller chunks is needed.`
    );
  }
  if (chunks > MAX_PLANNED_CHUNKS) {
    throw new AnalysisSizeError(
      `This selection touches ${count(chunks)} stored chunks (about ${chunkSize(chunkBytes)} each); plots read at most ${count(MAX_PLANNED_CHUNKS)}. Shorten the time range, or choose a smaller area or a coarser order.`,
      { reason: "size", decodedBytes: chunks * chunkBytes }
    );
  }
  if (outputValues > MAX_OUTPUT_VALUES) {
    throw tooManyValues(
      `The result would hold ${count(outputValues)} values; plots keep at most ${count(MAX_OUTPUT_VALUES)}. Use fewer samples or a shorter time range.`,
      outputValues,
      MAX_OUTPUT_VALUES,
      "samples"
    );
  }
  if (workingBytes > MAX_WORKING_BYTES) {
    throw new AnalysisSizeError(
      `This request needs about ${mib(workingBytes)} of working memory (${count(chunks)} stored chunks of about ${chunkSize(chunkBytes)} each); plots use at most ${mib(MAX_WORKING_BYTES)}. Shorten the time range or choose a smaller area.`,
      { reason: "size", decodedBytes: chunks * chunkBytes }
    );
  }
}

/**
 * Estimate, then admit. Working memory counts the decoded chunks the reader
 * can hold at once, per-operation scratch and the output.
 */
export function estimateFor(
  context: TVariableContext,
  chunks: number,
  outputValues: number,
  notes: string[],
  scratchBytes = 0,
  /** Auxiliary arrays (formula terms), whose chunks `chunks` includes. */
  terms: Pick<TTermPlan, "term" | "array" | "runs" | "points">[] = []
): TPlanEstimate {
  // Each auxiliary array is costed and limited by its own chunk size.
  let termCount = 0;
  let termBytes = 0;
  for (const plan of terms) {
    const bytes = arrayChunkBytes(plan.array);
    const n = countRunChunks(plan.runs, plan.array.chunks, plan.points);
    if (n > 0 && bytes > MAX_CHUNK_BYTES) {
      throw new AnalysisInputError(
        `One stored chunk of the formula term ${plan.term} (${plan.array.key}) decodes to ${mib(bytes)}; plots read at most ${mib(MAX_CHUNK_BYTES)} per chunk.`
      );
    }
    termCount += n;
    termBytes += n * bytes;
  }
  const mainBytes = chunkBytesOf(context);
  const chunkBytes = Math.max(
    mainBytes,
    ...terms.map((plan) => arrayChunkBytes(plan.array))
  );
  const decodedBytes = Math.max(0, chunks - termCount) * mainBytes + termBytes;
  // Decoded chunks held at once: those that participate, up to the page's
  // decoded-byte budget (a larger chunk is read alone).
  // A native grid's geometry is loaded (once, shared) for any locator.
  const geometryBytes =
    context.grid.kind === ANALYSIS_GRID_KINDS.NATIVE
      ? context.grid.geometryBytes
      : 0;
  const workingBytes =
    Math.min(decodedBytes, Math.max(DECODED_BUDGET_BYTES, chunkBytes)) +
    scratchBytes +
    geometryBytes +
    outputValues * 8;
  admit(mainBytes, chunks, outputValues, workingBytes);
  return {
    chunks,
    decodedBytes,
    workingBytes,
    outputValues,
    // Modest in what it keeps too: a million dates of one cell is not.
    modest:
      decodedBytes <= MODEST_BYTES &&
      chunks <= MODEST_CHUNKS &&
      workingBytes - geometryBytes <= MODEST_WORKING_BYTES,
    notes,
    ...(termCount ? { termChunks: termCount, termBytes } : {}),
  };
}

function countChunks(context: TVariableContext, runs: TIndexRuns[]) {
  return countRunChunks(runs, context.array.chunks);
}

/** How many asked rows have no date (a missing auxiliary time), said. */
function undatedNote(context: TVariableContext, query: TAnalysisQuery) {
  const time = context.time;
  if (!time?.undated || !query.time) {
    return [];
  }
  let n = 0;
  const stop = Math.min(query.time.stop, time.raw.length);
  for (let at = Math.max(0, query.time.start); at < stop; at++) {
    n += Number.isFinite(time.raw[at]) ? 0 : 1;
  }
  return n
    ? [
        `${n.toLocaleString("en-US")} ${n === 1 ? "observation has" : "observations have"} no time (a missing value of ${time.dimension}'s time coordinate): left out of time plots, not given a date.`,
      ]
    : [];
}

export function baseResult(
  context: TVariableContext,
  query: TAnalysisQuery,
  counters: TWorkCounters
): TAnalysisResult {
  const { grid } = context;
  return {
    kind: query.kind,
    query,
    units: context.units,
    ...(context.unitsMetadata ? { unitsMetadata: context.unitsMetadata } : {}),
    ...(context.cellMethods ? { cellMethods: context.cellMethods } : {}),
    longName: context.longName,
    // What the values are, as their source says: kept with them for every view
    // and export.
    ...(context.standardName !== undefined
      ? { standardName: context.standardName }
      : {}),
    values: [],
    shape: [],
    dims: [],
    grid:
      grid.kind === ANALYSIS_GRID_KINDS.HEALPIX
        ? {
            kind: `HEALPix nested, ${grid.layout}`,
            order: grid.order,
            frame: grid.frame.ellipsoidLabel,
            indexValidation: grid.index.validation,
            conflicts: grid.frame.conflicts,
          }
        : {
            kind:
              grid.kind === ANALYSIS_GRID_KINDS.RECTILINEAR
                ? "latitude/longitude"
                : grid.kind === ANALYSIS_GRID_KINDS.NATIVE
                  ? grid.label
                  : "unsupported",
            conflicts: [],
          },
    decoding: context.codec.rule,
    notes: undatedNote(context, query),
    counters,
    ...fixedLevelOf(context, query),
    ...selectionsOf(context, query),
    ...(context.scalarReference
      ? { referenceTime: context.scalarReference }
      : {}),
  };
}

/** The index chosen along each other dimension the query fixes. */
function leadBounds(
  bounds: number[] | undefined,
  index: number,
  declared: boolean
) {
  const [low, high] = [bounds?.[2 * index], bounds?.[2 * index + 1]];
  return low !== undefined &&
    high !== undefined &&
    Number.isFinite(low) &&
    Number.isFinite(high)
    ? { valueBounds: [low, high] as [number, number] }
    : declared
      ? { valueBoundsUnknown: true as const }
      : {};
}

// eslint-disable-next-line max-lines-per-function
function selectionsOf(context: TVariableContext, query: TAnalysisQuery) {
  const selections = context.others.flatMap((other) => {
    const index = query.fixed?.[other.dimension];
    return index === undefined
      ? []
      : [
          {
            dimension: other.dimension,
            index,
            ...(other.ids?.[index] !== undefined
              ? { id: other.ids[index] }
              : other.ids
                ? { idMissing: true as const }
                : {}),
            ...(other.idType ? { idType: other.idType } : {}),
            ...(other.ids
              ? { idEncoding: idEncoding(other.ids, other.idType) }
              : {}),
            ...(other.ensemble ? { ensemble: true } : {}),
            ...(other.forecastPeriod &&
            Number.isFinite(other.forecastPeriod.values[index])
              ? {
                  value: other.forecastPeriod.values[index],
                  ...(other.forecastPeriod.units
                    ? { units: other.forecastPeriod.units }
                    : {}),
                  ...(other.forecastPeriod.seconds !== undefined
                    ? { seconds: other.forecastPeriod.seconds }
                    : {}),
                  ...leadBounds(
                    other.forecastPeriod.bounds,
                    index,
                    Boolean(other.forecastPeriod.boundsDeclared)
                  ),
                  standardName: "forecast_period",
                }
              : {}),
          },
        ];
  });
  const scalar = context.scalarLead;
  if (scalar) {
    selections.push({
      dimension: scalar.name,
      index: 0,
      value: scalar.value,
      ...(scalar.units ? { units: scalar.units } : {}),
      seconds: scalar.seconds,
      ...(scalar.bounds ? { valueBounds: scalar.bounds } : {}),
      ...(scalar.pending ? { valueBoundsUnknown: true as const } : {}),
      standardName: "forecast_period",
    });
  }
  return selections.length ? { selections } : {};
}

/** Kinds that read one level and have no vertical axis of their own. */
const LEVEL_KINDS = new Set<string>([
  ANALYSIS_KINDS.POINT_SERIES,
  ANALYSIS_KINDS.REGION_SERIES,
  ANALYSIS_KINDS.HOVMOLLER_LON,
  ANALYSIS_KINDS.HOVMOLLER_LAT,
  ANALYSIS_KINDS.HOVMOLLER_PATH,
  ANALYSIS_KINDS.DISTRIBUTION,
]);

function fixedLevelOf(context: TVariableContext, query: TAnalysisQuery) {
  const v = context.vertical;
  if (!v || !LEVEL_KINDS.has(query.kind)) {
    return {};
  }
  const index = query.level ?? 0;
  const physical = v.kind === VERTICAL_KINDS.PHYSICAL;
  return {
    fixedLevel: {
      dimension: v.dimension,
      index,
      ...(physical && Number.isFinite(v.values[index])
        ? {
            value: v.values[index],
            ...(v.units ? { units: v.units } : {}),
            ...(v.positive ? { positive: v.positive } : {}),
            ...(v.positionStandardName
              ? { standardName: v.positionStandardName }
              : {}),
            // The selected layer's own bounds.
            ...(v.bounds?.length === 2 * v.values.length &&
            Number.isFinite(v.bounds[2 * index]) &&
            Number.isFinite(v.bounds[2 * index + 1])
              ? {
                  bounds: [v.bounds[2 * index], v.bounds[2 * index + 1]] as [
                    number,
                    number,
                  ],
                }
              : {}),
          }
        : {}),
    },
  };
}

/**
 * The time step a one-step plot reads; none without a time axis. A step asked
 * for while the timestamps are unusable is refused, not read as the first one.
 */
export function stepOf(context: TVariableContext, query: TAnalysisQuery) {
  if (
    !context.time &&
    context.timeProblemAxis !== undefined &&
    query.time !== undefined
  ) {
    throw new AnalysisInputError(
      context.timeProblem ??
        "The time coordinate cannot be used now, so the requested date cannot be found."
    );
  }
  return context.time ? (query.time?.start ?? 0) : undefined;
}

export function timeOf(context: TVariableContext, start: number, stop: number) {
  const time = context.time!;
  const bounds = time.bounds?.slice(2 * start, 2 * stop);
  // Bounds missing only outside the dates read leave these dates' totals known.
  const unread =
    time.boundsUnread && !(bounds?.length && bounds.every(Number.isFinite))
      ? time.boundsUnread
      : undefined;
  return {
    dimension: time.dimension,
    // Raw values only: dates are formatted where shown (readouts, rows,
    // ticks), not for the whole axis before the first read.
    raw: time.raw.slice(start, stop),
    ...(time.valid ? { valid: time.valid.slice(start, stop) } : {}),
    ...(time.validBounds
      ? { validBounds: time.validBounds.slice(2 * start, 2 * stop) }
      : {}),
    ...(time.validBoundsUnread
      ? { validBoundsUnread: time.validBoundsUnread }
      : {}),
    ...(time.clockProblem ? { clockProblem: time.clockProblem } : {}),
    ...(time.references
      ? { references: time.references.slice(start, stop) }
      : {}),
    ...(bounds ? { bounds } : {}),
    ...(unread ? { boundsUnread: unread } : {}),
    units: time.units,
    calendar: time.calendar,
    ...(time.standardName ? { standardName: time.standardName } : {}),
    note: time.note,
    ...(context.quantity ? { quantity: context.quantity } : {}),
  };
}

export function verticalOf(context: TVariableContext) {
  const v = context.vertical!;
  return {
    dimension: v.dimension,
    label: v.label,
    units: v.kind === VERTICAL_KINDS.MODEL ? undefined : v.units,
    positive: v.positive,
    physical: isPhysicalVertical(v),
    note: v.note,
    values: v.kind === VERTICAL_KINDS.FORMULA ? [] : v.values,
    ...(v.bounds ? { bounds: v.bounds } : {}),
    ...(v.auxiliary ? { auxiliary: v.auxiliary } : {}),
    ...(v.positionStandardName ? { standardName: v.positionStandardName } : {}),
    ...(context.quantity ? { quantity: context.quantity } : {}),
    ...(v.kind === VERTICAL_KINDS.FORMULA
      ? {
          model: {
            values: v.values,
            label: `${v.dimension} (model coordinate)`,
          },
        }
      : {}),
  };
}

/**
 * A bounded rectilinear cell as it lies: its interval holding its centre
 * (across the seam, [359.5°, 0.5°] is 1° wide; a 270° cell is 270° wide, not
 * the shorter arc), with its west and south edges, so two cells are compared by
 * where they are.
 */
function cellFootprint(grid: TRectilinearContext, i: number, j: number) {
  const [south, north] = cellInterval(grid.lat, i);
  const [west, east] = cellInterval(grid.lon, j);
  return {
    lat: north - south,
    lon: east - west,
    south,
    west: ((((west + 180) % 360) + 360) % 360) - 180,
  };
}

/** A cell as wide as it is tall, in degrees. */
const equalSides = (degrees: number) => ({ lat: degrees, lon: degrees });

/** Spatial position of a point: HEALPix cell or rectilinear (i, j). */
// eslint-disable-next-line max-lines-per-function
export async function locatePoint(
  context: TVariableContext,
  point: TLatLon,
  counters: TWorkCounters,
  signal?: AbortSignal
) {
  const { grid } = context;
  if (grid.kind === ANALYSIS_GRID_KINDS.HEALPIX) {
    const id = grid.grid.lonLatToHealpix(
      new Float64Array([point.lon, point.lat])
    )[0];
    const before = grid.index.counters.chunkReads;
    const [position] = await grid.index.positionsOf([id], signal);
    counters.indexChunkReads += grid.index.counters.chunkReads - before;
    const centre = grid.grid.healpixToLonLat(new BigUint64Array([id]));
    return {
      positions: position < 0 ? [] : [position],
      label: {
        id: id.toString(),
        stored: position >= 0,
        lat: centre[1],
        lon: centre[0],
        selection: "containing HEALPix cell",
        // An equal-area cell's width: the square root of its area.
        footprint: equalSides(
          (Math.sqrt((4 * Math.PI) / (12 * 4 ** grid.order)) * 180) / Math.PI
        ),
        index: { dims: indexDims(context), values: [id.toString()] },
      },
      missing:
        position < 0
          ? `Cell ${id} is not stored in this source; no nearby cell is substituted.`
          : undefined,
    };
  }
  if (grid.kind === ANALYSIS_GRID_KINDS.NATIVE) {
    const geometryStart = performance.now();
    const geometry = await grid.geometry(signal);
    counters.geometryMs += performance.now() - geometryStart;
    const hit = locateNative(grid, geometry, point.lat, point.lon);
    if (hit.cell < 0) {
      return {
        positions: [],
        label: {
          id: "",
          stored: false,
          lat: point.lat,
          lon: point.lon,
          selection: grid.method,
        },
        missing: "reason" in hit ? hit.reason : undefined,
      };
    }
    return {
      positions: nativePositions(grid, hit.cell),
      // The cell's halo or fold copies: a value missing in it is theirs.
      copies: (geometry.copies?.get(hit.cell) ?? []).map((copy) =>
        nativePositions(grid, copy)
      ),
      label: {
        id: nativeCellId(grid, context.dims, hit.cell),
        stored: true,
        lat: geometry.lat[hit.cell],
        lon: geometry.lon[hit.cell],
        selection: grid.method,
        ...(geometry.radii?.[hit.cell]
          ? { footprint: equalSides(2 * geometry.radii[hit.cell]) }
          : {}),
        index: {
          dims: indexDims(context),
          values: nativePositions(grid, hit.cell).map(String),
        },
      },
      missing: undefined,
    };
  }
  if (grid.kind !== ANALYSIS_GRID_KINDS.RECTILINEAR) {
    throw new AnalysisInputError("This grid is not supported for analysis.");
  }
  const i = locateOnAxis(grid.lat, point.lat);
  const j = locateOnAxis(grid.lon, point.lon);
  const nearest = i.nearest || j.nearest;
  const found = i.index >= 0 && j.index >= 0;
  return {
    positions: found ? [i.index, j.index] : [],
    label: {
      id: found ? `${i.index},${j.index}` : "",
      stored: found,
      lat: found ? grid.lat.values[i.index] : point.lat,
      lon: found ? grid.lon.values[j.index] : point.lon,
      // Edges halfway between centres are no published cell.
      selection: nearest
        ? "nearest cell centre (no bounds published)"
        : grid.approximateBounds
          ? (grid.inferredAxes?.length ?? 2) === 1
            ? `containing cell (${inferredEdges(grid)})`
            : "containing cell (edges halfway between centres; no bounds published)"
          : "containing cell (from bounds)",
      ...(found
        ? {
            decimals: Math.max(
              spacingDecimals(grid.lat.values, i.index),
              spacingDecimals(grid.lon.values, j.index)
            ),
          }
        : {}),
      ...(found && grid.lat.bounds && grid.lon.bounds
        ? { footprint: cellFootprint(grid, i.index, j.index) }
        : {}),
      ...(found
        ? {
            index: {
              dims: indexDims(context),
              values: [String(i.index), String(j.index)],
            },
          }
        : {}),
    },
    missing: found ? undefined : "The location is outside the grid.",
  };
}

/** Dimension names of a grid's cell positions (HEALPix: the cell id). */
function indexDims(context: TVariableContext) {
  const { grid } = context;
  switch (grid.kind) {
    case ANALYSIS_GRID_KINDS.HEALPIX:
      return ["healpix_id"];
    case ANALYSIS_GRID_KINDS.RECTILINEAR:
      return [context.dims[grid.latAxis], context.dims[grid.lonAxis]];
    case ANALYSIS_GRID_KINDS.NATIVE:
      return grid.axes.map((axis) => context.dims[axis]);
    default:
      return [];
  }
}

/**
 * The runs of each halo or fold copy of a located cell: `runs` at the copy's
 * place, to read where the cell and the copies before it are missing.
 */
export function copyRunsOf(
  context: TVariableContext,
  runs: TIndexRuns[],
  located: { copies?: number[][] }
) {
  return (located.copies ?? []).map((positions) => {
    const own = runs.map((r) => r.slice());
    setSpatialRuns(context, own, positions);
    return own;
  });
}

/** Runs covering every one of `lists` along each dimension, merged. */
function unitedRuns(lists: TIndexRuns[][]): TIndexRuns[] {
  return lists[0].map((_, d) => {
    const all = lists
      .flatMap((runs) => runs[d])
      .map(([a, b]) => [a, b] as [number, number])
      .sort((x, y) => x[0] - y[0]);
    const out: TIndexRuns = [];
    for (const [a, b] of all) {
      const last = out[out.length - 1];
      if (last && a <= last[1]) {
        last[1] = Math.max(last[1], b);
      } else {
        out.push([a, b]);
      }
    }
    return out;
  });
}

/**
 * A located cell's values, then each copy's where those before it left them
 * missing, one copy after another: the first valid copy gives each value,
 * whichever chunk arrives first. `visit` reads one cell's runs; with `fill`,
 * only into missing values.
 */
export async function withCopies(
  runs: TIndexRuns[],
  copies: TIndexRuns[][],
  missing: () => boolean,
  visit: (runs: TIndexRuns[], fill: boolean) => Promise<unknown>
) {
  await visit(runs, false);
  for (const copy of copies) {
    if (!missing()) {
      return;
    }
    await visit(copy, true);
  }
}

export function setSpatialRuns(
  context: TVariableContext,
  runs: TIndexRuns[],
  positions: number[]
) {
  const { grid } = context;
  if (grid.kind === ANALYSIS_GRID_KINDS.HEALPIX) {
    runs[grid.cellAxis] = [[positions[0], positions[0] + 1]];
  } else if (grid.kind === ANALYSIS_GRID_KINDS.RECTILINEAR) {
    runs[grid.latAxis] = [[positions[0], positions[0] + 1]];
    runs[grid.lonAxis] = [[positions[1], positions[1] + 1]];
  } else if (grid.kind === ANALYSIS_GRID_KINDS.NATIVE) {
    grid.axes.forEach((axis, k) => {
      runs[axis] = [[positions[k], positions[k] + 1]];
    });
  }
}

export function levelNote(context: TVariableContext, level: number) {
  const v = context.vertical!;
  return v.kind === VERTICAL_KINDS.PHYSICAL
    ? `At ${v.dimension} = ${v.values[level]} ${v.units ?? ""} (source coordinate).`
    : `At fixed model level ${level} of ${v.dimension}.`;
}

// eslint-disable-next-line max-lines-per-function
export async function planPointSeries(
  context: TVariableContext,
  query: TAnalysisQuery,
  read: ReadContext,
  signal?: AbortSignal
): Promise<TPlannedAnalysis> {
  if (query.geometry.kind !== GEOMETRY_KINDS.POINT) {
    throw new AnalysisInputError("A point series needs a point.");
  }
  const counters = emptyCounters();
  const { start, stop } = timeRange(context, query);
  const level = levelIndex(context, query);
  const located = await locatePoint(context, query.geometry, counters, signal);
  const runs = selectionRuns(context, query);
  runs[context.time!.axis] = [[start, stop]];
  if (level !== undefined) {
    runs[context.vertical!.axis] = [[level, level + 1]];
  }
  if (located.positions.length) {
    setSpatialRuns(context, runs, located.positions);
  }
  // Each copy of the cell, read only where the ones before it are missing.
  const copyRuns = copyRunsOf(context, runs, located);
  const chunks = located.positions.length
    ? countChunks(context, runs) +
      copyRuns.reduce((n, r) => n + countChunks(context, r), 0)
    : 0;
  const nt = stop - start;
  const layout = layoutNote(context, chunks, nt);
  return {
    estimate: {
      ...estimateFor(context, chunks, nt, layout ? [layout] : []),
      // Every shard a copy's fallback may reach, priced with the cell's.
      ...(located.positions.length
        ? { shardRuns: { own: unitedRuns([runs, ...copyRuns]) } }
        : {}),
    },
    // eslint-disable-next-line max-lines-per-function
    async execute(signal, hooks) {
      const started = performance.now();
      const values = new Array<number>(nt).fill(Number.NaN);
      const fromEnd = Boolean(query.time?.fromEnd);
      const parts = located.positions.length
        ? readingParts(context, start, stop, fromEnd)
        : [];
      const timeAxis = context.time!.axis;
      // Rows sent so far: [sentFrom, sentUntil).
      let [sentFrom, sentUntil] = fromEnd ? [stop, stop] : [start, start];
      // One base per run; every later update (offset 0 too) is a delta.
      let baseSent = false;
      if (parts.length) {
        // The window shows the parts to come before the first one arrives.
        hooks?.onPartial?.(show(0, fromEnd ? stop : start));
      }
      await streamParts(
        parts.length,
        POINT_LOOKAHEAD,
        signal,
        async (part, partSignal) => {
          // The spatial runs as they are (their chunk directory is built
          // once for every part); only the time run is the part's own.
          const [from, until] = parts[part];
          const partOf = (list: TIndexRuns[]) =>
            list.map((r, d) => (d === timeAxis ? [parts[part]] : r));
          // Each copy fills only what the cell and earlier copies left
          // missing, one after another, so the first valid one is used.
          const visit = async (list: TIndexRuns[], fill: boolean) =>
            visitRuns(
              read,
              context.array,
              context.codec,
              partOf(list),
              (_, index, value) => {
                const k = index[timeAxis] - start;
                if (!fill || Number.isNaN(values[k])) {
                  values[k] = value;
                }
              },
              counters,
              partSignal
            );
          await withCopies(
            runs,
            copyRuns,
            () => values.slice(from - start, until - start).some(Number.isNaN),
            visit
          );
        },
        async (part, publish) => {
          if (part + 1 < parts.length) {
            if (publish) {
              hooks?.onPartial?.(show(part + 1, parts[part][fromEnd ? 0 : 1]));
            }
            await hooks?.waitIfPaused?.(signal);
          }
        },
        hooks?.publishEveryMs
      );
      return assemble();

      // Values read ahead of the part shown stay hidden until it is reached.
      // `edge`: read up to it, or (from the end) back to it.
      function show(done: number, edge: number): TPartialUpdate {
        const partial = fromEnd
          ? { done, total: parts.length, readUntil: stop, readFrom: edge }
          : { done, total: parts.length, readUntil: edge };
        const [from, to] = fromEnd
          ? [edge - start, sentFrom - start]
          : [sentUntil - start, edge - start];
        [sentFrom, sentUntil] = fromEnd ? [edge, sentUntil] : [sentFrom, edge];
        if (baseSent) {
          return {
            offset: from,
            values: values.slice(from, to),
            partial,
            counters: { ...counters, totalMs: performance.now() - started },
          };
        }
        baseSent = true;
        const base = assemble(partial);
        if (fromEnd) {
          base.values.fill(Number.NaN, 0, from);
        } else {
          base.values.fill(Number.NaN, to);
        }
        return {
          base,
          offset: 0,
          values: [],
          partial,
          counters: base.counters,
        };
      }

      function assemble(partial?: TAnalysisResult["partial"]) {
        counters.totalMs = performance.now() - started;
        const result = baseResult(context, query, { ...counters });
        result.partial = partial;
        result.values = values.slice();
        result.shape = [values.length];
        result.dims = [context.time!.dimension];
        result.time = timeOf(context, start, stop);
        result.cell = located.label;
        if (level !== undefined) {
          result.notes.push(levelNote(context, level));
        }
        if (located.missing) {
          result.notes.push(located.missing);
        }
        if (layout) {
          result.notes.push(layout);
        }
        return result;
      }
    },
  };
}

function toRegion(geometry: TGeometry): TRegion {
  if (geometry.kind === GEOMETRY_KINDS.BOX) {
    try {
      validateBox(geometry);
    } catch (error) {
      throw new AnalysisInputError((error as Error).message);
    }
    return { kind: REGION_KINDS.BOX, box: geometry };
  }
  if (geometry.kind === GEOMETRY_KINDS.POLYGON) {
    try {
      return {
        kind: REGION_KINDS.POLYGON,
        polygon: preparePolygon(geometry.vertices),
      };
    } catch (error) {
      throw new AnalysisInputError((error as Error).message);
    }
  }
  throw new AnalysisInputError(
    "Choose a country, box or polygon for the region."
  );
}

// Cached masks retain only their numeric weights, independently of the
// planner's lexical scope (which can hold a complete native geometry).
function weightsByPoint(weights: Float64Array): TRegionSelection["weightOf"] {
  return (_, point) => weights[point];
}
const equalAreaWeight = () => 1;

/**
 * Centres by point, from a closure of their own: one made inside the selection
 * would share its scope, and a kept mask would keep the grid's geometry with
 * it.
 */
function positionsByPoint(
  centres: Float64Array
): NonNullable<TRegionSelection["positionOf"]> {
  return (_, point) => [centres[2 * point], centres[2 * point + 1]];
}

export type TRegionSelection = {
  /** Index runs to read; for a point selection, its dimensions are ignored. */
  runs: TIndexRuns[];
  /** Exact selected cells, when the selection is not a product of runs. */
  points?: TPointSelection;
  /** Weight of a visited element: by point, or from its index. */
  weightOf: (index: Float64Array, point: number) => number;
  /**
   * Centre (latitude, longitude) of a visited element, for a map of the
   * area; absent where the grid cannot say cheaply (compacted HEALPix).
   */
  positionOf?: (index: Float64Array, point: number) => [number, number];
  totalCells: bigint;
  storedCells: number;
  totalWeight: number;
  weighting: string;
  /** Sites without areas, each counted once (a site mean). */
  sites?: boolean;
  /**
   * Cells inside without a known area (a native cell without corners):
   * left out, so the footprint's total area is unknown.
   */
  unweighed?: number;
};

async function healpixRegionSelection(
  context: TVariableContext,
  region: TRegion,
  runs: TIndexRuns[],
  counters: TWorkCounters,
  signal?: AbortSignal
): Promise<TRegionSelection> {
  const grid = context.grid;
  if (grid.kind !== ANALYSIS_GRID_KINDS.HEALPIX) {
    throw new Error("Not a HEALPix grid.");
  }
  const geometryStart = performance.now();
  const cover = await coverHealpixRegion(grid.grid, region, {
    isCancelled: () => Boolean(signal?.aborted),
  });
  counters.geometryMs += performance.now() - geometryStart;
  const before = grid.index.counters.chunkReads;
  const beforeBytes = grid.index.counters.bytes;
  const { spans, stored } = await grid.index.spansOf(cover.ranges, signal);
  counters.indexChunkReads += grid.index.counters.chunkReads - before;
  counters.indexBytes += grid.index.counters.bytes - beforeBytes;
  runs[grid.cellAxis] = spans;
  if (cover.cellCount > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new AnalysisInputError(
      `The region selects ${cover.cellCount} cells, more than can be counted exactly; use a smaller region or a coarser order.`
    );
  }
  const total = toSafeNumber(cover.cellCount, "selected cell count");
  const axis = grid.cellAxis;
  return {
    runs,
    totalCells: cover.cellCount,
    storedCells: stored,
    weightOf: equalAreaWeight,
    // A dense level stores cell id = position: its centre is direct.
    ...(grid.index.kind === "dense"
      ? {
          positionOf: (index: Float64Array) => {
            const [lon, lat] = grid.grid.healpixToLonLat(
              new BigUint64Array([BigInt(index[axis])])
            );
            return [lat, lon] as [number, number];
          },
        }
      : {}),
    totalWeight: total,
    weighting: `equal-area HEALPix cells at order ${grid.order}; cells whose centres are inside the region`,
  };
}

/** Sorted indices as half-open runs. */
function runsOfSorted(indices: ArrayLike<number>): TIndexRuns {
  const out: TIndexRuns = [];
  for (let k = 0; k < indices.length; k++) {
    const at = indices[k];
    const last = out[out.length - 1];
    if (last && last[1] === at) {
      last[1]++;
    } else {
      out.push([at, at + 1]);
    }
  }
  return out;
}

const TESTS_BETWEEN_YIELDS = 1 << 16;
// Exact polygon members are held as (row, column) points: 16 bytes each.
const MAX_POLYGON_CELLS = 4_000_000;

function lonCandidates(region: TRegion) {
  if (region.kind === REGION_KINDS.COUNTRY) {
    return (lon: number) => countryHasLongitude(region.country, lon);
  }
  if (region.kind === REGION_KINDS.BOX) {
    return (lon: number) => boxContains(region.box, region.box.south, lon);
  }
  const { lonCentre, lonHalfWidth } = polygonExtent(region.polygon);
  return (lon: number) =>
    lonHalfWidth >= 180 ||
    Math.abs(((lon - lonCentre + 540) % 360) - 180) <= lonHalfWidth;
}

/**
 * Rows and columns that can hold selected centres, in one pass along each
 * axis. A box is exactly their product; a polygon is tested only there.
 */
/**
 * The cyclic copy of a longitude axis, if it has one: its last column exactly
 * one turn from its first (0°…360°, −180°…180°), covering the same cell when
 * bounds are published. A region mean counted it twice. Only that copy goes:
 * distinct columns, however close (0° and 0.0000004°), and an endpoint cell
 * with its own bounds ([315°, 360°] beside [0°, 45°]) keep their weight.
 */
const repeats = new WeakMap<ArrayLike<number>, Set<number>>();
const SAME_TURN_DEGREES = 1e-5;
/**
 * A side column copying any other column is a repeat too, not only the last
 * against the first. Side columns are compared from the middle outwards with
 * the columns kept, so the inner one stays.
 */
// eslint-disable-next-line max-lines-per-function
export function repeatedColumns(axis: {
  values: ArrayLike<number>;
  bounds?: ArrayLike<number>;
}) {
  const lons = axis.values;
  let found = repeats.get(lons);
  if (!found) {
    const out = new Set<number>();
    found = out;
    const n = lons.length;
    const bounds = axis.bounds;
    // Within a thousandth of the cells' own size (and 0.00001° at most): cells
    // 0.000004° wide at 0° and 360° − 0.000004° are distinct, not one.
    const width = (j: number) =>
      bounds
        ? Math.abs(bounds[2 * j + 1] - bounds[2 * j])
        : Math.abs(lons[j === 0 ? 1 : j] - lons[j === 0 ? 0 : j - 1]);
    const apart = (a: number, b: number) => {
      const d = (((a - b) % 360) + 360) % 360;
      return Math.min(d, 360 - d);
    };
    const copies = (j: number, k: number) => {
      const tolerance = Math.min(
        SAME_TURN_DEGREES,
        1e-3 * Math.min(width(j), width(k))
      );
      return (
        apart(lons[j], lons[k]) <= tolerance &&
        (!bounds ||
          (apart(bounds[2 * j], bounds[2 * k]) <= tolerance &&
            apart(bounds[2 * j + 1], bounds[2 * k + 1]) <= tolerance))
      );
    };
    // Columns by their place on the circle, in buckets of the widest tolerance:
    // a copy is looked for in its bucket and the two beside it, any number of
    // columns away. Not in one chain of near places compared all with all. The
    // column nearest the middle stays.
    const place = (j: number) => ((((lons[j] + 180) % 360) + 360) % 360) - 180;
    const middle = (n - 1) / 2;
    const order = Array.from({ length: n }, (_, j) => j)
      .filter((j) => Number.isFinite(lons[j]))
      .sort((a, b) => Math.abs(a - middle) - Math.abs(b - middle) || a - b);
    const kept = new Map<number, number[]>();
    const bucketOf = (p: number) => Math.floor(p / SAME_TURN_DEGREES);
    for (const j of order) {
      const p = place(j);
      let copy = false;
      for (const at of [p, p - 360, p + 360]) {
        const b0 = bucketOf(at);
        for (let b = b0 - 1; b <= b0 + 1 && !copy; b++) {
          copy = (kept.get(b) ?? []).some((other) => copies(j, other));
        }
      }
      if (copy) {
        out.add(j);
      } else {
        const own = bucketOf(p);
        (kept.get(own) ?? kept.set(own, []).get(own)!).push(j);
      }
    }
    repeats.set(lons, found);
  }
  return found;
}

function rectilinearCandidates(grid: TRectilinearContext, region: TRegion) {
  const extent =
    region.kind === REGION_KINDS.BOX
      ? { south: region.box.south, north: region.box.north }
      : region.kind === REGION_KINDS.COUNTRY
        ? region.country
        : polygonExtent(region.polygon);
  // A drawn Box decides centres within its band of the outline on screen: those
  // can lie beyond the traced outline's extent, so the rows and columns
  // searched reach that far too.
  const frame =
    region.kind === REGION_KINDS.COUNTRY ? region.country.frame : undefined;
  const margin = frame ? (frame.band * 180) / Math.PI : 0;
  const [south, north] = [extent.south - margin, extent.north + margin];
  const lats = grid.lat.values;
  const lons = grid.lon.values;
  const rows: number[] = [];
  for (let i = 0; i < lats.length; i++) {
    if (lats[i] >= south && lats[i] <= north) {
      rows.push(i);
    }
  }
  // In longitude the band is wider away from the equator; at a pole all.
  const widest = Math.max(Math.abs(south), Math.abs(north));
  const lonMargin =
    margin && widest < 89.999
      ? Math.min(180, margin / Math.cos((widest * Math.PI) / 180))
      : margin
        ? 180
        : 0;
  const lonInside =
    region.kind === REGION_KINDS.COUNTRY && lonMargin
      ? (lon: number) =>
          lonMargin >= 180 ||
          countryHasLongitude(region.country, lon, lonMargin)
      : lonCandidates(region);
  const repeated = repeatedColumns(grid.lon);
  const cols: number[] = [];
  for (let j = 0; j < lons.length; j++) {
    if (lonInside(lons[j]) && !repeated.has(j)) {
      cols.push(j);
    }
  }
  return { rows, cols };
}

/**
 * Weights of some indices (sorted), looked up by index: a typed array over
 * their range when dense, else a map. Nothing outside them is held.
 */
export function weightsAt(
  indices: number[],
  weightOf: (index: number) => number
): (index: number) => number {
  if (!indices.length) {
    return () => 0;
  }
  const first = indices[0];
  const span = indices[indices.length - 1] - first + 1;
  if (span <= 4 * indices.length + 64) {
    const dense = new Float64Array(span);
    for (const at of indices) {
      dense[at - first] = weightOf(at);
    }
    return (index) => dense[index - first] ?? 0;
  }
  const sparse = new Map(indices.map((at) => [at, weightOf(at)]));
  return (index) => sparse.get(index) ?? 0;
}

/**
 * How many candidate cells a region holds, from cells drawn at random: the
 * estimate and a lower bound it is very unlikely to be under.
 */
function sampledMembers(
  grid: TRectilinearContext,
  region: TRegion,
  candidates: { rows: number[]; cols: number[] }
) {
  const { rows, cols } = candidates;
  const total = rows.length * cols.length;
  if (total <= MAX_POLYGON_CELLS) {
    return { estimate: 0, lower: 0 }; // cannot be over: no sample needed
  }
  const n = 20_000;
  // A fixed-seed generator: the same region is judged the same each time.
  let seed = 0x9e3779b9;
  const next = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  let inside = 0;
  for (let k = 0; k < n; k++) {
    const i = rows[Math.floor(next() * rows.length)];
    const j = cols[Math.floor(next() * cols.length)];
    if (regionContains(region, grid.lat.values[i], grid.lon.values[j])) {
      inside++;
    }
  }
  const p = inside / n;
  // Four standard errors below: a refusal on the sample alone is sure.
  const lower = Math.max(0, p - 4 * Math.sqrt((p * (1 - p)) / n));
  return { estimate: p * total, lower: lower * total };
}

/**
 * Whether a region holds more than `limit` candidate cells, counted one by
 * one without keeping them, and stopped as soon as it is over.
 */
async function membersOver(
  grid: TRectilinearContext,
  region: TRegion,
  candidates: { rows: number[]; cols: number[] },
  limit: number,
  signal?: AbortSignal
) {
  let [inside, tests] = [0, 0];
  const { rows, cols } = candidates;
  const [lats, lons] = [grid.lat.values, grid.lon.values];
  for (const [i, j] of cellsNear(region, lats, lons, rows, cols)) {
    if (++tests % TESTS_BETWEEN_YIELDS === 0) {
      await yieldIfBusy(signal);
    }
    if (regionContains(region, lats[i], lons[j]) && ++inside > limit) {
      return true;
    }
  }
  return false;
}

/** Exact polygon or country members as points, with spherical weights. */
async function polygonMembers(
  grid: TRectilinearContext,
  region: TRegion,
  candidates: { rows: number[]; cols: number[] },
  weightOf: (i: number, j: number) => number,
  signal?: AbortSignal
) {
  // Sampled first: a region far over the limit is refused at once, not after
  // millions of tests and hundreds of MiB. A refusal is sure before it is made:
  // from the sample when even its lower bound is over, else from an exact
  // count.
  const { estimate, lower } = sampledMembers(grid, region, candidates);
  const advice = `A box on a map that is not tilted (or Box → All longitudes or Polar cap in Settings) is a latitude/longitude box, read in runs without that limit; or select a smaller area.`;
  if (lower > MAX_POLYGON_CELLS) {
    throw new AnalysisInputError(
      `The drawn region holds about ${count(Math.round(estimate))} cells, more than the ${count(MAX_POLYGON_CELLS)} a region keeps cell by cell. ${advice}`
    );
  }
  if (
    estimate > MAX_POLYGON_CELLS * 0.5 &&
    (await membersOver(grid, region, candidates, MAX_POLYGON_CELLS, signal))
  ) {
    throw new AnalysisInputError(
      `The drawn region holds more than the ${count(MAX_POLYGON_CELLS)} cells a region keeps cell by cell. ${advice}`
    );
  }
  // Only the cells near the region are tested, then put back in row,
  // then column, order.
  const found: [number, number][] = [];
  let tests = 0;
  const { rows, cols } = candidates;
  const [lats, lons] = [grid.lat.values, grid.lon.values];
  for (const [i, j] of cellsNear(region, lats, lons, rows, cols)) {
    if (++tests % TESTS_BETWEEN_YIELDS === 0) {
      await yieldIfBusy(signal);
    }
    if (regionContains(region, lats[i], lons[j])) {
      if (found.length >= MAX_POLYGON_CELLS) {
        throw new AnalysisInputError(
          `The polygon holds more than ${count(MAX_POLYGON_CELLS)} cells; use a box or a smaller polygon.`
        );
      }
      found.push([i, j]);
    }
  }
  found.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const positions = new Float64Array(2 * found.length);
  const pointWeights = new Float64Array(found.length);
  found.forEach(([i, j], at) => {
    positions[2 * at] = i;
    positions[2 * at + 1] = j;
    pointWeights[at] = weightOf(i, j);
  });
  return { positions, weights: pointWeights };
}

/**
 * A box selects a product of rows and columns, read as runs with separable
 * weights; a polygon selects exact cells, read as points.
 */
// eslint-disable-next-line max-lines-per-function
async function rectilinearRegionSelection(
  context: TVariableContext,
  region: TRegion,
  runs: TIndexRuns[],
  signal?: AbortSignal
): Promise<TRegionSelection> {
  const grid = context.grid as TRectilinearContext;
  const candidates = rectilinearCandidates(grid, region);
  // A 2-D measure under a drawn region or country: its cells first, then only
  // the area chunks under them. A 1-D one too: its rows (or columns) of those
  // cells.
  const underCells =
    region.kind !== REGION_KINDS.BOX &&
    (grid.areas?.array.dimensionNames.length ?? 0) >= 1;
  const chosen = underCells
    ? await polygonMembers(grid, region, candidates, () => 1, signal)
    : undefined;
  // Weights of the candidate rows and columns only (a narrow region on a
  // two-million-column grid holds no two million weights), or the grid's
  // declared cell areas, read once.
  const weights = await cellWeights(
    grid,
    candidates.rows,
    candidates.cols,
    signal,
    chosen?.positions
  );
  const weighting = `${weightingLabel(grid)}; cells whose centres are inside the region${weights.invalid ? `; ${count(weights.invalid)} ${weights.invalid === 1 ? "cell" : "cells"} in the region's rows and columns ${weights.invalid === 1 ? "has" : "have"} no valid area (left out where selected)` : ""}`;
  throwIfAborted(signal);
  if (region.kind === REGION_KINDS.BOX) {
    let totalWeight = 0;
    if (weights.separable) {
      let rowWeight = 0;
      for (const i of candidates.rows) {
        rowWeight += weights.separable.lat(i);
      }
      let colWeight = 0;
      for (const j of candidates.cols) {
        colWeight += weights.separable.lon(j);
      }
      totalWeight = rowWeight * colWeight;
    } else {
      for (const i of candidates.rows) {
        for (const j of candidates.cols) {
          totalWeight += weights.at(i, j);
        }
      }
    }
    runs[grid.latAxis] = runsOfSorted(candidates.rows);
    runs[grid.lonAxis] = runsOfSorted(candidates.cols);
    const cells = candidates.rows.length * candidates.cols.length;
    // Selected cells without a declared area are counted, as on native grids.
    let unweighed = 0;
    if (weights.invalid && weights.separable) {
      // Rows and columns without a weight, counted along each axis.
      let badRows = 0;
      for (const i of candidates.rows) {
        badRows += weights.separable.lat(i) > 0 ? 0 : 1;
      }
      let badCols = 0;
      for (const j of candidates.cols) {
        badCols += weights.separable.lon(j) > 0 ? 0 : 1;
      }
      unweighed =
        badRows * candidates.cols.length +
        badCols * candidates.rows.length -
        badRows * badCols;
    } else if (weights.invalid) {
      for (const i of candidates.rows) {
        for (const j of candidates.cols) {
          unweighed += weights.at(i, j) > 0 ? 0 : 1;
        }
      }
    }
    return {
      runs,
      totalCells: BigInt(cells),
      storedCells: cells,
      ...(unweighed ? { unweighed } : {}),
      weightOf: (index) => weights.at(index[grid.latAxis], index[grid.lonAxis]),
      positionOf: (index) => [
        grid.lat.values[index[grid.latAxis]],
        grid.lon.values[index[grid.lonAxis]],
      ],
      totalWeight,
      weighting,
    };
  }
  const members = chosen
    ? {
        positions: chosen.positions,
        weights: chosen.weights.map((_, at) =>
          weights.at(chosen.positions[2 * at], chosen.positions[2 * at + 1])
        ),
      }
    : await polygonMembers(grid, region, candidates, weights.at, signal);
  let totalWeight = 0;
  let unweighed = 0;
  for (const w of members.weights) {
    totalWeight += w;
    unweighed += weights.invalid && !(w > 0) ? 1 : 0;
  }
  const cells = members.weights.length;
  return {
    runs,
    ...(unweighed ? { unweighed } : {}),
    points: {
      dims: [grid.latAxis, grid.lonAxis],
      positions: members.positions,
    },
    totalCells: BigInt(cells),
    storedCells: cells,
    weightOf: weightsByPoint(members.weights),
    positionOf: (_, point) => [
      grid.lat.values[members.positions[2 * point]],
      grid.lon.values[members.positions[2 * point + 1]],
    ],
    totalWeight,
    weighting,
  };
}

function nativeRegionOf(region: TRegion): TNativeRegion {
  return region.kind === REGION_KINDS.BOX
    ? { box: region.box }
    : region.kind === REGION_KINDS.COUNTRY
      ? { country: region.country }
      : { polygon: region.polygon };
}

/**
 * Native cells whose centres are inside the region, read as exact points
 * with their area weights (declared measures or spherical outlines).
 */
// eslint-disable-next-line max-lines-per-function
async function nativeRegionSelection(
  context: TVariableContext,
  region: TRegion,
  runs: TIndexRuns[],
  counters: TWorkCounters,
  signal?: AbortSignal
): Promise<TRegionSelection> {
  const grid = context.grid as TNativeContext;
  if (!grid.weighting && !grid.siteMean) {
    throw new AnalysisInputError(grid.noWeights ?? "No area weights.");
  }
  // Sites: each counts once (the capabilities allow this for series only).
  const equal = !grid.weighting;
  const geometryStart = performance.now();
  const geometry = await grid.geometry(signal);
  const cells = await nativeMembers(
    geometry,
    nativeRegionOf(region),
    MAX_POLYGON_CELLS,
    signal
  );
  counters.geometryMs += performance.now() - geometryStart;
  if (cells.length > MAX_POLYGON_CELLS) {
    throw new AnalysisInputError(
      `The region holds more than ${count(MAX_POLYGON_CELLS)} cells; draw a smaller one.`
    );
  }
  // No cell inside: no area to read.
  const areas =
    equal || !cells.length
      ? undefined
      : await nativeAreas(grid, geometry, signal);
  // A cell's area from the first of its copies that has one: a halo copy
  // stands for the kept cell whose own area is missing.
  const areaOf = (cell: number) => {
    for (const c of [cell, ...(geometry.copies?.get(cell) ?? [])]) {
      const w = areas?.[c] ?? 0;
      if (Number.isFinite(w) && w > 0) {
        return w;
      }
    }
    return 0;
  };
  const rank = grid.axes.length;
  const positions = new Float64Array(cells.length * rank);
  const weights = new Float64Array(cells.length);
  // The selected centres themselves, not the geometry: a kept mask holds what
  // it is charged for, and a released source's geometry can go.
  const centres = new Float64Array(2 * cells.length);
  let totalWeight = 0;
  // Cells inside with no area from their corners: named, never weighed.
  let unweighed = 0;
  cells.forEach((cell, at) => {
    nativePositions(grid, cell).forEach(
      (p, k) => (positions[at * rank + k] = p)
    );
    centres[2 * at] = geometry.lat[cell];
    centres[2 * at + 1] = geometry.lon[cell];
    weights[at] = equal ? 1 : areaOf(cell);
    unweighed += weights[at] ? 0 : 1;
    totalWeight += weights[at];
  });
  return {
    runs,
    points: { dims: grid.axes, positions },
    totalCells: BigInt(cells.length),
    storedCells: cells.length,
    weightOf: weightsByPoint(weights),
    positionOf: positionsByPoint(centres),
    totalWeight,
    weighting: `${
      equal
        ? `${grid.siteMean}; sites inside the region`
        : `${grid.weighting}; cells whose centres are inside the region`
    }${geometry.duplicates ? `; ${count(geometry.duplicates)} repeated ${geometry.duplicates === 1 ? "cell" : "cells"} of the grid (halo or fold) counted once` : ""}${unweighed ? `; ${count(unweighed)} ${unweighed === 1 ? "cell" : "cells"} inside without an area from ${unweighed === 1 ? "its" : "their"} corners left out` : ""}`,
    ...(equal ? { sites: true } : {}),
    ...(unweighed ? { unweighed } : {}),
  };
}

export function emptyRegionNote(
  geometry: TGeometry,
  selection: TRegionSelection
) {
  const country = geometry.kind === GEOMETRY_KINDS.COUNTRY;
  if (selection.totalCells === 0n) {
    // Say why (smaller than a cell) and what to do.
    return country
      ? "No grid cell centre falls inside this country: it is smaller than the cells of this data (or lies between their centres), so there is no value to average. Plot a point time series on it (the cell it lies in), select a larger area around it, or use data on a finer grid."
      : "No cell centre lies inside this region: it is smaller than one grid cell of this data, so there is no value to average. Make it larger (Settings → Edit on map), or plot a point time series there (the cell it lies in).";
  }
  if (selection.storedCells === 0) {
    return country
      ? "This source stores no grid cells with centres inside the selected country."
      : "This source stores no grid cells with centres inside the selected region.";
  }
  return undefined;
}

/**
 * A native region's cells with the copies a halo or fold repeats them in:
 * each copy is read as a point of its kept cell's weight, so a value missing
 * in one copy is taken from another. Without copies, the selection as is.
 */
// eslint-disable-next-line max-lines-per-function
export async function withCellCopies(
  context: TVariableContext,
  selection: TRegionSelection,
  signal?: AbortSignal
): Promise<TRegionSelection & { classOf?: Int32Array }> {
  const grid = context.grid;
  const points = selection.points;
  if (grid.kind !== ANALYSIS_GRID_KINDS.NATIVE || !points) {
    return selection;
  }
  const copies = (await grid.geometry(signal)).copies;
  if (!copies?.size) {
    return selection;
  }
  const rank = grid.axes.length;
  const count = points.positions.length / rank;
  const shape = grid.shape;
  const cellOf = (at: number) => {
    let cell = 0;
    for (let k = 0; k < rank; k++) {
      cell = cell * shape[k] + points.positions[at * rank + k];
    }
    return cell;
  };
  const extra: number[] = [];
  const owner: number[] = [];
  for (let at = 0; at < count; at++) {
    for (const copy of copies.get(cellOf(at)) ?? []) {
      extra.push(...nativePositions(grid, copy));
      owner.push(at);
    }
  }
  if (!owner.length) {
    return selection;
  }
  const positions = new Float64Array(points.positions.length + extra.length);
  positions.set(points.positions);
  positions.set(extra, points.positions.length);
  const classOf = new Int32Array(count + owner.length).fill(-1);
  owner.forEach((at, k) => {
    classOf[at] = at;
    classOf[count + k] = at;
  });
  const primary = (point: number) =>
    point < count ? point : owner[point - count];
  return {
    ...selection,
    points: { ...points, positions },
    weightOf: (index, point) => selection.weightOf(index, primary(point)),
    ...(selection.positionOf
      ? {
          positionOf: (index: Float64Array, point: number) =>
            selection.positionOf!(index, primary(point)),
        }
      : {}),
    classOf,
  };
}

/**
 * Each repeated cell's value at each step of a span: from its first copy,
 * in the grid's order (the kept cell, then its copies), with a finite value.
 * Copies are held until the span is read and handed on in cell order, so
 * the order chunks arrive in does not change the answer.
 */
export function copyPicker(
  selection: { classOf?: Int32Array },
  length: number
) {
  const classOf = selection.classOf;
  if (!classOf) {
    return undefined;
  }
  const slotOf = new Int32Array(classOf.length).fill(-1);
  const rankOf = new Int32Array(classOf.length);
  const primaries: number[] = [];
  classOf.forEach((cls, point) => {
    if (cls < 0) {
      return;
    }
    if (cls === point) {
      slotOf[point] = primaries.push(point) - 1;
    }
  });
  // Copies follow their kept cell's slot, numbered in the order listed.
  const listed = new Int32Array(primaries.length);
  classOf.forEach((cls, point) => {
    if (cls >= 0 && cls !== point) {
      slotOf[point] = slotOf[cls];
      rankOf[point] = ++listed[slotOf[cls]];
    }
  });
  const best = new Float64Array(primaries.length * length).fill(Number.NaN);
  const from = new Int32Array(primaries.length * length).fill(-1);
  return {
    /** Whether `point` is a copy of a repeated cell (held, not counted now). */
    hold(point: number, k: number, value: number) {
      const slot = slotOf[point];
      if (slot < 0) {
        return false;
      }
      const at = slot * length + k;
      if (!Number.isNaN(value) && (from[at] < 0 || rankOf[point] < from[at])) {
        best[at] = value;
        from[at] = rankOf[point];
      }
      return true;
    },
    /** Each held cell's chosen value (NaN if none), by kept cell and step. */
    each(take: (point: number, k: number, value: number) => void) {
      primaries.forEach((point, slot) => {
        for (let k = 0; k < length; k++) {
          take(point, k, best[slot * length + k]);
        }
      });
    },
  };
}

/** The bytes a copy picker holds over `length` steps, with their sums. */
export function copyPickerBytes(
  selection: { classOf?: Int32Array },
  length: number
) {
  const classOf = selection.classOf;
  if (!classOf) {
    return 0;
  }
  let classes = 0;
  classOf.forEach((cls, point) => (classes += cls === point ? 1 : 0));
  // With the part's own sums they are folded through.
  return classOf.length * 8 + classes * (4 + 12 * length) + SUMS_BYTES * length;
}

/** The cells of a region on any supported grid. */
export async function regionSelection(
  context: TVariableContext,
  region: TRegion,
  runs: TIndexRuns[],
  counters: TWorkCounters,
  signal?: AbortSignal
): Promise<TRegionSelection> {
  switch (context.grid.kind) {
    case ANALYSIS_GRID_KINDS.HEALPIX:
      return healpixRegionSelection(context, region, runs, counters, signal);
    case ANALYSIS_GRID_KINDS.NATIVE:
      return nativeRegionSelection(context, region, runs, counters, signal);
    case ANALYSIS_GRID_KINDS.RECTILINEAR: {
      const start = performance.now();
      const selection = await rectilinearRegionSelection(
        context,
        region,
        runs,
        signal
      );
      counters.geometryMs += performance.now() - start;
      return selection;
    }
    default:
      throw new AnalysisInputError(context.grid.reason);
  }
}
type TCountryMask = Omit<TRegionSelection, "runs"> & { spans?: TIndexRuns };
const countryMasks = new ByteLru<TCountryMask>(32 * 2 ** 20);
const preparedCountries = new ByteLru<ReturnType<typeof prepareCountry>>(
  16 * 2 ** 20
);

/** A boundary's identity in caches: the atlas country, or the shape's hash. */
function boundaryKey(geometry: TCountryGeometry | TShapeGeometry) {
  return geometry.kind === GEOMETRY_KINDS.SHAPE
    ? ["shape", geometry.digest]
    : [
        COUNTRY_ATLAS_VERSION,
        countryIds(geometry).join("+"),
        geometry.resolution,
      ];
}

/** Atlas resolutions whose boundaries have been prepared this session. */
const preparedAtlases = new Set<string>();

/** Characters of each bundled atlas (world-atlas 2), parsed on first use. */
const ATLAS_CHARACTERS: Record<string, number> = {
  "110m": 107761,
  "50m": 756420,
  "10m": 3661071,
};

/**
 * The atlas a country plot would first parse, when it is not prepared yet (and
 * no kept mask spares it): its resolution and size.
 */
export function coldAtlas(context: TVariableContext, geometry: TGeometry) {
  if (geometry.kind !== GEOMETRY_KINDS.COUNTRY) {
    return undefined;
  }
  if (
    preparedAtlases.has(geometry.resolution) ||
    countryMasks.get(maskKey(context, geometry) || "")
  ) {
    return undefined;
  }
  return {
    resolution: geometry.resolution,
    characters: ATLAS_CHARACTERS[geometry.resolution] ?? 0,
  };
}

/** A country's (or an imported shape's, already clipped) prepared rings. */
async function loadCountryRegion(
  geometry: TCountryGeometry | TShapeGeometry,
  signal?: AbortSignal
) {
  const key = JSON.stringify(boundaryKey(geometry));
  const cached = preparedCountries.get(key);
  if (cached) {
    return cached;
  }
  const rings =
    geometry.kind === GEOMETRY_KINDS.SHAPE
      ? geometry.polygons
      : geometry.ids?.length
        ? await getCountriesRings(geometry.ids, geometry.resolution)
        : await getCountryRings(geometry.id, geometry.resolution);
  if (geometry.kind === GEOMETRY_KINDS.COUNTRY) {
    preparedAtlases.add(geometry.resolution);
  }
  throwIfAborted(signal);
  const shape = geometry.kind === GEOMETRY_KINDS.SHAPE ? geometry : undefined;
  const country = prepareCountry(rings, shape?.poles);
  // A drawn Box decides centres near its outline as its view showed them.
  if (shape?.frame) {
    country.frame = frameRule(shape.frame);
  }
  // Allow for the edge-index tree, JS array capacity and latitude-band lists.
  let bytes = 16 * 1024;
  for (const polygon of rings) {
    for (const ring of polygon) {
      bytes += 1024 + ring.length * 80;
    }
  }
  preparedCountries.set(key, country, bytes);
  return country;
}

function cacheCountryMask(
  key: string,
  selection: TRegionSelection,
  spans?: TIndexRuns
) {
  // Everything but the caller's runs: a reused mask must answer as the first.
  const { runs: _runs, ...kept } = selection;
  void _runs;
  const bytes = kept.points
    ? // Positions, weights and (native) centres.
      pointSelectionBytes(kept.points) + kept.storedCells * 24
    : (spans?.length ?? 0) * 80;
  countryMasks.set(key, { ...kept, spans }, bytes + 512 + key.length * 2);
}

/**
 * The key a region's mask is kept under: the shape, the grid's cells and
 * the field's own axes. Undefined where masks are not kept.
 */
function maskKey(
  context: TVariableContext,
  geometry: TCountryGeometry | TShapeGeometry
) {
  const { grid } = context;
  return (
    "regionKey" in grid &&
    grid.regionKey &&
    JSON.stringify([
      ...boundaryKey(geometry),
      grid.kind,
      grid.regionKey,
      grid.kind === ANALYSIS_GRID_KINDS.NATIVE ? grid.axes : null,
      // A mask's positions and weights read the field's own axes: a field
      // stored [cell, time] does not share one built on [time, cell].
      grid.kind === ANALYSIS_GRID_KINDS.HEALPIX
        ? grid.cellAxis
        : grid.kind === ANALYSIS_GRID_KINDS.RECTILINEAR
          ? [grid.latAxis, grid.lonAxis]
          : null,
    ])
  );
}

/**
 *  Reuse spatial membership and weights across variables, levels and times
 * on the same grid. Each call supplies its own non-spatial runs.
 */

export async function queryRegionSelection(
  context: TVariableContext,
  geometry: TGeometry,
  runs: TIndexRuns[],
  counters: TWorkCounters,
  signal?: AbortSignal
): Promise<TRegionSelection> {
  if (
    geometry.kind !== GEOMETRY_KINDS.COUNTRY &&
    geometry.kind !== GEOMETRY_KINDS.SHAPE
  ) {
    return regionSelection(context, toRegion(geometry), runs, counters, signal);
  }
  throwIfAborted(signal);
  const { grid } = context;
  const key = maskKey(context, geometry);
  const kept = key && countryMasks.get(key);
  // Windows asking for the same mask at once share one construction.
  const mask =
    kept ||
    (key
      ? await pendingMasks.share(
          key,
          1,
          (own) => buildCountryMask(context, geometry, key, counters, own),
          signal
        )
      : undefined);
  if (mask) {
    if (mask.spans && grid.kind === ANALYSIS_GRID_KINDS.HEALPIX) {
      runs[grid.cellAxis] = mask.spans;
    }
    return { ...mask, runs };
  }
  const country = await loadCountryRegion(geometry, signal);
  return regionSelection(
    context,
    { kind: REGION_KINDS.COUNTRY, country },
    runs,
    counters,
    signal
  );
}

/** Masks being built, shared by every plan waiting for one (not kept). */
const pendingMasks = new SharedReads(0);

async function buildCountryMask(
  context: TVariableContext,
  geometry: TCountryGeometry | TShapeGeometry,
  key: string,
  counters: TWorkCounters,
  signal: AbortSignal
): Promise<TCountryMask> {
  const start = performance.now();
  const country = await loadCountryRegion(geometry, signal);
  counters.geometryMs += performance.now() - start;
  const runs: TIndexRuns[] = context.dims.map(() => []);
  const selection = await regionSelection(
    context,
    { kind: REGION_KINDS.COUNTRY, country },
    runs,
    counters,
    signal
  );
  const { grid } = context;
  const spans =
    grid.kind === ANALYSIS_GRID_KINDS.HEALPIX ? runs[grid.cellAxis] : undefined;
  cacheCountryMask(key, selection, spans);
  // The caller's runs are its own; the mask carries the cell spans.
  const mask: TCountryMask & { runs?: TIndexRuns[] } = {
    ...selection,
    ...(spans ? { spans } : {}),
  };
  delete mask.runs;
  return mask;
}

type TChunkSums = {
  from: number;
  sum: Float64Array;
  weight: Float64Array;
  count: Float64Array;
  /**
   * Running weighted mean and centred second moment (Σw(x − mean)²), for
   * the area-weighted standard deviation: stable at any offset (values
   * near 1e8 or 1e12 keep their spread), merged exactly between chunks.
   */
  mean: Float64Array;
  m2: Float64Array;
  min: Float64Array;
  max: Float64Array;
};

/** Bytes of one time step in a chunk's sums (seven float64 arrays). */
const SUMS_BYTES = 56;

/** Add a value of weight `w` to the running mean and moment at `k`. */
function addMoment(
  acc: Pick<TChunkSums, "mean" | "m2" | "weight">,
  k: number,
  value: number,
  w: number
) {
  const total = acc.weight[k] + w;
  const d = value - acc.mean[k];
  acc.mean[k] += (w / total) * d;
  acc.m2[k] += w * d * (value - acc.mean[k]);
}

/**
 * Per-chunk partial sums over only that chunk's time interval, folded into
 * the totals in chunk order (deterministic) as soon as every earlier chunk
 * is done; at most one batch of chunk jobs is ever held.
 */
// eslint-disable-next-line max-lines-per-function
function orderedFolder(
  span: [number, number],
  chunkT: number,
  totals: Omit<TChunkSums, "from"> & { start: number },
  live: { bytes: number },
  counters: TWorkCounters
) {
  const filling = new Map<number, TChunkSums>();
  const finished = new Map<number, TChunkSums | null>();
  let next = 0;
  const fold = (acc: TChunkSums) => {
    const offset = acc.from - totals.start;
    for (let k = 0; k < acc.sum.length; k++) {
      // Two groups' moments merged (Chan et al.), before the weights add.
      const [wa, wb] = [totals.weight[offset + k], acc.weight[k]];
      if (wb > 0) {
        const d = acc.mean[k] - totals.mean[offset + k];
        totals.mean[offset + k] += (d * wb) / (wa + wb);
        totals.m2[offset + k] += acc.m2[k] + (d * d * wa * wb) / (wa + wb);
      }
      totals.sum[offset + k] += acc.sum[k];
      totals.weight[offset + k] += acc.weight[k];
      totals.count[offset + k] += acc.count[k];
      totals.min[offset + k] = Math.min(totals.min[offset + k], acc.min[k]);
      totals.max[offset + k] = Math.max(totals.max[offset + k], acc.max[k]);
    }
    live.bytes -= SUMS_BYTES * acc.sum.length;
  };
  return {
    /** Sums over the whole span, folded after every chunk's. */
    whole(add: (acc: TChunkSums) => void) {
      const length = span[1] - span[0];
      const acc = {
        from: span[0],
        sum: new Float64Array(length),
        weight: new Float64Array(length),
        count: new Float64Array(length),
        mean: new Float64Array(length),
        m2: new Float64Array(length),
        min: new Float64Array(length).fill(Infinity),
        max: new Float64Array(length).fill(-Infinity),
      };
      live.bytes += SUMS_BYTES * length;
      counters.peakAccumulatorBytes = Math.max(
        counters.peakAccumulatorBytes,
        live.bytes
      );
      add(acc);
      fold(acc);
    },
    accumulator(ordinal: number, t: number) {
      let acc = filling.get(ordinal);
      if (!acc) {
        const chunkStart = Math.floor(t / chunkT) * chunkT;
        const from = Math.max(span[0], chunkStart);
        const length = Math.min(span[1], chunkStart + chunkT) - from;
        acc = {
          from,
          sum: new Float64Array(length),
          weight: new Float64Array(length),
          count: new Float64Array(length),
          mean: new Float64Array(length),
          m2: new Float64Array(length),
          min: new Float64Array(length).fill(Infinity),
          max: new Float64Array(length).fill(-Infinity),
        };
        filling.set(ordinal, acc);
        live.bytes += SUMS_BYTES * length;
        counters.peakAccumulatorBytes = Math.max(
          counters.peakAccumulatorBytes,
          live.bytes
        );
      }
      return acc;
    },
    done(ordinal: number) {
      finished.set(ordinal, filling.get(ordinal) ?? null);
      filling.delete(ordinal);
      while (finished.has(next)) {
        const acc = finished.get(next);
        finished.delete(next);
        if (acc) {
          fold(acc);
        }
        next++;
      }
    },
  };
}

/**
 * A vector component's repeated cells over one part of its dates: each cell's
 * own value from its first valid copy, kept where the partner has a valid value
 * on any copy of the same cell at the same instant (U stored on one copy and V
 * on another are one cell's wind). As [kept point, step in the part, value].
 */
// eslint-disable-next-line max-lines-per-function
async function jointCopies(
  read: ReadContext,
  pair: {
    context: TVariableContext;
    partner: TVariableContext;
    selection: TRegionSelection & { classOf?: Int32Array };
    rows: Int32Array;
  },
  partnerRunsOf: TIndexRuns[],
  [from, until]: [number, number],
  counters: TWorkCounters,
  signal?: AbortSignal
) {
  const { context, partner, selection, rows } = pair;
  const classOf = selection.classOf!;
  const points = selection.points!;
  const rank = points.dims.length;
  const members = Array.from(classOf).flatMap((cls, point) =>
    cls >= 0 ? [point] : []
  );
  const positions = new Float64Array(members.length * rank);
  members.forEach((point, m) => {
    for (let d = 0; d < rank; d++) {
      positions[m * rank + d] = points.positions[point * rank + d];
    }
  });
  const only = { dims: points.dims, positions };
  const timeAxis = context.time!.axis;
  const length = until - from;
  const own = new Float64Array(members.length * length).fill(Number.NaN);
  const valid = new Uint8Array(members.length * length);
  // Own rows by the partner's row they are matched with.
  const byRow = new Map<number, number[]>();
  for (let t = from; t < until; t++) {
    if (rows[t] >= 0) {
      byRow.set(rows[t], [...(byRow.get(rows[t]) ?? []), t - from]);
    }
  }
  await visitRuns(
    read,
    context.array,
    context.codec,
    selection.runs.map((r, d) => (d === timeAxis ? [[from, until]] : r)),
    (_, index, value, m) => {
      own[m * length + index[timeAxis] - from] = value;
    },
    counters,
    signal,
    undefined,
    only
  );
  const partnerTime = partner.time!.axis;
  await visitRuns(
    read,
    partner.array,
    partner.codec,
    partnerRunsOf.map((r, d) =>
      d === partnerTime ? partnerRuns(rows, [[from, until]]) : r
    ),
    (_, index, value, m) => {
      if (!Number.isNaN(value)) {
        for (const k of byRow.get(index[partnerTime]) ?? []) {
          valid[m * length + k] = 1;
        }
      }
    },
    counters,
    signal,
    undefined,
    only
  );
  // Members of a class in point order: the kept cell, then its copies.
  const byClass = new Map<number, number[]>();
  members.forEach((point, m) =>
    byClass.set(classOf[point], [...(byClass.get(classOf[point]) ?? []), m])
  );
  const pairs: [number, number, number][] = [];
  for (const [kept, list] of byClass) {
    for (let k = 0; k < length; k++) {
      const first = list.find((m) => !Number.isNaN(own[m * length + k]));
      if (first !== undefined && list.some((m) => valid[m * length + k])) {
        pairs.push([kept, k, own[first * length + k]]);
      }
    }
  }
  return pairs;
}

/** One weighted value into a chunk's sums. */
function addValue(acc: TChunkSums, k: number, value: number, w: number) {
  addMoment(acc, k, value, w);
  acc.sum[k] += w * value;
  acc.weight[k] += w;
  acc.count[k] += 1;
  acc.min[k] = Math.min(acc.min[k], value);
  acc.max[k] = Math.max(acc.max[k], value);
}

/** Repeated cells' chosen values, each weighed once. */
function addPicked(
  acc: TChunkSums,
  picked: NonNullable<ReturnType<typeof copyPicker>>,
  selection: TRegionSelection
) {
  const none = new Float64Array(0);
  picked.each((point, k, value) => {
    const w = selection.weightOf(none, point);
    if (w > 0 && !Number.isNaN(value)) {
      addValue(acc, k, value, w);
    }
  });
}

// eslint-disable-next-line max-lines-per-function
export async function planRegionSeries(
  context: TVariableContext,
  query: TAnalysisQuery,
  read: ReadContext,
  signal?: AbortSignal,
  /** The other vector component's context (`query.jointWith`). */
  partner?: TVariableContext
): Promise<TPlannedAnalysis> {
  if (!context.capabilities[ANALYSIS_KINDS.REGION_SERIES].available) {
    throw new AnalysisInputError(
      context.capabilities[ANALYSIS_KINDS.REGION_SERIES].reason!
    );
  }
  const counters = emptyCounters();
  const { start, stop } = timeRange(context, query);
  const level = levelIndex(context, query);
  const runs = selectionRuns(context, query);
  runs[context.time!.axis] = [[start, stop]];
  if (level !== undefined) {
    runs[context.vertical!.axis] = [[level, level + 1]];
  }
  const selection = await withCellCopies(
    context,
    await queryRegionSelection(context, query.geometry, runs, counters, signal),
    signal
  );
  const empty = emptyRegionNote(query.geometry, selection);
  const notes = empty ? [empty] : [];
  const chunks =
    selection.totalCells === 0n
      ? 0
      : countRunChunks(selection.runs, context.array.chunks, selection.points);
  // A vector component over the cells where its partner is valid too, or no
  // vector.
  const joint = query.jointWith ? partner : undefined;
  let rows: Int32Array | undefined;
  let maps: Map<number, Int32Array> | undefined;
  if (query.jointWith) {
    const aligned = partner
      ? await jointAlignment(context, partner, level, signal)
      : { reason: "it could not be read" };
    if ("reason" in aligned) {
      throw new AnalysisInputError(
        `${query.jointWith} cannot be counted on the same cells as ${query.variable} (${aligned.reason}), so no vector is computed over this area.`
      );
    }
    rows = aligned.rows;
    maps = aligned.maps;
  }
  const timeAxis = context.time!.axis;
  const visited = joint
    ? jointArray(context.array, joint.array, joint.codec, read, counters, {
        runs: selection.runs,
        points: selection.points,
        timeAxis,
        rows: rows!,
        maps,
      })
    : context.array;
  // The partner's chunks, at its own size and type, held with each of ours:
  // those under the selected cells, at its own rows.
  const partnerTerm = joint && {
    term: query.jointWith!,
    array: joint.array,
    runs: selection.runs.map((r, d) =>
      d === timeAxis
        ? partnerRuns(rows!, r)
        : maps?.has(d)
          ? partnerRuns(maps.get(d)!, r)
          : r
    ),
    points: selection.points,
  };
  const nt = stop - start;
  const chunkT = context.array.chunks[context.time!.axis];
  const partLength = longestPart(context, start, stop);
  // Live reduction arrays: one per chunk job in flight, each only as long as
  // its chunk's share of a part; plus the selection's own points.
  const scratch =
    Math.min(chunks, REGION_LOOKAHEAD * JOBS_PER_BATCH) *
      SUMS_BYTES *
      Math.min(chunkT, partLength) +
    (selection.points ? pointSelectionBytes(selection.points) : 0) +
    runSelectionBytes(selection.runs) +
    // Accumulators (eight columns) and the published σ, min, max and time
    // besides the three values counted as output.
    nt * (8 + 4) * 8 +
    // Repeated cells' values held while each part in flight is read.
    REGION_LOOKAHEAD * copyPickerBytes(selection, partLength);
  return {
    estimate: {
      ...estimateFor(
        context,
        chunks +
          (partnerTerm
            ? countRunChunks(
                partnerTerm.runs,
                partnerTerm.array.chunks,
                partnerTerm.points
              )
            : 0),
        nt * 3,
        notes,
        scratch +
          (joint
            ? Math.min(chunks, REGION_LOOKAHEAD * JOBS_PER_BATCH) *
              partnerHeldBytes(context.array, joint.array, {
                runs: selection.runs,
                points: selection.points,
                timeAxis,
                rows: rows!,
                maps,
              })
            : 0),
        partnerTerm ? [partnerTerm] : []
      ),
      shardRuns: {
        own: selection.runs,
        ...(partnerTerm ? { partner: partnerTerm.runs } : {}),
      },
    },
    // eslint-disable-next-line max-lines-per-function
    async execute(signal, hooks) {
      const started = performance.now();
      const timeAxis = context.time!.axis;
      const totals = {
        start,
        sum: new Float64Array(nt),
        weight: new Float64Array(nt),
        count: new Float64Array(nt),
        mean: new Float64Array(nt),
        m2: new Float64Array(nt),
        min: new Float64Array(nt).fill(Infinity),
        max: new Float64Array(nt).fill(-Infinity),
      };
      const live = { bytes: 0 };
      const fromEnd = Boolean(query.time?.fromEnd);
      const parts =
        selection.storedCells > 0
          ? readingParts(context, start, stop, fromEnd)
          : [];
      // Rows read, [readFrom, readUntil), and sent, [sentFrom, sentUntil).
      let readUntil = parts.length && !fromEnd ? start : stop;
      let readFrom = parts.length && fromEnd ? stop : start;
      let [sentFrom, sentUntil] = [readFrom, readUntil];
      let baseSent = false;
      if (parts.length) {
        hooks?.onPartial?.(show(0));
      }
      await streamParts(
        parts.length,
        REGION_LOOKAHEAD,
        signal,
        // eslint-disable-next-line max-lines-per-function
        async (part, partSignal) => {
          // The spatial runs as they are (their chunk directory is built
          // once for every part); only the time run is the part's own.
          const partRuns = selection.runs.map((r, d) =>
            d === timeAxis ? [parts[part]] : r
          );
          const folder = orderedFolder(
            parts[part],
            chunkT,
            totals,
            live,
            counters
          );
          // One value of each repeated cell per date: its first valid copy.
          // A vector component's repeated cells are read apart, unmasked.
          const [from, until] = parts[part];
          const picked = joint
            ? undefined
            : copyPicker(selection, until - from);
          const apart = joint ? selection.classOf : undefined;
          await visitRuns(
            read,
            visited,
            context.codec,
            partRuns,
            (ordinal, index, value, point) => {
              const t = index[timeAxis];
              if (
                (apart && apart[point] >= 0) ||
                picked?.hold(point, t - from, value) ||
                Number.isNaN(value)
              ) {
                return;
              }
              const w = selection.weightOf(index, point);
              if (w === 0) {
                return;
              }
              const acc = folder.accumulator(ordinal, t);
              addValue(acc, t - acc.from, value, w);
            },
            counters,
            partSignal,
            folder.done,
            selection.points
          );
          if (picked) {
            folder.whole((acc) => addPicked(acc, picked, selection));
          }
          if (apart && partnerTerm) {
            const pairs = await jointCopies(
              read,
              { context, partner: joint!, selection, rows: rows! },
              partnerTerm.runs,
              [from, until],
              counters,
              partSignal
            );
            folder.whole((acc) =>
              pairs.forEach(([point, k, value]) =>
                addValue(
                  acc,
                  k,
                  value,
                  selection.weightOf(new Float64Array(0), point)
                )
              )
            );
          }
        },
        async (part, publish) => {
          if (fromEnd) {
            readFrom = parts[part][0];
          } else {
            readUntil = parts[part][1];
          }
          if (part + 1 < parts.length) {
            if (publish) {
              hooks?.onPartial?.(show(part + 1));
            }
            await hooks?.waitIfPaused?.(signal);
          }
        },
        hooks?.publishEveryMs
      );
      return assemble();

      function valueAt(t: number) {
        return totals.weight[t] > 0
          ? totals.sum[t] / totals.weight[t]
          : Number.NaN;
      }

      /**
       * The area-weighted standard deviation about the mean (population
       * form, Σw(x − mean)² / Σw), from the centred moment.
       */
      function stdAt(t: number) {
        const w = totals.weight[t];
        return w > 0 ? Math.sqrt(Math.max(0, totals.m2[t] / w)) : Number.NaN;
      }

      /** The smallest and largest valid value among the area's cells. */
      function minAt(t: number) {
        return totals.count[t] > 0 ? totals.min[t] : Number.NaN;
      }
      function maxAt(t: number) {
        return totals.count[t] > 0 ? totals.max[t] : Number.NaN;
      }

      function coverageAt(t: number) {
        return selection.totalWeight > 0
          ? totals.weight[t] / selection.totalWeight
          : 0;
      }

      function show(done: number): TPartialUpdate {
        const partial = {
          done,
          total: parts.length,
          readUntil,
          ...(fromEnd ? { readFrom } : {}),
        };
        const [from, to] = fromEnd
          ? [readFrom - start, sentFrom - start]
          : [sentUntil - start, readUntil - start];
        [sentFrom, sentUntil] = [readFrom, readUntil];
        if (!baseSent) {
          baseSent = true;
          // Only the steps read so far travel; the page pads to `nt`. From
          // the end, the whole (short) step travels, unread rows missing.
          const base = assemble(partial, fromEnd ? nt : to);
          return {
            base,
            offset: 0,
            values: [],
            ...(fromEnd ? {} : { padTo: nt }),
            partial,
            counters: base.counters,
          };
        }
        const slice = (f: (t: number) => number) =>
          Array.from({ length: to - from }, (_, k) => f(from + k));
        return {
          offset: from,
          values: slice(valueAt),
          coverage: slice(coverageAt),
          validCells: Array.from(totals.count.subarray(from, to)),
          spread: { std: slice(stdAt), min: slice(minAt), max: slice(maxAt) },
          partial,
          counters: { ...counters, totalMs: performance.now() - started },
        };
      }

      // Times not shown yet stay missing, with unknown coverage. `length`
      // cuts the columns to the steps read (a first part of a long series).
      function assemble(partial?: TAnalysisResult["partial"], length = nt) {
        const [shownFrom, shownTo] = [readFrom - start, readUntil - start];
        const shown = (f: (t: number) => number) => {
          const out = new Array<number>(length);
          for (let t = 0; t < length; t++) {
            out[t] = t >= shownTo || t < shownFrom ? Number.NaN : f(t);
          }
          return out;
        };
        const values = shown(valueAt);
        const coverage = shown(coverageAt);
        counters.totalMs = performance.now() - started;
        const result = baseResult(context, query, { ...counters });
        result.partial = partial;
        result.values = values;
        result.shape = [nt];
        result.dims = [context.time!.dimension];
        result.time = timeOf(context, start, stop);
        result.region = {
          totalCells: selection.totalCells.toString(),
          storedCells: selection.storedCells,
          coverage,
          validCells: shown((t) => totals.count[t]),
          // Cells left out for want of an area are not covered: the weighted
          // share says how much of the footprint is known.
          footprintCoverage:
            selection.totalCells > 0n
              ? (selection.storedCells - (selection.unweighed ?? 0)) /
                Number(selection.totalCells)
              : 0,
          weighting: selection.weighting,
          ...(selection.sites ? { sites: true } : {}),
          ...(joint ? { joint: true } : {}),
          ...(selection.unweighed
            ? { unweighedCells: selection.unweighed }
            : {}),
          spread: { std: shown(stdAt), min: shown(minAt), max: shown(maxAt) },
        };
        result.notes.push(...notes);
        if (level !== undefined) {
          result.notes.push(levelNote(context, level));
        }
        return result;
      }
    },
  };
}

type TTermValues = {
  /** Which entries of a column (position, or row and column) the term has. */
  spatial: number[];
  /** Whether the term varies along the vertical axis. */
  vertical: boolean;
  /** Values by projected column key; one per level, or one. */
  values: Map<string, Float64Array>;
};

type TColumnTerms = {
  terms: Map<string, TTermValues>;
  units: Record<string, string>;
};

export type TTermPlan = {
  term: string;
  array: TAnalysisArray;
  codec: TValueCodec;
  runs: TIndexRuns[];
  points?: TPointSelection;
  /** Term dimension of each entry of `spatial` (same order). */
  spatialDims: number[];
  spatial: number[];
  verticalDim: number;
  units: string;
};

/** Distinct values of the chosen entries of the columns, sorted. */
function distinctEntries(columns: number[][], entry: number) {
  return [...new Set(columns.map((column) => column[entry]))].sort(
    (a, b) => a - b
  );
}

/**
 * How to read each formula term at the given columns and timestep: the
 * request is projected onto the term's own named dimensions (time, the
 * vertical, the spatial ones, members by the variable's fixed index), and
 * omitted dimensions are broadcast when the formula is evaluated.
 */
// eslint-disable-next-line max-lines-per-function
export async function planFormulaTerms(
  context: TVariableContext,
  query: TAnalysisQuery,
  columns: number[][],
  timeIndex: number | undefined
): Promise<TTermPlan[]> {
  const vertical = context.vertical!;
  const grid = context.grid;
  // Names of the field's spatial dimensions, in column-entry order.
  const fieldSpatial =
    grid.kind === ANALYSIS_GRID_KINDS.HEALPIX
      ? [context.dims[grid.cellAxis]]
      : grid.kind === ANALYSIS_GRID_KINDS.RECTILINEAR
        ? [context.dims[grid.latAxis], context.dims[grid.lonAxis]]
        : grid.kind === ANALYSIS_GRID_KINDS.NATIVE
          ? grid.axes.map((axis) => context.dims[axis])
          : [];
  const plans: TTermPlan[] = [];
  for (const [term, variable] of Object.entries(vertical.terms ?? {})) {
    const array = await openReferenced(
      context.dataset,
      vertical.termsOwner ?? context.array,
      variable,
      context.variable
    );
    const dims = array.dimensionNames;
    const spatial: number[] = [];
    const spatialDims: number[] = [];
    const runs: TIndexRuns[] = dims.map((dim, d) => {
      const entry = fieldSpatial.indexOf(dim);
      if (entry >= 0) {
        spatial.push(entry);
        spatialDims.push(d);
        return [];
      }
      if (dim === vertical.dimension) {
        return [[0, array.shape[d]]];
      }
      if (dim === context.time?.dimension) {
        return timeIndex === undefined
          ? [[0, 1]]
          : [[timeIndex, timeIndex + 1]];
      }
      const fixed = query.fixed[dim];
      // A dimension the variable also has (a member, say) is at its fixed
      // index, 0 unless chosen.
      const selected = context.others.some((o) => o.dimension === dim);
      if (fixed === undefined && array.shape[d] > 1 && !selected) {
        throw new AnalysisInputError(
          `Formula term ${term} has dimension ${dim}, which the variable does not select.`
        );
      }
      return [[fixed ?? 0, (fixed ?? 0) + 1]];
    });
    let points: TPointSelection | undefined;
    if (spatial.length === 1) {
      runs[spatialDims[0]] = runsOf(distinctEntries(columns, spatial[0]));
    } else if (spatial.length === 2) {
      const pairs = new Map<string, number[]>();
      for (const column of columns) {
        const pair = spatial.map((entry) => column[entry]);
        pairs.set(pair.join(","), pair);
      }
      points = {
        dims: spatialDims,
        positions: Float64Array.from([...pairs.values()].flat()),
      };
      spatialDims.forEach((d) => (runs[d] = [[0, 1]]));
    }
    plans.push({
      term,
      array,
      codec: buildValueCodec(
        array.attrs,
        array.fillValue,
        array.dtype,
        context.dataset.format
      ),
      runs,
      points,
      spatialDims,
      spatial,
      verticalDim: dims.indexOf(vertical.dimension),
      units: typeof array.attrs.units === "string" ? array.attrs.units : "",
    });
    const problem = formulaUnitProblem(term, plans[plans.length - 1].units);
    if (problem) {
      throw new AnalysisInputError(problem);
    }
  }
  return plans;
}

export function termChunks(plans: TTermPlan[]) {
  return plans.reduce(
    (total, plan) =>
      total + countRunChunks(plan.runs, plan.array.chunks, plan.points),
    0
  );
}

/** Read the planned formula terms (each term's chunks once). */
export async function readFormulaTerms(
  plans: TTermPlan[],
  levels: number,
  read: ReadContext,
  counters: TWorkCounters,
  signal?: AbortSignal,
  /** Called as each term chunk is read (a section's progress). */
  onChunk?: () => void
): Promise<TColumnTerms> {
  const out: TColumnTerms = { terms: new Map(), units: {} };
  for (const plan of plans) {
    const vertical = plan.verticalDim >= 0;
    const values = new Map<string, Float64Array>();
    await visitRuns(
      read,
      plan.array,
      plan.codec,
      plan.runs,
      (_, index, value) => {
        const key = plan.spatialDims.map((d) => index[d]).join(",");
        let slot = values.get(key);
        if (!slot) {
          slot = new Float64Array(vertical ? levels : 1).fill(Number.NaN);
          values.set(key, slot);
        }
        slot[vertical ? index[plan.verticalDim] : 0] = value;
      },
      counters,
      signal,
      onChunk,
      plan.points
    );
    out.terms.set(plan.term, { spatial: plan.spatial, vertical, values });
    out.units[plan.term] = plan.units;
  }
  return out;
}

export function columnKey(column: number[]) {
  // Lossless for any safe-integer position or (row, column) pair.
  return column.join(",");
}

export function columnVertical(
  context: TVariableContext,
  terms: TColumnTerms,
  column: number[]
) {
  const vertical = context.vertical!;
  const levels = vertical.values.length;
  const perLevel: Record<string, Float64Array> = {};
  const scalar: Record<string, number> = {};
  for (const [name, term] of terms.terms) {
    // Broadcast: a term without some of the column's dimensions applies to
    // every column that shares the dimensions it has.
    const slot = term.values.get(term.spatial.map((e) => column[e]).join(","));
    if (term.vertical) {
      perLevel[name] = slot ?? new Float64Array(levels).fill(Number.NaN);
    } else {
      scalar[name] = slot ? slot[0] : Number.NaN;
    }
  }
  return evaluateFormula(
    vertical.family!,
    { perLevel, scalar },
    levels,
    normalizeFormulaTerms(terms.units)
  );
}

// eslint-disable-next-line max-lines-per-function
export async function planProfile(
  context: TVariableContext,
  query: TAnalysisQuery,
  read: ReadContext,
  signal?: AbortSignal
): Promise<TPlannedAnalysis> {
  if (query.geometry.kind !== GEOMETRY_KINDS.POINT) {
    throw new AnalysisInputError("A profile needs a point.");
  }
  const vertical = context.vertical;
  if (!vertical) {
    throw new AnalysisInputError("The variable has no vertical dimension.");
  }
  const counters = emptyCounters();
  const timeIndex = stepOf(context, query);
  if (
    context.time &&
    (timeIndex! < 0 || timeIndex! >= context.time.raw.length)
  ) {
    throw new AnalysisInputError(
      `Time index ${timeIndex} is outside the time axis.`
    );
  }
  const located = await locatePoint(context, query.geometry, counters, signal);
  const runs = selectionRuns(context, query);
  if (context.time) {
    runs[context.time.axis] = [[timeIndex!, timeIndex! + 1]];
  }
  const nk = vertical.values.length;
  runs[vertical.axis] = [[0, nk]];
  if (located.positions.length) {
    setSpatialRuns(context, runs, located.positions);
  }
  // Each copy of the cell, read only where the ones before it are missing.
  const copyRuns = copyRunsOf(context, runs, located);
  // Formula terms are auxiliary reads: planned now, counted in the estimate.
  const termPlans =
    vertical.kind === VERTICAL_KINDS.FORMULA && located.positions.length
      ? await planFormulaTerms(context, query, [located.positions], timeIndex)
      : [];
  const notes = termPlans.length
    ? [`Also reads ${termChunks(termPlans)} chunks of vertical formula terms.`]
    : [];
  return {
    estimate: estimateFor(
      context,
      (located.positions.length
        ? countChunks(context, runs) +
          copyRuns.reduce((n, r) => n + countChunks(context, r), 0)
        : 0) + termChunks(termPlans),
      nk,
      notes,
      0,
      termPlans
    ),

    // eslint-disable-next-line max-lines-per-function
    async execute(signal) {
      const started = performance.now();
      const values = new Array<number>(nk).fill(Number.NaN);
      let columnZ: number[] | undefined;
      if (located.positions.length) {
        await withCopies(
          runs,
          copyRuns,
          () => values.some(Number.isNaN),
          (list, fill) =>
            visitRuns(
              read,
              context.array,
              context.codec,
              list,
              (_, index, value) => {
                const k = index[vertical.axis];
                if (!fill || Number.isNaN(values[k])) {
                  values[k] = value;
                }
              },
              counters,
              signal
            )
        );
        if (termPlans.length) {
          const terms = await readFormulaTerms(
            termPlans,
            nk,
            read,
            counters,
            signal
          );
          columnZ = Array.from(
            columnVertical(context, terms, located.positions)
          );
        }
      }
      counters.totalMs = performance.now() - started;
      const result = baseResult(context, query, counters);
      result.values = values;
      result.shape = [nk];
      result.dims = [vertical.dimension];
      result.vertical = verticalOf(context);
      if (columnZ) {
        result.vertical.values = columnZ;
      }
      if (context.time) {
        result.time = timeOf(context, timeIndex!, timeIndex! + 1);
      }
      result.cell = located.label;
      result.notes.push(
        ...[located.missing, vertical.note].filter((n): n is string => !!n)
      );
      return result;
    },
  };
}

function sectionSpacing(length: number, samples?: number) {
  const target = Math.min(
    MAX_SECTION_SAMPLES,
    Math.max(2, samples ?? DEFAULT_SECTION_SAMPLES)
  );
  return length / (target - 1);
}

// eslint-disable-next-line max-lines-per-function
async function sectionColumns(
  context: TVariableContext,
  vertices: TLatLon[],
  samples: number | undefined,
  counters: TWorkCounters,
  signal?: AbortSignal
) {
  const length = polylineLengthMeters(vertices);
  const spacing = sectionSpacing(length, samples);
  const points = samplePolyline(
    vertices,
    spacing,
    MAX_SECTION_SAMPLES + vertices.length
  );
  const grid = context.grid;
  const keys: (number[] | undefined)[] = [];
  const cells: string[] = [];
  const index: string[][] = [];
  // Each kept native column's halo or fold copies, by its key.
  const copies = new Map<string, number[][]>();
  if (grid.kind === ANALYSIS_GRID_KINDS.HEALPIX) {
    const coords = new Float64Array(points.length * 2);
    points.forEach((point, at) => {
      coords[2 * at] = point.lon;
      coords[2 * at + 1] = point.lat;
    });
    const ids = grid.grid.lonLatToHealpix(coords);
    const unique = [...new Set(Array.from(ids))];
    const before = grid.index.counters.chunkReads;
    const positions = await grid.index.positionsOf(unique, signal);
    counters.indexChunkReads += grid.index.counters.chunkReads - before;
    const byId = new Map(unique.map((id, at) => [id, positions[at]]));
    for (const id of ids) {
      const position = byId.get(id)!;
      keys.push(position < 0 ? undefined : [position]);
      cells.push(position < 0 ? "" : id.toString());
      index.push(position < 0 ? [] : [id.toString()]);
    }
  } else if (grid.kind === ANALYSIS_GRID_KINDS.RECTILINEAR) {
    for (const point of points) {
      const i = locateOnAxis(grid.lat, point.lat).index;
      const j = locateOnAxis(grid.lon, point.lon).index;
      keys.push(i >= 0 && j >= 0 ? [i, j] : undefined);
      cells.push(i >= 0 && j >= 0 ? `${i},${j}` : "");
      index.push(i >= 0 && j >= 0 ? [String(i), String(j)] : []);
    }
  } else if (grid.kind === ANALYSIS_GRID_KINDS.NATIVE) {
    const geometryStart = performance.now();
    const geometry = await grid.geometry(signal);
    for (const point of points) {
      const hit = locateNative(grid, geometry, point.lat, point.lon);
      keys.push(hit.cell >= 0 ? nativePositions(grid, hit.cell) : undefined);
      const repeated =
        hit.cell >= 0 ? geometry.copies?.get(hit.cell) : undefined;
      if (repeated?.length) {
        copies.set(
          columnKey(nativePositions(grid, hit.cell)),
          repeated.map((copy) => nativePositions(grid, copy))
        );
      }
      cells.push(
        hit.cell >= 0 ? nativeCellId(grid, context.dims, hit.cell) : ""
      );
      index.push(
        hit.cell >= 0 ? nativePositions(grid, hit.cell).map(String) : []
      );
    }
    counters.geometryMs += performance.now() - geometryStart;
  }
  return {
    points,
    spacing,
    keys,
    cells,
    index: { dims: indexDims(context), values: index },
    copies,
  };
}

/**
 * A section's columns with their halo or fold copies, all to read: each kept
 * column's copy keys in order (a value missing in the column is taken from the
 * first copy that has it).
 */
export function withSectionCopies(
  unique: Map<string, number[]>,
  copies: Map<string, number[][]>
) {
  const all = new Map(unique);
  const copiesOf = new Map<string, string[]>();
  for (const [key, list] of copies) {
    if (unique.has(key)) {
      copiesOf.set(
        key,
        list.map((column) => {
          const name = columnKey(column);
          all.set(name, column);
          return name;
        })
      );
    }
  }
  const copyKeys = new Set([...copiesOf.values()].flat());
  return { all, copiesOf, copyKeys };
}

function runsOf(values: number[]): TIndexRuns {
  const sorted = [...new Set(values)].sort((a, b) => a - b);
  const runs: TIndexRuns = [];
  for (const value of sorted) {
    const last = runs[runs.length - 1];
    if (last && last[1] === value) {
      last[1]++;
    } else {
      runs.push([value, value + 1]);
    }
  }
  return runs;
}

/**
 * What a section reads: HEALPix columns as exact runs of positions along
 * the cell axis; rectilinear columns as exact (row, column) points, so a
 * diagonal path decodes only its own cells.
 */
export function sectionSelection(
  context: TVariableContext,
  unique: Map<string, number[]>,
  baseRuns: TIndexRuns[]
): { runs: TIndexRuns[]; points?: TPointSelection } | undefined {
  const grid = context.grid;
  if (!unique.size) {
    return undefined;
  }
  const runs = baseRuns.map((r) => r.slice());
  if (grid.kind === ANALYSIS_GRID_KINDS.HEALPIX) {
    runs[grid.cellAxis] = runsOf([...unique.values()].map((key) => key[0]));
    return { runs };
  }
  if (grid.kind === ANALYSIS_GRID_KINDS.RECTILINEAR) {
    const positions = new Float64Array(unique.size * 2);
    let at = 0;
    for (const [i, j] of unique.values()) {
      positions[at++] = i;
      positions[at++] = j;
    }
    return { runs, points: { dims: [grid.latAxis, grid.lonAxis], positions } };
  }
  if (grid.kind === ANALYSIS_GRID_KINDS.NATIVE) {
    const rank = grid.axes.length;
    const positions = new Float64Array(unique.size * rank);
    let at = 0;
    for (const key of unique.values()) {
      for (let k = 0; k < rank; k++) {
        positions[at++] = key[k];
      }
    }
    return { runs, points: { dims: grid.axes, positions } };
  }
  return undefined;
}

/**
 * Decimals that tell a centre from its neighbours on an axis: three for a
 * spacing of a tenth of a degree or more, one more per tenfold finer.
 */
function spacingDecimals(values: ArrayLike<number>, at: number) {
  const steps = [values[at + 1] - values[at], values[at] - values[at - 1]]
    .map(Math.abs)
    .filter((step) => Number.isFinite(step) && step > 0);
  if (!steps.length) {
    return 3;
  }
  // Spacings a rounding off a power of ten count as it (1e-6 written as
  // 9.99999e-7).
  const tenths = Math.ceil(-Math.log10(Math.min(...steps)) - 1e-6) + 1;
  return Math.min(12, Math.max(3, tenths));
}

export function sampleMethod(context: TVariableContext) {
  const grid = context.grid;
  if (grid.kind === ANALYSIS_GRID_KINDS.HEALPIX) {
    return "containing HEALPix cell";
  }
  if (grid.kind === ANALYSIS_GRID_KINDS.NATIVE) {
    return grid.method;
  }
  return grid.kind === ANALYSIS_GRID_KINDS.RECTILINEAR &&
    grid.lat.bounds &&
    grid.lon.bounds &&
    !grid.approximateBounds
    ? "containing cell (from bounds)"
    : "nearest cell centre within half the local spacing";
}

export function sampleColumnKey(
  context: TVariableContext,
  index: Float64Array
) {
  const grid = context.grid;
  if (grid.kind === ANALYSIS_GRID_KINDS.NATIVE) {
    return grid.axes.map((axis) => index[axis]).join(",");
  }
  return grid.kind === ANALYSIS_GRID_KINDS.HEALPIX
    ? String(index[grid.cellAxis])
    : `${index[(grid as TRectilinearContext).latAxis]},${index[(grid as TRectilinearContext).lonAxis]}`;
}

export async function preparedSectionColumns(
  context: TVariableContext,
  query: TAnalysisQuery,
  counters: TWorkCounters,
  signal?: AbortSignal
) {
  if (query.geometry.kind !== GEOMETRY_KINDS.POLYLINE) {
    throw new AnalysisInputError("A cross-section needs a path.");
  }
  const geometryStart = performance.now();
  try {
    const vertices = preparePath(query.geometry.vertices);
    const columns = await sectionColumns(
      context,
      vertices,
      query.sectionSamples,
      counters,
      signal
    );
    counters.geometryMs += performance.now() - geometryStart;
    return { ...columns, vertices };
  } catch (error) {
    if ((error as { name?: string }).name === "AbortError") {
      throw error;
    }
    throw new AnalysisInputError((error as Error).message);
  }
}

/**
 * Each kept column's missing values from its copies, the first valid one in
 * order; the copies' own columns dropped.
 */
function fillFromCopies(
  byColumn: Map<string, Float64Array>,
  copiesOf: Map<string, string[]>,
  nk: number
) {
  for (const [key, names] of copiesOf) {
    const column = byColumn.get(key) ?? new Float64Array(nk).fill(Number.NaN);
    for (let k = 0; k < nk; k++) {
      for (const name of names) {
        if (!Number.isNaN(column[k])) {
          break;
        }
        column[k] = byColumn.get(name)?.[k] ?? Number.NaN;
      }
    }
    byColumn.set(key, column);
    names.forEach((name) => byColumn.delete(name));
  }
}

/**
 * A section along a path. With a vertical axis it is a curtain of
 * sample × level values; without one, a path of one value per sample.
 */
// eslint-disable-next-line max-lines-per-function
export async function planSection(
  context: TVariableContext,
  query: TAnalysisQuery,
  read: ReadContext,
  signal?: AbortSignal
): Promise<TPlannedAnalysis> {
  const vertical = context.vertical;
  const counters = emptyCounters();
  const columns = await preparedSectionColumns(
    context,
    query,
    counters,
    signal
  );
  const timeIndex = stepOf(context, query);
  if (
    context.time &&
    !(timeIndex! >= 0 && timeIndex! < context.time.raw.length)
  ) {
    throw new AnalysisInputError(
      `Time index ${timeIndex} is outside the time axis.`
    );
  }
  const nk = vertical ? vertical.values.length : 1;
  const unique = new Map<string, number[]>();
  for (const key of columns.keys) {
    if (key) {
      unique.set(columnKey(key), key);
    }
  }
  const baseRuns = selectionRuns(context, query);
  if (context.time) {
    baseRuns[context.time.axis] = [[timeIndex!, timeIndex! + 1]];
  }
  if (vertical) {
    baseRuns[vertical.axis] = [[0, nk]];
  }
  const { all, copiesOf, copyKeys } = withSectionCopies(unique, columns.copies);
  const selection = sectionSelection(context, all, baseRuns);
  const termPlans =
    vertical?.kind === VERTICAL_KINDS.FORMULA && unique.size
      ? await planFormulaTerms(context, query, [...unique.values()], timeIndex)
      : [];
  const chunks =
    (selection
      ? countRunChunks(selection.runs, context.array.chunks, selection.points)
      : 0) + termChunks(termPlans);
  const ns = columns.points.length;
  return {
    estimate: estimateFor(context, chunks, ns * nk, [], 0, termPlans),
    // eslint-disable-next-line max-lines-per-function
    async execute(signal, hooks) {
      const started = performance.now();
      const byColumn = new Map<string, Float64Array>();
      // The curtain fills in as its chunks arrive, with a count of them (a
      // cross-section read for minutes showed no progress at all). With formula
      // levels counted only: their heights come at the end. Each update carries
      // the cells read since the last, not the whole section again.
      const streamed = Boolean(hooks?.onPartial);
      const countOnly = termPlans.length > 0;
      const planned = counters.plannedChunks;
      let [done, sentAt, sentBase] = [0, -Infinity, false];
      const every = hooks?.publishEveryMs || SECTION_PUBLISH_MS;
      // The samples showing each column, to place a column's new value.
      const samplesOf = new Map<string, number[]>();
      columns.keys.forEach((key, s) => {
        if (key) {
          const name = columnKey(key);
          // Appended, not copied.
          const list = samplesOf.get(name);
          if (list) {
            list.push(s);
          } else {
            samplesOf.set(name, [s]);
          }
        }
      });
      let fresh: { at: number[]; values: number[] } = { at: [], values: [] };
      const publish = () => {
        const now = performance.now();
        // With formula levels, their term chunks too.
        const total = countOnly ? chunks : counters.plannedChunks - planned;
        if (!streamed || done >= total || now - sentAt < every) {
          return;
        }
        sentAt = now;
        const partial = {
          done,
          total,
          readUntil: timeIndex ?? 0,
          chunks: true as const,
          ...(countOnly ? { countOnly: true as const } : {}),
        };
        const cells = fresh;
        fresh = { at: [], values: [] };
        if (!sentBase) {
          sentBase = true;
          const base = assemble(
            new Array<number>(ns * nk).fill(Number.NaN),
            undefined,
            undefined,
            partial
          );
          base.cellRead = new Array<number>(ns * nk).fill(0);
          hooks!.onPartial!({
            base,
            offset: 0,
            values: [],
            ...(countOnly ? {} : { cells }),
            partial,
            counters: base.counters,
          });
          return;
        }
        hooks!.onPartial!({
          offset: 0,
          values: [],
          ...(countOnly ? {} : { cells }),
          partial,
          counters: { ...counters },
        });
      };
      if (selection) {
        await visitRuns(
          read,
          context.array,
          context.codec,
          selection.runs,
          (_, index, value) => {
            const key = sampleColumnKey(context, index);
            let column = byColumn.get(key);
            if (!column) {
              column = new Float64Array(nk).fill(Number.NaN);
              byColumn.set(key, column);
            }
            const k = vertical ? index[vertical.axis] : 0;
            column[k] = value;
            // A copy's value is shown where its column has none yet; the
            // first valid one in order is kept at the end.
            const shownAt = copyKeys.has(key) ? undefined : key;
            if (streamed && !countOnly && shownAt) {
              for (const s of samplesOf.get(shownAt) ?? []) {
                fresh.at.push(s * nk + k);
                fresh.values.push(value);
              }
            }
          },
          counters,
          signal,
          () => {
            done++;
            publish();
          },
          selection.points
        );
      }
      let zByColumn: Map<string, Float64Array> | undefined;
      if (termPlans.length) {
        const terms = await readFormulaTerms(
          termPlans,
          nk,
          read,
          counters,
          signal,
          () => {
            done++;
            publish();
          }
        );
        zByColumn = new Map(
          [...unique.entries()].map(([key, column]) => [
            key,
            columnVertical(context, terms, column),
          ])
        );
      }
      fillFromCopies(byColumn, copiesOf, nk);
      const { values, columnZ, status } = collect(byColumn, zByColumn);
      counters.totalMs = performance.now() - started;
      return assemble(values, columnZ, status);
    },
  };

  /** Each sample's levels in path order, its heights and its status. */
  function collect(
    byColumn: Map<string, Float64Array>,
    zByColumn?: Map<string, Float64Array>
  ) {
    const values: number[] = [];
    const columnZ: number[] = [];
    const status: TSampleStatus[] = [];
    columns.keys.forEach((key) => {
      const column = key ? byColumn.get(columnKey(key)) : undefined;
      const z = key ? zByColumn?.get(columnKey(key)) : undefined;
      for (let k = 0; k < nk; k++) {
        values.push(column ? column[k] : Number.NaN);
        if (zByColumn) {
          columnZ.push(z ? z[k] : Number.NaN);
        }
      }
      status.push(
        !key
          ? SAMPLE_STATUS.OUTSIDE
          : column && column.some((v) => !Number.isNaN(v))
            ? SAMPLE_STATUS.OK
            : SAMPLE_STATUS.MISSING
      );
    });
    return { values, columnZ: zByColumn ? columnZ : undefined, status };
  }

  // eslint-disable-next-line max-lines-per-function
  function assemble(
    values: number[],
    columnZ?: number[],
    sampleStatus?: TSampleStatus[],
    partial?: TAnalysisResult["partial"]
  ) {
    const status =
      sampleStatus ??
      columns.keys.map((key) =>
        key ? SAMPLE_STATUS.MISSING : SAMPLE_STATUS.OUTSIDE
      );
    const result = baseResult(context, query, { ...counters });
    result.values = values;
    if (partial) {
      result.partial = partial;
    }
    if (vertical) {
      result.sectionMode = SECTION_MODES.CURTAIN;
      result.shape = [ns, nk];
      result.dims = ["sample", vertical.dimension];
      result.vertical = verticalOf(context);
      if (columnZ) {
        result.columnVertical = columnZ;
      }
    } else {
      result.sectionMode = SECTION_MODES.PATH;
      result.shape = [ns];
      result.dims = ["sample"];
    }
    if (context.time) {
      result.time = timeOf(context, timeIndex!, timeIndex! + 1);
    }
    result.samples = {
      distances: columns.points.map((p) => p.distance),
      lats: columns.points.map((p) => p.lat),
      lons: columns.points.map((p) => p.lon),
      cells: columns.cells,
      index: columns.index,
      status,
      method: sampleMethod(context),
      spacingMeters: columns.spacing,
      radiusMeters: DRAWING_SPHERE_RADIUS_METERS,
      vertices: columns.vertices,
    };
    const outside = status.filter((s) => s === SAMPLE_STATUS.OUTSIDE).length;
    if (outside) {
      result.notes.push(
        `${outside} of ${ns} samples fall on cells this source does not store; they are shown as gaps.`
      );
    }
    if (vertical?.note) {
      result.notes.push(vertical.note);
    }
    return result;
  }
}
