/**
 * Plots that combine time with a spatial or vertical axis, and value
 * distributions: time–depth at a point, Hovmöller diagrams (longitude ×
 * time over a latitude band, latitude × time over a longitude sector,
 * distance × time along a path) and the area-weighted distribution of a
 * region at one time. All read exact selections through the shared visitor
 * and stream time-oriented results part by part.
 */
import { tooManyValues } from "./analysisErrors.ts";
import { cellWeights, weightingLabel } from "./cellAreas.ts";
import {
  countRunChunks,
  type ReadContext,
  type TIndexRuns,
  type TPointSelection,
  visitRuns,
  yieldIfBusy,
  pointSelectionBytes,
  runSelectionBytes,
} from "./chunkVisitor.ts";
import { distributionSummaryAsync } from "./distributionStats.ts";
import {
  nativeAreas,
  nativeMembers,
  nativePositions,
  type TNativeContext,
} from "./nativeGrid.ts";
import {
  AnalysisInputError,
  baseResult,
  columnKey,
  columnVertical,
  estimateFor,
  JOBS_PER_BATCH,
  levelIndex,
  layoutNote,
  levelNote,
  locatePoint,
  planFormulaTerms,
  preparedSectionColumns,
  readFormulaTerms,
  emptyRegionNote,
  queryRegionSelection,
  REGION_LOOKAHEAD,
  sampleColumnKey,
  sampleMethod,
  sectionSelection,
  selectionRuns,
  setSpatialRuns,
  streamParts,
  termChunks,
  repeatedColumns,
  stepOf,
  timeOf,
  readingParts,
  timeRange,
  verticalOf,
  type TPlannedAnalysis,
  type TRegionSelection,
} from "./operations.ts";
import { REGION_KINDS, coverHealpixRegion } from "./regionCover.ts";
import {
  DRAWING_SPHERE_RADIUS_METERS,
  validateBox,
  type TBox,
} from "./sphere.ts";
import {
  ANALYSIS_KINDS,
  emptyCounters,
  MAX_SPACE_BINS,
  MAX_VALUE_BINS,
  MIN_BIN_DEGREES,
  GEOMETRY_KINDS,
  SAMPLE_STATUS,
  type TAnalysisQuery,
  type TAnalysisResult,
  type TPartialUpdate,
  type TSampleStatus,
  type TWorkCounters,
} from "./types.ts";
import {
  ANALYSIS_GRID_KINDS,
  type TRectilinearContext,
  type TVariableContext,
} from "./variableContext.ts";
import { VERTICAL_KINDS } from "./vertical.ts";

import { cellInterval } from "@/lib/grids/analysisGrid.ts";

type TRun = Parameters<NonNullable<TPlannedAnalysis["execute"]>>;
type THooks = TRun[1];

// Most cells a Hovmöller or distribution selection may hold (16 bytes each).
const MAX_SELECTED_CELLS = 4_000_000;
// Most time × bin values of one space–time result (values and coverage).
const MAX_OUTPUT_CELLS = 2_000_000;

function count(n: number) {
  return n.toLocaleString("en-US");
}

function lat(value: number) {
  return `${Math.abs(value).toFixed(1)}° ${value < 0 ? "S" : "N"}`;
}

function lon(value: number) {
  const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
  return `${Math.abs(wrapped).toFixed(1)}° ${wrapped < 0 ? "W" : "E"}`;
}

/**
 * A longitude cell's bounds as the arc between them that holds its centre (the
 * grid's own rule), a full circle staying one: each edge wrapped toward the
 * centre on its own made [0°, 270°] about 45° into [−90°, 0°], and the 270°
 * cell a missing bin.
 */
function lonInterval(axis: TRectilinearContext["lon"], at: number) {
  return cellInterval({ ...axis, longitude: true }, at);
}

/**
 * Degrees east of `west`, in [0, 360). A positive remainder is never
 * shifted by 360 first: 10⁻¹⁴° east stays 10⁻¹⁴°, not a rounded full turn.
 */
function eastOf(west: number, value: number) {
  const d = (value - west) % 360;
  if (d >= 0) {
    return d;
  }
  const up = d + 360;
  return up >= 360 ? 0 : up;
}

/**
 * For a full-turn box, a west edge on a true cell boundary: the edge of the
 * cell holding the requested west, so no cell is cut at the seam and the
 * bins cover 360° of whole cells.
 */
function seamWest(axis: TRectilinearContext["lon"], west: number) {
  const n = axis.values.length;
  if (!n) {
    return west;
  }
  if (axis.bounds) {
    for (let j = 0; j < n; j++) {
      const [lo, hi] = lonInterval(axis, j);
      const into = eastOf(lo, west);
      if (into > 0 && into < hi - lo) {
        return west - into;
      }
    }
    return west;
  }
  // Centres only: halfway between the last centre before the seam and the
  // first after it.
  let first = Infinity;
  let last = -Infinity;
  for (const value of axis.values) {
    const offset = eastOf(west, value);
    first = Math.min(first, offset);
    last = Math.max(last, offset);
  }
  return first === 0 ? west : west + (last + first + 360) / 2 - 360;
}

/** Longitude span of a box: equal ends are empty, ±180 is a full turn. */
function boxSpan(box: TBox) {
  const span = eastOf(box.west, box.east);
  return span === 0 && box.east !== box.west ? 360 : span;
}

/** A whole result as an update (it replaces what the window shows). */
function frame(
  base: (partial: TAnalysisResult["partial"]) => TAnalysisResult,
  partial: NonNullable<TAnalysisResult["partial"]>
) {
  return { base: base(partial), offset: 0, values: [], partial };
}

/** The window shows the parts to come before the first one arrives. */
function announceParts(
  count: number,
  span: TReadSpan,
  hooks: THooks,
  base: (partial: TAnalysisResult["partial"]) => TAnalysisResult
) {
  if (count) {
    hooks?.onPartial?.({
      ...frame(base, spanPartial(0, count, span)),
      counters: emptyCounters(),
    });
  }
}

/**
 * The rows read, [from, at): growing from the start, or (`fromEnd`, the
 * earlier dates of an Extend) back from the end.
 */
type TReadSpan = { at: number; from: number; fromEnd: boolean };
function readSpan(
  parts: number,
  start: number,
  stop: number,
  time: { fromEnd?: boolean } | undefined
): TReadSpan {
  const fromEnd = Boolean(time?.fromEnd);
  return {
    at: parts && !fromEnd ? start : stop,
    from: parts && fromEnd ? stop : start,
    fromEnd,
  };
}
function spanPartial(done: number, total: number, span: TReadSpan) {
  return {
    done,
    total,
    readUntil: span.at,
    ...(span.fromEnd ? { readFrom: span.from } : {}),
  };
}

/**
 * Stream a time-major result of `width` values per time step: parts are
 * read ahead and shown in time order, each update carrying only new rows.
 */
// eslint-disable-next-line max-lines-per-function
async function streamRows(
  parts: [number, number][],
  start: number,
  width: number,
  signal: AbortSignal | undefined,
  hooks: THooks,
  readPart: (part: [number, number], signal: AbortSignal) => Promise<unknown>,
  rows: (
    from: number,
    to: number
  ) => Omit<TPartialUpdate, "partial" | "offset">,
  base: (partial: TAnalysisResult["partial"]) => TAnalysisResult,
  readUntil: TReadSpan
) {
  let [sentFrom, sentUntil] = [readUntil.from, readUntil.at];
  announceParts(parts.length, readUntil, hooks, base);
  // One base per run (the announcement); later updates are deltas.
  let baseSent = parts.length > 0;
  await streamParts(
    parts.length,
    REGION_LOOKAHEAD,
    signal,
    (part, partSignal) => readPart(parts[part], partSignal),
    async (part, publish) => {
      if (readUntil.fromEnd) {
        readUntil.from = parts[part][0];
      } else {
        readUntil.at = parts[part][1];
      }
      if (part + 1 >= parts.length) {
        return;
      }
      if (publish) {
        const partial = spanPartial(part + 1, parts.length, readUntil);
        const [from, to] = readUntil.fromEnd
          ? [readUntil.from - start, sentFrom - start]
          : [sentUntil - start, readUntil.at - start];
        [sentFrom, sentUntil] = [readUntil.from, readUntil.at];
        const first = !baseSent;
        baseSent = true;
        hooks?.onPartial?.(
          first
            ? { ...frame(base, partial), counters: emptyCounters() }
            : {
                ...rows(from * width, to * width),
                offset: from * width,
                partial,
              }
        );
      }
      await hooks?.waitIfPaused?.(signal);
    },
    hooks?.publishEveryMs
  );
}

// ---------------------------------------------------------------- time–depth

/** Time × level at the cell containing a point. */
// eslint-disable-next-line max-lines-per-function
export async function planTimeDepth(
  context: TVariableContext,
  query: TAnalysisQuery,
  read: ReadContext,
  signal?: AbortSignal
): Promise<TPlannedAnalysis> {
  if (query.geometry.kind !== GEOMETRY_KINDS.POINT) {
    throw new AnalysisInputError("A time–depth plot needs a point.");
  }
  const vertical = context.vertical!;
  const counters = emptyCounters();
  const { start, stop } = timeRange(context, query);
  const located = await locatePoint(context, query.geometry, counters, signal);
  const nk = vertical.values.length;
  const nt = stop - start;
  const runs = selectionRuns(context, query);
  runs[context.time!.axis] = [[start, stop]];
  runs[vertical.axis] = [[0, nk]];
  if (located.positions.length) {
    setSpatialRuns(context, runs, located.positions);
  }
  // Physical levels from formula terms are used when they do not vary with
  // time; otherwise the axis is labelled as model levels.
  let termPlans =
    vertical.kind === VERTICAL_KINDS.FORMULA && located.positions.length
      ? await planFormulaTerms(context, query, [located.positions], start)
      : [];
  const timeVarying = termPlans.some((plan) =>
    plan.array.dimensionNames.includes(context.time!.dimension)
  );
  if (timeVarying) {
    termPlans = [];
  }
  const chunks =
    (located.positions.length
      ? countRunChunks(runs, context.array.chunks)
      : 0) + termChunks(termPlans);
  // Values per time step: a whole column shares each chunk's cost.
  const layout = layoutNote(context, chunks, nt);
  return {
    estimate: estimateFor(
      context,
      chunks,
      nt * nk,
      layout ? [layout] : [],
      0,
      termPlans
    ),
    // eslint-disable-next-line max-lines-per-function
    async execute(signal, hooks) {
      const started = performance.now();
      const values = new Array<number>(nt * nk).fill(Number.NaN);
      const parts = located.positions.length
        ? readingParts(context, start, stop, query.time?.fromEnd)
        : [];
      const timeAxis = context.time!.axis;
      const readUntil = readSpan(parts.length, start, stop, query.time);
      let levels: number[] | undefined;
      if (termPlans.length) {
        const terms = await readFormulaTerms(
          termPlans,
          nk,
          read,
          counters,
          signal
        );
        levels = Array.from(columnVertical(context, terms, located.positions));
      }
      const assemble = (partial?: TAnalysisResult["partial"]) => {
        counters.totalMs = performance.now() - started;
        const result = baseResult(context, query, { ...counters });
        const shownTo = (readUntil.at - start) * nk;
        const shownFrom = (readUntil.from - start) * nk;
        result.partial = partial;
        result.values = values.map((value, at) =>
          at < shownTo && at >= shownFrom ? value : Number.NaN
        );
        result.shape = [nt, nk];
        result.dims = [context.time!.dimension, vertical.dimension];
        result.time = timeOf(context, start, stop);
        result.vertical = verticalOf(context);
        if (levels) {
          result.vertical.values = levels;
        } else if (vertical.kind === VERTICAL_KINDS.FORMULA) {
          // No physical levels at this place and time range: the source's
          // own level coordinate, named as such, without physical units.
          result.vertical = {
            ...result.vertical,
            label: `${vertical.dimension} (model coordinate)`,
            units: undefined,
            physical: false,
            positive: undefined,
            values: vertical.values,
          };
        }
        result.axis = {
          dimension: vertical.dimension,
          label: result.vertical.label,
          units: result.vertical.units,
          values: result.vertical.values,
          reduction: "value of the containing cell",
        };
        result.cell = located.label;
        result.notes.push(
          ...[
            located.missing,
            vertical.note,
            timeVarying
              ? "The physical levels vary with time; they are shown as model levels."
              : undefined,
            layout,
          ].filter((n): n is string => Boolean(n))
        );
        return result;
      };
      await streamRows(
        parts,
        start,
        nk,
        signal,
        hooks,
        (part, partSignal) => {
          // The spatial runs as they are (their chunk directory is built
          // once for every part); only the time run is the part's own.
          const partRuns = runs.map((r, d) => (d === timeAxis ? [part] : r));
          return visitRuns(
            read,
            context.array,
            context.codec,
            partRuns,
            (_, index, value) => {
              values[(index[timeAxis] - start) * nk + index[vertical.axis]] =
                value;
            },
            counters,
            partSignal
          );
        },
        (from, to) => ({
          values: values.slice(from, to),
          counters: { ...counters },
        }),
        assemble,
        readUntil
      );
      return assemble();
    },
  };
}

// --------------------------------------------------------- band/sector means

type TBins = {
  /** Bin of each selected cell (by point) or by index. */
  binOf: (index: Float64Array, point: number) => number;
  weightOf: (index: Float64Array, point: number) => number;
  /** Bin centres (degrees, continuous from the west edge for longitude). */
  centres: number[];
  /** Bin edges, clipped to the box (one more than the centres). */
  edges: number[];
  /** Total area weight of each bin, stored or not. */
  binWeight: Float64Array;
  runs: TIndexRuns[];
  points?: TPointSelection;
  cells: number;
  weighting: string;
  /** Bytes the bins keep while the plot runs (index maps, selections). */
  retainedBytes?: number;
  /** Cells in the bands without a known area: left out of coverage. */
  unweighed?: number;
};

/**
 * Cells of the bands without a known area: left out, so each band's valid area
 * is of the cells with one.
 */
function unweighedText(bins: TBins) {
  const n = bins.unweighed ?? 0;
  return n
    ? `; ${count(n)} ${n === 1 ? "cell" : "cells"} without an area left out: valid area is of the cells with one`
    : "";
}

/**
 * The bins along a box's longitude (west to east, continuous across 180°)
 * or latitude: edges clipped to the box, so no bin lies beyond it. Checked
 * before anything is allocated.
 */
function bandLayout(
  box: TBox,
  along: "lon" | "lat",
  width: number,
  nt: number
) {
  const extent = along === "lon" ? boxSpan(box) : box.north - box.south;
  if (!(extent > 0)) {
    throw new AnalysisInputError(
      "The box has no width along this axis; draw a wider box or choose All longitudes."
    );
  }
  if (!(Number.isFinite(width) && width >= MIN_BIN_DEGREES)) {
    throw new AnalysisInputError(
      `A bin width must be at least ${MIN_BIN_DEGREES}°.`
    );
  }
  // A positive span, however narrow, is at least one bin.
  const nbins = Math.max(1, Math.ceil(extent / width - 1e-9));
  if (nbins > MAX_SPACE_BINS) {
    throw new AnalysisInputError(
      `${count(nbins)} bins of ${width}° across ${extent.toFixed(2)}°: plots use at most ${count(MAX_SPACE_BINS)}. Choose a wider bin.`
    );
  }
  if (nbins * nt > MAX_OUTPUT_CELLS) {
    throw tooManyValues(
      `${count(nbins)} bins × ${count(nt)} times is more than ${count(MAX_OUTPUT_CELLS)} values. Choose a wider bin or a shorter time range.`,
      nbins * nt,
      MAX_OUTPUT_CELLS,
      "bins"
    );
  }
  const origin = along === "lon" ? box.west : box.south;
  const edges = Array.from(
    { length: nbins + 1 },
    (_, i) => origin + Math.min(extent, i * width)
  );
  return {
    nbins,
    width,
    edges,
    centres: edges.slice(0, -1).map((e, i) => (e + edges[i + 1]) / 2),
    /** Bin of an offset from the box's west (or south) edge, or −1. */
    binOf: (offset: number) =>
      offset < 0 || offset > extent + 1e-9
        ? -1
        : Math.min(nbins - 1, Math.floor(offset / width)),
    offsetOf: (lat: number, lon: number) =>
      along === "lon" ? eastOf(box.west, lon) : lat - box.south,
  };
}

/**
 * The automatic bin width: about one grid spacing (in degrees of arc) at
 * the box, in degrees of longitude for longitude bins.
 */
function autoWidth(box: TBox, along: "lon" | "lat", spacingDegrees: number) {
  const mid = ((box.south + box.north) / 2) * (Math.PI / 180);
  const stretch = along === "lon" ? 1 / Math.max(0.05, Math.cos(mid)) : 1;
  return Math.max(
    MIN_BIN_DEGREES,
    Number((spacingDegrees * stretch).toPrecision(2))
  );
}

/**
 * Rectilinear band/sector bins: one per column (lon) or row (lat) by
 * default, or the columns (rows) grouped into bins of the chosen width.
 */
// eslint-disable-next-line max-lines-per-function
async function rectilinearBins(
  grid: TRectilinearContext,
  box: TBox,
  runs: TIndexRuns[],
  along: "lon" | "lat",
  binDegrees: number | undefined,
  nt: number,
  signal?: AbortSignal
): Promise<TBins> {
  // A full turn keeps its identity whatever its endpoints (170°..530°):
  // its width is never recomputed from rotated, rounded endpoints.
  const fullTurn = boxSpan(box) === 360;
  // Per-column bins of a full turn start on a true cell boundary; explicit
  // bins stay anchored at the requested west edge.
  const west =
    fullTurn && along === "lon" && binDegrees === undefined
      ? seamWest(grid.lon, box.west)
      : box.west;
  const span = fullTurn ? 360 : boxSpan(box);
  const rows = selectSorted(
    grid.lat.values,
    (v) => v >= box.south && v <= box.north,
    (v) => v
  );
  // A 360° copy of a column is the same column (counted once).
  const repeated = repeatedColumns(grid.lon);
  const cols = selectSorted(
    grid.lon.values,
    (v) => fullTurn || eastOf(west, v) <= span,
    (v) => eastOf(west, v)
  ).filter((j) => !repeated.has(j));
  const members = along === "lon" ? cols : rows;
  // Output admitted before any per-member structure is built.
  if (binDegrees === undefined && members.length * nt > MAX_OUTPUT_CELLS) {
    throw tooManyValues(
      `${count(members.length)} columns × ${count(nt)} times is more than ${count(MAX_OUTPUT_CELLS)} values. Choose a bin width or a shorter time range.`,
      members.length * nt,
      MAX_OUTPUT_CELLS,
      "columns"
    );
  }
  const frame = {
    along,
    west,
    south: box.south,
    origin: along === "lon" ? west : box.south,
    extent: along === "lon" ? span : box.north - box.south,
  };
  const axis = along === "lon" ? grid.lon : grid.lat;
  const intervals = memberIntervals(axis, members, frame);
  // Bins, weights and lookups only for the selected rows and columns: a
  // one-column band of a two-million-column grid allocates for one.
  const binOfMember = new Int32Array(members.length).fill(-1);
  const layout =
    binDegrees === undefined
      ? columnLayout(axis, members, intervals, frame, binOfMember)
      : explicitLayout(
          axis,
          members,
          intervals,
          frame,
          bandLayout(box, along, binDegrees, nt),
          fullTurn && along === "lon",
          binOfMember
        );
  const weights = await cellWeights(grid, rows, cols, signal);
  const binWeight = new Float64Array(layout.centres.length);
  // A bin's weight: its members' cells across the band. A row factor times a
  // column factor sums across once; declared 2-D areas are summed cell by cell,
  // yielding to the page and to Cancel every few milliseconds.
  const across = along === "lon" ? rows : cols;
  const separable = weights.separable;
  if (separable) {
    const factorAcross = along === "lon" ? separable.lat : separable.lon;
    const factorAlong = along === "lon" ? separable.lon : separable.lat;
    let sumAcross = 0;
    for (const other of across) {
      sumAcross += factorAcross(other);
    }
    binOfMember.forEach((bin, k) => {
      if (bin >= 0) {
        binWeight[bin] += factorAlong(members[k]) * sumAcross;
      }
    });
  }
  let unweighed = 0;
  if (!separable) {
    for (let k = 0; k < binOfMember.length; k++) {
      const bin = binOfMember[k];
      if (bin < 0) {
        continue;
      }
      for (const other of across) {
        const w =
          along === "lon"
            ? weights.at(other, members[k])
            : weights.at(members[k], other);
        binWeight[bin] += w;
        unweighed += weights.invalid && !(w > 0) ? 1 : 0;
      }
      await yieldIfBusy(signal);
    }
  }
  const binOf = indexTable(members, binOfMember);
  const binAxis = along === "lon" ? grid.lonAxis : grid.latAxis;
  runs[grid.latAxis] = runsOfSorted(Int32Array.from(rows).sort());
  runs[grid.lonAxis] = runsOfSorted(Int32Array.from(cols).sort());
  return {
    binOf: (index) => binOf.get(index[binAxis]) ?? -1,
    ...(unweighed ? { unweighed } : {}),
    weightOf: (index) => weights.at(index[grid.latAxis], index[grid.lonAxis]),
    centres: layout.centres,
    edges: layout.edges,
    binWeight,
    runs,
    cells: rows.length * cols.length,
    retainedBytes:
      (rows.length + cols.length) * 16 +
      binOf.bytes +
      (rows.length + cols.length) * 4 +
      2 * 24,
    weighting:
      binDegrees === undefined
        ? `${weightingLabel(grid)}, one bin per source column`
        : `${weightingLabel(grid)}, binned every ${binDegrees}° by centre`,
  };
}

type TBinFrame = {
  along: "lon" | "lat";
  west: number;
  south: number;
  /** West (or south) edge the offsets count from. */
  origin: number;
  extent: number;
};

/**
 * Indices passing `keep`, ordered by `key`: typed, and sized by the
 * selection (two passes over the axis), not by the axis.
 */
function selectSorted(
  values: ArrayLike<number>,
  keep: (value: number) => boolean,
  key: (value: number) => number
) {
  let n = 0;
  for (let at = 0; at < values.length; at++) {
    n += Number(keep(values[at]));
  }
  const picked = new Int32Array(n);
  for (let at = 0, k = 0; k < n; at++) {
    if (keep(values[at])) {
      picked[k++] = at;
    }
  }
  const keys = Float64Array.from(picked, (at) => key(values[at]));
  const order = Uint32Array.from(picked, (_, k) => k).sort(
    (a, b) => keys[a] - keys[b] || picked[a] - picked[b]
  );
  return Int32Array.from(order, (k) => picked[k]);
}

/**
 * Values at some axis indices (`values[k]` at `indices[k]`), looked up by
 * index: a window over their span, or a map when they are spread out (a
 * selection across the seam of a wide axis).
 */
function indexTable(indices: Int32Array, values: ArrayLike<number>) {
  let min = Infinity;
  let max = -Infinity;
  for (const at of indices) {
    min = Math.min(min, at);
    max = Math.max(max, at);
  }
  const n = indices.length;
  if (n && max - min + 1 <= 4 * n + 64) {
    const window = new Float64Array(max - min + 1).fill(Number.NaN);
    indices.forEach((at, k) => (window[at - min] = values[k]));
    return {
      get: (at: number) => {
        const v = window[at - min];
        return v === undefined || Number.isNaN(v) ? undefined : v;
      },
      bytes: window.byteLength,
    };
  }
  const map = new Map<number, number>();
  indices.forEach((at, k) => map.set(at, values[k]));
  return { get: (at: number) => map.get(at), bytes: n * 48 };
}

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

function offsetIn(axis: TRectilinearContext["lon"], at: number, f: TBinFrame) {
  return f.along === "lon"
    ? eastOf(f.west, axis.values[at])
    : axis.values[at] - f.south;
}

/**
 * Each member's own cell interval (published bounds, else halfway to its
 * neighbours) as offsets from the west/south edge, clipped to the extent:
 * two Float64 values per member.
 */
function memberIntervals(
  axis: TRectilinearContext["lon"],
  members: Int32Array,
  f: TBinFrame
) {
  const out = new Float64Array(2 * members.length);
  members.forEach((at, k) => {
    const centre = offsetIn(axis, at, f);
    let lo: number;
    let hi: number;
    if (axis.bounds) {
      [lo, hi] =
        f.along === "lon"
          ? lonInterval(axis, at).map((b) => centre + b - axis.values[at])
          : [axis.bounds[2 * at] - f.south, axis.bounds[2 * at + 1] - f.south];
    } else {
      lo =
        k > 0 ? (centre + offsetIn(axis, members[k - 1], f)) / 2 : Number.NaN;
      hi =
        k + 1 < members.length
          ? (centre + offsetIn(axis, members[k + 1], f)) / 2
          : Number.NaN;
    }
    if (lo > hi) {
      [lo, hi] = [hi, lo];
    }
    // Without bounds, an end cell reaches as far out as in.
    lo = Number.isNaN(lo) ? centre - (Number.isNaN(hi) ? 0 : hi - centre) : lo;
    hi = Number.isNaN(hi) ? centre + (centre - lo) : hi;
    out[2 * k] = Math.max(0, lo);
    out[2 * k + 1] = Math.min(f.extent, hi);
  });
  return out;
}

/**
 * One bin per source column (row) on its own cell interval; a gap between
 * cells is an empty bin, and nothing reaches past the data.
 */
function columnLayout(
  axis: TRectilinearContext["lon"],
  members: Int32Array,
  intervals: Float64Array,
  f: TBinFrame,
  binOfMember: Int32Array
) {
  const edges: number[] = [];
  const centres: number[] = [];
  members.forEach((at, k) => {
    const [lo, hi] = [intervals[2 * k], intervals[2 * k + 1]];
    const last = edges[edges.length - 1];
    if (!edges.length) {
      edges.push(lo);
    } else if (lo > last + 1e-9) {
      centres.push(f.origin + (last + lo) / 2); // a gap: no member
      edges.push(lo);
    }
    binOfMember[k] = centres.length;
    centres.push(f.origin + offsetIn(axis, at, f));
    edges.push(Math.max(hi, edges[edges.length - 1]));
  });
  return {
    centres,
    edges: edges.length
      ? edges.map((e) => f.origin + e)
      : [f.origin, f.origin + f.extent],
  };
}

/**
 * Bins of a given width from the requested edge. Bins past the data's
 * extent are dropped and the outer ones clipped to it, so no bin claims
 * area the grid does not cover; a full turn is periodic and keeps all of
 * them. With no member at all, the requested bins stay, empty.
 */

function explicitLayout(
  axis: TRectilinearContext["lon"],
  members: Int32Array,
  intervals: Float64Array,
  f: TBinFrame,
  bins: ReturnType<typeof bandLayout>,
  periodic: boolean,
  binOfMember: Int32Array
) {
  // Extent in one bounded pass (no argument spread over 150,000 rows).
  let lo = members.length && !periodic ? Infinity : 0;
  let hi = members.length && !periodic ? -Infinity : f.extent;
  if (!periodic) {
    for (let k = 0; k < members.length; k++) {
      lo = Math.min(lo, intervals[2 * k]);
      hi = Math.max(hi, intervals[2 * k + 1]);
    }
  }
  const offsets = bins.edges.map((e) => e - f.origin);
  let first = 0;
  while (first < bins.centres.length - 1 && offsets[first + 1] <= lo) {
    first++;
  }
  let end = bins.centres.length;
  while (end > first + 1 && offsets[end - 1] >= hi) {
    end--;
  }
  // A represented span narrower than float noise keeps a positive width.
  if (!(hi > lo)) {
    [lo, hi] = [offsets[first], offsets[end]];
  }
  const edges = offsets
    .slice(first, end + 1)
    .map(
      (e, k, all) =>
        f.origin +
        (k === 0 ? Math.max(e, lo) : k === all.length - 1 ? Math.min(e, hi) : e)
    );
  members.forEach((at, k) => {
    const bin = bins.binOf(offsetIn(axis, at, f)) - first;
    if (bin >= 0 && bin < end - first) {
      binOfMember[k] = bin;
    }
  });
  return {
    edges,
    centres: edges.slice(0, -1).map((e, k) => (e + edges[k + 1]) / 2),
  };
}

/**
 * Native band/sector bins: the cells whose centres are inside the box,
 * binned by centre longitude (or latitude) with their area weights.
 */
// eslint-disable-next-line max-lines-per-function
async function nativeBins(
  context: TVariableContext,
  box: TBox,
  runs: TIndexRuns[],
  along: "lon" | "lat",
  binDegrees: number | undefined,
  nt: number,
  counters: TWorkCounters,
  signal?: AbortSignal
): Promise<TBins> {
  const grid = context.grid as TNativeContext;
  if (!grid.weighting) {
    throw new AnalysisInputError(grid.noWeights ?? "No area weights.");
  }
  if (binDegrees !== undefined) {
    // A given width is checked before the geometry is loaded.
    bandLayout(box, along, binDegrees, nt);
  }
  const geometryStart = performance.now();
  const geometry = await grid.geometry(signal);
  const cells = await nativeMembers(
    geometry,
    { box },
    MAX_SELECTED_CELLS,
    signal
  );
  counters.geometryMs += performance.now() - geometryStart;
  if (cells.length > MAX_SELECTED_CELLS) {
    throw new AnalysisInputError(
      `The band holds more than ${count(MAX_SELECTED_CELLS)} cells; narrow it.`
    );
  }
  // Automatic width: the local spacing, from the cells inside the box.
  const mid = ((box.south + box.north) / 2) * (Math.PI / 180);
  const boxArea = boxSpan(box) * (box.north - box.south) * Math.cos(mid);
  const spacing = Math.sqrt(
    Math.max(boxArea, 1e-6) / Math.max(1, cells.length)
  );
  const layout = bandLayout(
    box,
    along,
    binDegrees ?? autoWidth(box, along, spacing),
    nt
  );
  // No cell inside: no area to read.
  const areas = cells.length
    ? await nativeAreas(grid, geometry, signal)
    : undefined;
  const rank = grid.axes.length;
  const positions = new Float64Array(cells.length * rank);
  const bins = new Int32Array(cells.length);
  const weights = new Float64Array(cells.length);
  const binWeight = new Float64Array(layout.nbins);
  let unweighed = 0;
  cells.forEach((cell, at) => {
    nativePositions(grid, cell).forEach(
      (p, k) => (positions[at * rank + k] = p)
    );
    const bin = layout.binOf(
      layout.offsetOf(geometry.lat[cell], geometry.lon[cell])
    );
    const w = areas?.[cell] ?? 0;
    bins[at] = bin;
    weights[at] = Number.isFinite(w) && w > 0 && bin >= 0 ? w : 0;
    unweighed += areas && bin >= 0 && !weights[at] ? 1 : 0;
    if (bin >= 0) {
      binWeight[bin] += weights[at];
    }
  });
  return {
    binOf: (_, point) => bins[point],
    ...(unweighed ? { unweighed } : {}),
    weightOf: (_, point) => weights[point],
    centres: layout.centres,
    edges: layout.edges,
    binWeight,
    runs,
    points: { dims: grid.axes, positions },
    cells: cells.length,
    weighting: `${grid.weighting}, binned every ${layout.width}° by centre`,
  };
}

const ID_BATCH = 65_536;

/**
 * HEALPix band/sector bins of a fixed width in degrees: cells whose centres
 * are inside the box are binned by centre longitude (or latitude); equal
 * areas, and cells absent from a packed source count in each bin's total.
 * Centres and stored positions are found in batches, yielding between.
 */
// eslint-disable-next-line max-lines-per-function
async function healpixBins(
  context: TVariableContext,
  box: TBox,
  runs: TIndexRuns[],
  along: "lon" | "lat",
  binDegrees: number | undefined,
  nt: number,
  counters: TWorkCounters,
  signal?: AbortSignal
): Promise<TBins> {
  const grid = context.grid;
  if (grid.kind !== ANALYSIS_GRID_KINDS.HEALPIX) {
    throw new Error("Not a HEALPix grid.");
  }
  // About one cell across: 58.6° / nside of arc.
  const layout = bandLayout(
    box,
    along,
    binDegrees ?? autoWidth(box, along, 58.6 / 2 ** grid.order),
    nt
  );
  const cover = await coverHealpixRegion(
    grid.grid,
    { kind: REGION_KINDS.BOX, box },
    { isCancelled: () => Boolean(signal?.aborted) }
  );
  if (cover.cellCount > BigInt(MAX_SELECTED_CELLS)) {
    throw new AnalysisInputError(
      `The band holds ${count(Number(cover.cellCount))} cells; this plot uses at most ${count(MAX_SELECTED_CELLS)}. Narrow it or choose a coarser order.`
    );
  }
  const binWeight = new Float64Array(layout.nbins);
  const stored: number[] = [];
  const storedBins: number[] = [];
  const batch: bigint[] = [];
  const flush = async () => {
    if (!batch.length) {
      return;
    }
    const centres = grid.grid.healpixToLonLat(BigUint64Array.from(batch));
    const before = grid.index.counters.chunkReads;
    const positions = await grid.index.positionsOf(batch, signal);
    counters.indexChunkReads += grid.index.counters.chunkReads - before;
    positions.forEach((position, at) => {
      const bin = layout.binOf(
        layout.offsetOf(centres[2 * at + 1], centres[2 * at])
      );
      if (bin < 0) {
        return;
      }
      binWeight[bin] += 1;
      if (position >= 0) {
        stored.push(position);
        storedBins.push(bin);
      }
    });
    batch.length = 0;
    await yieldIfBusy(signal);
  };
  for (const [from, to] of cover.ranges) {
    for (let id = from; id < to; id++) {
      batch.push(id);
      if (batch.length === ID_BATCH) {
        await flush();
      }
    }
  }
  await flush();
  return {
    binOf: (_, point) => storedBins[point],
    weightOf: () => 1,
    centres: layout.centres,
    edges: layout.edges,
    binWeight,
    runs,
    points: { dims: [grid.cellAxis], positions: Float64Array.from(stored) },
    cells: Number(cover.cellCount),
    weighting: `equal-area HEALPix cells at order ${grid.order}, binned every ${layout.width}° by centre`,
  };
}

/**
 * Hovmöller: at each time, the area-weighted mean of the cells in each
 * longitude bin across a latitude band (or each latitude bin across a
 * longitude sector), with the valid-area fraction of every mean.
 */
/** Horizontal cells in one stored chunk: the most bins it can touch. */
function spatialChunkCells(context: TVariableContext) {
  const { grid } = context;
  const axes =
    grid.kind === ANALYSIS_GRID_KINDS.HEALPIX
      ? [grid.cellAxis]
      : grid.kind === ANALYSIS_GRID_KINDS.RECTILINEAR
        ? [grid.latAxis, grid.lonAxis]
        : grid.kind === ANALYSIS_GRID_KINDS.NATIVE
          ? grid.axes
          : [];
  return axes.reduce(
    (product, axis) => product * context.array.chunks[axis],
    1
  );
}

/** Bins of a box along one axis, on any supported grid. */
function bandBins(
  context: TVariableContext,
  box: TBox,
  runs: TIndexRuns[],
  along: "lon" | "lat",
  binDegrees: number | undefined,
  rows: number,
  counters: TWorkCounters,
  signal?: AbortSignal
): Promise<TBins> | TBins {
  return context.grid.kind === ANALYSIS_GRID_KINDS.HEALPIX
    ? healpixBins(context, box, runs, along, binDegrees, rows, counters, signal)
    : context.grid.kind === ANALYSIS_GRID_KINDS.NATIVE
      ? nativeBins(
          context,
          box,
          runs,
          along,
          binDegrees,
          rows,
          counters,
          signal
        )
      : rectilinearBins(
          context.grid as TRectilinearContext,
          box,
          runs,
          along,
          binDegrees,
          rows,
          signal
        );
}

/**
 * Per-chunk sums over each chunk's own rows of one part (typed, two values
 * per time × bin), folded into `sum`/`weight` in chunk order so means are
 * deterministic whatever order chunks finish in.
 */
/**
 * One chunk's sums over only the bins it touches: one slot per touched bin
 * (in touch order) of `rows` pairs. Sites in distant bins cost one slot
 * each, never the span between them.
 */
type TSpanAcc = {
  from: number;
  rows: number;
  slotOf: Map<number, number>;
  bins: number[];
  sums: Float64Array;
};

function slotFor(acc: TSpanAcc, bin: number) {
  let slot = acc.slotOf.get(bin);
  if (slot === undefined) {
    slot = acc.bins.length;
    acc.slotOf.set(bin, slot);
    acc.bins.push(bin);
    const needed = acc.bins.length * acc.rows * 2;
    if (needed > acc.sums.length) {
      const grown = new Float64Array(Math.max(needed, acc.sums.length * 2));
      grown.set(acc.sums);
      acc.sums = grown;
    }
  }
  return slot;
}

function foldSpan(
  acc: TSpanAcc,
  into: {
    sum: Float64Array;
    weight: Float64Array;
    start: number;
    width: number;
  }
) {
  acc.bins.forEach((bin, slot) => {
    for (let r = 0; r < acc.rows; r++) {
      const at = (slot * acc.rows + r) * 2;
      const target = (acc.from - into.start + r) * into.width + bin;
      into.sum[target] += acc.sums[at];
      into.weight[target] += acc.sums[at + 1];
    }
  });
}

function accumulatorBytes(
  chunks: number,
  rows: number,
  width: number,
  context: TVariableContext
) {
  const touched = Math.min(width, spatialChunkCells(context));
  return (
    Math.min(chunks, REGION_LOOKAHEAD * JOBS_PER_BATCH) *
    (2 * rows * touched * 16 + touched * 64)
  );
}

// eslint-disable-next-line max-lines-per-function
export function chunkFolder(
  part: [number, number],
  chunkT: number,
  width: number,
  start: number,
  sum: Float64Array,
  weight: Float64Array
) {
  const [pending, finished] = [
    new Map<number, TSpanAcc>(),
    new Map<number, TSpanAcc | null>(),
  ];
  let next = 0;
  const accumulator = (ordinal: number, t: number) => {
    let acc = pending.get(ordinal);
    if (!acc) {
      const chunkStart = Math.floor(t / chunkT) * chunkT;
      const from = Math.max(part[0], chunkStart);
      const rows = Math.min(part[1], chunkStart + chunkT) - from;
      acc = {
        from,
        rows,
        slotOf: new Map(),
        bins: [],
        sums: new Float64Array(rows * 2),
      };
      pending.set(ordinal, acc);
    }
    return acc;
  };
  return {
    add(ordinal: number, t: number, bin: number, w: number, value: number) {
      const acc = accumulator(ordinal, t);
      const at = 2 * (slotFor(acc, bin) * acc.rows + (t - acc.from));
      acc.sums[at] += w * value;
      acc.sums[at + 1] += w;
    },
    /** Values held by unfolded accumulators (memory check). */
    liveValues() {
      let total = 0;
      for (const acc of [...pending.values(), ...finished.values()]) {
        total += acc?.sums.length ?? 0;
      }
      return total;
    },
    done(ordinal: number) {
      finished.set(ordinal, pending.get(ordinal) ?? null);
      pending.delete(ordinal);
      while (finished.has(next)) {
        const acc = finished.get(next);
        finished.delete(next);
        if (acc) {
          foldSpan(acc, { sum, weight, start, width });
        }
        next++;
      }
    },
  };
}

// eslint-disable-next-line max-lines-per-function
export async function planHovmollerBand(
  context: TVariableContext,
  query: TAnalysisQuery,
  read: ReadContext,
  signal?: AbortSignal
): Promise<TPlannedAnalysis> {
  if (query.geometry.kind !== GEOMETRY_KINDS.BOX) {
    throw new AnalysisInputError(
      "A Hovmöller diagram needs a box (band or sector)."
    );
  }
  const box = query.geometry;
  try {
    validateBox(box);
  } catch (error) {
    throw new AnalysisInputError((error as Error).message);
  }
  const along = query.kind === ANALYSIS_KINDS.HOVMOLLER_LAT ? "lat" : "lon";
  const counters = emptyCounters();
  const { start, stop } = timeRange(context, query);
  const nt = stop - start;
  const level = levelIndex(context, query);
  const runs = selectionRuns(context, query);
  runs[context.time!.axis] = [[start, stop]];
  if (level !== undefined) {
    runs[context.vertical!.axis] = [[level, level + 1]];
  }
  const bins = await bandBins(
    context,
    box,
    runs,
    along,
    query.binDegrees,
    nt,
    counters,
    signal
  );
  const width = bins.centres.length;
  const chunkT = context.array.chunks[context.time!.axis];
  const chunks = bins.cells
    ? countRunChunks(bins.runs, context.array.chunks, bins.points)
    : 0;
  const reduction =
    (along === "lon"
      ? `mean over ${lat(box.south)}–${lat(box.north)} at each longitude, ${bins.weighting}`
      : `mean over ${lon(box.west)}–${lon(box.east)} at each latitude, ${bins.weighting}`) +
    unweighedText(bins);
  return {
    estimate: estimateFor(
      context,
      chunks,
      nt * width * 2,
      [],
      // Live per-chunk accumulators (finished ones wait for their turn to
      // fold only within one batch): jobs per batch × their rows × the bins
      // one chunk can touch, capacity grown ×2, plus the slot index.
      accumulatorBytes(chunks, Math.min(chunkT, nt), width, context) +
        (bins.retainedBytes ?? 0) +
        runSelectionBytes(bins.runs) +
        (bins.points ? pointSelectionBytes(bins.points) : 0)
    ),
    // eslint-disable-next-line max-lines-per-function
    async execute(signal, hooks) {
      const started = performance.now();
      const timeAxis = context.time!.axis;
      const sum = new Float64Array(nt * width);
      const weight = new Float64Array(nt * width);
      const parts = bins.cells
        ? readingParts(context, start, stop, query.time?.fromEnd)
        : [];
      const readUntil = readSpan(parts.length, start, stop, query.time);
      const mean = (at: number) =>
        weight[at] > 0 ? sum[at] / weight[at] : Number.NaN;
      const cover = (at: number) => {
        const total = bins.binWeight[at % width];
        return total > 0 ? weight[at] / total : 0;
      };
      const assemble = (partial?: TAnalysisResult["partial"]) => {
        counters.totalMs = performance.now() - started;
        const shownTo = (readUntil.at - start) * width;
        const shownFrom = (readUntil.from - start) * width;
        const result = baseResult(context, query, { ...counters });
        result.partial = partial;
        result.values = Array.from({ length: nt * width }, (_, at) =>
          at < shownTo && at >= shownFrom ? mean(at) : Number.NaN
        );
        result.cellCoverage = Array.from({ length: nt * width }, (_, at) =>
          at < shownTo && at >= shownFrom ? cover(at) : Number.NaN
        );
        result.shape = [nt, width];
        result.dims = [
          context.time!.dimension,
          along === "lon" ? "longitude" : "latitude",
        ];
        result.time = timeOf(context, start, stop);
        result.axis = {
          dimension: along === "lon" ? "longitude" : "latitude",
          label: along === "lon" ? "Longitude" : "Latitude",
          units: along === "lon" ? "degrees_east" : "degrees_north",
          values: bins.centres,
          bounds: bins.edges,
          reduction,
        };
        if (level !== undefined) {
          result.notes.push(levelNote(context, level));
        }
        if (!bins.cells) {
          result.notes.push("No cell centre lies inside this band.");
        }
        return result;
      };
      await streamRows(
        parts,
        start,
        width,
        signal,
        hooks,
        async (part, partSignal) => {
          const fold = chunkFolder(part, chunkT, width, start, sum, weight);
          // The spatial runs as they are (their chunk directory is built
          // once for every part); only the time run is the part's own.
          const partRuns = bins.runs.map((r, d) =>
            d === timeAxis ? [part] : r
          );
          await visitRuns(
            read,
            context.array,
            context.codec,
            partRuns,
            (ordinal, index, value, point) => {
              const bin = bins.binOf(index, point);
              if (Number.isNaN(value) || bin < 0) {
                return;
              }
              const w = bins.weightOf(index, point);
              fold.add(ordinal, index[timeAxis], bin, w, value);
            },
            counters,
            partSignal,
            fold.done,
            bins.points
          );
        },
        (from, to) => ({
          values: Array.from({ length: to - from }, (_, k) => mean(from + k)),
          cellCoverage: Array.from({ length: to - from }, (_, k) =>
            cover(from + k)
          ),
          counters: { ...counters },
        }),
        assemble,
        readUntil
      );
      return assemble();
    },
  };
}

// ------------------------------------------------------- distance × time

/** Hovmöller along a path: at each time, the value of each sample's cell. */
// eslint-disable-next-line max-lines-per-function
export async function planHovmollerPath(
  context: TVariableContext,
  query: TAnalysisQuery,
  read: ReadContext,
  signal?: AbortSignal
): Promise<TPlannedAnalysis> {
  const counters = emptyCounters();
  const columns = await preparedSectionColumns(
    context,
    query,
    counters,
    signal
  );
  const { start, stop } = timeRange(context, query);
  const level = levelIndex(context, query);
  const nt = stop - start;
  const ns = columns.points.length;
  const samplesOf = new Map<string, number[]>();
  const unique = new Map<string, number[]>();
  columns.keys.forEach((key, s) => {
    if (key) {
      const k = columnKey(key);
      unique.set(k, key);
      // Appended in place: linear in samples however many share one cell.
      const list = samplesOf.get(k);
      if (list) {
        list.push(s);
      } else {
        samplesOf.set(k, [s]);
      }
    }
  });
  const base = selectionRuns(context, query);
  base[context.time!.axis] = [[start, stop]];
  if (level !== undefined) {
    base[context.vertical!.axis] = [[level, level + 1]];
  }
  const selection = sectionSelection(context, unique, base);
  const chunks = selection
    ? countRunChunks(selection.runs, context.array.chunks, selection.points)
    : 0;
  return {
    estimate: estimateFor(context, chunks, nt * ns, []),
    // eslint-disable-next-line max-lines-per-function
    async execute(signal, hooks) {
      const started = performance.now();
      const timeAxis = context.time!.axis;
      const values = new Array<number>(nt * ns).fill(Number.NaN);
      const parts = selection
        ? readingParts(context, start, stop, query.time?.fromEnd)
        : [];
      const readUntil = readSpan(parts.length, start, stop, query.time);
      const status: TSampleStatus[] = columns.keys.map((key) =>
        key ? SAMPLE_STATUS.OK : SAMPLE_STATUS.OUTSIDE
      );
      const assemble = (partial?: TAnalysisResult["partial"]) => {
        counters.totalMs = performance.now() - started;
        const shownTo = (readUntil.at - start) * ns;
        const shownFrom = (readUntil.from - start) * ns;
        const result = baseResult(context, query, { ...counters });
        result.partial = partial;
        result.values = values.map((value, at) =>
          at < shownTo && at >= shownFrom ? value : Number.NaN
        );
        result.shape = [nt, ns];
        result.dims = [context.time!.dimension, "sample"];
        result.time = timeOf(context, start, stop);
        result.axis = {
          dimension: "sample",
          label: "Distance along path",
          units: "m",
          values: columns.points.map((p) => p.distance),
          reduction: `${sampleMethod(context)} at each sample`,
        };
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
        if (level !== undefined) {
          result.notes.push(levelNote(context, level));
        }
        return result;
      };
      await streamRows(
        parts,
        start,
        ns,
        signal,
        hooks,
        (part, partSignal) => {
          // The spatial runs as they are (their chunk directory is built
          // once for every part); only the time run is the part's own.
          const partRuns = selection!.runs.map((r, d) =>
            d === timeAxis ? [part] : r
          );
          return visitRuns(
            read,
            context.array,
            context.codec,
            partRuns,
            (_, index, value) => {
              const row = (index[timeAxis] - start) * ns;
              for (const s of samplesOf.get(sampleColumnKey(context, index)) ??
                []) {
                values[row + s] = value;
              }
            },
            counters,
            partSignal,
            undefined,
            selection!.points
          );
        },
        (from, to) => ({
          values: values.slice(from, to),
          counters: { ...counters },
        }),
        assemble,
        readUntil
      );
      return assemble();
    },
  };
}

// ------------------------------------------------------------ distribution

/**
 * Value-bin edges for [low, high]: round steps where they are representable,
 * otherwise even steps; always strictly increasing, at most `bins` bins,
 * built by a bounded integer index (no floating loop that can stall), with
 * `high` inside the last bin. A constant field gets one narrow bin.
 */
// eslint-disable-next-line max-lines-per-function
export function binEdges(low: number, high: number, bins: number) {
  const n = Math.min(MAX_VALUE_BINS, Math.max(1, Math.floor(bins) || 1));
  if (!Number.isFinite(low) || !Number.isFinite(high)) {
    return [0, 1];
  }
  if (!(high > low)) {
    const pad = low === 0 ? 0.5 : Math.abs(low) * 1e-6;
    const a = low - pad;
    const b = low + pad;
    // Finite edges even at ±Number.MAX_VALUE (the last bin is closed).
    if (!Number.isFinite(b)) {
      return [a, low];
    }
    if (!Number.isFinite(a)) {
      return [low, b];
    }
    return a < low && b > low ? [a, b] : [low, low + Math.abs(low) || 1];
  }
  const strictly = (edges: number[]) => {
    const out: number[] = [];
    for (const edge of edges) {
      if (!out.length || edge > out[out.length - 1]) {
        out.push(edge);
      }
    }
    if (out[out.length - 1] < high) {
      out.push(high);
    }
    return out.length >= 2 ? out : [low, high];
  };
  // Divided first, so ±Number.MAX_VALUE does not overflow.
  const raw = high / n - low / n;
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10]
    .map((m) => m * magnitude)
    .find((m) => m >= raw);
  if (step && Number.isFinite(step)) {
    const first = Math.floor(low / step) * step;
    const count = Math.min(n + 2, Math.ceil((high - first) / step) + 1);
    const nice: number[] = [];
    for (let i = 0; i <= count; i++) {
      const edge = Number((first + i * step).toPrecision(15));
      nice.push(edge);
      if (edge > high) {
        break;
      }
    }
    // Round steps hold only where they stay distinct and cover the range.
    const distinct = nice.every((e, i) => i === 0 || e > nice[i - 1]);
    // At most the requested bins; the last bin is closed, so a last edge
    // equal to the maximum keeps it inside.
    if (
      distinct &&
      nice.every(Number.isFinite) &&
      nice[0] <= low &&
      nice[nice.length - 1] >= high &&
      nice.length - 1 <= n
    ) {
      return strictly(nice);
    }
  }
  // Even steps; coincident edges (a spread of a few ulps) are collapsed.
  return strictly(
    // Weighted ends: finite even across ±Number.MAX_VALUE.
    Array.from({ length: n + 1 }, (_, i) =>
      i === n ? high : low * (1 - i / n) + high * (i / n)
    )
  );
}

/** The bin of a value: the last edge at or below it, clamped to the bins. */
export function binOfValue(edges: number[], value: number) {
  let lo = 0;
  let hi = edges.length - 2;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (edges[mid] <= value) {
      lo = mid;
    } else {
      hi = mid - 1;
    }
  }
  return lo;
}

/** A distribution maps its cells when the area holds at most this many. */
const MAX_FIELD_CELLS = 60_000;

/**
 * The area-weighted distribution of a field over a region at one time and
 * level: the share of valid area in each value bin, with the mean and the
 * valid fraction of the region reported alongside.
 */
// eslint-disable-next-line max-lines-per-function
export async function planDistribution(
  context: TVariableContext,
  query: TAnalysisQuery,
  read: ReadContext,
  signal?: AbortSignal
): Promise<TPlannedAnalysis> {
  const counters = emptyCounters();
  const level = levelIndex(context, query);
  const runs = selectionRuns(context, query);
  const timeIndex = stepOf(context, query);
  if (context.time) {
    if (!(timeIndex! >= 0 && timeIndex! < context.time.raw.length)) {
      throw new AnalysisInputError(
        `Time index ${timeIndex} is outside the time axis.`
      );
    }
    runs[context.time.axis] = [[timeIndex!, timeIndex! + 1]];
  }
  if (level !== undefined) {
    runs[context.vertical!.axis] = [[level, level + 1]];
  }
  const selection: TRegionSelection = await queryRegionSelection(
    context,
    query.geometry,
    runs,
    counters,
    signal
  );
  if (selection.storedCells > MAX_SELECTED_CELLS) {
    throw new AnalysisInputError(
      `The region holds ${count(selection.storedCells)} cells; a distribution uses at most ${count(MAX_SELECTED_CELLS)}. Choose a smaller region or a coarser order.`
    );
  }
  const chunks =
    selection.totalCells === 0n
      ? 0
      : countRunChunks(selection.runs, context.array.chunks, selection.points);
  const nbins = Math.min(MAX_VALUE_BINS, Math.max(2, query.valueBins ?? 30));
  const empty = emptyRegionNote(query.geometry, selection);
  return {
    estimate: estimateFor(
      context,
      chunks,
      nbins,
      empty ? [empty] : [],
      selection.storedCells * 16 + runSelectionBytes(selection.runs)
    ),
    // eslint-disable-next-line max-lines-per-function
    async execute(signal) {
      const started = performance.now();
      const values = new Float64Array(selection.storedCells);
      const weights = new Float64Array(selection.storedCells);
      let n = 0;
      // The cells themselves, for a map of the area (small areas only).
      const mapped =
        selection.positionOf && selection.storedCells <= MAX_FIELD_CELLS
          ? { lat: [] as number[], lon: [] as number[], values: [] as number[] }
          : undefined;
      if (selection.storedCells > 0) {
        await visitRuns(
          read,
          context.array,
          context.codec,
          selection.runs,
          (_, index, value, point) => {
            if (mapped) {
              const [lat, lon] = selection.positionOf!(index, point);
              mapped.lat.push(lat);
              mapped.lon.push(lon);
              mapped.values.push(value);
            }
            // Only cells with an area count: a zero-area (or undefined)
            // cell neither stretches the range nor counts as valid.
            const weight = selection.weightOf(index, point);
            if (
              !Number.isNaN(value) &&
              Number.isFinite(weight) &&
              weight > 0 &&
              n < values.length
            ) {
              values[n] = value;
              weights[n] = weight;
              n++;
            }
          },
          counters,
          signal,
          undefined,
          selection.points
        );
      }
      let low = Number.POSITIVE_INFINITY;
      let high = Number.NEGATIVE_INFINITY;
      for (let at = 0; at < n; at++) {
        low = Math.min(low, values[at]);
        high = Math.max(high, values[at]);
      }
      // The mean of values scaled by their magnitude: finite near ±1e308.
      const scale = Math.max(Math.abs(low), Math.abs(high)) || 1;
      let validWeight = 0;
      let weighted = 0;
      for (let at = 0; at < n; at++) {
        validWeight += weights[at];
        weighted += weights[at] * (values[at] / scale);
      }
      const edges = n ? binEdges(low, high, nbins) : [0, 1];
      const shares = new Array<number>(edges.length - 1).fill(0);
      for (let at = 0; at < n; at++) {
        shares[binOfValue(edges, values[at])] += weights[at];
      }
      // Percentiles and the curve are part of the work: cancellable
      // before they start, and in the reported time.
      signal?.throwIfAborted();
      const summary = await distributionSummaryAsync(
        values,
        weights,
        n,
        low,
        high,
        signal
      );
      counters.totalMs = performance.now() - started;
      const result = baseResult(context, query, counters);
      result.values = shares.map((w) =>
        validWeight > 0 ? w / validWeight : Number.NaN
      );
      result.shape = [shares.length];
      result.dims = ["value_bin"];
      if (context.time) {
        result.time = timeOf(context, timeIndex!, timeIndex! + 1);
      }
      if (mapped) {
        result.field = mapped;
      }
      result.histogram = {
        edges,
        validFraction:
          selection.totalWeight > 0 ? validWeight / selection.totalWeight : 0,
        validCells: n,
        selectedCells: Number(selection.totalCells),
        mean: validWeight > 0 ? (weighted / validWeight) * scale : Number.NaN,
        weighting: selection.weighting,
        // Cells without an area are not in the denominator: said so.
        ...(selection.unweighed ? { unweighedCells: selection.unweighed } : {}),
        ...(n && low === high ? { constant: low } : {}),
      };
      if (summary) {
        result.histogram.summary = summary;
      }
      if (level !== undefined) {
        result.notes.push(levelNote(context, level));
      }
      if (!n) {
        result.notes.push(
          empty ?? "No valid value lies inside this region at this time."
        );
      }
      return result;
    },
  };
}

/**
 * Latitude × vertical section at one time: the mean over a longitude
 * sector at each latitude bin and level (area-weighted, as the Hovmöller
 * latitude × time). Vertical coordinates from formula terms vary by column,
 * so those axes are shown as model levels.
 */
export function planLatVertical(
  context: TVariableContext,
  query: TAnalysisQuery,
  read: ReadContext,
  signal?: AbortSignal
): Promise<TPlannedAnalysis> {
  return planBandVertical(context, query, read, signal, "lat");
}

/**
 * Longitude × vertical section at one time: the mean over a latitude band
 * at each longitude bin and level (the equatorial thermocline's tilt, a
 * Walker circulation), as the latitude section with the axes swapped.
 */
export function planLonVertical(
  context: TVariableContext,
  query: TAnalysisQuery,
  read: ReadContext,
  signal?: AbortSignal
): Promise<TPlannedAnalysis> {
  return planBandVertical(context, query, read, signal, "lon");
}

/** A section binned along latitude or longitude, the other averaged. */
// eslint-disable-next-line max-lines-per-function
async function planBandVertical(
  context: TVariableContext,
  query: TAnalysisQuery,
  read: ReadContext,
  signal: AbortSignal | undefined,
  along: "lat" | "lon"
): Promise<TPlannedAnalysis> {
  if (query.geometry.kind !== GEOMETRY_KINDS.BOX) {
    throw new AnalysisInputError(
      along === "lat"
        ? "A latitude–pressure section needs a box: its longitudes are averaged."
        : "A longitude–depth section needs a box: its latitudes are averaged."
    );
  }
  const vertical = context.vertical;
  if (!vertical) {
    throw new AnalysisInputError("The variable has no vertical dimension.");
  }
  const box = query.geometry;
  try {
    validateBox(box);
  } catch (error) {
    throw new AnalysisInputError((error as Error).message);
  }
  const counters = emptyCounters();
  const nk = context.array.shape[vertical.axis];
  const runs = selectionRuns(context, query);
  const time = context.time;
  const t = time ? timeRange(context, query).start : undefined;
  if (time && t !== undefined) {
    runs[time.axis] = [[t, t + 1]];
  }
  runs[vertical.axis] = [[0, nk]];
  const bins = await bandBins(
    context,
    box,
    runs,
    along,
    query.binDegrees,
    nk,
    counters,
    signal
  );
  const width = bins.centres.length;
  const chunkK = context.array.chunks[vertical.axis];
  const chunks = bins.cells
    ? countRunChunks(bins.runs, context.array.chunks, bins.points)
    : 0;
  const reduction =
    (along === "lat"
      ? `mean over ${lon(box.west)}–${lon(box.east)} at each latitude and level, ${bins.weighting}`
      : `mean over ${lat(box.south)}–${lat(box.north)} at each longitude and level, ${bins.weighting}`) +
    unweighedText(bins);
  return {
    estimate: estimateFor(
      context,
      chunks,
      nk * width * 2,
      [],
      accumulatorBytes(chunks, Math.min(chunkK, nk), width, context) +
        (bins.retainedBytes ?? 0) +
        runSelectionBytes(bins.runs) +
        (bins.points ? pointSelectionBytes(bins.points) : 0)
    ),
    async execute(execSignal) {
      const started = performance.now();
      // Rows are levels: sums per (level, latitude bin), folded per chunk in
      // chunk order so the means do not depend on completion order.
      const sum = new Float64Array(nk * width);
      const weight = new Float64Array(nk * width);
      if (bins.cells) {
        const fold = chunkFolder([0, nk], chunkK, width, 0, sum, weight);
        await visitRuns(
          read,
          context.array,
          context.codec,
          bins.runs,
          (ordinal, index, value, point) => {
            const bin = bins.binOf(index, point);
            if (Number.isNaN(value) || bin < 0) {
              return;
            }
            fold.add(
              ordinal,
              index[vertical.axis],
              bin,
              bins.weightOf(index, point),
              value
            );
          },
          counters,
          execSignal,
          fold.done,
          bins.points
        );
      }
      counters.totalMs = performance.now() - started;
      return latitudeVerticalResult(context, query, counters, {
        sum,
        weight,
        bins,
        nk,
        t,
        reduction,
        along,
      });
    },
  };
}

/**
 * The vertical axis of a section over many columns: formula coordinates
 * differ by column, so they are shown as model levels (no Pa or m).
 */
function sectionVertical(context: TVariableContext) {
  const vertical = context.vertical!;
  const v = verticalOf(context);
  return vertical.kind === VERTICAL_KINDS.FORMULA
    ? {
        ...v,
        label: `${vertical.dimension} (model coordinate)`,
        units: undefined,
        physical: false,
        positive: undefined,
        values: vertical.values,
      }
    : v;
}

/** The result of a latitude × vertical section from its sums. */
// eslint-disable-next-line max-lines-per-function
function latitudeVerticalResult(
  context: TVariableContext,
  query: TAnalysisQuery,
  counters: TWorkCounters,
  parts: {
    sum: Float64Array;
    weight: Float64Array;
    bins: TBins;
    nk: number;
    t: number | undefined;
    reduction: string;
    along: "lat" | "lon";
  }
) {
  const { sum, weight, bins, nk, t, reduction, along } = parts;
  const axisName = along === "lat" ? "latitude" : "longitude";
  const vertical = context.vertical!;
  const time = context.time;
  const width = bins.centres.length;
  const result = baseResult(context, query, { ...counters });
  // Values latitude-major, a level column per bin: [bin][level]; sums are
  // stored level-major.
  const at = (i: number) => (i % nk) * width + Math.floor(i / nk);
  result.values = Array.from({ length: width * nk }, (_, i) =>
    weight[at(i)] > 0 ? sum[at(i)] / weight[at(i)] : Number.NaN
  );
  result.cellCoverage = Array.from({ length: width * nk }, (_, i) => {
    const total = bins.binWeight[Math.floor(i / nk)];
    return total > 0 ? weight[at(i)] / total : 0;
  });
  result.shape = [width, nk];
  result.dims = [axisName, vertical.dimension];
  if (time && t !== undefined) {
    result.time = timeOf(context, t, t + 1);
  }
  result.vertical = sectionVertical(context);
  if (vertical.kind === VERTICAL_KINDS.FORMULA) {
    result.notes.push(
      "The vertical formula gives each column its own pressure or height; this section shows model levels."
    );
  }
  result.axis = {
    dimension: axisName,
    label: along === "lat" ? "Latitude" : "Longitude",
    units: along === "lat" ? "degrees_north" : "degrees_east",
    values: bins.centres,
    bounds: bins.edges,
    reduction,
  };
  if (!bins.cells) {
    result.notes.push(
      `No cell centre lies inside this ${along === "lat" ? "sector" : "band"}.`
    );
  }
  return result;
}
