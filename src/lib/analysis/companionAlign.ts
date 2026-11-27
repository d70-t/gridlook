/**
 * A companion (a wind component, a variable scattered against the plot)
 * read with the plot's own query is not necessarily on the plot's own
 * samples: another group may keep other times, another time order or
 * other levels. Its values are taken at the plot's samples by what they
 * are (the time as its calendar writes it, the vertical position), never
 * by index; samples it does not have are missing.
 */
import {
  durationSeconds,
  instantKey,
  parseTimeAxis,
  sameDuration,
} from "./calendar.ts";
import {
  parseCellMethods,
  quantityKind,
  timeCellMethod,
} from "./cellMethods.ts";
import { rowIndices } from "./timeRows.ts";
import type { TAnalysisQuery, TAnalysisResult } from "./types.ts";
import { converter } from "./unitConvert.ts";
import { looksEnsemble } from "./vertical.ts";

type TAligned = { values: number[]; matched: number };
type TTime = {
  raw: number[];
  units?: string;
  calendar?: string;
  /** Declared cells, [start, end] per step, flat. */
  bounds?: number[];
  /** The variable's CF cell_methods ("time: mean", "time: point"…). */
  cellMethods?: string;
  /** The time dimension's name: cell_methods may name it for time. */
  dimension?: string;
  /** Intensive or extensive, when known (see quantityKind). */
  quantity?: "intensive" | "extensive";
};

/**
 * Whether a time axis holds statistics over declared cells (a mean, sum,
 * maximum…) rather than samples at instants: bounds on every step, and no
 * `time: point`.
 */
export function overCells(time: TTime | undefined) {
  const method = time && timeCellMethod(time.cellMethods, time.dimension);
  return Boolean(
    time?.bounds &&
    time.bounds.length === 2 * time.raw.length &&
    method !== "point" &&
    // No time method: CF's default for an intensive quantity is a value at an
    // instant, its bounds notwithstanding.
    !(method === undefined && time.quantity === "intensive")
  );
}

/** Readings at instants: a point method, or an intensive quantity without one. */
function atInstants(time: TTime) {
  const method = timeCellMethod(time.cellMethods, time.dimension);
  return (
    method === "point" ||
    (method === undefined && time.quantity === "intensive")
  );
}

/**
 * How two time axes are matched, one rule for Against, its check before reading
 * and Compare: statistics over cells on both sides by their intervals (a daily
 * mean stamped at its midpoint and one stamped at its end are the same
 * observation), anything else by the instant, to the microsecond.
 */
export function matchMode(a: TTime | undefined, b: TTime | undefined) {
  return overCells(a) && overCells(b) ? "intervals" : "instants";
}

/** Keys per axis, kept per coordinate array. */
const keyCache = new WeakMap<
  object,
  {
    bounds?: number[];
    units?: string;
    calendar?: string;
    instants?: string[];
    intervals?: string[];
  }
>();

/** The keys of an axis under a match mode, cached. */
export function observationKeys(time: TTime, mode: "instants" | "intervals") {
  let entry = keyCache.get(time.raw);
  if (
    !entry ||
    entry.bounds !== time.bounds ||
    entry.units !== time.units ||
    entry.calendar !== time.calendar
  ) {
    entry = { bounds: time.bounds, units: time.units, calendar: time.calendar };
    keyCache.set(time.raw, entry);
  }
  return (entry[mode] ??= timeKeys(time, mode === "intervals"));
}

/**
 * A key per time: the instant (calendar, day, microsecond) whatever its units,
 * or, in a calendar without a decoder, the raw offset with its units and
 * calendar (another origin is another time). With `cells`, the key is the
 * declared interval, start and end: two means over [0, 1] and [1, 2] that share
 * a time stamp are different observations, as are a month and a day that share
 * one.
 */
/** The key of a cell whose bounds are unknown: never matched. */
const UNKNOWN_CELL = "\u0000unknown cell";
/** Whether a key is a cell of unknown bounds (it pairs with nothing). */
export const unknownCell = (key: string) => key === UNKNOWN_CELL;
function timeKeys(time: TTime, cells = false) {
  const axis = parseTimeAxis(time.units, time.calendar);
  const key =
    "unsupported" in axis
      ? (raw: number) =>
          `${raw} ${time.units ?? ""} ${calendarName(time.calendar)}`
      : (raw: number) => instantKey(axis, raw);
  const bounds = time.bounds;
  if (!cells || !bounds || bounds.length !== 2 * time.raw.length) {
    // An undated row is no observation: it pairs with nothing, not with another
    // undated row.
    return time.raw.map((raw) =>
      Number.isFinite(raw) ? key(raw) : UNKNOWN_CELL
    );
  }
  return time.raw.map((_, at) => {
    const [a, b] = [bounds[2 * at], bounds[2 * at + 1]];
    // Unknown support: matches nothing, even an unknown row of the same axis.
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return UNKNOWN_CELL;
    }
    return `${key(Math.min(a, b))}..${key(Math.max(a, b))}`;
  });
}

/** Whether both axes are statistics over cells: matched by interval. */
const bothCells = (a?: TTime, b?: TTime) => matchMode(a, b) === "intervals";

/**
 * A vertical position's key: in Pa or m when its units convert, metres as
 * heights.
 */
function levelKey(
  value: number,
  units: string | undefined,
  positive?: "up" | "down"
) {
  // An unknown level matches nothing, not another unknown one.
  if (!Number.isFinite(value)) {
    return UNKNOWN_CELL;
  }
  for (const base of ["Pa", "m"]) {
    const to = converter(units, base);
    if (to) {
      const signed =
        base === "m" && positive === "down" ? -to(value) : to(value);
      return `${Number(signed.toPrecision(12)) || 0} ${base}`;
    }
  }
  return `${value} ${units ?? ""}`;
}

/** The key of each sample of a one-axis result: its time, or its level. */
function sampleKeys(r: TAnalysisResult, cells = false, layers = false) {
  if (r.dims.length !== 1) {
    return undefined;
  }
  if (r.time && r.time.raw.length === r.values.length) {
    return {
      by: "times" as const,
      keys: observationKeys(withMethods(r), cells ? "intervals" : "instants"),
    };
  }
  if (r.vertical && r.vertical.values.length === r.values.length) {
    return { by: "levels" as const, keys: levelKeys(r.vertical, layers) };
  }
  return undefined;
}

/** A key per level: its position, and with `layers` its layer too. */
function levelKeys(
  vertical: NonNullable<TAnalysisResult["vertical"]>,
  layers: boolean
) {
  const { units, positive, bounds } = vertical;
  const layer = (at: number) => {
    const [lo, hi] = [bounds![2 * at], bounds![2 * at + 1]];
    return Number.isFinite(lo) && Number.isFinite(hi)
      ? `${levelKey(Math.min(lo, hi), units)}..${levelKey(Math.max(lo, hi), units)}|${positive ?? ""}`
      : UNKNOWN_CELL;
  };
  return vertical.values.map((value, at) => {
    const key = levelKey(value, units, positive);
    return layers && key !== UNKNOWN_CELL
      ? ((l) => (l === UNKNOWN_CELL ? l : `${key}|${l}`))(layer(at))
      : key;
  });
}

/**
 * Each key with its occurrence (`date#2` for a date's second sample), so
 * repeated dates match in order; keys repeated a different number of
 * times on the two sides are ambiguous and match nothing.
 */
function occurrences(keys: string[], other: string[]) {
  const count = (list: string[]) => {
    const n = new Map<string, number>();
    list.forEach((key) => n.set(key, (n.get(key) ?? 0) + 1));
    return n;
  };
  const [mine, theirs] = [count(keys), count(other)];
  const seen = new Map<string, number>();
  return keys.map((key) => {
    const at = seen.get(key) ?? 0;
    seen.set(key, at + 1);
    const [a, b] = [mine.get(key)!, theirs.get(key) ?? 0];
    return a === 1 && b <= 1 ? key : a === b ? `${key}#${at}` : undefined;
  });
}

const sameList = (a: readonly unknown[] = [], b: readonly unknown[] = []) =>
  a.length === b.length && a.every((value, at) => value === b[at]);

/** A result's time axis with its variable's cell methods. */
function withMethods(r: TAnalysisResult): TTime {
  return { ...r.time!, cellMethods: r.cellMethods, ...physicalClock(r.time!) };
}

/**
 * The times rows are matched by: published valid times where the axis is of
 * initializations.
 */
export function physicalClock(time: {
  raw: number[];
  bounds?: number[];
  valid?: number[];
  validBounds?: number[];
}) {
  return time.valid?.length === time.raw.length
    ? { raw: time.valid, bounds: time.validBounds }
    : { raw: time.raw, bounds: time.bounds };
}

type TClockAxis = Parameters<typeof physicalClock>[0] & {
  units?: string;
  calendar?: string;
  boundsUnread?: string;
  validBoundsUnread?: string;
};

/** Why the cells of the clock rows are matched by are unknown, if they are. */
export function clockBoundsUnread(time: TClockAxis) {
  return time.valid?.length === time.raw.length
    ? time.validBoundsUnread
    : time.boundsUnread;
}

/**
 * Keys extended by each row's forecast initialization when both axes date
 * their rows by valid times beside initializations: a vector or a pair is
 * of one run, so a 48-hour U and a 72-hour V valid at the same hour are
 * other forecasts. Either side without initializations keeps its keys.
 */
export function withCycles(
  keys: string[],
  time: TClockAxis,
  partner: TClockAxis | undefined
) {
  const dated = (t: TClockAxis | undefined) =>
    Boolean(t?.valid && t.valid.length === t.raw.length);
  if (!dated(time) || !dated(partner)) {
    return keys;
  }
  const cycles = observationKeys(
    { raw: time.raw, units: time.units, calendar: time.calendar },
    "instants"
  );
  return keys.map((key, at) =>
    unknownCell(key) ? key : `${key}@${cycles[at]}`
  );
}

/**
 * Whether values may be a statistic over their vertical cells: as their cell
 * methods say for that dimension; without one, an intensive quantity is a
 * sample at its level, CF's default. An unknown or extensive quantity keeps its
 * layers compared.
 */
function layerMethod(
  cellMethods: string | undefined,
  quantity: string | undefined,
  dimension: string
) {
  const method = parseCellMethods(cellMethods).get(dimension);
  return method !== undefined ? method !== "point" : quantity !== "intensive";
}

function layerStatistic(r: TAnalysisResult, dimension: string) {
  return layerMethod(
    r.cellMethods,
    r.time?.quantity ??
      r.vertical?.quantity ??
      quantityKind(r.units, r.standardName || undefined),
    dimension
  );
}

/** Two fixed levels' published layers, compared as positions. */
function sameLayer(
  a: NonNullable<TAnalysisResult["fixedLevel"]>,
  b: NonNullable<TAnalysisResult["fixedLevel"]>
) {
  const key = (l: typeof a) =>
    l
      .bounds!.map((edge) => levelKey(edge, l.units, l.positive))
      .sort()
      .join("..");
  return key(a) === key(b);
}

/**
 * Each axis's keys of a result on two axes: its times, and its levels
 * (their layers too with `layers`).
 */
function axesKeys(
  r: TAnalysisResult,
  mode: "instants" | "intervals",
  layers: boolean
) {
  return {
    time: r.time ? observationKeys(withMethods(r), mode) : [],
    level: r.vertical ? levelKeys(r.vertical, layers) : [],
    column: r.columnVertical?.map((v) => levelKey(v, r.vertical?.units)) ?? [],
  };
}

/**
 * Whether two results are on the same samples in every axis: each axis's
 * support, not only its centres.
 */
function sameAxes(
  shown: TAnalysisResult,
  other: TAnalysisResult,
  layers: boolean
) {
  const mode =
    shown.time && other.time
      ? matchMode(withMethods(shown), withMethods(other))
      : "instants";
  const [a, b] = [axesKeys(shown, mode, layers), axesKeys(other, mode, layers)];
  return sameList(shown.shape, other.shape) &&
    sameList(a.time, b.time) &&
    sameList(a.level, b.level) &&
    // A curtain's pressure surfaces per column (terrain-following levels).
    sameList(a.column, b.column)
    ? a
    : undefined;
}

/** The match when no date repeats on either side (the usual case). */
function uniqueMatch(own: string[], theirs: string[]) {
  const at = new Map<string, number>();
  for (const [index, key] of theirs.entries()) {
    if (at.has(key)) {
      return undefined;
    }
    at.set(key, index);
  }
  const seen = new Set<string>();
  const index = new Int32Array(own.length);
  for (const [k, key] of own.entries()) {
    if (seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    index[k] = at.get(key) ?? -1;
  }
  return index;
}

/** The match with repeated dates paired in order (see occurrences). */
function repeatedMatch(own: string[], theirs: string[]) {
  const at = new Map<string, number>();
  occurrences(theirs, own).forEach((key, index) => {
    if (key !== undefined) {
      at.set(key, index);
    }
  });
  return Int32Array.from(occurrences(own, theirs), (key) =>
    key === undefined ? -1 : (at.get(key) ?? -1)
  );
}

/** Matches between two key lists, kept per pair of lists. */
const matches = new WeakMap<object, WeakMap<object, Int32Array>>();

/**
 * For each of `own`'s samples the index of the same sample in `theirs`, or −1.
 * Kept per pair of key lists (a time axis's keys are kept per axis): a
 * streaming series keeps its axis while its values arrive, so each update of
 * 200,000 dates is one pass over the values, not two maps of 200,000 keys. Not
 * per axis object: the same levels matched as samples and as layers are two
 * matches.
 */
function matchIndex(own: string[], theirs: string[]) {
  const cached = matches.get(own)?.get(theirs);
  if (cached?.length === own.length) {
    return cached;
  }
  const index = uniqueMatch(own, theirs) ?? repeatedMatch(own, theirs);
  own.forEach((key, at) => {
    if (key === UNKNOWN_CELL) {
      index[at] = -1;
    }
  });
  const byOther = matches.get(own) ?? new WeakMap<object, Int32Array>();
  byOther.set(theirs, index);
  matches.set(own, byOther);
  return index;
}

/**
 * `other`'s values at `shown`'s samples, or the reason they cannot be
 * matched. Two-axis results (time × level, sections) must share both axes.
 */
// eslint-disable-next-line max-lines-per-function
export function alignTo(
  shown: TAnalysisResult,
  other: TAnalysisResult
): TAligned | { reason: string } {
  // Each pair is one observation: the same instant, or, where both declare
  // their cells, the same interval (not a median width of the axis).
  const cells =
    Boolean(shown.time && other.time) &&
    bothCells(withMethods(shown), withMethods(other));
  const reference = referenceProblem(
    shown.vertical?.standardName ?? shown.fixedLevel?.standardName,
    other.vertical?.standardName ?? other.fixedLevel?.standardName
  );
  if (reference) {
    return { reason: reference };
  }
  // Statistics over cells whose bounds could not be read: which interval each
  // value covers is unknown, so none is paired. With some rows' bounds known,
  // those pair and the rest match nothing.
  // The cells of the clock matched by: published valid times' own bounds.
  const unread = [shown, other].find(
    (r) =>
      r.time &&
      clockBoundsUnread(r.time) &&
      !atInstants(withMethods(r)) &&
      !physicalClock(r.time).bounds?.some(Number.isFinite)
  );
  if (unread) {
    return {
      // "its declared bounds tb could not be read", of either side.
      reason: `${unread === shown ? "this plot's time: " : ""}${clockBoundsUnread(unread.time!)}`,
    };
  }
  const [a, b] = [shown.fixedLevel, other.fixedLevel];
  if (
    a?.value !== undefined &&
    b?.value !== undefined &&
    levelKey(a.value, a.units, a.positive) !==
      levelKey(b.value, b.units, b.positive)
  ) {
    return { reason: "it is at another level" };
  }
  const support = leadSupportProblem(shown, other);
  if (support) {
    return { reason: support };
  }
  // Layer statistics at one level: the same layer too, not only its centre.
  if (
    a?.bounds &&
    b?.bounds &&
    layerStatistic(shown, a.dimension) &&
    layerStatistic(other, b.dimension) &&
    !sameLayer(a, b)
  ) {
    return { reason: "it is a statistic over another layer" };
  }
  // Layers compared only for statistics over them: point samples match by
  // position whatever nominal bounds they carry.
  const layers = [shown, other].every(
    (r) =>
      r.vertical?.bounds?.length === 2 * (r.vertical?.values.length ?? -1) &&
      layerStatistic(r, r.vertical.dimension)
  );
  const own = sampleKeys(shown, cells, layers);
  const theirs = sampleKeys(other, cells, layers);
  if (own?.by === "times" && theirs?.by === "times") {
    own.keys = withCycles(own.keys, shown.time!, other.time);
    theirs.keys = withCycles(theirs.keys, other.time!, shown.time);
  }
  if (own && theirs && own.by === theirs.by) {
    const index = matchIndex(own.keys, theirs.keys);
    let matched = 0;
    const values = Array.from(index, (at) => {
      if (at < 0) {
        return Number.NaN;
      }
      matched++;
      return other.values[at];
    });
    return matched
      ? { values, matched }
      : {
          reason:
            supportProblem(shown.time, other.time) ??
            (cells
              ? "its time cells are other intervals than this plot's"
              : `it shares no ${own.by} with this plot`),
        };
  }
  const same = sameAxes(shown, other, layers);
  return same
    ? unknownOut(shown, other.values, same)
    : { reason: "its times or levels differ from this plot's" };
}

/**
 * Two-axis values on the same axes, samples of an unknown date, time cell or
 * level left out: an unknown sample is no observation of both.
 */
function unknownOut(
  shown: TAnalysisResult,
  values: number[],
  keys: { time: string[]; level: string[] }
) {
  const out = values.slice();
  const strides = shown.shape.map((_, d) =>
    shown.shape.slice(d + 1).reduce((n, size) => n * size, 1)
  );
  for (const [dimension, axis] of [
    [shown.time?.dimension, keys.time],
    [shown.vertical?.dimension, keys.level],
  ] as const) {
    const d = dimension === undefined ? -1 : shown.dims.indexOf(dimension);
    if (d < 0 || axis.length !== shown.shape[d] || !axis.some(unknownCell)) {
      continue;
    }
    out.forEach((_, at) => {
      if (unknownCell(axis[Math.floor(at / strides[d]) % shown.shape[d]])) {
        out[at] = Number.NaN;
      }
    });
  }
  return { values: out, matched: out.filter(Number.isFinite).length };
}

/** The typical length of a time axis's declared cells, in seconds. */
function cellSeconds(time: TTime & { bounds?: number[] }) {
  const axis = parseTimeAxis(time.units, time.calendar);
  if (!time.bounds?.length || "unsupported" in axis) {
    return undefined;
  }
  const widths: number[] = [];
  for (let k = 0; k + 1 < time.bounds.length; k += 2) {
    widths.push(Math.abs(time.bounds[k + 1] - time.bounds[k]));
  }
  widths.sort((a, b) => a - b);
  return widths[widths.length >> 1] * axis.unitSeconds;
}

/**
 * Samples over cells of different length are different observations: a daily
 * mean is not the hundredth of a day that shares its date. Compared where both
 * sides declare their cells.
 */
function supportProblem(
  a: (TTime & { bounds?: number[] }) | undefined,
  b: (TTime & { bounds?: number[] }) | undefined
) {
  const [mine, theirs] = [a && cellSeconds(a), b && cellSeconds(b)];
  if (!mine || !theirs || Math.abs(mine - theirs) <= 0.01 * mine) {
    return undefined;
  }
  const words = (seconds: number) =>
    seconds >= 86400
      ? `${Number((seconds / 86400).toPrecision(3))} days`
      : `${Number((seconds / 3600).toPrecision(3))} hours`;
  return `its samples cover ${words(theirs)} each, this plot's ${words(mine)}`;
}

export type TAxes = {
  time?: TTime & { dimension: string; chunk?: number };
  vertical?: {
    dimension: string;
    values: number[];
    units?: string;
    positive?: "up" | "down";
    /** CF standard name of the positions (altitude, height…), if known. */
    standardName?: string;
    /** Published layer bounds, [low, high] per level, flat. */
    bounds?: number[];
    cellMethods?: string;
    quantity?: string;
  };
  /** Other dimensions (members, realizations…), sizes and member IDs. */
  others?: {
    dimension: string;
    size: number;
    ids?: (string | undefined)[];
    idsUnread?: boolean;
    forecastPeriod?: {
      values: number[];
      units?: string;
      seconds?: number;
      /** Published bounds, [low, high] per lead, flat (NaN: unknown). */
      bounds?: number[];
      /** Some leads or bounds are not read yet (a long axis). */
      unread?: boolean;
      lazy?: { array: { chunks: number[] }; read: Set<number> };
      lazyBounds?: object;
    };
  }[];
};

/** A CF calendar's name, with its aliases (unset is the standard one). */
function calendarName(calendar: string | undefined) {
  const name = (calendar ?? "standard").trim().toLowerCase();
  const alias: Record<string, string> = {
    gregorian: "standard",
    "365_day": "noleap",
    "366_day": "all_leap",
  };
  return alias[name] ?? name;
}

/**
 * Two vertical quantities measured from different references (an altitude above
 * the geoid and a height above the surface): the same number of metres is not
 * the same place.
 */
function referenceProblem(mine?: string, theirs?: string) {
  if (!mine || !theirs || mine === theirs) {
    return undefined;
  }
  const words = (name: string) => name.replace(/_/g, " ");
  return `its levels are ${words(theirs)}, this plot's ${words(mine)}`;
}

/**
 * Why two variables cannot be paired sample for sample, before either is read:
 * another calendar (2000-02-30 is no date of the other), heights against
 * depths, or a member dimension the partner lacks or has another number of.
 * Member coordinates are not compared: the same dimension and size are taken as
 * the same members.
 */
// eslint-disable-next-line max-lines-per-function
function pairProblem(query: TAnalysisQuery, own: TAxes, partner: TAxes) {
  if (own.time && partner.time) {
    const [a, b] = [own.time.calendar, partner.time.calendar].map(calendarName);
    if (a !== b) {
      return `its calendar is ${b}, this plot's is ${a}`;
    }
  }
  const [up, them] = [own.vertical, partner.vertical];
  const reference = referenceProblem(up?.standardName, them?.standardName);
  if (reference) {
    return reference;
  }
  if (
    up?.positive &&
    them?.positive &&
    up.positive !== them.positive &&
    converter(up.units, "m") &&
    converter(them.units, "m")
  ) {
    return `its levels count ${them.positive}ward, this plot's ${up.positive}ward`;
  }
  // A partner that varies along an axis this plot does not have would be read
  // at its first entry, unasked. It is refused, saying which.
  if (!up && them && them.values.length > 1) {
    const shown = them.values
      .slice(0, 3)
      .map((value) => `${value}${them.units ? ` ${them.units}` : ""}`)
      .join(", ");
    return `it has ${them.values.length} levels (${shown}${them.values.length > 3 ? ", …" : ""}) and this plot none; choose a partner at a single level`;
  }
  const extra = partner.others?.find(
    (d) =>
      d.size > 1 && !own.others?.some((mine) => mine.dimension === d.dimension)
  );
  if (extra) {
    return `it varies along ${extra.dimension} (${extra.size}${extra.ids ? `: ${extra.ids.slice(0, 3).join(", ")}${extra.size > 3 ? ", …" : ""}` : ""}), which this plot does not have`;
  }
  if (!partner.others) {
    return undefined;
  }
  for (const dimension of Object.keys(query.fixed)) {
    const mine = own.others?.find((d) => d.dimension === dimension);
    if (!mine) {
      continue;
    }
    const theirs = partner.others.find((d) => d.dimension === dimension);
    if (!theirs) {
      return `it has no ${dimension} dimension to match this plot's`;
    }
    if (mine.forecastPeriod || theirs.forecastPeriod) {
      const lead = partnerLead(mine, theirs, query.fixed[dimension]);
      if (typeof lead === "string") {
        return lead;
      }
      continue;
    }
    if (mine.idsUnread || theirs.idsUnread) {
      return `the ${dimension} identifiers of ${mine.idsUnread ? "this plot" : "it"} could not be read`;
    }
    // Members known by ID on one side only cannot be matched to the other.
    if (Boolean(mine.ids) !== Boolean(theirs.ids)) {
      return `its ${dimension} ${theirs.ids ? "has" : "has no"} member IDs, this plot's ${mine.ids ? "has" : "has none"}`;
    }
    // Members known by ID on both sides are matched by it (below); else
    // by position, which needs the same number.
    if (!(mine.ids && theirs.ids) && theirs.size !== mine.size) {
      return `its ${dimension} has ${theirs.size} entries, this plot's ${mine.size}`;
    }
    const id = mine.ids?.[query.fixed[dimension]];
    if (mine.ids && id === undefined) {
      return `this plot's ${dimension} ${query.fixed[dimension]} has no identifier (its declared missing value), so no member matches it`;
    }
    if (mine.ids && theirs.ids && !theirs.ids.includes(id!)) {
      return `it has no ${dimension} ${id}`;
    }
    if (
      mine.ids &&
      theirs.ids &&
      theirs.ids.indexOf(id!) !== theirs.ids.lastIndexOf(id!)
    ) {
      return `its ${dimension} ${id} is listed more than once`;
    }
  }
  return undefined;
}

type TOther = NonNullable<TAxes["others"]>[number];

/**
 * The partner's index of a fixed forecast lead: the one of equal duration,
 * whatever its position or units, over the same published interval where both
 * publish one, or why there is none. A partner whose leads are not read yet is
 * asked for the lead by its duration (`{ seconds }`), found where it is read.
 */

// eslint-disable-next-line max-lines-per-function
function partnerLead(
  mine: TOther,
  theirs: TOther,
  index: number
): number | { seconds: number; interval?: [number, number] } | string {
  const [a, b] = [mine.forecastPeriod, theirs.forecastPeriod];
  if (!a || !b) {
    return `its ${mine.dimension} ${a ? "is not" : "is"} a forecast period, this plot's ${a ? "is" : "is not"}`;
  }
  const lead = a.values[index];
  if (!Number.isFinite(lead) || a.seconds === undefined) {
    return `this plot's forecast period at ${mine.dimension} ${index} is not known`;
  }
  if (b.seconds === undefined) {
    return `its forecast period units (${b.units ?? "none"}) are not a duration`;
  }
  const label = `${lead}${a.units ? ` ${a.units}` : ""}`;
  const want = lead * a.seconds;
  const interval = leadInterval(a, index);
  const sameInterval = (at: number) => {
    const theirs = leadInterval(b, at);
    return (
      interval !== undefined &&
      theirs !== undefined &&
      sameDuration(interval[0], theirs[0]) &&
      sameDuration(interval[1], theirs[1])
    );
  };
  let found: number[] = [];
  b.values.forEach((value, at) => {
    if (sameDuration(value * b.seconds!, want)) {
      found.push(at);
    }
  });
  // Equal leads told apart by their intervals.
  if (found.length > 1 && interval) {
    found = found.filter(sameInterval);
  }
  if (found.length > 1) {
    return `its forecast period ${label} is listed more than once`;
  }
  const unread =
    b.unread ||
    (b.lazy &&
      b.lazy.read.size <
        Math.ceil(b.values.length / Math.max(1, b.lazy.array.chunks[0] ?? 1)));
  if (found.length === 0) {
    return unread
      ? { seconds: want, ...(interval ? { interval } : {}) }
      : `it has no forecast period of ${label}`;
  }
  const theirsInterval = leadInterval(b, found[0]);
  if (
    interval &&
    theirsInterval &&
    !(
      sameDuration(interval[0], theirsInterval[0]) &&
      sameDuration(interval[1], theirsInterval[1])
    )
  ) {
    return `its ${label} lead covers another interval (${intervalText(theirsInterval)} against ${intervalText(interval)})`;
  }
  return found[0];
}

/**
 * Two read forecasts whose leads cover other intervals (a 1 h and a 24 h total
 * ending at +48 h), or one an interval and the other an instant: not the same
 * observations.
 */
function leadSupportProblem(a: TAnalysisResult, b: TAnalysisResult) {
  const lead = (r: TAnalysisResult) =>
    r.selections?.find(
      (s) => s.standardName === "forecast_period" && s.value !== undefined
    );
  const [x, y] = [lead(a), lead(b)];
  const seconds = (s: NonNullable<typeof x>) =>
    s.seconds ?? durationSeconds(s.units);
  // One lead known, the other's not: their valid times cannot be matched.
  if (Boolean(x) !== Boolean(y)) {
    return `${x ? "its" : "this plot's"} lead time is not known`;
  }
  if (!x || !y || seconds(x) === undefined || seconds(y) === undefined) {
    return undefined;
  }
  // The same lead: +24 h and +48 h of one initialization are other dates.
  if (!sameDuration(x.value! * seconds(x)!, y.value! * seconds(y)!)) {
    return `its lead is ${(y.value! * seconds(y)!) / 3600} h, this plot's ${(x.value! * seconds(x)!) / 3600} h`;
  }
  if (x.valueBoundsUnknown || y.valueBoundsUnknown) {
    return `${x.valueBoundsUnknown ? "this plot's" : "its"} lead declares an interval that could not be read`;
  }
  const span = (s: NonNullable<typeof x>) =>
    s.valueBounds?.map((v) => v * seconds(s)!) as [number, number] | undefined;
  const [p, q] = [span(x), span(y)];
  if (!p && !q) {
    return undefined;
  }
  return p && q && sameDuration(p[0], q[0]) && sameDuration(p[1], q[1])
    ? undefined
    : `its lead covers ${q ? intervalText(q) : "an instant"}, this plot's ${p ? intervalText(p) : "an instant"}`;
}

/** A lead's published interval in seconds, if both its ends are known. */
function leadInterval(
  period: NonNullable<TOther["forecastPeriod"]>,
  index: number
) {
  const [low, high] = [
    period.bounds?.[2 * index],
    period.bounds?.[2 * index + 1],
  ];
  return low !== undefined &&
    high !== undefined &&
    Number.isFinite(low) &&
    Number.isFinite(high) &&
    period.seconds !== undefined
    ? ([low * period.seconds, high * period.seconds] as [number, number])
    : undefined;
}

function intervalText([low, high]: [number, number]) {
  return `${low / 3600}–${high / 3600} h`;
}

/** The partner's index of each fixed member: by ID where both have them. */
function partnerMembers(
  query: TAnalysisQuery,
  own: TAxes,
  partner: TAxes,
  next: TAnalysisQuery
) {
  for (const [dimension, index] of Object.entries(query.fixed)) {
    const mine = own.others?.find((d) => d.dimension === dimension);
    const theirs = partner.others?.find((d) => d.dimension === dimension);
    if (mine && theirs && (mine.forecastPeriod || theirs.forecastPeriod)) {
      const lead = partnerLead(mine, theirs, index);
      next.fixed[dimension] = typeof lead === "number" ? lead : -1;
      if (typeof lead === "object") {
        next.leadSeconds = { ...next.leadSeconds, [dimension]: lead.seconds };
        if (lead.interval) {
          next.leadInterval = {
            ...next.leadInterval,
            [dimension]: lead.interval,
          };
        }
      }
    } else if (mine?.ids && theirs?.ids) {
      const id = mine.ids[index];
      next.fixed[dimension] = id === undefined ? -1 : theirs.ids.indexOf(id);
    }
  }
}

/**
 * Sparse times read as runs of whole stored chunks: two dates 40,000 days apart
 * are two chunks, not 40,001 dates. Indices within the same or the next chunk
 * join one run.
 */
export function timeRuns(found: number[], chunk: number) {
  const runs: { start: number; stop: number }[] = [];
  for (const at of found) {
    const last = runs.at(-1);
    if (
      last &&
      Math.floor(at / chunk) <= Math.floor((last.stop - 1) / chunk) + 1
    ) {
      last.stop = at + 1;
    } else {
      runs.push({ start: at, stop: at + 1 });
    }
  }
  return runs;
}

/** A partner query's times as separate runs, when they are sparse. */
const piecesOf = new WeakMap<
  TAnalysisQuery,
  { start: number; stop: number; chunk?: number }[]
>();
export function partnerPieces(query: TAnalysisQuery) {
  return piecesOf.get(query);
}

/** A copy of a partner query (a field added) keeps its sparse date pieces. */
export function withPieces<T extends TAnalysisQuery>(
  from: TAnalysisQuery,
  to: T
): T {
  const pieces = piecesOf.get(from);
  if (pieces) {
    piecesOf.set(to, pieces);
  }
  return to;
}

/**
 * The partner's stored time chunks a plot query reads (its dates found on the
 * partner's axis): the new ones of a longer request are what an Extend reads
 * for it.
 */
export function partnerTimeChunks(
  query: TAnalysisQuery,
  own: TAxes,
  partner: TAxes,
  variable: string
) {
  const next = partnerQuery(query, own, partner, variable);
  if ("reason" in next || !next.time) {
    return undefined;
  }
  const chunk = partner.time?.chunk ?? 1;
  const chunks = new Set<number>();
  for (const piece of partnerPieces(next) ?? [next.time]) {
    const last = Math.floor((piece.stop - 1) / chunk);
    for (let c = Math.floor(piece.start / chunk); c <= last; c++) {
      chunks.add(c);
    }
  }
  return chunks;
}

/** Each key's rows along a keys array (cached with the keys themselves). */
const rowsByKey = new WeakMap<string[], Map<string, number[]>>();

/** Indices of `wanted` keys along `keys`, ascending: looked up, not scanned. */
function indicesOf(keys: string[], wanted: Set<string>) {
  let index = rowsByKey.get(keys);
  if (!index) {
    index = new Map();
    for (let at = 0; at < keys.length; at++) {
      const rows = index.get(keys[at]);
      if (rows) {
        rows.push(at);
      } else {
        index.set(keys[at], [at]);
      }
    }
    rowsByKey.set(keys, index);
  }
  const found: number[] = [];
  // A cell of unknown bounds is no observation: two of them are not one.
  for (const key of wanted) {
    if (!unknownCell(key)) {
      for (const at of index.get(key) ?? []) {
        found.push(at);
      }
    }
  }
  return found.sort((a, b) => a - b);
}

/** Sets `next`'s times to the plot's on the partner's axis; or why not. */
// eslint-disable-next-line max-lines-per-function
function partnerTimes(
  next: TAnalysisQuery,
  query: TAnalysisQuery,
  own: TAxes,
  partner: TAxes
): string | undefined {
  if (own.time && partner.time) {
    // By the clock the reads are matched by, and each row's run.
    const [mine, them] = [own.time, partner.time].map((t) => ({
      ...t,
      ...physicalClock(t),
    }));
    const runs = withCycles(["x"], own.time, partner.time)[0] !== "x";
    // The same rule as the join after reading: decided from the bounds and
    // cell methods alone, before any partner field read.
    if (
      sameTimeAxis(mine, them) &&
      (!runs || sameTimeAxis(own.time, partner.time))
    ) {
      sameAxisTimes(next, query, partner.time.chunk ?? 1);
      const fixed = query.fixed[own.time.dimension];
      // One known, unrepeated date: equal axes do not make a missing or
      // repeated date the same observation.
      const problem =
        fixed === undefined ? undefined : fixedTimeProblem(own.time, fixed);
      if (problem) {
        return problem;
      }
      if (fixed !== undefined) {
        delete next.fixed[own.time.dimension];
        next.fixed[partner.time.dimension] = fixed;
      }
      return undefined;
    }
    const mode = matchMode(mine, them);
    const keys = withCycles(
      observationKeys(mine, mode),
      own.time,
      partner.time
    );
    const theirs = withCycles(
      observationKeys(them, mode),
      partner.time,
      own.time
    );
    if (query.time) {
      // The plot's own dates, in one slice or several (timeSelection.ts).
      const wanted = new Set(rowIndices(query.time).map((at) => keys[at]));
      const found = indicesOf(theirs, wanted);
      if (!found.length) {
        return mode === "intervals"
          ? (supportProblem(own.time, partner.time) ??
              "its time cells are other intervals than this plot's")
          : "it shares no times with this plot";
      }
      next.time = { start: found[0], stop: found[found.length - 1] + 1 };
      // Each piece with the partner's chunk length: a quote counts the stored
      // chunks it reads.
      const chunk = partner.time.chunk ?? 1;
      const pieces = timeRuns(found, chunk).map((p) => ({ ...p, chunk }));
      // One run too, with its chunk span: priced as one unit it made each of
      // its 33 chunks the price of all 33.
      if (pieces.length) {
        piecesOf.set(next, pieces);
      }
    }
    const fixed = query.fixed[own.time.dimension];
    if (fixed !== undefined) {
      const found = indicesOf(theirs, new Set([keys[fixed]]));
      if (found.length !== 1) {
        return found.length
          ? "its time of this plot repeats"
          : "it has no sample at this plot's time";
      }
      delete next.fixed[own.time.dimension];
      next.fixed[partner.time.dimension] = found[0];
    }
  }
  return undefined;
}

/** Why the date at `index` is no observation to pair, if it is not. */
function fixedTimeProblem(time: TTime, index: number) {
  const value = time.raw[index];
  const bounded = time.bounds
    ? [time.bounds[2 * index], time.bounds[2 * index + 1]]
    : [];
  if (!Number.isFinite(value) || !bounded.every(Number.isFinite)) {
    return "it has no sample at this plot's time";
  }
  for (let k = 0; k < time.raw.length; k++) {
    if (k !== index && time.raw[k] === value) {
      return "its time of this plot repeats";
    }
  }
  return undefined;
}

/**
 * Equal time axes, compared once per set of coordinate and bounds arrays, also
 * when the bounds are allocated apart.
 */
const equalAxes = new WeakMap<
  object,
  WeakMap<object, WeakMap<object, WeakMap<object, boolean>>>
>();
const NO_BOUNDS = {};

function remembered(a: TTime, b: TTime) {
  return equalAxes
    .get(a.raw)
    ?.get(b.raw)
    ?.get(a.bounds ?? NO_BOUNDS)
    ?.get(b.bounds ?? NO_BOUNDS);
}

function remember(a: TTime, b: TTime, same: boolean) {
  const level = <K extends object, V>(
    map: WeakMap<K, V>,
    key: K,
    make: () => V
  ) => map.get(key) ?? map.set(key, make()).get(key)!;
  const byB = level(equalAxes, a.raw, () => new WeakMap());
  const byBoundsA = level(byB, b.raw, () => new WeakMap());
  level(
    byBoundsA,
    a.bounds ?? NO_BOUNDS,
    () => new WeakMap<object, boolean>()
  ).set(b.bounds ?? NO_BOUNDS, same);
}

/**
 * Whether two time axes are one (the same values, bounds, units and calendar,
 * as two components of one store have): the partner's rows are the plot's,
 * found without a date per row.
 */
function sameTimeAxis(a: TTime, b: TTime) {
  if (
    a.units !== b.units ||
    calendarName(a.calendar) !== calendarName(b.calendar) ||
    a.raw.length !== b.raw.length ||
    Boolean(a.bounds) !== Boolean(b.bounds)
  ) {
    return false;
  }
  const known = remembered(a, b);
  if (known !== undefined) {
    return known;
  }
  const equal = (x: ArrayLike<number>, y: ArrayLike<number>) => {
    if (x === y) {
      return true;
    }
    for (let k = 0; k < x.length; k++) {
      if (!(x[k] === y[k] || (Number.isNaN(x[k]) && Number.isNaN(y[k])))) {
        return false;
      }
    }
    return x.length === y.length;
  };
  const same =
    equal(a.raw, b.raw) &&
    (!a.bounds || a.bounds === b.bounds || equal(a.bounds, b.bounds!));
  remember(a, b, same);
  return same;
}

/** The partner's times on one axis with the plot's: its own rows, pieced. */
function sameAxisTimes(
  next: TAnalysisQuery,
  query: TAnalysisQuery,
  chunk: number
) {
  if (query.time) {
    const runs = query.time.runs ?? [[query.time.start, query.time.stop]];
    next.time = { start: query.time.start, stop: query.time.stop };
    // As timeRuns pieces them: runs in the same or the next chunk join.
    const pieces: { start: number; stop: number; chunk: number }[] = [];
    for (const [start, stop] of runs) {
      if (stop <= start) {
        continue;
      }
      const last = pieces.at(-1);
      if (
        last &&
        Math.floor(start / chunk) <= Math.floor((last.stop - 1) / chunk) + 1
      ) {
        last.stop = stop;
      } else {
        pieces.push({ start, stop, chunk });
      }
    }
    if (pieces.length) {
      next.time = { start: pieces[0].start, stop: pieces.at(-1)!.stop };
      piecesOf.set(next, pieces);
    }
  }
}

/**
 * The plot's query for another variable (`partner`), on that variable's
 * own axes: the plot's times and level found by what they are, so a
 * partner stored in another order, over other dates or on other levels is
 * read where the plot's samples are. `own` describes the plot's variable.
 */
export function partnerQuery(
  query: TAnalysisQuery,
  own: TAxes,
  partner: TAxes,
  variable: string
): TAnalysisQuery | { reason: string } {
  const problem = pairProblem(query, own, partner);
  if (problem) {
    return { reason: problem };
  }
  const next: TAnalysisQuery = {
    ...query,
    variable,
    fixed: { ...query.fixed },
  };
  partnerMembers(query, own, partner, next);
  const timeProblem = partnerTimes(next, query, own, partner);
  if (timeProblem) {
    return { reason: timeProblem };
  }
  const at = query.level;
  if (at !== undefined && own.vertical && partner.vertical) {
    const key = levelKey(
      own.vertical.values[at],
      own.vertical.units,
      own.vertical.positive
    );
    const found = indicesOf(
      partner.vertical.values.map((v) =>
        levelKey(v, partner.vertical?.units, partner.vertical?.positive)
      ),
      new Set([key])
    );
    if (found.length !== 1) {
      return { reason: "it is not at this plot's level" };
    }
    if (otherLayer(own.vertical, at, partner.vertical, found[0])) {
      return { reason: "it is a statistic over another layer" };
    }
    next.level = found[0];
  }
  return next;
}

/**
 * Two statistics over layers at one level, over different layers: decided from
 * the published bounds before any partner read.
 */
function otherLayer(
  own: NonNullable<TAxes["vertical"]>,
  at: number,
  partner: NonNullable<TAxes["vertical"]>,
  their: number
) {
  const layer = (v: typeof own, k: number) => {
    const [lo, hi] = [v.bounds?.[2 * k], v.bounds?.[2 * k + 1]];
    return lo !== undefined &&
      hi !== undefined &&
      Number.isFinite(lo) &&
      Number.isFinite(hi) &&
      layerMethod(v.cellMethods, v.quantity, v.dimension)
      ? [lo, hi]
          .map((edge) => levelKey(edge, v.units, v.positive))
          .sort()
          .join("..")
      : undefined;
  };
  const [a, b] = [layer(own, at), layer(partner, their)];
  return a !== undefined && b !== undefined && a !== b;
}

/**
 * Variables that describe others rather than a quantity of their own: CF
 * quality flags (flag values, masks or meanings; *status_flag and
 * *quality_flag standard names), cell measures (cell_area, cell_volume, or
 * named by any variable's cell_measures), declared ancillary variables,
 * cell and climatology bounds, and auxiliary coordinates.
 */
export function ancillaryNames(
  variables: Record<string, { attrs?: Record<string, unknown> }>
) {
  const names = new Set<string>();
  for (const [name, { attrs = {} }] of Object.entries(variables)) {
    const standard = String(attrs.standard_name ?? "");
    if (
      attrs.flag_values !== undefined ||
      attrs.flag_masks !== undefined ||
      attrs.flag_meanings !== undefined ||
      /(status|quality)_flag$|^cell_(area|volume)$/.test(standard)
    ) {
      names.add(name);
    }
    for (const [, measure] of String(attrs.cell_measures ?? "").matchAll(
      /\w+:\s*(\S+)/g
    )) {
      names.add(measure);
    }
    // Declared ancillaries, cell boundaries, climatology bounds and auxiliary
    // coordinates are no field of their own.
    for (const linked of [
      attrs.ancillary_variables,
      attrs.bounds,
      attrs.climatology,
      attrs.coordinates,
    ]) {
      for (const name of String(linked ?? "").split(/\s+/)) {
        if (name) {
          names.add(name);
        }
      }
    }
  }
  return names;
}

/**
 * The fields a plot of `plotted` can be scattered against: the dataset's
 * other variables that are fields, not coordinates, bounds or formula
 * terms (the source index marks those), by name.
 */
/**
 * A variable as a choice to scatter against: its name, with its CF
 * standard name in words and its units, so "so" or "var129" says what it
 * is before it is read.
 */
export function pairHint(
  name: string,
  entry: { standardName?: string; units?: string } | undefined
) {
  const quantity = entry?.standardName?.replace(/_/g, " ");
  const units = entry?.units?.trim();
  const about = [quantity, units].filter(Boolean).join(", ");
  return {
    name,
    label: about ? `${name} (${about})` : name,
    title: quantity ?? "",
  };
}

export function pairCandidates(
  variables: Record<
    string,
    {
      support?: boolean;
      dims?: string[];
      shape?: number[];
      standardName?: string;
      axis?: string;
    }
  >,
  plotted: string | undefined
) {
  // Members the plot does not have cannot pair with its one sample per date:
  // known from the listed dimensions, before any read.
  const own = plotted ? variables[plotted]?.dims : undefined;
  const extraMembers = (entry: { dims?: string[]; shape?: number[] }) =>
    Boolean(
      own &&
      entry.dims?.some(
        (dim, at) =>
          !own.includes(dim) &&
          (entry.shape?.[at] ?? 0) > 1 &&
          looksEnsemble(dim, {
            // eslint-disable-next-line camelcase -- CF attribute name
            standard_name: variables[dim]?.standardName,
            axis: variables[dim]?.axis,
          })
      )
    );
  return Object.entries(variables)
    .filter(
      ([name, entry]) =>
        name !== plotted && !entry.support && !extraMembers(entry)
    )
    .map(([name]) => name)
    .sort();
}
