import * as healpixGeo from "healpix-geo";

import { AnalysisInputError } from "./analysisErrors.ts";
import type { ByteLru } from "./byteLru.ts";
import {
  durationSeconds,
  formatCalendarDate,
  decodeTimeValue,
  encodeTimeValue,
  parseTimeAxis,
  sameDuration,
  type TTimeAxis,
} from "./calendar.ts";
import {
  midpointBounds,
  resolveCellAreas,
  type TCellAreas,
} from "./cellAreas.ts";
import {
  createDenseIndex,
  createMappedIndex,
  createRunsIndex,
  createSortedIndex,
  createValidatedIndex,
  compactedRuns,
  INDEX_VALIDATION,
  isStrictlyAscending,
  rangeRuns,
  type TCellIndex,
} from "./cellIndex.ts";
import { quantityKind } from "./cellMethods.ts";
import {
  chargeWholeIndexes,
  checkDeclaredChunk,
  chunkByteSize,
  throwIfAborted,
  type TAnalysisArray,
} from "./chunkVisitor.ts";
import { healpixCellCount } from "./healpixIds.ts";
import {
  readAlong,
  resolveNativeGrid,
  type TNativeContext,
} from "./nativeGrid.ts";
import { SharedReads } from "./sharedRead.ts";
import {
  arrayPath,
  isMissing,
  openReferenced,
  type TAnalysisDataset,
} from "./sourceAdapter.ts";
import {
  ANALYSIS_KINDS,
  type TAnalysisKind,
  type TReferenceTime,
} from "./types.ts";
import {
  buildValueCodec,
  decodeStoredBigInt,
  decodeStoredValue,
  type TValueCodec,
} from "./valueDecoding.ts";
import {
  FORMULA_FAMILIES,
  looksEnsemble,
  looksVertical,
  verticalScore,
  parseFormulaTerms,
  positiveOf,
  PRESSURE_UNITS,
  resolveVerticalAxis,
  unitFactor,
  VERTICAL_KINDS,
  type TVerticalAxis,
} from "./vertical.ts";

import {
  isLatitudeName,
  isLongitudeName,
} from "@/lib/data/coordinateVariables.ts";
import { isTimeCoordinate } from "@/lib/data/timeHandling.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  healpixCellAxis,
  resolveHealpixFrame,
  type THealpixFrame,
  type TRectilinearAxis,
} from "@/lib/grids/analysisGrid.ts";
import { healpixCellCoordinateNames } from "@/lib/grids/healpixCalculations.ts";

type TAttrs = Record<string, unknown>;

export const ANALYSIS_GRID_KINDS = {
  HEALPIX: "healpix",
  RECTILINEAR: "rectilinear",
  NATIVE: "native",
  UNSUPPORTED: "unsupported",
} as const;

type THealpixContext = {
  /** Identity of the cell layout: country masks are reused across fields. */
  regionKey?: string;
  kind: typeof ANALYSIS_GRID_KINDS.HEALPIX;
  frame: THealpixFrame;
  grid: healpixGeo.Grid;
  order: number;
  cellAxis: number;
  index: TCellIndex;
  layout: string;
};

export type TRectilinearContext = {
  /** Identity of the cell layout: country masks are reused across fields. */
  regionKey?: string;
  kind: typeof ANALYSIS_GRID_KINDS.RECTILINEAR;
  latAxis: number;
  lonAxis: number;
  lat: TRectilinearAxis;
  lon: TRectilinearAxis;
  /** The declared cell measure, checked against the grid (areacella). */
  areas?: TCellAreas;
  /** Why a declared measure cannot weight this grid. */
  areaProblem?: string;
  /** Its store could not be reached: described again next time. */
  areasUnreachable?: boolean;
  /** Bounds made halfway between centres (none published): approximate. */
  approximateBounds?: boolean;
  /** Which axes' edges were made so (the others' are published). */
  inferredAxes?: ("latitude" | "longitude")[];
};

type TGridContext =
  | THealpixContext
  | TRectilinearContext
  | TNativeContext
  | { kind: typeof ANALYSIS_GRID_KINDS.UNSUPPORTED; reason: string };

/** A coordinate's CF `standard_name`, when it has one. */
function standardNameOf(attrs: Record<string, unknown>) {
  const name = attrs.standard_name;
  return typeof name === "string" && name ? { standardName: name } : {};
}

type TTimeContext = {
  axis: number;
  dimension: string;
  /** Decoded time coordinate values (scale and offset applied). */
  raw: number[];
  /** Steps after the last whose timestamps are not written yet (live). */
  unpublished?: number;
  /** A readable label of one coordinate value, formatted on demand. */
  label: (raw: number) => string;
  timeAxis?: TTimeAxis;
  units?: string;
  calendar?: string;
  /**
   * The coordinate's CF `standard_name`: `forecast_reference_time` is no valid
   * time.
   */
  standardName?: string;
  /** Declared cell bounds, [start, end] per time step, flat. */
  bounds?: number[];
  /** Why declared bounds could not be used (they are not guessed then). */
  boundsUnread?: string;
  /** The bounds' read failed: a later description reads them again. */
  boundsFailed?: boolean;
  note?: string;
  /** Rows of a missing auxiliary time (NaN in raw): no place in time. */
  undated?: number;
  /** Reference times: the valid times published beside them, same units. */
  valid?: number[];
  /** Their published cells, [start, end] per row, in the same units. */
  validBounds?: number[];
  /** Why the valid times' declared cells could not be used. */
  validBoundsUnread?: string;
  /** Why the source's clocks cannot date its rows (they disagree). */
  clockProblem?: string;
  /** Valid times: each row's own reference time, when published. */
  references?: number[];
};

export type TVerticalContext = TVerticalAxis & {
  values: number[];
  /** Published layer bounds, [low, high] per level, flat. */
  bounds?: number[];
  /**
   * Positions from an auxiliary coordinate along the dimension (`depth(obs)`):
   * its own name, and the dimension's own coordinate (observation IDs) when
   * it has a numeric one.
   */
  auxiliary?: {
    name: string;
    native?: number[];
    /** 64-bit integer IDs exactly, as text, with their stored type. */
    nativeIds?: string[];
    nativeType?: string;
  };
};

export type TCapability = { available: boolean; reason?: string };

export type TVariableContext = {
  dataset: TAnalysisDataset;
  variable: string;
  array: TAnalysisArray;
  codec: TValueCodec;
  dims: string[];
  grid: TGridContext;
  time?: TTimeContext;
  /** A scalar forecast period the field names: its one lead. */
  scalarLead?: TScalarLead;
  /** A scalar forecast reference time the field names (valid-time axis). */
  scalarReference?: TReferenceTime;
  vertical?: TVerticalContext;
  /** A scalar vertical coordinate the field names (`height = 10 m`). */
  scalarLevel?: TScalarLevel;
  /** Why a vertical coordinate the field names could not be used. */
  verticalProblem?: string;
  /** Why the time coordinate cannot be used (time plots say so). */
  timeProblem?: string;
  /**
   * The field's time axis when its coordinate cannot be used: a later
   * publication still forgets the field's chunks along it.
   */
  timeProblemAxis?: number;
  /**
   * The time coordinate and its bounds as stored (key, steps a chunk, and their
   * shard indices' reset): a publication of steps reads them again.
   */
  timeArrays?: TTimeArray[];
  /** Dimensions that are neither spatial, time nor vertical. */
  others: {
    axis: number;
    dimension: string;
    size: number;
    /** Ensemble members (realizations): plots can read them all. */
    ensemble?: boolean;
    /**
     * Each member's identifier, from its coordinate (when it has one);
     * undefined where the coordinate holds its declared missing value.
     */
    ids?: (string | undefined)[];
    /** The identifiers' stored type (`uint64`, `int16`, `string`, …). */
    idType?: string;
    /** Member identifiers are declared but could not be read. */
    idsUnread?: boolean;
    /** A forecast lead time (CF `forecast_period`) at each index. */
    forecastPeriod?: TForecastPeriod;
  }[];
  capabilities: Record<TAnalysisKind, TCapability>;
  units?: string;
  /** CF `units_metadata`: "temperature: difference" is no position on a scale. */
  unitsMetadata?: string;
  /** CF `cell_methods`: how each value stands for its cell. */
  cellMethods?: string;
  /** Intensive or extensive (see quantityKind), when known. */
  quantity?: "intensive" | "extensive";
  longName?: string;
  /** CF `standard_name` ("" when none is published). */
  standardName?: string;
};

// Cell coordinates up to this size are read whole and validated globally;
// a larger one is read lazily only when its order is declared.
const SMALL_COORDINATE_BYTES = 64 * 2 ** 20;
// Peak bytes of an unsorted coordinate and its in-memory index.
const MAPPED_INDEX_BYTES = 128 * 2 ** 20;
const MAX_AXIS_LENGTH = 5_000_000;
// Reading an undeclared-order coordinate whole is bounded in chunk reads too.
const MAX_ID_CHUNKS = 65_536;
// Cell bounds matrices (rows × 2) larger than this are not read.
const MAX_BOUNDS_VALUES = 2 ** 24;

/** Coordinate chunks read at once: a long axis is not read one by one. */
const COORDINATE_READS = 8;
/** Decoded bytes of coordinate chunks in flight at once, at most. */
const COORDINATE_BYTES_IN_FLIGHT = 64 * 2 ** 20;

/** Lanes for chunks of this array: by count, and by decoded bytes. */
function lanesFor(array: Pick<TAnalysisArray, "chunks" | "dtype">) {
  const bytes = chunkByteSize(array);
  return Math.max(
    1,
    Math.min(COORDINATE_READS, Math.floor(COORDINATE_BYTES_IN_FLIGHT / bytes))
  );
}

/**
 * Run `task(0)`…`task(count − 1)`, at most `limit` at a time, in order.
 * The first failure (or the caller's abort) stops it: no lane starts
 * another task, and tasks in flight get an aborted signal.
 */
export async function inPool(
  count: number,
  limit: number,
  task: (at: number, signal: AbortSignal) => Promise<void>,
  signal?: AbortSignal
) {
  const stop = new AbortController();
  const relay = () => stop.abort(signal?.reason);
  if (signal?.aborted) {
    relay();
  }
  signal?.addEventListener("abort", relay, { once: true });
  let next = 0;
  try {
    await Promise.all(
      Array.from({ length: Math.min(limit, count) }, async () => {
        while (next < count && !stop.signal.aborted) {
          try {
            await task(next++, stop.signal);
          } catch (error) {
            stop.abort(error);
            throw error;
          }
        }
      })
    );
    throwIfAborted(stop.signal);
  } finally {
    signal?.removeEventListener("abort", relay);
  }
}

async function readWhole(array: TAnalysisArray, signal?: AbortSignal) {
  if (array.shape.length > 1 || (array.shape[0] ?? 1) > MAX_AXIS_LENGTH) {
    throw new Error("A coordinate is too large to read for analysis.");
  }
  checkDeclaredChunk(array);
  if (!array.shape.length) {
    return [(await array.readChunk([], signal)).data[0]];
  }
  const length = array.shape[0];
  const chunkLength = array.chunks[0] ?? 1;
  const values = new Array<number | bigint>(length);
  await inPool(
    Math.ceil(length / chunkLength),
    lanesFor(array),
    async (chunk, lane) => {
      throwIfAborted(lane);
      const stored = await array.readChunk([chunk], lane);
      const end = Math.min(chunkLength, length - chunk * chunkLength);
      for (let at = 0; at < end; at++) {
        values[chunk * chunkLength + at] = stored.data[at];
      }
    },
    signal
  );
  return values;
}

/**
 * Coordinates and bounds shared by every variable of a source: six
 * descriptions over one time axis read and decode it and its bounds once,
 * also while the read is running, on the array without any one
 * description's guard (see SharedReads).
 */
// Kept: 64 MiB of decoded axes. Read at once, by every source: 256 MiB.
const sharedAxes = new SharedReads(64 * 2 ** 20, 256 * 2 ** 20);

/** A released store's shared coordinates and bounds go with it. */
export function releaseSharedAxes(storeKey: string) {
  sharedAxes.release(`${storeKey}|`);
  for (const key of [...revisedAxes.keys()]) {
    if (key.startsWith(`${storeKey}|`)) {
      revisedAxes.delete(key);
    }
  }
}

function unguarded(array: TAnalysisArray) {
  return array.unguarded ?? array;
}

function signalOf(dataset: TAnalysisDataset) {
  return dataset.signal;
}

type TTimeArray = {
  key: string;
  size: number;
  /** Stored chunks reading it whole takes, and their decoded bytes. */
  reads: number;
  bytes: number;
  /**
   * Steps `from`..`to` read again where decoded (their chunks only): true
   * when a value changed, or none was kept to compare.
   */
  refresh: (
    from: number,
    to: number,
    /**
     * The description's own decoded values (dates, or bounds flat by
     * row), compared step by step when the axis is too long to be kept
     * shared.
     */
    current?: ArrayLike<number>,
    /** Aborted when the source is released: no further chunk is read. */
    stop?: AbortSignal
  ) => Promise<boolean>;
  /** Bounds (rows × 2), not the coordinate itself. */
  matrix: boolean;
};

/**
 * A time coordinate (`rows` 1) or its bounds (2) as a live publication
 * refreshes them: the published steps' chunks are read again, shard indices
 * first, into the decoded values every variable shares, not the whole axis.
 */
// eslint-disable-next-line max-lines-per-function
function timeArray(
  dataset: TAnalysisDataset,
  array: TAnalysisArray,
  matrix: boolean,
  /**
   * Bounds in other units than their coordinate: the description's values (in
   * the coordinate's units) back to the stored ones, so a revision of a few
   * rows is patched into stored values only.
   */
  toStored?: (values: number[]) => number[] | undefined
): TTimeArray {
  const key = matrix ? `${array.key}|matrix` : array.key;
  // eslint-disable-next-line max-lines-per-function
  const once = async (
    from: number,
    to: number,
    current?: ArrayLike<number>,
    stop?: AbortSignal
  ) => {
    array.forgetShards?.(0, from, to);
    // Too long to be kept shared: only the published steps are read and
    // compared with the description's own.
    if (current && !sharedAxes.holds(key)) {
      return refreshedSteps(
        dataset,
        array,
        matrix,
        from,
        to,
        current,
        stop,
        toStored
      );
    }
    let changed = true;
    const update = async <T extends number[] | Float64Array>(
      old: T,
      signal: AbortSignal
    ) => {
      // The published steps read into a window first: an unchanged poll keeps
      // the shared values as they are.
      const { offset, fresh } = await readWindow(
        dataset,
        array,
        matrix,
        from,
        to,
        signal
      );
      changed = fresh.some((value, k) => !Object.is(value, old[offset + k]));
      if (!changed) {
        return old;
      }
      const values = old.slice() as T;
      fresh.forEach((value, k) => {
        if (offset + k < values.length) {
          values[offset + k] = value;
        }
      });
      return values;
    };
    await (matrix
      ? sharedAxes.revise<Float64Array>(key, update, stop)
      : sharedAxes.revise<number[]>(key, update, stop));
    throwIfAborted(stop);
    if (matrix) {
      // Chunks kept on their own (a large matrix): the published ones go.
      const rows = array.chunks[0] ?? 1;
      for (let r = Math.floor(from / rows); r * rows <= to; r++) {
        sharedAxes.forgetPrefix(`${array.key}|matrix|${r},`);
      }
    }
    return changed;
  };
  // One refresh of an axis at a time, each after the one before: of two
  // overlapping publications the later is read last.
  const refresh = (
    from: number,
    to: number,
    current?: ArrayLike<number>,
    stop?: AbortSignal
  ) => {
    const before = refreshing.get(key) ?? Promise.resolve(false);
    const next = before
      .catch(() => false)
      .then(() => once(from, to, current, stop));
    const settled = next.catch(() => false);
    refreshing.set(key, settled);
    void settled.then(() => {
      if (refreshing.get(key) === settled) {
        refreshing.delete(key);
      }
      return undefined;
    });
    return next;
  };
  // What reading it whole takes, said apart from the field's reads.
  const [rows = 1, cols = 1] = array.shape;
  const [chunkRows = 1, chunkCols = 1] = array.chunks;
  const reads =
    Math.ceil(rows / chunkRows) * (matrix ? Math.ceil(cols / chunkCols) : 1);
  return {
    key: array.key,
    size: array.chunks[0],
    refresh,
    matrix,
    reads,
    bytes: reads * chunkByteSize(array),
  };
}

/** The refresh of each axis running now (they run one after another). */
const refreshing = new Map<string, Promise<boolean>>();

/**
 * Steps `from`..`to` read again into a window of their whole chunks:
 * `fresh[k]` is the decoded value at flat position `offset + k`.
 */
async function readWindow(
  dataset: TAnalysisDataset,
  array: TAnalysisArray,
  matrix: boolean,
  from: number,
  to: number,
  stop?: AbortSignal
) {
  const [rows, cols = 1] = array.shape;
  const chunkRows = array.chunks[0] || 1;
  const last = Math.min(to, rows - 1);
  // The published steps' chunks in one window, not a map entry per step.
  const offset = Math.floor(from / chunkRows) * chunkRows * cols;
  const end = Math.min(rows, (Math.floor(last / chunkRows) + 1) * chunkRows);
  const fresh = new Float64Array(Math.max(0, end * cols - offset)).fill(
    Number.NaN
  );
  const sink = new Proxy([] as number[], {
    set: (_, at, value) => {
      fresh[Number(at) - offset] = value as number;
      return true;
    },
  });
  await readSteps(
    dataset,
    array,
    matrix,
    from,
    to,
    sink,
    stop ?? new AbortController().signal
  );
  return { offset, fresh };
}

/** Whether steps `from`..`to` read again differ from `current`. */
async function refreshedSteps(
  dataset: TAnalysisDataset,
  array: TAnalysisArray,
  matrix: boolean,
  from: number,
  to: number,
  current: ArrayLike<number>,
  stop?: AbortSignal,
  toStored?: (values: number[]) => number[] | undefined
) {
  const key = matrix ? `${array.key}|matrix` : array.key;
  const [rows, cols = 1] = array.shape;
  const { offset, fresh } = await readWindow(
    dataset,
    array,
    matrix,
    from,
    to,
    stop
  );
  // On top of a correction still waiting for the next description, not instead
  // of it. Both in stored values.
  const pending = revisedAxes.get(key);
  const base: ArrayLike<number> | undefined =
    pending ?? (toStored ? toStored(Array.from(current)) : current);
  if (!base) {
    // Not convertible back: the next description reads the bounds whole.
    sharedAxes.release(key);
    return true;
  }
  const at = (values: ArrayLike<number>, k: number) =>
    k < values.length ? values[k] : Number.NaN;
  let changed = false;
  for (let k = 0; k < fresh.length && !changed; k++) {
    changed = !Object.is(fresh[k], at(base, offset + k));
  }
  if (changed) {
    // As long as the declared axis, as a whole read gives.
    const patched = new Array<number>(rows * cols);
    for (let k = 0; k < patched.length; k++) {
      patched[k] = at(base, k);
    }
    fresh.forEach((value, k) => {
      patched[offset + k] = value;
    });
    revisedAxes.set(key, patched);
  }
  return changed || pending !== undefined;
}

/** Axes corrected by a publication, waiting for their next description. */
const revisedAxes = new Map<string, number[]>();

/** A revised axis, once: the next description starts from it. */
function takeRevised(key: string) {
  const values = revisedAxes.get(key);
  revisedAxes.delete(key);
  return values;
}

/** Steps `from`..`to` of a decoded axis (or rows × 2 bounds) read again. */
// eslint-disable-next-line max-lines-per-function
async function readSteps(
  dataset: TAnalysisDataset,
  array: TAnalysisArray,
  matrix: boolean,
  from: number,
  to: number,
  values: number[] | Float64Array,
  signal: AbortSignal
) {
  const codec = buildValueCodec(
    array.attrs,
    array.fillValue,
    array.dtype,
    dataset.format
  );
  const [rows, cols = 1] = array.shape;
  const [chunkRows = 1, chunkCols = 1] = array.chunks;
  const last = Math.min(to, rows - 1);
  const jobs: [number, number][] = [];
  for (let r = Math.floor(from / chunkRows); r * chunkRows <= last; r++) {
    for (let c = 0; c * chunkCols < cols; c++) {
      jobs.push([r, c]);
    }
  }
  // Several chunks in flight, as a whole axis is read.
  const place = (
    r: number,
    c: number,
    chunk: Awaited<ReturnType<TAnalysisArray["readChunk"]>>
  ) => {
    for (let i = 0; i < chunkRows && r * chunkRows + i < rows; i++) {
      for (let j = 0; j < chunkCols && c * chunkCols + j < cols; j++) {
        const stored = matrix
          ? chunk.data[i * chunk.stride[0] + j * chunk.stride[1]]
          : chunk.data[i];
        values[(r * chunkRows + i) * cols + c * chunkCols + j] =
          matrix && chunk.absent
            ? codec.absentValue
            : typeof stored === "bigint"
              ? decodeStoredBigInt(codec, stored)
              : decodeStoredValue(codec, Number(stored));
      }
    }
  };
  await inPool(
    jobs.length,
    lanesFor(array),
    async (at, lane) => {
      // A released source reads no further step.
      throwIfAborted(lane);
      const [r, c] = jobs[at];
      place(
        r,
        c,
        await unguarded(array).readChunk(matrix ? [r, c] : [r], lane)
      );
    },
    signal
  );
}

async function readDecoded(
  dataset: TAnalysisDataset,
  array: TAnalysisArray
): Promise<number[]> {
  const revised = takeRevised(array.key);
  const values = await sharedAxes.share(
    array.key,
    (array.shape[0] ?? 1) * 8,
    (signal) =>
      revised
        ? Promise.resolve(revised)
        : readDecodedNow(dataset, unguarded(array), signal),
    signalOf(dataset)
  );
  return values.slice();
}

/**
 * A coordinate's values decoded like data: scale, offset and missing
 * markers applied (a packed coordinate is not usable as stored).
 */
async function readDecodedNow(
  dataset: TAnalysisDataset,
  array: TAnalysisArray,
  signal?: AbortSignal
): Promise<number[]> {
  chargeWholeIndexes(array, describing.get(dataset));
  const codec = buildValueCodec(
    array.attrs,
    array.fillValue,
    array.dtype,
    dataset.format
  );
  return (await readWhole(array, signal)).map((value) =>
    typeof value === "bigint"
      ? decodeStoredBigInt(codec, value)
      : decodeStoredValue(codec, Number(value))
  );
}

/** A whole 1-D cell-id coordinate as exact 64-bit integers. */
async function readIds(array: TAnalysisArray) {
  checkDeclaredChunk(array);
  const length = array.shape[0] ?? 0;
  const chunkLength = array.chunks[0] ?? 1;
  const out = new BigInt64Array(length);
  for (let chunk = 0; chunk * chunkLength < length; chunk++) {
    const stored = await array.readChunk([chunk]);
    const end = Math.min(chunkLength, length - chunk * chunkLength);
    for (let at = 0; at < end; at++) {
      const value = stored.data[at];
      out[chunk * chunkLength + at] =
        typeof value === "bigint" ? value : BigInt(value as number);
    }
  }
  return out;
}

/**
 * An array, or undefined when the store has none; a cancel or a failed read
 * (HTTP 503, a dropped connection) propagates, so the description fails and is
 * tried again instead of taking another method.
 */
async function tryOpen(dataset: TAnalysisDataset, path: string) {
  try {
    return await dataset.openArray(path);
  } catch (error) {
    if ((error as Error)?.name === "AbortError" || !isMissing(error)) {
      throw error;
    }
    return undefined;
  }
}

/** An array `from` names, from `from`'s own store and group first. */
async function tryReferenced(
  dataset: TAnalysisDataset,
  from: TAnalysisArray,
  name: string,
  context: string
) {
  try {
    return await openReferenced(dataset, from, name, context);
  } catch (error) {
    if ((error as Error)?.name === "AbortError" || !isMissing(error)) {
      throw error;
    }
    return undefined;
  }
}

function declaredSorted(attrs: TAttrs, dggs: TAttrs | null) {
  const flags = [attrs.sorted, attrs.is_sorted, dggs?.sorted, attrs.monotonic];
  return flags.some((flag) => flag === true || flag === "increasing");
}

/** The cell-id coordinate of a packed HEALPix level, if any. */
async function findCellCoordinate(
  dataset: TAnalysisDataset,
  variable: string,
  dggs: TAttrs | null
) {
  for (const name of healpixCellCoordinateNames(
    typeof dggs?.coordinate === "string" ? dggs.coordinate : undefined
  )) {
    const coordinate = await tryOpen(
      dataset,
      ZarrDataManager.resolveVariablePath(variable, name)
    );
    if (coordinate) {
      return { coordinate, name };
    }
  }
  return undefined;
}

// eslint-disable-next-line max-lines-per-function
async function healpixIndex(
  found: { coordinate: TAnalysisArray; name: string } | undefined,
  order: number,
  cellLength: number,
  dggs: TAttrs | null,
  indexCache: ByteLru<BigInt64Array>
): Promise<{ index: TCellIndex; layout: string }> {
  if (!found) {
    return {
      index: createDenseIndex(order, cellLength),
      layout: "dense (cell id = position)",
    };
  }
  const { coordinate, name } = found;
  const compression = dggs?.compression;
  if (compression === "compacted" || compression === "ranges") {
    const ids = await readWhole(coordinate);
    const runs =
      compression === "ranges"
        ? rangeRuns(order, ids)
        : compactedRuns(order, ids);
    const index = createRunsIndex(runs);
    if (index.length !== cellLength) {
      throw new Error(
        `The ${compression} cell coordinate covers ${index.length} cells, but the data holds ${cellLength}.`
      );
    }
    return { index, layout: `packed (${compression} runs)` };
  }
  if (coordinate.shape[0] !== cellLength) {
    throw new Error(
      `The cell coordinate ${name} has ${coordinate.shape[0]} entries, but the data holds ${cellLength}.`
    );
  }
  if (declaredSorted(coordinate.attrs, dggs)) {
    checkDeclaredChunk(coordinate);
    const reader = {
      length: cellLength,
      chunkLength: coordinate.chunks[0],
      async readChunk(chunk: number, signal?: AbortSignal) {
        const stored = await coordinate.readChunk([chunk], signal);
        const end = Math.min(
          coordinate.chunks[0],
          cellLength - chunk * coordinate.chunks[0]
        );
        return Array.prototype.slice.call(stored.data, 0, end) as (
          number | bigint
        )[];
      },
    };
    return {
      index: createSortedIndex(
        reader,
        indexCache,
        coordinate.key,
        INDEX_VALIDATION.DECLARED
      ),
      layout: "packed (declared sorted cell ids, read lazily)",
    };
  }
  // Without a declared order, a binary search over unread chunks could miss
  // a stored cell: the whole coordinate is read and checked instead.
  const chunkCount = Math.ceil(cellLength / Math.max(1, coordinate.chunks[0]));
  if (cellLength * 8 > SMALL_COORDINATE_BYTES || chunkCount > MAX_ID_CHUNKS) {
    throw new Error(
      `The cell coordinate ${name} holds ${cellLength} ids without a declared order; plots need it to be declared sorted (attribute sorted=true) or to be at most ${SMALL_COORDINATE_BYTES / 8} cells in at most ${MAX_ID_CHUNKS} chunks.`
    );
  }
  const ids = await readIds(coordinate);
  if (!isStrictlyAscending(ids)) {
    // The map holds the ids sorted (8 B) and their positions (4 B) while
    // the coordinate as read (8 B) is still alive.
    if (cellLength * 20 > MAPPED_INDEX_BYTES) {
      throw new Error(
        `The cell coordinate ${name} holds ${cellLength} unsorted ids; plots map at most ${Math.floor(MAPPED_INDEX_BYTES / 20)} in memory. Declare it sorted (attribute sorted=true) after sorting, or publish ranges.`
      );
    }
    return {
      index: createMappedIndex(ids),
      layout: "packed (unsorted, mapped in memory)",
    };
  }
  return {
    index: createValidatedIndex(ids),
    layout: "packed (sorted cell ids, checked in full)",
  };
}

/** The cell count the metadata declares (its level), if it declares one. */
function declaredCellCount(crsAttrs: TAttrs | undefined, dggs: TAttrs | null) {
  try {
    const frame = resolveHealpixFrame({ crsAttrs, dggs, cellCount: 0 });
    return Number(healpixCellCount(frame.options.level));
  } catch {
    return undefined;
  }
}

/**
 * The cell axis of a HEALPix variable, or why it has none (an unsupported
 * grid, said in words, instead of a level/length mismatch).
 */
function cellAxisOf(
  variable: string,
  array: TAnalysisArray,
  crsAttrs: TAttrs | undefined,
  dggs: TAttrs | null,
  found: { coordinate: TAnalysisArray } | undefined
): number | TGridContext {
  const cellAxis = healpixCellAxis(
    array.dimensionNames,
    array.shape,
    dggs,
    found?.coordinate.dimensionNames[0],
    declaredCellCount(crsAttrs, dggs)
  );
  if (cellAxis < 0) {
    const dims = array.dimensionNames
      .map((name, at) => `${name} ${array.shape[at]}`)
      .join(", ");
    return {
      kind: ANALYSIS_GRID_KINDS.UNSUPPORTED,
      reason: `${variable} has no HEALPix cell dimension (${dims || "no dimensions"}): it is not a field on the grid, so plots cannot place it.`,
    };
  }
  return cellAxis;
}

async function resolveHealpix(
  dataset: TAnalysisDataset,
  variable: string,
  array: TAnalysisArray,
  crsAttrs: TAttrs | undefined,
  dggs: TAttrs | null,
  indexCache: ByteLru<BigInt64Array>
): Promise<TGridContext> {
  // The cell axis comes from the cell coordinate's own dimension, so a
  // field ordered (cell, time) is not measured along time.
  const found = await findCellCoordinate(dataset, variable, dggs);
  const cellAxis = cellAxisOf(variable, array, crsAttrs, dggs, found);
  if (typeof cellAxis !== "number") {
    return cellAxis;
  }
  const frame = resolveHealpixFrame({
    crsAttrs,
    dggs,
    cellCount: array.shape[cellAxis],
  });
  if (frame.options.scheme !== "nested") {
    return {
      kind: ANALYSIS_GRID_KINDS.UNSUPPORTED,
      reason: `Analysis supports nested HEALPix; this source uses the ${frame.options.scheme} scheme.`,
    };
  }
  const order = frame.options.level;
  const { index, layout } = await healpixIndex(
    found,
    order,
    array.shape[cellAxis],
    dggs,
    indexCache
  );
  return {
    kind: ANALYSIS_GRID_KINDS.HEALPIX,
    frame,
    regionKey: JSON.stringify([
      dataset.key,
      found?.coordinate.key,
      frame.options,
      array.shape[cellAxis],
      layout,
    ]),
    grid: new healpixGeo.Grid(frame.options),
    order,
    cellAxis,
    index,
    layout,
  };
}

class AxisError extends Error {}

function strictlyMonotonic(values: Float64Array) {
  if (values.length < 2) {
    return values.length === 1 && Number.isFinite(values[0]);
  }
  const up = values[1] > values[0];
  for (let at = 0; at < values.length; at++) {
    if (!Number.isFinite(values[at])) {
      return false;
    }
    if (
      at > 0 &&
      (up ? values[at] <= values[at - 1] : values[at] >= values[at - 1])
    ) {
      return false;
    }
  }
  return true;
}

async function rectilinearAxis(
  dataset: TAnalysisDataset,
  variable: string,
  coordinate: TAnalysisArray,
  name: string,
  { longitude, length }: { longitude: boolean; length: number }
): Promise<TRectilinearAxis | undefined> {
  if (coordinate.shape.length !== 1) {
    return undefined;
  }
  if (coordinate.shape[0] !== length) {
    throw new AxisError(
      `The ${name} coordinate has ${coordinate.shape[0]} values for ${length} ${coordinate.dimensionNames[0] ?? "positions"}.`
    );
  }
  if (!geographicUnits(coordinate.attrs as TAttrs, longitude)) {
    throw new AxisError(
      `The ${name} coordinate has units "${String(coordinate.attrs.units)}", not degrees ${longitude ? "east" : "north"}; it is no ${longitude ? "longitude" : "latitude"}.`
    );
  }
  // Coordinates (and bounds without their own units) in radians: degrees.
  const scale = radianScale(coordinate.attrs as TAttrs);
  const values = Float64Array.from(
    await readDecoded(dataset, coordinate),
    (v) => v * scale
  );
  if (!strictlyMonotonic(values)) {
    throw new AxisError(
      `The ${name} coordinate is not strictly monotonic or has missing values.`
    );
  }
  const bounds = await axisBounds(
    dataset,
    variable,
    coordinate,
    values.length,
    scale
  );
  const span =
    values.length > 1 ? Math.abs(values[values.length - 1] - values[0]) : 0;
  const step = values.length > 1 ? span / (values.length - 1) : 0;
  return {
    values,
    bounds,
    periodic: longitude && span + step >= 359.999,
    longitude,
  };
}

/** `[low, high]` per cell of an axis, in degrees, when published. */
async function axisBounds(
  dataset: TAnalysisDataset,
  variable: string,
  coordinate: TAnalysisArray,
  length: number,
  coordinateScale: number
) {
  if (typeof coordinate.attrs.bounds !== "string") {
    return undefined;
  }
  const boundsArray = await tryReferenced(
    dataset,
    coordinate,
    coordinate.attrs.bounds,
    variable
  );
  if (
    !boundsArray ||
    boundsArray.shape.length !== 2 ||
    boundsArray.shape[0] !== length ||
    boundsArray.shape[1] !== 2
  ) {
    return undefined;
  }
  const bounds = await readMatrix(dataset, boundsArray);
  // Bounds without units of their own share their coordinate's.
  const scale =
    boundsArray.attrs.units === undefined
      ? coordinateScale
      : radianScale(boundsArray.attrs as TAttrs);
  return scale === 1 ? bounds : bounds.map((v) => v * scale);
}

/**
 * Units a latitude (or longitude) may have: none, degrees (north or east)
 * or radians. An index (units "1") or a distance is not one.
 */
function geographicUnits(attrs: TAttrs, longitude: boolean) {
  const units = String(attrs.units ?? "").trim();
  return (
    !units ||
    /^rad(ian)?s?$/i.test(units) ||
    (longitude
      ? /^(deg(ree)?s?|°)([_\s]?(e|east))?$/i
      : /^(deg(ree)?s?|°)([_\s]?(n|north))?$/i
    ).test(units)
  );
}

/**
 * The field's declared (`coordinates`) 1-D latitude and longitude, along
 * its own dimensions; `false` when it declares them otherwise (2-D, on
 * sites), which is a native grid's to resolve.
 */
// eslint-disable-next-line max-lines-per-function
async function declaredAxes(
  dataset: TAnalysisDataset,
  variable: string,
  array: TAnalysisArray
) {
  let lat: { name: string; array: TAnalysisArray } | undefined;
  let lon: { name: string; array: TAnalysisArray } | undefined;
  const named = String(array.attrs.coordinates ?? "")
    .split(/\s+/)
    .filter((n) => n && n !== variable);
  // Then the dimension coordinates themselves, by their metadata: y(y) with
  // standard_name latitude is the latitude axis without a `coordinates`
  // attribute naming it.
  const dimensional = array.dimensionNames.filter(
    (dim) => dim && !named.includes(dim)
  );
  for (const name of [...named, ...dimensional]) {
    const found = await tryOpen(
      dataset,
      ZarrDataManager.resolveVariablePath(variable, name)
    );
    const attrs = (found?.attrs ?? {}) as TAttrs;
    const units = String(attrs.units ?? "");
    if (
      !found ||
      (!named.includes(name) &&
        (found.dimensionNames.length !== 1 || found.dimensionNames[0] !== name))
    ) {
      continue;
    }
    if (
      !lat &&
      (attrs.standard_name === "latitude" ||
        /^(deg(ree)?s?|°)[_\s]?(n|north)$/i.test(units))
    ) {
      lat = { name, array: found };
    } else if (
      !lon &&
      (attrs.standard_name === "longitude" ||
        /^(deg(ree)?s?|°)[_\s]?(e|east)$/i.test(units))
    ) {
      lon = { name, array: found };
    }
  }
  if (!lat && !lon) {
    return undefined;
  }
  // Each declared axis on its own.
  const dims = array.dimensionNames;
  const along = (c?: { array: TAnalysisArray }) =>
    !c ||
    (c.array.dimensionNames.length === 1 &&
      dims.includes(c.array.dimensionNames[0]));
  return along(lat) &&
    along(lon) &&
    (!lat ||
      !lon ||
      lat.array.dimensionNames[0] !== lon.array.dimensionNames[0])
    ? { lat, lon }
    : false;
}

/** Degrees per stored unit of a latitude or longitude: radians convert. */
function radianScale(attrs: TAttrs) {
  return /^rad(ian)?s?$/i.test(String(attrs.units ?? "").trim())
    ? 180 / Math.PI
    : 1;
}

/** Cell bounds (rows × 2), shared like axes (see shareRead); a copy. */
async function readMatrix(dataset: TAnalysisDataset, array: TAnalysisArray) {
  const [rows, cols] = array.shape;
  if (rows * cols > MAX_BOUNDS_VALUES) {
    throw new AxisError(
      `Cell bounds of ${rows} × ${cols} values are too large to read for plots.`
    );
  }
  const revised = takeRevised(`${array.key}|matrix`);
  const values = await sharedAxes.share(
    `${array.key}|matrix`,
    rows * cols * 8,
    (signal) =>
      revised
        ? Promise.resolve(Float64Array.from(revised))
        : readMatrixNow(dataset, unguarded(array), signal),
    signalOf(dataset),
    rows * cols * 8 > WHOLE_MATRIX_BYTES ? 0 : rows * cols * 8
  );
  return values.slice();
}

// eslint-disable-next-line max-lines-per-function
async function readMatrixNow(
  dataset: TAnalysisDataset,
  array: TAnalysisArray,
  signal: AbortSignal
) {
  const [rows, cols] = array.shape;
  try {
    checkDeclaredChunk(array);
    chargeWholeIndexes(array, describing.get(dataset));
  } catch (error) {
    throw new AxisError((error as Error).message);
  }
  const codec = buildValueCodec(
    array.attrs,
    array.fillValue,
    array.dtype,
    dataset.format
  );
  const out = new Float64Array(rows * cols);
  const [chunkRows, chunkCols] = array.chunks;
  const across = Math.ceil(cols / chunkCols);
  // A chunk's part inside the array: a 16,777,216-row chunk of a
  // 1,048,577-row axis decodes 1,048,577 rows, not 256 MiB.
  const width = (c: number) => Math.min(chunkCols, cols - c * chunkCols);
  const inside = (r: number, c: number) =>
    Math.min(chunkRows, rows - r * chunkRows) * width(c);
  const block = async (r: number, c: number, lane: AbortSignal) => {
    const chunk = await array.readChunk([r, c], lane);
    const decoded = new Float64Array(inside(r, c));
    for (let i = 0; i < chunkRows && r * chunkRows + i < rows; i++) {
      for (let j = 0; j < chunkCols && c * chunkCols + j < cols; j++) {
        // Packed int64 decoded exactly, before it becomes a float.
        const stored = chunk.data[i * chunk.stride[0] + j * chunk.stride[1]];
        decoded[i * width(c) + j] = chunk.absent
          ? codec.absentValue
          : typeof stored === "bigint"
            ? decodeStoredBigInt(codec, stored)
            : decodeStoredValue(codec, Number(stored));
      }
    }
    return decoded;
  };
  // Too large to keep whole: kept chunk by chunk, so a publication reads only
  // its own chunks again.
  const byChunk = rows * cols * 8 > WHOLE_MATRIX_BYTES;
  await inPool(
    Math.ceil(rows / chunkRows) * across,
    lanesFor(array),
    async (at, lane) => {
      const [r, c] = [Math.floor(at / across), at % across];
      throwIfAborted(lane);
      const decoded = byChunk
        ? await sharedAxes.share(
            matrixChunkKey(array, r, c),
            inside(r, c) * 8,
            (own) => block(r, c, own),
            lane
          )
        : await block(r, c, lane);
      for (let i = 0; i < chunkRows && r * chunkRows + i < rows; i++) {
        for (let j = 0; j < chunkCols && c * chunkCols + j < cols; j++) {
          out[(r * chunkRows + i) * cols + c * chunkCols + j] =
            decoded[i * width(c) + j];
        }
      }
    },
    signal
  );
  return out;
}

/** Decoded bounds kept whole up to this (a quarter of the shared budget). */
const WHOLE_MATRIX_BYTES = 16 * 2 ** 20;

/** A large bounds matrix's chunk, kept on its own. */
function matrixChunkKey(array: TAnalysisArray, r: number, c: number) {
  return `${array.key}|matrix|${r},${c}`;
}

// eslint-disable-next-line max-lines-per-function
async function resolveTime(
  dataset: TAnalysisDataset,
  variable: string,
  dims: string[],
  taken: Set<number>,
  shape: number[],
  /** Names in the field's `coordinates` attribute. */
  named: string[]
): Promise<
  | (TTimeContext & { arrays: TTimeArray[] })
  | { invalidTime: string; axis: number; arrays: TTimeArray[] }
  | undefined
> {
  for (let axis = 0; axis < dims.length; axis++) {
    if (taken.has(axis)) {
      continue;
    }
    const found = await timeCoordinateOf(
      dataset,
      variable,
      dims[axis],
      shape[axis],
      named
    );
    if (!found) {
      continue;
    }
    const { coordinate, path } = found;
    const stored = await readDecoded(dataset, coordinate);
    const arrays = [timeArray(dataset, coordinate, false)];
    // Timestamps not written yet at the end (a live store publishing): the axis
    // ends before them, its dates usable meanwhile.
    let known = stored.length;
    while (known > 0 && !Number.isFinite(stored[known - 1])) {
      known--;
    }
    // A coordinate variable has no missing values: a NaN date would misplace
    // every chart, tick and CSV row, so time plots are refused. An auxiliary
    // one (`time(obs)`) may (CF 2.5.1): its row is missing data, kept in place
    // and left out of time plots, said, the other rows dated.
    const name = path.split("/").pop();
    const auxiliary = name !== dims[axis];
    // An auxiliary time's undated rows in the chunk of its last dated one are
    // observations without a date, also at the end; whole chunks after it are
    // not published yet.
    if (auxiliary && known > 0) {
      const size = Math.max(1, coordinate.chunks[0] ?? stored.length);
      known = Math.min(stored.length, Math.ceil(known / size) * size);
    }
    const raw = known < stored.length ? stored.slice(0, known) : stored;
    let undated = 0;
    for (const value of raw) {
      undated += Number.isFinite(value) ? 0 : 1;
    }
    if (!raw.length || (!auxiliary && undated) || undated === raw.length) {
      return {
        invalidTime: `The ${dims[axis]} coordinate has missing or invalid timestamps.`,
        axis,
        arrays,
      };
    }
    // Bounds are named relative to the coordinate's own group.
    const read = await timeBounds(dataset, path, coordinate, stored.length);
    const { boundsUnread, boundsFailed, boundsArray } = read;
    const bounds =
      read.bounds && known < stored.length
        ? read.bounds.slice(0, 2 * known)
        : read.bounds;
    const parsed = parseTimeAxis(
      coordinate.attrs.units,
      coordinate.attrs.calendar
    );
    const units =
      typeof coordinate.attrs.units === "string"
        ? coordinate.attrs.units
        : undefined;
    const calendar = String(coordinate.attrs.calendar ?? "standard");
    if (boundsArray) {
      arrays.push(
        timeArray(
          dataset,
          boundsArray,
          true,
          typeof boundsArray.attrs.units === "string" &&
            boundsArray.attrs.units !== coordinate.attrs.units
            ? (values) =>
                inParentUnits(values, coordinate.attrs, boundsArray.attrs)
            : undefined
        )
      );
    }
    if ("unsupported" in parsed) {
      return {
        arrays,
        axis,
        dimension: dims[axis],
        raw,
        ...(known < stored.length
          ? { unpublished: stored.length - known }
          : {}),
        label: String,
        units,
        calendar,
        ...standardNameOf(coordinate.attrs),
        bounds,
        boundsUnread,
        boundsFailed,
        note: parsed.unsupported,
        ...(undated ? { undated } : {}),
      };
    }
    return {
      arrays,
      axis,
      dimension: dims[axis],
      raw,
      ...(known < stored.length ? { unpublished: stored.length - known } : {}),
      // Formatted on demand: a long axis is not formatted before admission.
      label: (value) => formatCalendarDate(decodeTimeValue(parsed, value)),
      timeAxis: parsed,
      units,
      calendar,
      ...standardNameOf(coordinate.attrs),
      bounds,
      boundsUnread,
      boundsFailed,
      ...(undated ? { undated } : {}),
    };
  }
  return leadTimeAxis(dataset, variable, dims, taken, shape, named);
}

/**
 * A forecast's one reference time, named as a scalar coordinate with a date
 * unit: kept as the reference of every valid time.
 */
async function scalarReferenceOf(
  dataset: TAnalysisDataset,
  variable: string,
  named: string[]
): Promise<TReferenceTime | undefined> {
  for (const name of named) {
    const coordinate = await tryOpen(
      dataset,
      ZarrDataManager.resolveVariablePath(variable, name)
    ).catch(() => undefined);
    const units = coordinate?.attrs.units;
    if (
      coordinate?.attrs.standard_name !== "forecast_reference_time" ||
      coordinate.shape.length !== 0 ||
      typeof units !== "string" ||
      "unsupported" in parseTimeAxis(units, coordinate.attrs.calendar)
    ) {
      continue;
    }
    const [value] = await readDecoded(dataset, coordinate);
    if (Number.isFinite(value)) {
      return {
        name,
        value,
        units,
        ...(typeof coordinate.attrs.calendar === "string"
          ? { calendar: coordinate.attrs.calendar }
          : {}),
      };
    }
  }
  return undefined;
}

/**
 * The one physical level of a field without a level dimension, named as a
 * scalar coordinate (`height = 10 m`): components compare it.
 */
async function scalarLevelOf(
  dataset: TAnalysisDataset,
  variable: string,
  named: string[]
): Promise<TScalarLevel | undefined> {
  for (const name of named) {
    const coordinate = await tryOpen(
      dataset,
      ZarrDataManager.resolveVariablePath(variable, name)
    ).catch(() => undefined);
    if (!coordinate || coordinate.shape.length !== 0) {
      continue;
    }
    const axis = resolveVerticalAxis(
      0,
      name,
      coordinate.attrs as TAttrs,
      () => false
    );
    if (axis.kind !== VERTICAL_KINDS.PHYSICAL) {
      continue;
    }
    const [value] = await readDecoded(dataset, coordinate);
    return {
      name,
      value,
      ...(axis.units ? { units: axis.units } : {}),
      ...(axis.positive ? { positive: axis.positive } : {}),
      ...(axis.positionStandardName
        ? { standardName: axis.positionStandardName }
        : {}),
    };
  }
  return undefined;
}

type TScalarLevel = {
  name: string;
  value: number;
  units?: string;
  positive?: "up" | "down";
  standardName?: string;
};

/** Lead chunks a valid-time axis made from them reads while describing. */
const MAX_LEAD_AXIS_CHUNKS = 4096;

/**
 * A lead axis dated by one scalar reference time: valid times are the reference
 * plus each lead.
 */
// eslint-disable-next-line max-lines-per-function
async function leadTimeAxis(
  dataset: TAnalysisDataset,
  variable: string,
  dims: string[],
  taken: Set<number>,
  shape: number[],
  named: string[]
): Promise<
  | (TTimeContext & { arrays: TTimeArray[] })
  | { invalidTime: string; axis: number; arrays: TTimeArray[] }
  | undefined
> {
  const reference = await scalarReferenceOf(dataset, variable, named);
  if (!reference) {
    return undefined;
  }
  const perUnit = durationSeconds(reference.units);
  const parsed = parseTimeAxis(reference.units, reference.calendar);
  if (!perUnit || "unsupported" in parsed) {
    return undefined;
  }
  for (let axis = 0; axis < dims.length; axis++) {
    if (taken.has(axis)) {
      continue;
    }
    const found = await leadCoordinate(
      dataset,
      variable,
      dims[axis],
      shape[axis],
      named
    );
    const seconds = durationSeconds(found?.coordinate.attrs.units);
    if (!found || seconds === undefined) {
      continue;
    }
    // Every lead dates a row: read whole, within a budget of chunks.
    const chunks = chunkCount(found.coordinate);
    if (chunks > MAX_LEAD_AXIS_CHUNKS) {
      return {
        invalidTime: `Its valid times come from the ${dims[axis]} leads, stored in ${chunks.toLocaleString("en-US")} chunks; plots read at most ${MAX_LEAD_AXIS_CHUNKS.toLocaleString("en-US")} of them to date a series.`,
        axis,
        arrays: [],
      };
    }
    const leads = await readDecoded(dataset, found.coordinate);
    // A missing lead is an undated row, kept in place.
    const undated = leads.filter((lead) => !Number.isFinite(lead)).length;
    if (!leads.length || undated === leads.length) {
      continue;
    }
    const scale = seconds / perUnit;
    // The leads' cells, shifted by the reference time.
    const cells = await timeBounds(
      dataset,
      found.path,
      found.coordinate,
      shape[axis]
    );
    const bounds = cells.bounds?.map((b) => reference.value + b * scale);
    return {
      arrays: [],
      axis,
      dimension: dims[axis],
      ...(undated ? { undated } : {}),
      ...(bounds ? { bounds } : {}),
      ...(cells.boundsUnread ? { boundsUnread: cells.boundsUnread } : {}),
      raw: leads.map((lead) => reference.value + lead * scale),
      label: (value) => formatCalendarDate(decodeTimeValue(parsed, value)),
      timeAxis: parsed,
      units: reference.units,
      calendar: reference.calendar ?? "standard",
      standardName: "time",
      note: `Valid times: the ${reference.name} reference time plus each ${dims[axis]} lead.`,
    };
  }
  return undefined;
}

/** Reference times published along a valid-time axis, in its units. */
async function rowReferencesOf(
  dataset: TAnalysisDataset,
  variable: string,
  time: TTimeContext,
  named: string[]
) {
  for (const name of named) {
    const coordinate = await tryOpen(
      dataset,
      ZarrDataManager.resolveVariablePath(variable, name)
    ).catch(() => undefined);
    if (
      coordinate?.attrs.standard_name !== "forecast_reference_time" ||
      coordinate.shape.length !== 1 ||
      coordinate.shape[0] < time.raw.length ||
      coordinate.dimensionNames?.[0] !== time.dimension ||
      typeof coordinate.attrs.units !== "string" ||
      !/\bsince\b/.test(coordinate.attrs.units)
    ) {
      continue;
    }
    const decoded = (await readDecoded(dataset, coordinate)).slice(
      0,
      time.raw.length
    );
    const references = inParentUnits(decoded, coordinate.attrs, {
      units: time.units,
      calendar: time.calendar,
    });
    if (references?.some(Number.isFinite)) {
      return references;
    }
  }
  return undefined;
}

/**
 * Valid times published beside reference times: an auxiliary `time` coordinate
 * along the same dimension.
 */
// eslint-disable-next-line max-lines-per-function
async function publishedValidTimes(
  dataset: TAnalysisDataset,
  variable: string,
  time: TTimeContext,
  named: string[]
) {
  for (const name of named) {
    const coordinate = await tryOpen(
      dataset,
      ZarrDataManager.resolveVariablePath(variable, name)
    ).catch(() => undefined);
    if (
      coordinate?.attrs.standard_name !== "time" ||
      coordinate.shape.length !== 1 ||
      coordinate.shape[0] < time.raw.length ||
      coordinate.dimensionNames?.[0] !== time.dimension
    ) {
      continue;
    }
    // Dates need their own units and the reference times' calendar.
    const units = coordinate.attrs.units;
    if (typeof units !== "string" || !/\bsince\b/.test(units)) {
      return { problem: `its valid times ${name} have no date units` };
    }
    const calendars = [coordinate.attrs.calendar, time.calendar]
      .map((c) =>
        c === undefined ? "standard" : String(c).trim().toLowerCase()
      )
      .map((c) => (c === "gregorian" ? "standard" : c));
    if (calendars[0] !== calendars[1]) {
      return {
        problem: `its valid times ${name} use the ${calendars[0]} calendar and its reference times the ${calendars[1]} one`,
      };
    }
    const decoded = (await readDecoded(dataset, coordinate)).slice(
      0,
      time.raw.length
    );
    const parent = { units: time.units, calendar: time.calendar };
    const valid = inParentUnits(decoded, coordinate.attrs, parent);
    if (!valid?.some(Number.isFinite)) {
      continue;
    }
    // Their cells too: a 6-hour and a 24-hour total ending together are not one
    // reading.
    const cells = await timeBounds(
      dataset,
      ZarrDataManager.resolveVariablePath(variable, name),
      coordinate,
      coordinate.shape[0]
    );
    const bounds = cells.bounds
      ? inParentUnits(
          cells.bounds.slice(0, 2 * time.raw.length),
          coordinate.attrs,
          parent
        )
      : undefined;
    return {
      valid,
      ...(bounds ? { bounds } : {}),
      ...(cells.boundsUnread || (cells.bounds && !bounds)
        ? {
            boundsUnread:
              cells.boundsUnread ?? `the bounds of ${name} do not convert`,
          }
        : {}),
    };
  }
  return undefined;
}

/**
 * The time coordinate of one field dimension, with its path: the variable
 * named like the dimension, or a one-dimensional auxiliary coordinate along
 * it named in the field's `coordinates` (`time(record)`). Either must lie
 * along that dimension with its length; a same-named array of another
 * dimension is not this axis.
 */
async function timeCoordinateOf(
  dataset: TAnalysisDataset,
  variable: string,
  dimension: string,
  length: number,
  named: string[]
) {
  for (const name of [dimension, ...named.filter((n) => n !== dimension)]) {
    const path = ZarrDataManager.resolveVariablePath(variable, name);
    const coordinate = await tryOpen(dataset, path);
    const along = coordinate?.dimensionNames?.[0];
    if (
      coordinate &&
      coordinate.shape.length === 1 &&
      coordinate.shape[0] === length &&
      // Zarr v2 without _ARRAY_DIMENSIONS: only the same name is trusted.
      (along === dimension || (!along && name === dimension)) &&
      isTimeCoordinate(name, coordinate.attrs as never)
    ) {
      return { coordinate, path };
    }
  }
  return undefined;
}

/**
 * Declared time cell bounds ([start, end] per step), or why declared ones
 * cannot be used: unreadable (a failed request), of another shape, with
 * missing values or in units that do not convert. Undeclared: neither.
 */
// eslint-disable-next-line max-lines-per-function
async function timeBounds(
  dataset: TAnalysisDataset,
  variable: string,
  coordinate: TAnalysisArray,
  length: number
): Promise<{
  bounds?: number[];
  boundsUnread?: string;
  boundsFailed?: boolean;
  boundsArray?: TAnalysisArray;
}> {
  const name = coordinate.attrs.bounds;
  if (typeof name !== "string") {
    return {};
  }
  const unread = (why: string, failed = false) => ({
    boundsUnread: `its declared bounds ${name} ${why}`,
    ...(failed ? { boundsFailed: true } : {}),
  });
  let array: TAnalysisArray;
  try {
    array = await openReferenced(dataset, coordinate, name, variable);
  } catch (error) {
    return unreadAs(error, unread);
  }
  const along = coordinate.dimensionNames[0];
  if (
    array.shape.length !== 2 ||
    array.shape[0] !== length ||
    array.shape[1] !== 2 ||
    // Named dimensions must agree: tb(time, nv) bounds time, not another axis.
    (along && array.dimensionNames[0] && array.dimensionNames[0] !== along)
  ) {
    return unread(`are not ${length} × 2 along ${along ?? "time"}`);
  }
  let values: number[];
  try {
    values = Array.from(await readMatrix(dataset, array));
  } catch (error) {
    return unreadAs(error, unread);
  }
  if (!values.some(Number.isFinite)) {
    // Its array is still the variable's: a publication of its chunks is read
    // again.
    return { ...unread("have missing values"), boundsArray: array };
  }
  // Rows with a missing end keep NaN, the rest their bounds (matching by
  // interval); totals, whose support is then partly unknown, are withheld.
  const missing = unknownRows(values, length);
  const bounds = inParentUnits(values, array.attrs, coordinate.attrs);
  if (!bounds) {
    return unread("are in units that do not convert");
  }
  return missing
    ? {
        bounds,
        boundsArray: array,
        ...unread(`have missing values (${missing} of ${length} steps)`),
      }
    : { bounds, boundsArray: array };
}

/**
 * A row with a missing end has unknown support: both ends NaN; the other rows
 * keep theirs.
 */
function unknownRows(values: number[], length: number) {
  let missing = 0;
  for (let at = 0; at < length; at++) {
    if (
      !Number.isFinite(values[2 * at]) ||
      !Number.isFinite(values[2 * at + 1])
    ) {
      values[2 * at] = values[2 * at + 1] = Number.NaN;
      missing++;
    }
  }
  return missing;
}

/** A time context without the arrays it was read from (kept apart). */
function withoutArrays(
  time: TTimeContext & { arrays: TTimeArray[] }
): TTimeContext {
  const { arrays: _arrays, ...rest } = time;
  void _arrays;
  return rest;
}

/** Why a read of declared bounds failed; aborts are rethrown. */
function unreadAs<T>(
  error: unknown,
  unread: (why: string, failed?: boolean) => T
) {
  if ((error as Error)?.name === "AbortError") {
    throw error;
  }
  return isMissing(error)
    ? unread("are not in the source")
    : unread(`could not be read (${(error as Error).message})`, true);
}

/**
 * CF bounds share their coordinate's units; bounds that declare other time
 * units (days since another epoch beside hours, say) are converted through
 * calendar dates. Bounds in units that cannot be converted are dropped.
 */
function inParentUnits(values: number[], own: TAttrs, parent: TAttrs) {
  if (typeof own.units !== "string" || own.units === parent.units) {
    return values;
  }
  // Time bounds: converted through calendar dates, or dropped when either
  // side cannot be decoded (never read as the parent's raw units).
  if (/\bsince\b/.test(String(parent.units ?? ""))) {
    const calendar = own.calendar ?? parent.calendar;
    const to = parseTimeAxis(parent.units, parent.calendar ?? calendar);
    const from = parseTimeAxis(own.units, calendar);
    if ("unsupported" in to || "unsupported" in from) {
      return undefined;
    }
    return values.map((v) =>
      Number.isFinite(v) ? encodeTimeValue(to, decodeTimeValue(from, v)) : v
    );
  }
  // Layer bounds in another pressure or length unit (Pa beside hPa) are
  // scaled; incompatible ones are dropped.
  const factor =
    typeof parent.units === "string"
      ? unitFactor(own.units, parent.units)
      : undefined;
  return factor === undefined ? undefined : values.map((v) => v * factor);
}

// eslint-disable-next-line max-lines-per-function
async function resolveVertical(
  dataset: TAnalysisDataset,
  variable: string,
  dims: string[],
  shape: number[],
  taken: Set<number>
): Promise<TVerticalContext | { ambiguous: string } | undefined> {
  let best:
    | {
        axis: number;
        score: number;
        attrs: TAttrs;
        values?: number[];
        coordinate?: TAnalysisArray;
      }
    | undefined;
  for (let axis = 0; axis < dims.length; axis++) {
    if (taken.has(axis)) {
      continue;
    }
    const named = await tryOpen(
      dataset,
      ZarrDataManager.resolveVariablePath(variable, dims[axis])
    );
    // An array merely named like the dimension is not its coordinate: it
    // must lie along that dimension, one value per level (`layer(other)`
    // beside `actual_pressure(layer)` is unrelated).
    const coordinate =
      named &&
      (!named.dimensionNames.length ||
        named.dimensionNames.includes(dims[axis])) &&
      (named.shape.length !== 1 || named.shape[0] === shape[axis])
        ? named
        : undefined;
    const attrs = (coordinate?.attrs ?? {}) as TAttrs;
    const score = verticalScore(dims[axis], attrs);
    if (score > 0 && (!best || score > best.score)) {
      const values =
        coordinate && coordinate.shape.length === 1
          ? await readDecoded(dataset, coordinate)
          : undefined;
      best = {
        axis,
        score,
        attrs,
        values,
        coordinate: coordinate ?? undefined,
      };
    }
  }
  if (!best) {
    return auxiliaryVertical(dataset, variable, dims, shape, taken);
  }
  const resolved = await formulaAxisOf(
    dataset,
    best.coordinate,
    ZarrDataManager.resolveVariablePath(variable, dims[best.axis]),
    best.attrs,
    best.axis,
    dims[best.axis]
  );
  const values =
    best.values ?? Array.from({ length: shape[best.axis] }, (_, at) => at);
  if (resolved.kind === VERTICAL_KINDS.MODEL) {
    // A model index (model_level_number) along which the field names a
    // physical coordinate (pressure(lev, lat, lon)): positions come from
    // that coordinate per column; the native index values are kept.
    const physical = await auxiliaryVertical(
      dataset,
      variable,
      dims,
      shape,
      taken
    );
    if (
      physical &&
      !("ambiguous" in physical) &&
      physical.axis === best.axis &&
      physical.kind !== VERTICAL_KINDS.MODEL
    ) {
      // Positions read per column keep the index values; a coordinate
      // along the levels only has its own.
      return physical.kind === VERTICAL_KINDS.PHYSICAL
        ? physical
        : { ...physical, values };
    }
  }
  // CF layer bounds, drawn and exported as published (not midpoints).
  const bounds =
    best.coordinate && resolved.kind === VERTICAL_KINDS.PHYSICAL
      ? (await timeBounds(dataset, variable, best.coordinate, shape[best.axis]))
          .bounds
      : undefined;
  return { ...resolved, values, ...(bounds ? { bounds } : {}) };
}

/**
 * A level dimension known only through an auxiliary coordinate named by the
 * field, e.g. `coordinates="pressure"` with `pressure(layer_id, lat, lon)`:
 * the dimension is vertical; its pressure varies by column, so levels are
 * shown as indices with a note naming the coordinate.
 */
/** Two or more candidate level dimensions: say so rather than guess. */
function ambiguousLevels(name: string, dims: string[], levels: string[]) {
  return {
    ambiguous: `${name}(${dims.join(", ")}) varies along ${levels.join(" and ")}; plots cannot tell which is the level. Fix the others in the source or publish a level coordinate.`,
  };
}

/**
 * A CF formula axis from its attributes and the terms the dataset holds.
 * Terms are named relative to the coordinate's own group and store
 * (`coordinate`, or the path `context` when it has no array). They are
 * returned as resolved paths with the coordinate's key, so execution reads
 * the same arrays.
 */
async function formulaAxisOf(
  dataset: TAnalysisDataset,
  coordinate: TAnalysisArray | undefined,
  context: string,
  attrs: TAttrs,
  at: number,
  axis: string
) {
  const terms = parseFormulaTerms(attrs.formula_terms);
  const available = new Set<string>();
  for (const term of Object.values(terms)) {
    const found = coordinate
      ? await tryReferenced(dataset, coordinate, term, context)
      : await tryOpen(
          dataset,
          ZarrDataManager.resolveVariablePath(context, term)
        );
    if (found) {
      available.add(term);
    }
  }
  const resolved = resolveVerticalAxis(at, axis, attrs, (term) =>
    available.has(term)
  );
  const base = (coordinate && arrayPath(dataset, coordinate)) ?? context;
  return resolved.terms
    ? {
        ...resolved,
        terms: Object.fromEntries(
          Object.entries(resolved.terms).map(([key, term]) => [
            key,
            ZarrDataManager.resolveVariablePath(base, term),
          ])
        ),
        ...(coordinate ? { termsOwner: coordinate.key } : {}),
      }
    : resolved;
}

/**
 * An auxiliary coordinate along the vertical only: the same levels in
 * every column, physical positions for sections as for profiles (not
 * indices).
 */
// eslint-disable-next-line max-lines-per-function
async function staticLevels(
  dataset: TAnalysisDataset,
  coordinate: TAnalysisArray,
  {
    where,
    axis,
    at,
    length,
  }: { where: string; axis: string; at: number; length: number },
  /** The coordinate's path and name: its bounds are named beside it. */
  path: string,
  name: string
): Promise<TVerticalContext | undefined> {
  const fixed = resolveVerticalAxis(
    at,
    axis,
    coordinate.attrs as TAttrs,
    () => false
  );
  if (
    coordinate.dimensionNames.length !== 1 ||
    coordinate.dimensionNames[0] !== axis ||
    coordinate.shape[0] !== length ||
    fixed.kind !== VERTICAL_KINDS.PHYSICAL
  ) {
    return undefined;
  }
  // Its layer bounds, as a dimension coordinate's are read, and the dimension's
  // own coordinate: exported beside it.
  const bounds = (await timeBounds(dataset, path, coordinate, length)).bounds;
  const own = await tryOpen(
    dataset,
    ZarrDataManager.resolveVariablePath(path, axis)
  );
  const usable =
    own &&
    own !== coordinate &&
    own.shape.length === 1 &&
    own.shape[0] === length &&
    /^(u?int|float)/.test(own.dtype);
  // 64-bit identifiers exactly: a float holds neither 2^53 + 1 nor most of
  // them. Read once, both forms made from it.
  const wideType = usable && /^u?int64$/.test(String(own.dtype));
  const stored = wideType
    ? await readWhole(unguarded(own), signalOf(dataset)).catch(() => undefined)
    : undefined;
  const codec =
    stored &&
    buildValueCodec(own!.attrs, own!.fillValue, own!.dtype, dataset.format);
  const native = !usable
    ? undefined
    : stored && codec
      ? stored.map((v) =>
          typeof v === "bigint"
            ? decodeStoredBigInt(codec, v)
            : decodeStoredValue(codec, Number(v))
        )
      : wideType
        ? undefined
        : await readDecoded(dataset, own).catch(() => undefined);
  const wide = stored ? Array.from(stored, (v) => String(v)) : undefined;
  return {
    ...fixed,
    note: `Vertical position is ${where}.`,
    values: await readDecoded(dataset, coordinate),
    ...(bounds ? { bounds } : {}),
    auxiliary: {
      name,
      ...(native ? { native } : {}),
      ...(wide ? { nativeIds: wide, nativeType: String(own!.dtype) } : {}),
    },
  };
}

/**
 * Levels of an auxiliary vertical coordinate: physical positions per
 * column when its units convert to a length or pressure. A one-dimensional
 * one with a CF formula standard name (ocean_sigma_coordinate with
 * formula_terms) is a formula axis with its own values. Otherwise levels
 * are indices; a dimensionless one (units "1") is never a length.
 */
async function auxiliaryLevels(
  dataset: TAnalysisDataset,
  /** The coordinate's path: its formula terms are relative to it. */
  path: string,
  name: string,
  coordinate: TAnalysisArray,
  level: { where: string; axis: string; at: number; length: number }
): Promise<TVerticalContext> {
  const { where, axis, at, length } = level;
  const attrs = coordinate.attrs as TAttrs;
  const units = typeof attrs.units === "string" ? attrs.units : "";
  const indices = Array.from({ length }, (_, k) => k);
  if (
    unitFactor(units, "Pa") !== undefined ||
    unitFactor(units, "m") !== undefined
  ) {
    return (
      (await staticLevels(dataset, coordinate, level, path, name)) ??
      auxiliaryPositions(name, where, attrs, axis, at, indices)
    );
  }
  if (
    coordinate.dimensionNames.length === 1 &&
    Object.values(FORMULA_FAMILIES).some(
      (family) => family === attrs.standard_name
    )
  ) {
    const resolved = await formulaAxisOf(
      dataset,
      coordinate,
      path,
      attrs,
      at,
      axis
    );
    return { ...resolved, values: await readDecoded(dataset, coordinate) };
  }
  const dimensionless = /^(1|-|dimensionless|fraction|level|levels)?$/i.test(
    units.trim()
  );
  return {
    ...resolveVerticalAxis(at, axis, {}, () => false),
    note: dimensionless
      ? `Vertical position is ${where}, a dimensionless model coordinate; levels are shown by index.`
      : `Vertical position is ${where}${units ? ` in ${units}` : ""}, which has no convertible physical units; levels are shown by index.`,
    values: indices,
  };
}

/** An auxiliary vertical coordinate read per column, like a formula term. */
function auxiliaryPositions(
  name: string,
  where: string,
  attrs: TAttrs,
  dimension: string,
  axis: number,
  values: number[]
): TVerticalContext {
  const units = String(attrs.units);
  const pressure = PRESSURE_UNITS.test(units.trim());
  const positive = positiveOf(attrs) ?? "up";
  return {
    kind: VERTICAL_KINDS.FORMULA,
    axis,
    dimension,
    family: FORMULA_FAMILIES.AUXILIARY,
    terms: { z: name },
    units: pressure ? "Pa" : "m",
    positive,
    label: `${pressure ? "pressure (Pa" : "vertical position (m"}, from ${name})`,
    note: `Vertical position is ${where} in ${units}, read at each column.`,
    ...(typeof attrs.standard_name === "string"
      ? { positionStandardName: attrs.standard_name }
      : {}),
    values,
  };
}

/** Field dimensions that are ensemble members (realizations). */
async function ensembleOf(
  dataset: TAnalysisDataset,
  variable: string,
  dims: string[],
  /** The field's named coordinates: `run_id(run)` can name a realization. */
  named: string[]
) {
  // Each ensemble dimension, with the coordinate naming its members.
  const found = new Map<string, string>();
  for (const dim of dims) {
    const own = await tryOpen(
      dataset,
      ZarrDataManager.resolveVariablePath(variable, dim)
    );
    if (looksEnsemble(dim, (own?.attrs ?? {}) as TAttrs)) {
      found.set(dim, dim);
    }
  }
  for (const name of named) {
    const alias = await tryOpen(
      dataset,
      ZarrDataManager.resolveVariablePath(variable, name)
    );
    const own = alias?.dimensionNames ?? [];
    if (
      alias &&
      own.length === 1 &&
      dims.includes(own[0]) &&
      looksEnsemble(name, alias.attrs as TAttrs)
    ) {
      // The named auxiliary holds the identifiers.
      found.set(own[0], name);
    }
  }
  return found;
}

/**
 * A member dimension's identifiers, from its coordinate variable of the same
 * name: a pair of fields is matched member by member by these, not by position.
 */
async function memberIds(
  dataset: TAnalysisDataset,
  variable: string,
  /** The coordinate holding the identifiers (the dimension's or an alias). */
  dimension: string,
  size: number
) {
  try {
    const coordinate = await tryOpen(
      dataset,
      ZarrDataManager.resolveVariablePath(variable, dimension)
    );
    if (!coordinate) {
      return {};
    }
    // Declared but not read (too many, or not one per member): not known, which
    // is not "unlabelled".
    if (
      coordinate.shape.length !== 1 ||
      coordinate.shape[0] !== size ||
      size > 4096
    ) {
      return { idsUnread: true };
    }
    const values = await readWhole(unguarded(coordinate), signalOf(dataset));
    const codec = buildValueCodec(
      coordinate.attrs,
      coordinate.fillValue,
      coordinate.dtype,
      dataset.format
    );
    // With the coordinate's type: one source's members are exported in one
    // type. Decoded as data are: stored 1 with add_offset 100 is member 101. A
    // declared missing value (`_FillValue`, `missing_value`) is no member's
    // name: it matches none and is written as missing. A storage default alone
    // names a member as stored.
    const declared =
      coordinate.attrs._FillValue !== undefined ||
      coordinate.attrs.missing_value !== undefined;
    // Text identifiers: a declared marker ("NA") is missing too.
    const markers = new Set(
      [coordinate.attrs._FillValue, coordinate.attrs.missing_value]
        .flat()
        .filter((m): m is string => typeof m === "string")
    );
    return {
      ids: values.map((value) =>
        typeof value === "string" && markers.has(value)
          ? undefined
          : memberIdText(codec, value, declared)
      ),
      idType: String(coordinate.dtype),
    };
  } catch {
    return { idsUnread: true };
  }
}

/** A stored member identifier as text, unpacked exactly where it can be. */
function memberIdText(
  codec: TValueCodec,
  value: unknown,
  declaredMissing: boolean
): string | undefined {
  if (typeof value !== "number" && typeof value !== "bigint") {
    return String(value);
  }
  const packed = codec.scale !== 1 || codec.offset !== 0;
  const decoded =
    typeof value === "bigint"
      ? decodeStoredBigInt(codec, value)
      : decodeStoredValue(codec, value);
  if (Number.isNaN(decoded) && declaredMissing) {
    return undefined;
  }
  // Unpacked, or a stored value the codec reads as missing: as stored
  // (a member is never dropped for equalling a storage fill value).
  if (!packed || Number.isNaN(decoded)) {
    return String(value);
  }
  const integral = (n: number) => Number.isInteger(n) && Math.abs(n) < 2 ** 53;
  if (
    typeof value === "bigint" &&
    integral(codec.scale) &&
    integral(codec.offset)
  ) {
    return String(value * BigInt(codec.scale) + BigInt(codec.offset));
  }
  return String(decoded);
}

/**
 * A dimension's lead times, when its coordinate is a CF `forecast_period`:
 * a forecast plotted along its reference times is valid that much later.
 */
/** Lead chunks read whole while describing; past them, only the chosen. */
const EAGER_LEAD_CHUNKS = 64;

/**
 * A forecast period dimension's leads, decoded as data are, with their unit in
 * seconds and their published bounds. The coordinate is the dimension's own, or
 * an auxiliary one along it that the field names. Leads and their bounds are
 * each read whole only when stored in few chunks; past that, only at the lead a
 * plot fixes (readSelectedLeads): describing 8,193 one-value chunks read all of
 * them, and leads in 65 chunks lost the selected lead's accumulation interval
 * altogether.
 */
// eslint-disable-next-line max-lines-per-function
async function forecastPeriodOf(
  dataset: TAnalysisDataset,
  variable: string,
  dimension: string,
  size: number,
  named: string[] = []
): Promise<{ forecastPeriod?: TForecastPeriod }> {
  try {
    const found = await leadCoordinate(
      dataset,
      variable,
      dimension,
      size,
      named
    );
    if (!found) {
      return {};
    }
    const { coordinate, path } = found;
    const units = coordinate.attrs.units;
    const seconds = durationSeconds(units);
    const lazy = chunkCount(coordinate) > EAGER_LEAD_CHUNKS;
    const values = lazy
      ? new Array<number>(size).fill(Number.NaN)
      : await readDecoded(dataset, coordinate);
    const declared = await leadBoundsArray(dataset, path, coordinate, size);
    const eager =
      declared && chunkCount(declared) <= EAGER_LEAD_CHUNKS
        ? (await timeBounds(dataset, path, coordinate, size)).bounds
        : undefined;
    // Rows read row by row: a long bounds axis, or one with rows missing when
    // described.
    const lazyBounds =
      declared &&
      (!eager || eager.some((v, at) => !Number.isFinite(v) && at < 2 * size));
    const bounds = !declared
      ? undefined
      : (eager ?? new Array<number>(2 * size).fill(Number.NaN));
    return {
      forecastPeriod: {
        values,
        ...(typeof units === "string" ? { units } : {}),
        ...(seconds !== undefined ? { seconds } : {}),
        ...(bounds ? { bounds } : {}),
        ...(typeof coordinate.attrs.bounds === "string"
          ? { boundsDeclared: true as const }
          : {}),
        // Declared, its array not there yet: looked for at each read.
        ...(typeof coordinate.attrs.bounds === "string" && !declared
          ? {
              reopenBounds: () =>
                leadBoundsArray(dataset, path, coordinate, size),
              parentAttrs: coordinate.attrs,
            }
          : {}),
        ...(lazy
          ? { lazy: { array: coordinate, read: new Set<number>() } }
          : {}),
        ...(lazyBounds
          ? {
              lazyBounds: {
                array: declared,
                read: new Set<number>(
                  bounds!.flatMap((_, at) =>
                    at % 2 === 0 &&
                    Number.isFinite(bounds![at]) &&
                    Number.isFinite(bounds![at + 1])
                      ? [at / 2]
                      : []
                  )
                ),
                parent: coordinate.attrs,
              },
            }
          : {}),
      },
    };
  } catch {
    return {};
  }
}

function chunkCount(array: TAnalysisArray) {
  return array.shape.reduce(
    (p, n, d) => p * Math.ceil(n / Math.max(1, array.chunks[d] ?? n)),
    1
  );
}

/** The forecast period coordinate along `dimension`, its own or named. */
async function leadCoordinate(
  dataset: TAnalysisDataset,
  variable: string,
  dimension: string,
  size: number,
  named: string[]
) {
  for (const name of [dimension, ...named.filter((n) => n !== dimension)]) {
    const path = ZarrDataManager.resolveVariablePath(variable, name);
    const coordinate = await tryOpen(dataset, path);
    const along = coordinate?.dimensionNames?.[0];
    if (
      coordinate?.attrs.standard_name === "forecast_period" &&
      coordinate.shape.length === 1 &&
      coordinate.shape[0] === size &&
      size <= 65536 &&
      (along === dimension || (!along && name === dimension))
    ) {
      return { coordinate, path };
    }
  }
  return undefined;
}

/** The lead's declared bounds array, when it is size × 2 along the leads. */
async function leadBoundsArray(
  dataset: TAnalysisDataset,
  path: string,
  coordinate: TAnalysisArray,
  size: number
) {
  const name = coordinate.attrs.bounds;
  if (typeof name !== "string") {
    return undefined;
  }
  const array = await openReferenced(dataset, coordinate, name, path).catch(
    () => undefined
  );
  // Along the leads by name too, when both name their dimensions: one of
  // another dimension the same size is no lead's bounds.
  const [along, own] = [
    array?.dimensionNames?.[0],
    coordinate.dimensionNames?.[0],
  ];
  return array?.shape.length === 2 &&
    array.shape[0] === size &&
    array.shape[1] === 2 &&
    (!along || !own || along === own)
    ? array
    : undefined;
}

/**
 * A scalar forecast period the field names (`coordinates: "fp"` with
 * fp a 0-d forecast_period): its one lead, for valid times.
 */
/** A scalar lead, with its declared interval when it has one. */
type TScalarLead = {
  name: string;
  value: number;
  seconds: number;
  units?: string;
  /** Its published bounds, in its units. */
  bounds?: [number, number];
  /**
   * Bounds declared but not readable yet: support unknown. Their array,
   * when it opened, is read again at each plan.
   */
  pending?: {
    array?: TAnalysisArray;
    parent: TAttrs;
    reopen: () => Promise<TAnalysisArray | undefined>;
  };
};

/**
 * A scalar lead's two bounds, in its units; undefined when not readable
 * (missing, malformed, or of another shape).
 */
async function scalarLeadBounds(
  dataset: TAnalysisDataset,
  array: TAnalysisArray,
  parent: TAttrs
) {
  if (array.shape.reduce((p, n) => p * n, 1) !== 2 || array.shape.length > 2) {
    return undefined;
  }
  const decoded = await readDecodedNow(dataset, array).catch(() => undefined);
  const converted = decoded && inParentUnits(decoded, array.attrs, parent);
  return converted?.length === 2 && converted.every(Number.isFinite)
    ? ([converted[0], converted[1]] as [number, number])
    : undefined;
}

// eslint-disable-next-line max-lines-per-function
async function scalarForecastPeriod(
  dataset: TAnalysisDataset,
  variable: string,
  named: string[]
): Promise<TScalarLead | undefined> {
  for (const name of named) {
    const coordinate = await tryOpen(
      dataset,
      ZarrDataManager.resolveVariablePath(variable, name)
    ).catch(() => undefined);
    if (
      coordinate?.attrs.standard_name !== "forecast_period" ||
      coordinate.shape.length !== 0
    ) {
      continue;
    }
    const [value] = await readDecoded(dataset, coordinate);
    const units = coordinate.attrs.units;
    const seconds = durationSeconds(units);
    if (Number.isFinite(value) && seconds !== undefined) {
      const declared = coordinate.attrs.bounds;
      const array =
        typeof declared === "string"
          ? await openReferenced(dataset, coordinate, declared, name).catch(
              () => undefined
            )
          : undefined;
      const bounds = array
        ? await scalarLeadBounds(dataset, array, coordinate.attrs)
        : undefined;
      return {
        name,
        value,
        seconds,
        ...(typeof units === "string" ? { units } : {}),
        ...(bounds ? { bounds } : {}),
        // Declared, not read: unknown support, looked for again later.
        ...(typeof declared === "string" && !bounds
          ? {
              pending: {
                array,
                parent: coordinate.attrs,
                // Its metadata may be published later too.
                reopen: () =>
                  openReferenced(dataset, coordinate, declared, name).catch(
                    () => undefined
                  ),
              },
            }
          : {}),
      };
    }
  }
  return undefined;
}

type TForecastPeriod = {
  /** Decoded leads in their units; NaN where missing (or not read yet). */
  values: number[];
  units?: string;
  /** Seconds in one unit, when the units are a duration. */
  seconds?: number;
  /** Published bounds, [low, high] per lead, decoded, flat. */
  bounds?: number[];
  /** The lead declares bounds: a lead without them has unknown support. */
  boundsDeclared?: true;
  /** A long axis: read at the leads fixed, chunk by chunk. */
  lazy?: { array: TAnalysisArray; read: Set<number> };
  /** Bounds in many chunks: read at the leads fixed, row by row. */
  lazyBounds?: { array: TAnalysisArray; read: Set<number>; parent: TAttrs };
  /** Declared bounds whose array could not be opened yet. */
  reopenBounds?: () => Promise<TAnalysisArray | undefined>;
  parentAttrs?: TAttrs;
};

/** Lead chunks searched for a partner's lead of a given duration. */
const MAX_LEAD_SEARCH_CHUNKS = 4096;

/**
 * The leads a query fixes, read where a long forecast period axis has not been
 * read yet: one chunk for one lead, and that lead's bounds row. A lead asked
 * for by its duration (a partner's, `leadSeconds`) is found here, reading the
 * axis as far as needed: a companion stored in 65 lead chunks was refused on a
 * fresh open, and matched only after its lead had been plotted.
 */

// eslint-disable-next-line max-lines-per-function
export async function readSelectedLeads(
  context: TVariableContext,
  query: {
    fixed?: Record<string, number>;
    leadSeconds?: Record<string, number>;
    leadInterval?: Record<string, [number, number]>;
  },
  signal?: AbortSignal
) {
  for (const other of context.others) {
    const period = other.forecastPeriod;
    const wanted = query.leadSeconds?.[other.dimension];
    if (period && wanted !== undefined && query.fixed) {
      query.fixed[other.dimension] = await leadOfDuration(
        context.dataset,
        period,
        { seconds: wanted, interval: query.leadInterval?.[other.dimension] },
        other.dimension,
        signal
      );
    }
    const index = query.fixed?.[other.dimension];
    if (!period || index === undefined || index < 0) {
      continue;
    }
    if (period.lazy) {
      await readLeadChunk(context.dataset, period, index, signal);
    }
    if (period.reopenBounds && !period.lazyBounds) {
      const array = await period.reopenBounds();
      if (array) {
        period.bounds = new Array<number>(2 * period.values.length).fill(
          Number.NaN
        );
        period.lazyBounds = {
          array,
          read: new Set(),
          parent: period.parentAttrs!,
        };
        delete period.reopenBounds;
      }
    }
    const rows = period.lazyBounds;
    if (rows && !rows.read.has(index) && period.bounds) {
      await readBoundsChunk(context.dataset, period, index, signal);
    }
  }
  // A scalar lead's declared bounds not read yet: looked for again (one tiny
  // chunk), so a later publication counts. Bounds metadata missing when
  // described is looked for again as well.
  const scalar = context.scalarLead;
  if (scalar?.pending && !scalar.pending.array) {
    scalar.pending.array = await scalar.pending.reopen();
  }
  if (scalar?.pending?.array) {
    const { array, parent } = scalar.pending;
    const bounds = await scalarLeadBounds(context.dataset, array, parent);
    if (bounds) {
      scalar.bounds = bounds;
      delete scalar.pending;
    }
  }
}

/**
 * The bounds rows of the chunk holding `index`, each kept once known: a row
 * still missing is read again later, and 64 rows of one chunk read it once, not
 * 64 times.
 */
async function readBoundsChunk(
  dataset: TAnalysisDataset,
  period: TForecastPeriod,
  index: number,
  signal?: AbortSignal
) {
  const rows = period.lazyBounds!;
  const { offset, fresh } = await readWindow(
    dataset,
    rows.array,
    true,
    index,
    index,
    signal
  );
  const first = offset / 2;
  const count = Math.min(fresh.length / 2, period.values.length - first);
  for (let k = 0; k < count; k++) {
    const row = first + k;
    if (rows.read.has(row)) {
      continue;
    }
    const converted = inParentUnits(
      [fresh[2 * k], fresh[2 * k + 1]],
      rows.array.attrs,
      rows.parent
    );
    if (converted && converted.every(Number.isFinite)) {
      period.bounds![2 * row] = converted[0];
      period.bounds![2 * row + 1] = converted[1];
      rows.read.add(row);
    }
  }
}

/** One chunk of a long lead axis, decoded into its values. */
async function readLeadChunk(
  dataset: TAnalysisDataset,
  period: TForecastPeriod,
  index: number,
  signal?: AbortSignal
) {
  const lazy = period.lazy!;
  const size = lazy.array.chunks[0] || 1;
  const chunk = Math.floor(index / size);
  if (lazy.read.has(chunk)) {
    return;
  }
  const at = await readAlong(dataset, lazy.array, [index], signal);
  const end = Math.min(period.values.length, (chunk + 1) * size);
  for (let k = chunk * size; k < end; k++) {
    period.values[k] = at(k);
  }
  lazy.read.add(chunk);
}

/** Lead chunks read at once while searching. */
const LEAD_SEARCH_BATCH = 16;

/**
 * The index of the lead lasting `seconds` (−1: none), over the interval asked
 * for when several last as long. Chunks are read some at a time, not one after
 * another; an axis too long to search says so.
 */
// eslint-disable-next-line max-lines-per-function
async function leadOfDuration(
  dataset: TAnalysisDataset,
  period: TForecastPeriod,
  wanted: { seconds: number; interval?: [number, number] },
  dimension: string,
  signal?: AbortSignal
) {
  if (period.seconds === undefined) {
    return -1;
  }
  const matches = (k: number) =>
    sameDuration(period.values[k] * period.seconds!, wanted.seconds);
  if (period.lazy) {
    const size = period.lazy.array.chunks[0] || 1;
    const chunks = Math.ceil(period.values.length / size);
    if (chunks - period.lazy.read.size > MAX_LEAD_SEARCH_CHUNKS) {
      throw new AnalysisInputError(
        `The lead of ${wanted.seconds / 3600} h was not looked up along ${dimension}: its values are stored in ${chunks.toLocaleString("en-US")} chunks, more than the ${MAX_LEAD_SEARCH_CHUNKS.toLocaleString("en-US")} searched.`
      );
    }
    const unread = Array.from({ length: chunks }, (_, c) => c).filter(
      (c) => !period.lazy!.read.has(c)
    );
    for (let at = 0; at < unread.length; at += LEAD_SEARCH_BATCH) {
      await Promise.all(
        unread
          .slice(at, at + LEAD_SEARCH_BATCH)
          .map((c) => readLeadChunk(dataset, period, c * size, signal))
      );
    }
  }
  let found: number[] = [];
  period.values.forEach((_, k) => {
    if (matches(k)) {
      found.push(k);
    }
  });
  const interval = wanted.interval;
  if (found.length > 1 && interval && period.bounds) {
    for (const k of found) {
      if (period.lazyBounds && !period.lazyBounds.read.has(k)) {
        await readBoundsChunk(dataset, period, k, signal);
      }
    }
    found = found.filter((k) => {
      const [low, high] = [period.bounds![2 * k], period.bounds![2 * k + 1]];
      return (
        sameDuration(low * period.seconds!, interval[0]) &&
        sameDuration(high * period.seconds!, interval[1])
      );
    });
  }
  return found.length === 1 ? found[0] : -1;
}

/** The vertical coordinates a field names, in the order they are taken. */
async function verticalCandidates(
  dataset: TAnalysisDataset,
  variable: string,
  named: string[]
) {
  const candidates: {
    name: string;
    path: string;
    coordinate: TAnalysisArray;
    attrs: TAttrs;
  }[] = [];
  for (const name of named) {
    const path = ZarrDataManager.resolveVariablePath(variable, name);
    const coordinate = await tryOpen(dataset, path);
    const attrs = (coordinate?.attrs ?? {}) as TAttrs;
    if (coordinate && looksVertical(attrs) && !isSurfaceName(name, attrs)) {
      candidates.push({ name, path, coordinate, attrs });
    }
  }
  return candidates.sort(
    (a, b) =>
      a.coordinate.shape.length - b.coordinate.shape.length ||
      verticalPrecedence(a.attrs) - verticalPrecedence(b.attrs) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0)
  );
}

/** Which of several vertical coordinates is shown: lower first. */
function verticalPrecedence(attrs: TAttrs) {
  const standard = String(attrs.standard_name ?? "");
  const units = String(attrs.units ?? "").trim();
  const order = [
    /^depth/,
    /^height/,
    /^altitude|geopotential_height/,
    /pressure/,
  ];
  const at = order.findIndex((pattern) => pattern.test(standard));
  if (at >= 0) {
    return at;
  }
  return PRESSURE_UNITS.test(units) ? 3 : 4;
}

/** A surface quantity (orography, surface height or pressure), not levels. */
function isSurfaceName(name: string, attrs: TAttrs) {
  const standard = String(attrs.standard_name ?? "");
  return (
    /^surface_/.test(standard) ||
    /(^|_)(surface|orog|orography|topo|topography|zs|ps)($|_)/i.test(name)
  );
}

async function auxiliaryVertical(
  dataset: TAnalysisDataset,
  variable: string,
  dims: string[],
  shape: number[],
  taken: Set<number>
): Promise<TVerticalContext | { ambiguous: string } | undefined> {
  const field = await tryOpen(dataset, variable);
  const named = String(field?.attrs.coordinates ?? "")
    .split(/\s+/)
    .filter(Boolean);
  // Ensemble dimensions are never levels; looked up only once a named
  // coordinate looks vertical (no extra metadata requests otherwise).
  let ensemble: Promise<Map<string, string>> | undefined;
  const ensembleDims = () =>
    (ensemble ??= ensembleOf(dataset, variable, dims, named));
  // The order of `coordinates` means nothing (CF): of several vertical
  // coordinates, one per level first, then by quantity (depth, height,
  // altitude, then pressures, then others), then by name.
  const candidates = await verticalCandidates(dataset, variable, named);
  for (const { name, path, coordinate } of candidates) {
    // One untaken, non-ensemble field dimension is the level.
    const members = await ensembleDims();
    const levels = coordinate.dimensionNames.filter(
      (dim) =>
        dims.includes(dim) && !taken.has(dims.indexOf(dim)) && !members.has(dim)
    );
    if (levels.length > 1) {
      return ambiguousLevels(name, coordinate.dimensionNames, levels);
    }
    if (!levels.length) {
      continue;
    }
    const axis = levels[0];
    const at = dims.indexOf(axis);
    const where = `${name}(${coordinate.dimensionNames.join(", ")})`;
    return auxiliaryLevels(dataset, path, name, coordinate, {
      where,
      axis,
      at,
      length: shape[at],
    });
  }
  return undefined;
}

// eslint-disable-next-line max-lines-per-function
function capabilities(
  context: Omit<TVariableContext, "capabilities">
): Record<TAnalysisKind, TCapability> {
  const { grid, time, vertical, codec } = context;
  const all = Object.values(ANALYSIS_KINDS);
  if (grid.kind === ANALYSIS_GRID_KINDS.UNSUPPORTED) {
    const off = { available: false, reason: grid.reason };
    return Object.fromEntries(all.map((kind) => [kind, off])) as Record<
      TAnalysisKind,
      TCapability
    >;
  }
  const ok = { available: true };
  // A one-step time dimension with no coordinate (a single analysis
  // time): one date, not a missing axis, as the map's own slider shows.
  const singleStep = context.array.dimensionNames.some(
    (name, axis) =>
      context.array.shape[axis] === 1 && isTimeCoordinate(name, {})
  );
  const noTime = {
    available: false,
    reason:
      context.timeProblem ??
      (singleStep
        ? "The variable has only one time step, and no time coordinate."
        : "The variable has no time dimension."),
  };
  const fewTimes = {
    available: false,
    reason: "The variable has only one time step.",
  };
  const noVertical = {
    available: false,
    reason:
      context.verticalProblem ?? "The variable has no vertical dimension.",
  };
  const fewLevels = {
    available: false,
    reason: "The variable has only one vertical level.",
  };
  // Means over cells need weights: equal-area HEALPix cells, or spherical
  // areas from published latitude/longitude bounds; categories have none.
  let weights: TCapability = ok;
  if (codec.categorical) {
    weights = {
      available: false,
      reason:
        "The variable is categorical (flag values); means and distributions are not defined.",
    };
  } else if (grid.kind === ANALYSIS_GRID_KINDS.NATIVE && grid.noWeights) {
    weights = {
      available: false,
      reason: grid.siteMean
        ? `${grid.noWeights} An area time series averages the sites inside instead.`
        : grid.noWeights,
    };
  } else if (
    grid.kind === ANALYSIS_GRID_KINDS.RECTILINEAR &&
    grid.areaProblem
  ) {
    weights = { available: false, reason: grid.areaProblem };
  } else if (
    grid.kind === ANALYSIS_GRID_KINDS.RECTILINEAR &&
    !grid.areas &&
    (!grid.lat.bounds || !grid.lon.bounds)
  ) {
    weights = {
      available: false,
      reason:
        "Area means need cell areas (a declared cell measure such as areacella) or latitude and longitude cell bounds; this source publishes neither, and its grid is not regular enough to assume edges halfway between centres.",
    };
  }
  const series = time ? ok : noTime;
  const spaceTime = !time ? noTime : time.raw.length < 2 ? fewTimes : ok;
  const both = (a: TCapability, b: TCapability) => (a.available ? b : a);
  return {
    [ANALYSIS_KINDS.POINT_SERIES]: series,
    // Sites without areas: their plain mean, labelled (siteMean).
    [ANALYSIS_KINDS.REGION_SERIES]: both(
      series,
      grid.kind === ANALYSIS_GRID_KINDS.NATIVE && grid.siteMean ? ok : weights
    ),
    [ANALYSIS_KINDS.PROFILE]: vertical ? ok : noVertical,
    // Without a vertical axis a section is a path: one value per sample.
    // An unresolved level is not a surface: no path in place of a curtain.
    [ANALYSIS_KINDS.SECTION]: context.verticalProblem ? noVertical : ok,
    [ANALYSIS_KINDS.TIME_DEPTH]: both(
      spaceTime,
      !vertical ? noVertical : vertical.values.length < 2 ? fewLevels : ok
    ),
    [ANALYSIS_KINDS.HOVMOLLER_LON]: both(spaceTime, weights),
    [ANALYSIS_KINDS.HOVMOLLER_LAT]: both(spaceTime, weights),
    [ANALYSIS_KINDS.HOVMOLLER_PATH]: spaceTime,
    // A distribution needs no time: static fields work.
    [ANALYSIS_KINDS.DISTRIBUTION]: weights,
    // One time (or none) and every level: needs levels and area weights.
    [ANALYSIS_KINDS.LAT_VERTICAL]: both(
      !vertical ? noVertical : vertical.values.length < 2 ? fewLevels : ok,
      weights
    ),
    [ANALYSIS_KINDS.LON_VERTICAL]: both(
      !vertical ? noVertical : vertical.values.length < 2 ? fewLevels : ok,
      weights
    ),
  };
}

const ROTATED_NAMES = /^(grid_latitude|grid_longitude)$/;

/**
 * Axes that are not geographic latitude/longitude: rotated-pole axes
 * (standard names grid_latitude/longitude, or rlat/rlon). Such a grid is
 * usable through its true two-dimensional coordinates, when named.
 */
/**
 * The prime meridians of the mappings a field names: its resolved mapping
 * and each one of an expanded `grid_mapping` ("a: lat lon b: y x"), in
 * degrees east of Greenwich, by CF's longitude_of_prime_meridian or the
 * PRIMEM of their WKT (crs_wkt, spatial_ref).
 */
async function primeMeridians(
  dataset: TAnalysisDataset,
  variable: string,
  array: TAnalysisArray,
  crs: TAnalysisArray | undefined
) {
  const named = String(array.attrs.grid_mapping ?? "");
  const listed = /:/.test(named)
    ? [...named.matchAll(/([^\s:]+):/g)].map((m) => m[1])
    : [];
  const arrays = [crs];
  for (const name of listed) {
    arrays.push(
      await tryOpen(
        dataset,
        ZarrDataManager.resolveVariablePath(variable, name)
      ).catch(() => undefined)
    );
  }
  const out: { degrees: number; from: string; name?: string }[] = [];
  for (const mapping of arrays) {
    const attrs = mapping?.attrs;
    if (!attrs) {
      continue;
    }
    const name = mapping!.key.split("|").pop()?.split("/").pop();
    if (attrs.longitude_of_prime_meridian !== undefined) {
      out.push({
        degrees: Number(attrs.longitude_of_prime_meridian),
        from: "longitude_of_prime_meridian",
        name,
      });
      continue;
    }
    for (const key of ["crs_wkt", "spatial_ref"]) {
      const degrees = wktPrimeMeridian(attrs[key]);
      if (degrees !== undefined) {
        out.push({ degrees, from: `the PRIMEM of its ${key}`, name });
        break;
      }
    }
  }
  return out;
}

/** A WKT's PRIMEM in degrees (its angular unit applied), if it has one. */
export function wktPrimeMeridian(wkt: unknown) {
  if (typeof wkt !== "string") {
    return undefined;
  }
  const primem =
    /PRIMEM\s*\[\s*"[^"]*"\s*,\s*(-?[\d.eE+-]+)\s*(?:,\s*(?:ANGLEUNIT|UNIT)\s*\[\s*"[^"]*"\s*,\s*([\d.eE+-]+))?/i.exec(
      wkt
    );
  if (!primem) {
    return undefined;
  }
  const value = Number(primem[1]);
  // Its own unit in radians, else the geographic CRS's angular unit.
  const unit =
    primem[2] ??
    /(?:ANGLEUNIT|UNIT)\s*\[\s*"(?:degree|grad|gon|radian)[^"]*"\s*,\s*([\d.eE+-]+)/i.exec(
      wkt
    )?.[1];
  const radians = unit === undefined ? Math.PI / 180 : Number(unit);
  const degrees = (value * radians * 180) / Math.PI;
  return Math.abs(degrees) < 1e-12 ? 0 : Number(degrees.toPrecision(12));
}

async function rotatedAxes(
  dataset: TAnalysisDataset,
  variable: string,
  array: TAnalysisArray
) {
  for (const dim of array.dimensionNames) {
    const coordinate = await tryOpen(
      dataset,
      ZarrDataManager.resolveVariablePath(variable, dim)
    );
    const standard = String(coordinate?.attrs.standard_name ?? "");
    if (ROTATED_NAMES.test(standard) || /^r(lat|lon)$/i.test(dim)) {
      return `${dim} is a rotated-pole axis, not geographic latitude/longitude.`;
    }
  }
  return undefined;
}

// eslint-disable-next-line max-lines-per-function
async function resolveGrid(
  dataset: TAnalysisDataset,
  variable: string,
  array: TAnalysisArray,
  indexCache: ByteLru<BigInt64Array>
): Promise<TGridContext> {
  const groupAttrs = await dataset.groupAttrs(
    ZarrDataManager.resolveGroupPath(variable)
  );
  const crsName = ZarrDataManager.getCRSVariableName(
    array.attrs as never,
    (groupAttrs ?? {}) as never
  );
  const crs = await tryOpen(
    dataset,
    ZarrDataManager.resolveVariablePath(variable, crsName)
  );
  const dggs = (groupAttrs?.dggs as TAttrs | undefined) ?? null;
  // A mesh the variable names outranks a mapping only its group declares.
  const groupMappingOnly =
    typeof array.attrs.mesh === "string" &&
    typeof array.attrs.grid_mapping !== "string";
  const mapping = groupMappingOnly ? undefined : crs?.attrs.grid_mapping_name;
  // The variable's own mapping first; the group's DGGS only for variables that
  // name none. A UGRID mesh the variable names is its own grid too.
  const ownMapping =
    (typeof array.attrs.grid_mapping === "string" && mapping !== undefined) ||
    typeof array.attrs.mesh === "string";
  // HEALPix only from the group: the variable's own geographic coordinates come
  // first, not a grid found by a dimension's length.
  const inherited =
    typeof array.attrs.grid_mapping !== "string" &&
    (mapping === "healpix" || dggs?.name === "healpix");
  if (inherited) {
    const product = await productGrid(dataset, variable, array);
    if ("kind" in product) {
      return product;
    }
  }
  if (mapping === "healpix" || (dggs?.name === "healpix" && !ownMapping)) {
    return await resolveHealpix(
      dataset,
      variable,
      array,
      crs?.attrs,
      dggs,
      indexCache
    );
  }
  const geographic = !mapping || mapping === "latitude_longitude";
  // Longitudes from another prime meridian (CF Appendix F) are other places
  // than their numbers say: refused, not sampled as Greenwich's. Of every
  // mapping the field names (an expanded grid_mapping lists one per coordinate
  // pair), by its CF attribute or its WKT's PRIMEM, rotated poles too.
  const meridians = await primeMeridians(dataset, variable, array, crs);
  const offset = meridians.find((m) => m.degrees !== 0);
  if (offset && (geographic || mapping === "rotated_latitude_longitude")) {
    return {
      kind: ANALYSIS_GRID_KINDS.UNSUPPORTED,
      reason: Number.isFinite(offset.degrees)
        ? `Its longitudes${offset.name ? ` (${offset.name})` : ""} are from a prime meridian ${offset.degrees}° from Greenwich (${offset.from}); plots read longitudes from Greenwich only.`
        : `Its prime meridian (${offset.from}${offset.name ? ` of ${offset.name}` : ""}) is not a number.`,
    };
  }
  const rotated = geographic
    ? await rotatedAxes(dataset, variable, array)
    : undefined;
  let reason =
    "Plots support HEALPix, latitude/longitude, curvilinear, irregular and UGRID grids; this variable's coordinates were not found.";
  if (geographic && !rotated) {
    const product = await productGrid(dataset, variable, array);
    if ("kind" in product) {
      return product;
    }
    reason = product.reason ?? reason;
  }
  // Curvilinear, irregular, UGRID, or a rotated or projected grid with its
  // true latitude/longitude as auxiliary coordinates.
  const native = await resolveNativeGrid(dataset, variable, array);
  if (native && "kind" in native) {
    return native;
  }
  if (native) {
    return { kind: ANALYSIS_GRID_KINDS.UNSUPPORTED, reason: native.reason };
  }
  if (!geographic) {
    reason = `Plots of ${String(mapping)} grids need the true latitude and longitude as auxiliary coordinates, which this variable does not name.`;
  } else if (rotated) {
    reason = `${rotated} Plots of rotated grids need the true latitude and longitude as two-dimensional coordinates, which this variable does not name.`;
  }
  return { kind: ANALYSIS_GRID_KINDS.UNSUPPORTED, reason };
}

/**
 * One axis of a product grid: the declared array, else the array named
 * like the dimension, only when it lies along that dimension (an array of
 * that name along another axis is another variable's coordinate).
 */
async function productAxis(
  dataset: TAnalysisDataset,
  variable: string,
  name: string,
  found: TAnalysisArray | undefined,
  options: { longitude: boolean; length: number }
) {
  const named = found
    ? undefined
    : await tryOpen(
        dataset,
        ZarrDataManager.resolveVariablePath(variable, name)
      );
  const coordinate =
    found ??
    (named &&
    named.dimensionNames.length === 1 &&
    named.dimensionNames[0] === name
      ? named
      : undefined);
  return (
    coordinate && rectilinearAxis(dataset, variable, coordinate, name, options)
  );
}

/** The field's latitude and longitude axes: declared, else by name. */
function productAxes(
  dims: string[],
  declared: Awaited<ReturnType<typeof declaredAxes>>
) {
  const known = declared || undefined;
  return [
    known?.lat
      ? dims.indexOf(known.lat.array.dimensionNames[0])
      : dims.findIndex(isLatitudeName),
    known?.lon
      ? dims.indexOf(known.lon.array.dimensionNames[0])
      : dims.findIndex(isLongitudeName),
  ];
}

/** A latitude × longitude product grid, or why the axes are unusable. */
// eslint-disable-next-line max-lines-per-function
async function productGrid(
  dataset: TAnalysisDataset,
  variable: string,
  array: TAnalysisArray
): Promise<TRectilinearContext | { reason?: string }> {
  const dims = array.dimensionNames;
  // The field's own coordinates first: same-named arrays may be others.
  const declared = await declaredAxes(dataset, variable, array);
  const [latAxis, lonAxis] = productAxes(dims, declared);
  // Latitude and longitude along one dimension are paired coordinates of sites,
  // not a product.
  if (declared === false || latAxis < 0 || lonAxis < 0 || latAxis === lonAxis) {
    return {};
  }
  const latName = (declared && declared.lat?.name) || dims[latAxis];
  const lonName = (declared && declared.lon?.name) || dims[lonAxis];
  const axis = (name: string, at: number, found?: TAnalysisArray) =>
    productAxis(dataset, variable, name, found, {
      longitude: at === lonAxis,
      length: array.shape[at],
    });
  let lat: TRectilinearAxis | undefined;
  let lon: TRectilinearAxis | undefined;
  try {
    lat = await axis(
      latName,
      latAxis,
      (declared && declared.lat?.array) || undefined
    );
    lon = await axis(
      lonName,
      lonAxis,
      (declared && declared.lon?.array) || undefined
    );
  } catch (error) {
    if (error instanceof AxisError) {
      return { reason: error.message };
    }
    throw error;
  }
  if (!lat || !lon) {
    return {};
  }
  const weighting = await weightingOf(dataset, variable, array, {
    latDim: dims[latAxis],
    lonDim: dims[lonAxis],
    latName,
    lonName,
    lat,
    lon,
  });
  return {
    kind: ANALYSIS_GRID_KINDS.RECTILINEAR,
    ...weighting,
    // Membership and weights are kept together: the key names the weights too.
    regionKey: JSON.stringify([
      dataset.key,
      ZarrDataManager.resolveVariablePath(variable, latName),
      ZarrDataManager.resolveVariablePath(variable, lonName),
      latAxis,
      lonAxis,
      "areas" in weighting && weighting.areas
        ? [
            weighting.areas.dataset.key,
            // Its own array: two groups' measures may share a name.
            weighting.areas.array.key,
            weighting.areas.origin,
            weighting.areas.name,
          ]
        : null,
      "areaProblem" in weighting ? weighting.areaProblem : null,
      Boolean(weighting.approximateBounds),
    ]),
    latAxis,
    lonAxis,
  };
}

/**
 * How a product grid's cells are weighted: its declared cell measure (or
 * why that cannot serve), else its bounds; with neither, a regular grid's
 * edges halfway between centres, labelled approximate (a Gaussian grid
 * gets none). Returns the axes to use (with any such bounds).
 */
async function weightingOf(
  dataset: TAnalysisDataset,
  variable: string,
  array: TAnalysisArray,
  axes: Parameters<typeof resolveCellAreas>[3]
) {
  let { lat, lon } = axes;
  const areas = await resolveCellAreas(dataset, variable, array, axes);
  let approximateBounds = false;
  // Which axis was inferred, not the whole cell.
  const inferredAxes = [
    ...(lat.bounds ? [] : ["latitude" as const]),
    ...(lon.bounds ? [] : ["longitude" as const]),
  ];
  if (!areas && (!lat.bounds || !lon.bounds)) {
    const latBounds = lat.bounds ?? midpointBounds(lat.values, true);
    const lonBounds = lon.bounds ?? midpointBounds(lon.values, false);
    if (latBounds && lonBounds) {
      approximateBounds = true;
      lat = { ...lat, bounds: latBounds };
      lon = { ...lon, bounds: lonBounds };
    }
  }
  return {
    lat,
    lon,
    ...(areas && "reason" in areas
      ? {
          areaProblem: areas.reason,
          ...(areas.unreachable ? { areasUnreachable: true } : {}),
        }
      : areas
        ? { areas }
        : {}),
    ...(approximateBounds ? { approximateBounds, inferredAxes } : {}),
  };
}

/** Everything analysis needs to know about one variable, from metadata. */

/** Index bytes each description in progress has asked for, by dataset. */
const describing = new WeakMap<object, { bytes: number }>();

export async function resolveVariableContext(
  dataset: TAnalysisDataset,
  variable: string,
  indexCache: ByteLru<BigInt64Array>
): Promise<TVariableContext> {
  const tally = { bytes: 0 };
  describing.set(dataset, tally);
  try {
    return await resolveVariableContextNow(dataset, variable, indexCache);
  } finally {
    if (describing.get(dataset) === tally) {
      describing.delete(dataset);
    }
  }
}

// eslint-disable-next-line max-lines-per-function
async function resolveVariableContextNow(
  dataset: TAnalysisDataset,
  variable: string,
  indexCache: ByteLru<BigInt64Array>
): Promise<TVariableContext> {
  const array = await dataset.openArray(variable);
  const dims = array.dimensionNames;
  if (dims.length !== array.shape.length) {
    throw new Error(`Variable ${variable} has no dimension names.`);
  }
  const grid = await resolveGrid(dataset, variable, array, indexCache);
  const taken = new Set<number>();
  if (grid.kind === ANALYSIS_GRID_KINDS.HEALPIX) {
    taken.add(grid.cellAxis);
  } else if (grid.kind === ANALYSIS_GRID_KINDS.RECTILINEAR) {
    taken.add(grid.latAxis).add(grid.lonAxis);
  } else if (grid.kind === ANALYSIS_GRID_KINDS.NATIVE) {
    grid.axes.forEach((axis) => taken.add(axis));
  }
  const named = String(array.attrs.coordinates ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const timeCoordinate = await resolveTime(
    dataset,
    variable,
    dims,
    taken,
    array.shape,
    named
  );
  const time =
    timeCoordinate && "invalidTime" in timeCoordinate
      ? undefined
      : timeCoordinate && withoutArrays(timeCoordinate);
  if (time) {
    taken.add(time.axis);
  }
  const found = await resolveVertical(
    dataset,
    variable,
    dims,
    array.shape,
    taken
  );
  const vertical = found && "ambiguous" in found ? undefined : found;
  const verticalProblem =
    found && "ambiguous" in found ? found.ambiguous : undefined;
  if (vertical) {
    taken.add(vertical.axis);
  }
  const rest = dims
    .map((dimension, axis) => ({ axis, dimension, size: array.shape[axis] }))
    .filter(({ axis }) => !taken.has(axis));
  const members = rest.length
    ? await ensembleOf(
        dataset,
        variable,
        rest.map(({ dimension }) => dimension),
        named
      )
    : new Map<string, string>();
  const others = await Promise.all(
    rest.map(async (other) =>
      members.has(other.dimension)
        ? {
            ...other,
            ensemble: true,
            ...(await memberIds(
              dataset,
              variable,
              members.get(other.dimension)!,
              other.size
            )),
          }
        : {
            ...other,
            ...(await forecastPeriodOf(
              dataset,
              variable,
              other.dimension,
              other.size,
              named
            )),
          }
    )
  );
  // A forecast plotted along its reference times with one lead named as a
  // scalar coordinate: that lead dates it.
  const scalarLead =
    time?.standardName === "forecast_reference_time" &&
    !others.some((other) => "forecastPeriod" in other && other.forecastPeriod)
      ? await scalarForecastPeriod(dataset, variable, named)
      : undefined;
  // Both clocks where the source publishes both: valid times beside the
  // reference axis, or the reference time of a valid-time axis. With a scalar
  // lead too: the two clocks must agree.
  if (
    time?.standardName === "forecast_reference_time" &&
    !others.some((other) => "forecastPeriod" in other && other.forecastPeriod)
  ) {
    const published = await publishedValidTimes(dataset, variable, time, named);
    const perUnit = durationSeconds(time.units);
    if (published && "problem" in published) {
      time.clockProblem = published.problem;
    } else if (
      published &&
      scalarLead &&
      perUnit &&
      published.valid.some(
        (v, at) =>
          Number.isFinite(v) &&
          Math.abs(
            time.raw[at] + (scalarLead.value * scalarLead.seconds) / perUnit - v
          ) >
            1e-6 * perUnit
      )
    ) {
      time.clockProblem = `its published valid times disagree with its reference times plus the ${scalarLead.name} lead`;
    } else if (published && !scalarLead) {
      time.valid = published.valid;
      if (published.bounds) {
        time.validBounds = published.bounds;
      }
      if (published.boundsUnread) {
        time.validBoundsUnread = published.boundsUnread;
      }
    }
  }
  const scalarReference =
    time && time.standardName !== "forecast_reference_time"
      ? await scalarReferenceOf(dataset, variable, named)
      : undefined;
  // Or one initialization per valid time, along it.
  if (
    time &&
    !scalarReference &&
    time.standardName !== "forecast_reference_time"
  ) {
    const references = await rowReferencesOf(dataset, variable, time, named);
    if (references) {
      time.references = references;
    }
  }
  const scalarLevel = vertical
    ? undefined
    : await scalarLevelOf(dataset, variable, named);
  const codec = buildValueCodec(
    array.attrs,
    array.fillValue,
    array.dtype,
    dataset.format
  );
  const partial = {
    dataset,
    ...(scalarLevel ? { scalarLevel } : {}),
    ...(scalarLead ? { scalarLead } : {}),
    ...(scalarReference ? { scalarReference } : {}),
    variable,
    array,
    codec,
    dims,
    grid,
    time,
    ...(timeCoordinate && "invalidTime" in timeCoordinate
      ? {
          timeProblem: timeCoordinate.invalidTime,
          timeProblemAxis: timeCoordinate.axis,
        }
      : {}),
    ...(timeCoordinate ? { timeArrays: timeCoordinate.arrays } : {}),
    vertical,
    ...(verticalProblem ? { verticalProblem } : {}),
    others,
    units:
      typeof array.attrs.units === "string" ? array.attrs.units : undefined,
    ...(typeof array.attrs.units_metadata === "string"
      ? { unitsMetadata: array.attrs.units_metadata }
      : {}),
    ...(typeof array.attrs.cell_methods === "string"
      ? { cellMethods: array.attrs.cell_methods }
      : {}),
    ...quantityOf(array.attrs),
    longName: String(
      array.attrs.long_name ?? array.attrs.standard_name ?? variable
    ),
    standardName:
      typeof array.attrs.standard_name === "string"
        ? array.attrs.standard_name
        : "",
  };
  return { ...partial, capabilities: capabilities(partial) };
}

function quantityOf(attrs: TAttrs) {
  const kind = quantityKind(
    typeof attrs.units === "string" ? attrs.units : undefined,
    typeof attrs.standard_name === "string" ? attrs.standard_name : undefined
  );
  return kind ? { quantity: kind } : {};
}

export function isPhysicalVertical(vertical?: TVerticalContext) {
  return (
    vertical?.kind === VERTICAL_KINDS.PHYSICAL ||
    vertical?.kind === VERTICAL_KINDS.FORMULA
  );
}
