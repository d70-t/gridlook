/**
 * The two components of a vector over an area, counted on the same cells.
 * Pairing stored positions would change with the storage: components in two
 * stores would not join, another chunking or memory order would pair other
 * cells, a chunk never written (its fill a value) would escape the mask, and
 * two grids of equal shape but other longitudes would pair by position. So
 * the cells are matched by their logical index, each component
 * read with its own chunking, order and fill, and only when both name the same
 * cells, times and level; otherwise no vector is computed.
 */
import { dayNumberOfDate, parseTimeAxis, sameDuration } from "./calendar.ts";
import type { TCellAreas } from "./cellAreas.ts";
import { CELL_INDEX_KINDS } from "./cellIndex.ts";
import { timeCellMethod, vectorMethodProblem } from "./cellMethods.ts";
import {
  chunkByteSize,
  type ReadContext,
  type TAnalysisArray,
  type TIndexRuns,
  type TPointSelection,
  type TStoredChunk,
  throwIfAborted,
} from "./chunkVisitor.ts";
import {
  matchMode,
  observationKeys,
  clockBoundsUnread,
  overCells,
  physicalClock,
  withCycles,
  unknownCell,
} from "./companionAlign.ts";
import { nativeAreas, readAllShared, sameCellOutlines } from "./nativeGrid.ts";
import type { TWorkCounters } from "./types.ts";
import {
  decodeStoredBigInt,
  decodeStoredValue,
  type TValueCodec,
} from "./valueDecoding.ts";
import {
  ANALYSIS_GRID_KINDS,
  type TVariableContext,
} from "./variableContext.ts";

/** Longitudes, latitudes and times this close are the same (degrees, raw). */
const SAME = 1e-9;

/**
 * Equal values to SAME relative to each (radii, areas); degrees (`periodic`
 * longitudes, latitudes through `degrees`) to SAME degrees wherever they are: a
 * relative test let a grid shifted 1e-7° pass at 179.99° that it refused at 0°.
 */
function sameValues(
  a: ArrayLike<number> | undefined,
  b: ArrayLike<number> | undefined,
  periodic = false,
  degrees = periodic
) {
  if (!a || !b) {
    return a === b;
  }
  if (a.length !== b.length) {
    return false;
  }
  for (let at = 0; at < a.length; at++) {
    let d = a[at] - b[at];
    if (periodic) {
      d -= 360 * Math.round(d / 360);
    }
    const both = Number.isNaN(a[at]) && Number.isNaN(b[at]);
    const scale = degrees ? 1 : Math.max(1, Math.abs(a[at]));
    if (!both && !(Math.abs(d) <= SAME * scale)) {
      return false;
    }
  }
  return true;
}

/**
 * Whether two declared cell measures weigh alike: the same measure of the
 * same store, or none on either (then both weigh by their cells' areas).
 */
async function sameWeights(
  a: TCellAreas | undefined,
  b: TCellAreas | undefined,
  signal?: AbortSignal
) {
  if (!a || !b) {
    return a === b;
  }
  // One array read through one dataset: by its resolved key, not its name.
  if (sameMeasure(a, b)) {
    return true;
  }
  const known = verdicts.get(a.array)?.get(b.array);
  if (known !== undefined) {
    return known;
  }
  const same = await compareWeights(a, b, signal);
  const mine =
    verdicts.get(a.array) ?? verdicts.set(a.array, new WeakMap()).get(a.array)!;
  mine.set(b.array, same);
  return same;
}

/** The same measure array of the same dataset. */
function sameMeasure(a: TCellAreas, b: TCellAreas) {
  return a.array.key === b.array.key && a.dataset.key === b.dataset.key;
}

/**
 * Whether two weightings are one: each cell's share of the whole equal to a
 * relative 1e-9, where both are weights (a weighted mean depends only on the
 * shares). In any units: km² beside m², or 1e-10 km² cells, decide alike.
 */
function sameShares(
  x: ArrayLike<number> | undefined,
  y: ArrayLike<number> | undefined
) {
  if (!x || !y || x.length !== y.length) {
    return x === y;
  }
  const total = (w: ArrayLike<number>) => {
    let sum = 0;
    for (let k = 0; k < w.length; k++) {
      sum += Number.isFinite(w[k]) && w[k] > 0 ? w[k] : 0;
    }
    return sum;
  };
  const [sx, sy] = [total(x), total(y)];
  if (!(sx > 0) || !(sy > 0)) {
    return sx === sy;
  }
  for (let k = 0; k < x.length; k++) {
    const [p, q] = [
      Number.isFinite(x[k]) && x[k] > 0 ? x[k] / sx : 0,
      Number.isFinite(y[k]) && y[k] > 0 ? y[k] / sy : 0,
    ];
    if (Math.abs(p - q) > 1e-9 * Math.max(p, q)) {
      return false;
    }
  }
  return true;
}

/** Two measures' comparison, once per pair of arrays as opened. */
const verdicts = new WeakMap<object, WeakMap<object, boolean>>();

/** Whether two measures' values would be compared whole (else unlike). */
function comparable(a: TCellAreas, b: TCellAreas) {
  return (
    a.dims.join() === b.dims.join() &&
    // Stored in another order, the same values are other cells' weights.
    a.array.dimensionNames.join() === b.array.dimensionNames.join() &&
    a.array.shape.join() === b.array.shape.join() &&
    sizeOf(a) <= MAX_COMPARED_AREAS &&
    chunksOf(a) <= 64 &&
    chunksOf(b) <= 64
  );
}
const sizeOf = (x: TCellAreas) => x.array.shape.reduce((p, n) => p * n, 1);
const chunksOf = (x: TCellAreas) =>
  x.array.shape.reduce(
    (p, n, d) => p * Math.ceil(n / Math.max(1, x.array.chunks[d])),
    1
  );

/**
 * What comparing two components' declared areas reads, before it is read: every
 * chunk of both, and the largest one decoded.
 */
export function weightComparisonCost(
  a: TCellAreas | undefined,
  b: TCellAreas | undefined
) {
  if (
    !a ||
    !b ||
    sameMeasure(a, b) ||
    verdicts.get(a.array)?.has(b.array) ||
    !comparable(a, b)
  ) {
    return { reads: 0, bytes: 0, largest: 0 };
  }
  return {
    reads: chunksOf(a) + chunksOf(b),
    bytes:
      chunksOf(a) * chunkByteSize(a.array) +
      chunksOf(b) * chunkByteSize(b.array),
    largest: Math.max(chunkByteSize(a.array), chunkByteSize(b.array)),
  };
}

async function compareWeights(
  a: TCellAreas,
  b: TCellAreas,
  signal?: AbortSignal
) {
  // Another measure, or the same name in another store: the same weights only
  // if their values are. Compared whole, within a bound; past it, not assumed.
  if (!comparable(a, b)) {
    return false;
  }
  // One after the other: both whole arrays are not held at once beside their
  // decoding.
  const x = await readAllShared(a.dataset, a.array, signal);
  const y = await readAllShared(b.dataset, b.array, signal);
  return sameShares(x, y);
}

/** The most cells of two area measures compared value by value. */
const MAX_COMPARED_AREAS = 2 ** 20;

/** Why the two fields are not on the same cells ("" when they are). */
// eslint-disable-next-line max-lines-per-function
async function cellsProblem(
  own: TVariableContext,
  other: TVariableContext,
  signal?: AbortSignal
) {
  const [a, b] = [own.grid, other.grid];
  if (a.kind !== b.kind) {
    return "they are on different kinds of grid";
  }
  switch (a.kind) {
    case ANALYSIS_GRID_KINDS.RECTILINEAR: {
      const c = b as typeof a;
      // Their cells, not only their centres: the same centres with other edges
      // are other footprints; and weighed alike.
      if (
        a.latAxis !== c.latAxis ||
        a.lonAxis !== c.lonAxis ||
        !sameValues(a.lat.values, c.lat.values, false, true) ||
        !sameValues(a.lon.values, c.lon.values, true)
      ) {
        return "their latitudes or longitudes differ";
      }
      if (
        !sameValues(a.lat.bounds, c.lat.bounds, false, true) ||
        !sameValues(a.lon.bounds, c.lon.bounds, true)
      ) {
        return "their cells have other edges";
      }
      return (await sameWeights(a.areas, c.areas, signal))
        ? ""
        : "their cells weigh differently";
    }
    case ANALYSIS_GRID_KINDS.HEALPIX: {
      const c = b as typeof a;
      const sameLayout =
        a.order === c.order &&
        a.layout === c.layout &&
        a.cellAxis === c.cellAxis &&
        a.index.length === c.index.length &&
        JSON.stringify(a.frame.options) === JSON.stringify(c.frame.options);
      // Cells stored in id order need no comparison; others the same
      // stored cell coordinate.
      const sameIds =
        a.index.kind === CELL_INDEX_KINDS.DENSE &&
        c.index.kind === CELL_INDEX_KINDS.DENSE
          ? true
          : a.regionKey === c.regionKey;
      return sameLayout && sameIds ? "" : "their HEALPix cells differ";
    }
    case ANALYSIS_GRID_KINDS.NATIVE: {
      const c = b as typeof a;
      // The same coordinate arrays of the same store: the same cells.
      if (a.regionKey && a.regionKey === c.regionKey) {
        return "";
      }
      // Two stores: the same cells when their centres, outlines' extent and
      // weights are the same.
      const [x, y] = await Promise.all([
        a.geometry(signal),
        c.geometry(signal),
      ]);
      if (!(
        x.count === y.count &&
        sameValues(x.lat, y.lat, false, true) &&
        sameValues(x.lon, y.lon, true) &&
        sameValues(x.radii, y.radii) &&
        sameCellOutlines(x, y)
      )) {
        return "they do not use the same cell coordinates";
      }
      // The weights each reduction uses: a declared measure where there is one,
      // not the outlines' areas.
      const wa = await nativeAreas(a, x, signal);
      const wb = await nativeAreas(c, y, signal);
      return sameShares(wa, wb) ? "" : "their cells weigh differently";
    }
    default:
      return "their grid cannot be read";
  }
}

/** The time readings of a component, as companions match them. */
function readings(context: TVariableContext) {
  const time = context.time!;
  return {
    ...physicalClock(time),
    units: time.units,
    calendar: time.calendar,
    cellMethods: context.cellMethods,
    dimension: time.dimension,
    quantity: context.quantity,
  };
}

/** Time statistics that combine into a vector's when both use them. */
const LINEAR_TIME_METHODS = new Set(["mean", "point"]);

/**
 * The partner's row of each of `a`'s rows `start`..`stop` (−1 where it has no
 * observation then), by the rule companions use: statistics over cells on both
 * sides by their intervals, readings at instants by the instant, to the
 * microsecond. Their time statistics must agree and combine.
 */
// eslint-disable-next-line max-lines-per-function
function timeRows(
  own: TVariableContext,
  other: TVariableContext
): Int32Array | { reason: string } {
  const [a, b] = [readings(own), readings(other)];
  const [ma, mb] = [
    timeCellMethod(a.cellMethods, a.dimension),
    timeCellMethod(b.cellMethods, b.dimension),
  ];
  // Statistics over cells whose bounds went unread (a description budget, a
  // failed read): their support is unknown, so no row pairs.
  const unread = [own, other].find(
    (c, at) =>
      c.time &&
      clockBoundsUnread(c.time) &&
      !(at ? mb === "point" : ma === "point") &&
      !((at ? mb : ma) === undefined && c.quantity === "intensive") &&
      !physicalClock(c.time).bounds?.some(Number.isFinite)
  );
  if (unread) {
    return { reason: clockBoundsUnread(unread.time!)! };
  }
  const [ca, cb] = [overCells(a), overCells(b)];
  if (ca !== cb) {
    return {
      reason:
        "one is read at instants and the other is a statistic over time cells",
    };
  }
  if ((ma ?? "point") !== (mb ?? "point")) {
    return { reason: `their time statistics differ (${ma} and ${mb})` };
  }
  if (ma && !LINEAR_TIME_METHODS.has(ma)) {
    return {
      reason: `the ${ma} of each component is taken apart, which makes no vector`,
    };
  }
  // The whole chain, every axis, in order, with its qualifiers.
  const chain = vectorMethodProblem(
    { cellMethods: a.cellMethods, timeDimension: a.dimension },
    { cellMethods: b.cellMethods, timeDimension: b.dimension }
  );
  if (chain) {
    return { reason: chain };
  }
  const mode = matchMode(a, b);
  // Built once per pair of axes (their values and bounds as read), for all of
  // our rows: slices of one selection share it. The same raw arrays with other
  // units or calendars are other times.
  const axes = `${a.units}|${a.calendar}|${b.units}|${b.calendar}`;
  const cached = rowCache.get(a.raw)?.get(b.raw);
  if (
    cached &&
    cached.mode === mode &&
    cached.axes === axes &&
    cached.ownBounds === a.bounds &&
    cached.theirBounds === b.bounds
  ) {
    return cached.rows;
  }
  const rows = cycled(own, other)
    ? keyedRows(a, b, mode, own, other)
    : (sameAxisRows(a, b, mode) ?? keyedRows(a, b, mode));
  const byPartner = rowCache.get(a.raw) ?? new WeakMap();
  byPartner.set(b.raw, {
    mode,
    axes,
    ownBounds: a.bounds,
    theirBounds: b.bounds,
    rows,
  });
  rowCache.set(a.raw, byPartner);
  return rows;
}

type TReadings = ReturnType<typeof readings>;

/** Whether a mapping has any partner row, once per mapping. */
function anyRow(rows: Int32Array) {
  let known = anyRows.get(rows);
  if (known === undefined) {
    known = rows.some((row) => row >= 0);
    anyRows.set(rows, known);
  }
  return known;
}
const anyRows = new WeakMap<Int32Array, boolean>();

/** Rows by calendar keys: any two axes the calendar decodes or not. */
/** Both dated by valid times beside initializations: rows are of one run. */
const cycled = (a: TVariableContext, b: TVariableContext) =>
  [a, b].every((c) => c.time?.valid?.length === c.time?.raw.length);

function keyedRows(
  a: TReadings,
  b: TReadings,
  mode: "instants" | "intervals",
  own?: TVariableContext,
  other?: TVariableContext
) {
  const [x, y] =
    own && other
      ? [
          withCycles(observationKeys(a, mode), own.time!, other.time),
          withCycles(observationKeys(b, mode), other.time!, own.time),
        ]
      : [observationKeys(a, mode), observationKeys(b, mode)];
  // Each observation's one row of the partner; repeated ones name none.
  const theirs = new Map<string, number>();
  y.forEach((k, at) => {
    if (!unknownCell(k)) {
      theirs.set(k, theirs.has(k) ? -1 : at);
    }
  });
  const rows = new Int32Array(a.raw.length).fill(-1);
  for (let at = 0; at < a.raw.length; at++) {
    rows[at] = unknownCell(x[at]) ? -1 : (theirs.get(x[at]) ?? -1);
  }
  return rows;
}

/** Days within which a day and microsecond make one exact number. */
const EXACT_DAYS = 100_000;

/**
 * Rows of two axes in the same units and calendar, by number rather than by
 * formatted date: the same instant to the microsecond is the same whole day and
 * microsecond of it (as `instantKey`), without decoding a date per row.
 * Undefined where it does not apply.
 */
// eslint-disable-next-line max-lines-per-function
function sameAxisRows(
  a: TReadings,
  b: TReadings,
  mode: "instants" | "intervals"
) {
  const axis = parseTimeAxis(a.units, a.calendar);
  const other = parseTimeAxis(b.units, b.calendar);
  const whole = (t: TReadings) =>
    t.bounds !== undefined && t.bounds.length === 2 * t.raw.length;
  if (
    (mode === "intervals" && !(whole(a) && whole(b))) ||
    "unsupported" in axis ||
    "unsupported" in other ||
    axis.calendar !== other.calendar
  ) {
    return undefined;
  }
  let exact = true;
  // Each axis by its own units and origin, as days from the first axis's origin
  // and microseconds of the day: hours beside minutes of the same dates are
  // numbers too.
  const DAY_US = 86_400_000_000;
  const base = dayNumberOfDate(axis.calendar, axis.reference);
  const keyOf = (t: typeof axis) => {
    const day = dayNumberOfDate(t.calendar, t.reference) - base;
    const clock = Math.round(
      (t.reference.hour * 3600 + t.reference.minute * 60 + t.reference.second) *
        1e6
    );
    return (raw: number) => {
      if (!Number.isFinite(raw)) {
        return Number.NaN;
      }
      const seconds = raw * t.unitSeconds;
      const days = Math.floor(seconds / 86400);
      let us = Math.round((seconds - days * 86400) * 1e6) + clock;
      const carry = Math.floor(us / DAY_US);
      us -= carry * DAY_US;
      const whole = day + days + carry;
      if (Math.abs(whole) > EXACT_DAYS) {
        exact = false;
      }
      return whole * DAY_US + us;
    };
  };
  const keys = new Map([
    [a, keyOf(axis)],
    [b, keyOf(other)],
  ]);
  // Keys as flat typed arrays (low, high): no array or map per row.
  const keysOf = (t: TReadings) => {
    const key = keys.get(t)!;
    const n = t.raw.length;
    const low = new Float64Array(n);
    const high = new Float64Array(n);
    const bounds = t.bounds;
    for (let at = 0; at < n; at++) {
      if (mode === "instants" || !bounds) {
        low[at] = key(t.raw[at]);
      } else {
        const [p, q] = [key(bounds[2 * at]), key(bounds[2 * at + 1])];
        [low[at], high[at]] = [Math.min(p, q), Math.max(p, q)];
      }
    }
    return { low, high };
  };
  const [x, y] = [keysOf(a), keysOf(b)];
  if (!exact) {
    return undefined;
  }
  const rows = new Int32Array(a.raw.length).fill(-1);
  // The same keys in the same order, ascending: each row is its own.
  if (identicalAscending(x, y)) {
    for (let at = 0; at < rows.length; at++) {
      rows[at] = Number.isNaN(x.low[at] + x.high[at]) ? -1 : at;
    }
    return rows;
  }
  // One map of the partner's rows by low key; intervals sharing a low key
  // (rare) are told apart by their high one.
  const theirs = new Map<number, number>();
  const shared = new Map<number, Map<number, number>>();
  for (let at = 0; at < y.low.length; at++) {
    const [p, q] = [y.low[at], y.high[at]];
    if (Number.isNaN(p) || Number.isNaN(q)) {
      continue;
    }
    const first = theirs.get(p);
    if (first === undefined) {
      theirs.set(p, at);
      continue;
    }
    const inner = shared.get(p) ?? new Map<number, number>();
    if (!shared.has(p)) {
      if (first >= 0) {
        inner.set(y.high[first], first);
      }
      shared.set(p, inner);
      theirs.set(p, -2);
    }
    inner.set(q, inner.has(q) ? -1 : at);
  }
  for (let at = 0; at < rows.length; at++) {
    const [p, q] = [x.low[at], x.high[at]];
    if (Number.isNaN(p) || Number.isNaN(q)) {
      continue;
    }
    const found = theirs.get(p);
    rows[at] =
      found === undefined
        ? -1
        : found === -2
          ? (shared.get(p)!.get(q) ?? -1)
          : y.high[found] === q
            ? found
            : -1;
  }
  return rows;
}

/** Two axes' keys equal row by row and strictly ascending (no repeats). */
function identicalAscending(
  x: { low: Float64Array; high: Float64Array },
  y: { low: Float64Array; high: Float64Array }
) {
  if (x.low.length !== y.low.length) {
    return false;
  }
  let last = -Infinity;
  for (let at = 0; at < x.low.length; at++) {
    const [p, q] = [x.low[at], x.high[at]];
    if (!Object.is(p, y.low[at]) || !Object.is(q, y.high[at])) {
      return false;
    }
    if (!Number.isNaN(p)) {
      if (!(p > last)) {
        return false;
      }
      last = p;
    }
  }
  return true;
}

/** Row maps per pair of time axes (keyed by their value arrays). */
const rowCache = new WeakMap<
  object,
  WeakMap<
    object,
    {
      mode: string;
      axes: string;
      ownBounds?: number[];
      theirBounds?: number[];
      rows: Int32Array;
    }
  >
>();

/**
 * How `other` is counted on `own`'s cells for the dates `start` to `stop`
 * at `level`: its rows' shift along time, or why it cannot be.
 */
// eslint-disable-next-line max-lines-per-function
export async function jointAlignment(
  own: TVariableContext,
  other: TVariableContext,
  level: number | undefined,
  signal?: AbortSignal
): Promise<
  { reason: string } | { rows: Int32Array; maps: Map<number, Int32Array> }
> {
  const [a, b] = [own.array, other.array];
  const timeAxis = own.time?.axis;
  if (
    !own.time ||
    !other.time ||
    other.time.axis !== timeAxis ||
    a.dimensionNames.join() !== b.dimensionNames.join() ||
    a.shape.some((n, d) => d !== timeAxis && n !== b.shape[d])
  ) {
    return { reason: "their dimensions differ" };
  }
  const cells = await cellsProblem(own, other, signal);
  if (cells) {
    return { reason: cells };
  }
  const rows = timeRows(own, other);
  if ("reason" in rows) {
    return rows;
  }
  // No instant in common at all: no vector. Rows of the selection without the
  // partner are missing, not a refusal of the rest.
  if (!anyRow(rows)) {
    return { reason: "their dates differ" };
  }
  const scalarLevels = scalarLevelProblem(own, other);
  if (scalarLevels) {
    return { reason: scalarLevels };
  }
  if (level !== undefined) {
    const [x, y] = [own.vertical, other.vertical];
    const surfaces = surfaceProblem(own, other);
    if (surfaces) {
      return { reason: surfaces };
    }
    if (
      !x ||
      !y ||
      x.axis !== y.axis ||
      !sameValues([x.values[level]], [y.values[level]]) ||
      // The same layer, not only the same centre: 0–10 m is no 4–6 m.
      Boolean(x.bounds) !== Boolean(y.bounds) ||
      (x.bounds &&
        !sameValues(
          x.bounds.slice(2 * level, 2 * level + 2),
          y.bounds!.slice(2 * level, 2 * level + 2)
        )) ||
      (x.kind === "physical" &&
        y.kind === "physical" &&
        (x.units !== y.units || x.positive !== y.positive))
    ) {
      return { reason: "their levels differ" };
    }
  }
  const scalar = scalarLeadProblem(own.scalarLead, other.scalarLead);
  if (scalar) {
    return { reason: scalar };
  }
  const maps = new Map<number, Int32Array>([[timeAxis!, rows]]);
  for (const mine of own.others) {
    const theirs = other.others.find((o) => o.dimension === mine.dimension);
    const map = othersMap(mine, theirs);
    if (map === "unmatched") {
      return { reason: `their ${mine.dimension} entries cannot be matched` };
    }
    if (map) {
      maps.set(mine.axis, map);
    }
  }
  return { rows, maps };
}

type TOther = TVariableContext["others"][number];

/**
 * Two components' scalar leads: the same duration over the same interval, both
 * known.
 */
function scalarLeadProblem(
  a: TVariableContext["scalarLead"],
  b: TVariableContext["scalarLead"]
) {
  if (!a && !b) {
    return undefined;
  }
  if (!a || !b) {
    return "only one of them names its lead time";
  }
  if (!sameDuration(a.value * a.seconds, b.value * b.seconds)) {
    return "their lead times differ";
  }
  if (a.pending || b.pending) {
    return "a lead's declared interval could not be read";
  }
  const span = (l: NonNullable<typeof a>) =>
    l.bounds?.map((v) => v * l.seconds);
  const [p, q] = [span(a), span(b)];
  return Boolean(p) !== Boolean(q) ||
    (p && q && !(sameDuration(p[0], q[0]) && sameDuration(p[1], q[1])))
    ? "their leads cover other intervals"
    : undefined;
}

/**
 * Why two components' levels are not one surface by what they are: a model
 * index beside a physical depth, or hybrid levels computed from other terms.
 */
/** One-level components: the same named height on the same surface. */
function scalarLevelProblem(own: TVariableContext, other: TVariableContext) {
  const [x, y] = [own.scalarLevel, other.scalarLevel];
  if (!x && !y) {
    return undefined;
  }
  if (!x || !y || own.vertical || other.vertical) {
    return "only one names its level";
  }
  return x.standardName === y.standardName &&
    x.positive === y.positive &&
    sameLevel(x.value, x.units, y.value, y.units)
    ? undefined
    : `their levels differ (${x.value} ${x.units ?? ""} and ${y.value} ${y.units ?? ""})`;
}

/** Two levels, in metres or pascals where their units say so. */
function sameLevel(
  a: number,
  au: string | undefined,
  b: number,
  bu: string | undefined
) {
  const [x, y] = [LEVEL_UNITS[au?.trim() ?? ""], LEVEL_UNITS[bu?.trim() ?? ""]];
  if (au === bu || !x || !y) {
    return au === bu && sameValues([a], [b]);
  }
  return x[0] === y[0] && sameValues([a * x[1]], [b * y[1]]);
}

const LEVEL_UNITS: Record<string, [string, number]> = {
  m: ["length", 1],
  km: ["length", 1000],
  Pa: ["pressure", 1],
  hPa: ["pressure", 100],
  mbar: ["pressure", 100],
};

function surfaceProblem(own: TVariableContext, other: TVariableContext) {
  const [x, y] = [own.vertical, other.vertical];
  if (!x || !y) {
    return undefined;
  }
  // Levels of one value over other datums: 100 m of height is not 100 m of
  // altitude.
  if (
    x.positionStandardName &&
    y.positionStandardName &&
    x.positionStandardName !== y.positionStandardName
  ) {
    return `their levels are on other surfaces (${x.positionStandardName.replace(/_/g, " ")} and ${y.positionStandardName.replace(/_/g, " ")})`;
  }
  if (x.kind !== y.kind) {
    return `their levels differ (${x.kind === "physical" ? "a physical level" : "a model level"} beside ${y.kind === "physical" ? "a physical one" : "a model one"})`;
  }
  if (x.kind !== "formula") {
    return undefined;
  }
  const same =
    x.family === y.family &&
    JSON.stringify(x.terms ?? {}) === JSON.stringify(y.terms ?? {}) &&
    (x.termsOwner ?? own.dataset.key) === (y.termsOwner ?? other.dataset.key);
  return same
    ? undefined
    : "their model levels are computed from other terms, so the same level index can be another height or pressure";
}

/**
 * The partner's index of each of our entries along another dimension, by what
 * it is, not where it is stored: a realization by its identifier, a lead time
 * by its value. Undefined where position is the identity (no identifiers on
 * either side).
 */
function othersMap(mine: TOther, theirs: TOther | undefined) {
  if (!theirs || mine.idsUnread || theirs.idsUnread) {
    return "unmatched" as const;
  }
  // A lead is its duration, over its published interval: a 24 h and a 12 h mean
  // ending at +48 h are no one wind.
  const micro = (x: number) => Math.round(x * 1e6) / 1e6;
  const label = (o: TOther, side: string) => {
    const period = o.forecastPeriod;
    if (period) {
      return period.values.map((v, k) => {
        if (period.seconds === undefined || !Number.isFinite(v)) {
          return `unknown ${side} ${k}`;
        }
        const s = period.seconds;
        const [lo, hi] = [period.bounds?.[2 * k], period.bounds?.[2 * k + 1]];
        const interval =
          lo !== undefined && hi !== undefined && Number.isFinite(lo + hi)
            ? ` [${micro(lo * s)}, ${micro(hi * s)}]`
            : "";
        return `${micro(v * s)} s${interval}`;
      });
    }
    return o.ids;
  };
  const [a, b] = [label(mine, "a"), label(theirs, "b")];
  if (!a && !b) {
    return undefined;
  }
  if (!a || !b || mine.ensemble !== theirs.ensemble) {
    return "unmatched" as const;
  }
  // A member without an identifier (its declared missing value) matches none.
  const at = new Map<string, number>();
  b.forEach((id, k) => {
    if (id !== undefined) {
      at.set(id, at.has(id) ? -1 : k);
    }
  });
  const map = Int32Array.from(a, (id) =>
    id === undefined ? -1 : (at.get(id) ?? -1)
  );
  return map.every((k, i) => k === i) ? undefined : map;
}

/** The cells a joint read visits, and where the partner's rows are. */
export type TJointSelection = {
  runs: TIndexRuns[];
  points?: TPointSelection;
  timeAxis: number;
  /** The partner's row of each of ours along time (−1: none). */
  rows: Int32Array;
  /**
   * The partner's index of ours along each mapped axis (time and others:
   * members by identifier); unmapped axes are the identity.
   */
  maps?: Map<number, Int32Array>;
};

/** The partner's index of ours along axis `d` (−1: none). */
function partnerIndex(selection: TJointSelection, d: number, i: number) {
  const map =
    selection.maps?.get(d) ??
    (d === selection.timeAxis ? selection.rows : undefined);
  return map ? map[i] : i;
}

/**
 * The partner's stored chunks holding the selected cells of `array`'s chunk at
 * `coords` (its other cells are never visited): the same chunks the plan
 * counts.
 */
// eslint-disable-next-line max-lines-per-function
function partnerChunks(
  array: TAnalysisArray,
  partner: TAnalysisArray,
  coords: number[],
  selection: TJointSelection,
  pointChunks: Map<string, number[][]> | undefined
) {
  const pointDims = selection.points?.dims ?? [];
  const along: number[][] = coords.map((c, d) => {
    if (pointDims.includes(d)) {
      return [];
    }
    const from = c * array.chunks[d];
    const to = Math.min(array.shape[d], from + array.chunks[d]);
    const found = new Set<number>();
    for (const [rs, re] of selection.runs[d]) {
      const [lo, hi] = [Math.max(rs, from), Math.min(re, to)];
      if (d === selection.timeAxis || selection.maps?.has(d)) {
        // Each of our rows at its partner row, where it has one.
        for (let i = lo; i < hi; i++) {
          const row = partnerIndex(selection, d, i);
          if (row >= 0) {
            found.add(Math.floor(row / partner.chunks[d]));
          }
        }
        continue;
      }
      for (
        let k = Math.floor(lo / partner.chunks[d]);
        hi > lo && k <= Math.floor((hi - 1) / partner.chunks[d]);
        k++
      ) {
        found.add(k);
      }
    }
    return [...found].sort((x, y) => x - y);
  });
  // The point dimensions' partner chunks, as tuples, for this chunk.
  const tuples = pointDims.length
    ? (pointChunks?.get(pointDims.map((d) => coords[d]).join()) ?? [])
    : [[]];
  const list: number[][] = [];
  const runDims = coords.map((_, d) => d).filter((d) => !pointDims.includes(d));
  const at = runDims.map(() => 0);
  if (runDims.some((d) => !along[d].length)) {
    return list;
  }
  for (;;) {
    for (const tuple of tuples) {
      const chunk = coords.map(() => 0);
      runDims.forEach((d, k) => {
        chunk[d] = along[d][at[k]];
      });
      pointDims.forEach((d, k) => {
        chunk[d] = tuple[k];
      });
      list.push(chunk);
    }
    let k = runDims.length - 1;
    for (; k >= 0; k--) {
      if (++at[k] < along[runDims[k]].length) {
        break;
      }
      at[k] = 0;
    }
    if (k < 0) {
      return list;
    }
  }
}

/**
 * The partner's chunk tuples on the point dimensions, per primary chunk of
 * those dimensions: grouped once, not per chunk read.
 */
function groupPointChunks(
  array: TAnalysisArray,
  partner: TAnalysisArray,
  points: TPointSelection | undefined
) {
  if (!points) {
    return undefined;
  }
  const rank = points.dims.length;
  const groups = new Map<string, Map<string, number[]>>();
  for (let p = 0; p < points.positions.length / rank; p++) {
    const own: number[] = [];
    const theirs: number[] = [];
    points.dims.forEach((d, k) => {
      const i = points.positions[p * rank + k];
      own.push(Math.floor(i / array.chunks[d]));
      theirs.push(Math.floor(i / partner.chunks[d]));
    });
    const group = groups.get(own.join()) ?? new Map<string, number[]>();
    group.set(theirs.join(), theirs);
    groups.set(own.join(), group);
  }
  const out = new Map<string, number[][]>();
  for (const [key, group] of groups) {
    out.set(key, [...group.values()]);
  }
  return out;
}

/**
 * `array` with each cell missing where `partner`'s value at the same
 * cell and instant is: the partner read with its own chunking, memory
 * order and fill, through the shared reads (each chunk fetched once,
 * whichever component asks first), only where the selection visits. Its
 * chunks are not cached: the stored ones are.
 */
// eslint-disable-next-line max-lines-per-function
export function jointArray(
  array: TAnalysisArray,
  partner: TAnalysisArray,
  codec: TValueCodec,
  read: ReadContext,
  counters: TWorkCounters,
  selection: TJointSelection
): TAnalysisArray {
  const fillMissing = Number.isNaN(codec.absentValue);
  const pointChunks = groupPointChunks(array, partner, selection.points);
  const size = partner.chunks;
  const { timeAxis, rows } = selection;
  const readChunk = async (
    coords: number[],
    signal?: AbortSignal,
    onBackend?: (settled: Promise<unknown>) => void
  ): Promise<TStoredChunk> => {
    // Every backend read it starts, its own and the partner's, settled
    // before its reader's reservation is given back, stopped or not.
    // Counted, not kept: a settled read is let go at once.
    let pending = 0;
    let ended = false;
    let finish!: () => void;
    onBackend?.(
      new Promise<void>((resolve) => {
        finish = resolve;
      })
    );
    const started = (settled: Promise<unknown>) => {
      pending++;
      void settled.then(() => {
        if (--pending === 0 && ended) {
          finish?.();
        }
        return undefined;
      });
    };
    try {
      return await readJoint(coords, signal, started);
    } finally {
      ended = true;
      if (pending === 0) {
        finish?.();
      }
    }
  };
  // eslint-disable-next-line max-lines-per-function
  const readJoint = async (
    coords: number[],
    signal: AbortSignal | undefined,
    started: (settled: Promise<unknown>) => void
  ): Promise<TStoredChunk> => {
    const list = partnerChunks(array, partner, coords, selection, pointChunks);
    // Numbered within the chunks' box: a cell's chunk found by arithmetic
    // (loops, not a spread: 135,000 tiles overflowed the stack).
    const low = size.map(() => Number.POSITIVE_INFINITY);
    const high = size.map(() => Number.NEGATIVE_INFINITY);
    for (const chunk of list) {
      chunk.forEach((c, d) => {
        low[d] = Math.min(low[d], c);
        high[d] = Math.max(high[d], c);
      });
    }
    const counts = size.map((_, d) => (list.length ? high[d] - low[d] + 1 : 0));
    const slotOf = (chunk: number[]) =>
      chunk.reduce((n, c, d) => n * counts[d] + c - low[d], 0);
    // Each partner tile as one bit per value (1: missing), its decoded values
    // let go at once: tiles are read a few at a time, each batch settled before
    // the next (or before a stop is passed on), so neither all of them are held
    // decoded together nor is the memory booked for them given back while a
    // read still holds it.
    const masks = new Map<
      number,
      { bits: Uint8Array; shape: number[] } | "absent"
    >();
    const own = read.read(array, coords, counters, signal, started);
    // Awaited below; a stop before then is not an unhandled rejection. A failed
    // tile of ours ends the partner's reads with it.
    let ownFailed = false;
    own.catch(() => {
      ownFailed = true;
    });
    for (let at = 0; at < list.length; at += PARTNER_BATCH) {
      if (ownFailed) {
        await own;
      }
      const batch = list.slice(at, at + PARTNER_BATCH);
      const settled = await Promise.allSettled(
        batch.map((pc) => read.read(partner, pc, counters, undefined, started))
      );
      settled.forEach((outcome, k) => {
        if (outcome.status === "fulfilled") {
          masks.set(slotOf(batch[k]), missingBits(outcome.value, codec));
        }
      });
      const failed = settled.find((o) => o.status === "rejected");
      if (failed) {
        throw (failed as PromiseRejectedResult).reason;
      }
      throwIfAborted(signal);
    }
    const chunk = await own;
    const missingAt = (index: ArrayLike<number>) => {
      const row = rows[index[timeAxis]];
      if (row < 0) {
        // No observation of the partner at this instant.
        return true;
      }
      const at = (d: number) =>
        d === timeAxis ? row : partnerIndex(selection, d, index[d]);
      let slot = 0;
      for (let d = 0; d < size.length; d++) {
        const i = at(d);
        const c = Math.floor(i / size[d]);
        if (c < low[d] || c >= low[d] + counts[d]) {
          return true;
        }
        slot = slot * counts[d] + c - low[d];
      }
      const mask = masks.get(slot);
      if (!mask) {
        // A cell the selection does not visit.
        return true;
      }
      if (mask === "absent") {
        return fillMissing;
      }
      // Row-major within the tile, as the bits were written.
      let flat = 0;
      for (let d = 0; d < size.length; d++) {
        flat = flat * mask.shape[d] + (at(d) % size[d]);
      }
      return (mask.bits[flat >> 3] & (1 << (flat & 7))) !== 0;
    };
    return { ...chunk, missingAt };
  };
  // Its own key: masked chunks are never served to a plain read; still
  // under the array's prefix, so a publication forgets them too.
  const key = `${array.key}|joint ${partner.key}|${rowsKey(rows)}${[
    ...(selection.maps ?? []),
  ]
    .filter(([d]) => d !== timeAxis)
    .map(([d, map]) => `|${d}:${rowsKey(map)}`)
    .join("")}`;
  return {
    ...array,
    key,
    readChunk,
    readsThrough: true,
    unguarded: undefined,
    partnerBytes: partnerHeldBytes(array, partner, selection),
  };
}

/** The partner's rows of our time runs, as runs of its own. */
export function partnerRuns(rows: Int32Array, runs: TIndexRuns): TIndexRuns {
  const found: number[] = [];
  for (const [a, b] of runs) {
    for (let at = a; at < b; at++) {
      if (rows[at] >= 0) {
        found.push(rows[at]);
      }
    }
  }
  found.sort((x, y) => x - y);
  const out: TIndexRuns = [];
  for (const row of found) {
    const last = out[out.length - 1];
    if (last && row <= last[1]) {
      last[1] = Math.max(last[1], row + 1);
    } else {
      out.push([row, row + 1]);
    }
  }
  return out;
}

/** Partner tiles read and held decoded at once by a joint read. */
const PARTNER_BATCH = 4;

/**
 * A partner tile's values as one bit each, row-major in the tile's own
 * shape (1: missing), or "absent" for a chunk never written.
 */
function missingBits(
  chunk: TStoredChunk,
  codec: TValueCodec
): { bits: Uint8Array; shape: number[] } | "absent" {
  if (chunk.absent) {
    return "absent";
  }
  const shape = chunk.shape;
  const total = shape.reduce((p, n) => p * n, 1);
  const bits = new Uint8Array(Math.ceil(total / 8));
  const index = shape.map(() => 0);
  for (let flat = 0; flat < total; flat++) {
    let at = 0;
    for (let d = 0; d < shape.length; d++) {
      at += index[d] * chunk.stride[d];
    }
    const raw = chunk.data[at];
    const missing = Number.isNaN(
      typeof raw === "bigint"
        ? decodeStoredBigInt(codec, raw)
        : decodeStoredValue(codec, Number(raw))
    );
    if (missing) {
      bits[flat >> 3] |= 1 << (flat & 7);
    }
    for (let d = shape.length - 1; d >= 0; d--) {
      if (++index[d] < shape[d]) {
        break;
      }
      index[d] = 0;
    }
  }
  return { bits, shape };
}

/** A short name of a row mapping: masked chunks of others are others. */
function rowsKey(rows: Int32Array) {
  // Once per mapping, not per slice.
  const known = rowKeys.get(rows);
  if (known) {
    return known;
  }
  const key = hashRows(rows);
  rowKeys.set(rows, key);
  return key;
}
const rowKeys = new WeakMap<Int32Array, string>();

function hashRows(rows: Int32Array) {
  let hash = 2166136261;
  for (const row of rows) {
    hash = Math.imul(hash ^ (row + 1), 16777619);
  }
  return `${rows.length}:${hash >>> 0}`;
}

/**
 * What a joint read holds beside each chunk of `array` for this selection: a
 * batch of partner tiles decoded, and one bit per value of every tile the
 * selected cells of that chunk overlap, at the partner's own rows.
 */
export function partnerHeldBytes(
  array: Pick<TAnalysisArray, "chunks" | "shape">,
  partner: Pick<TAnalysisArray, "chunks" | "dtype">,
  selection: TJointSelection
) {
  const pointDims = selection.points?.dims ?? [];
  let tiles = 1;
  for (let d = 0; d < array.chunks.length; d++) {
    if (pointDims.includes(d)) {
      continue;
    }
    // The most partner tiles the selected runs of one primary chunk span.
    const byChunk = new Map<number, Set<number>>();
    for (const [start, stop] of selection.runs[d] ?? []) {
      for (let i = start; i < stop; i++) {
        const j = partnerIndex(selection, d, i);
        if (j < 0) {
          continue;
        }
        const own = Math.floor(i / array.chunks[d]);
        const set = byChunk.get(own) ?? new Set<number>();
        set.add(Math.floor(j / partner.chunks[d]));
        byChunk.set(own, set);
      }
    }
    let most = 0;
    for (const set of byChunk.values()) {
      most = Math.max(most, set.size);
    }
    tiles *= Math.max(1, most);
  }
  if (selection.points) {
    // Points: the partner tiles of their dimensions, per primary group.
    const groups = groupPointChunks(
      array as TAnalysisArray,
      partner as TAnalysisArray,
      selection.points
    );
    let most = 1;
    for (const list of groups?.values() ?? []) {
      most = Math.max(most, list.length);
    }
    tiles *= most;
  }
  const values = partner.chunks.reduce((p, n) => p * n, 1);
  return (
    Math.min(tiles, PARTNER_BATCH) * chunkByteSize(partner) +
    tiles * Math.ceil(values / 8)
  );
}
