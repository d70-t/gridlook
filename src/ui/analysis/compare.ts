/**
 * Comparing time series against a reference (observations, or a chosen
 * run): pairs matched by date, Taylor statistics (correlation, standard
 * deviations, centred RMS difference) with the mean bias kept apart, and
 * a portrait of errors by season relative to the median series.
 */

import { niceTicks } from "./heatmapRaster.ts";
import { dateKey, monthOf } from "./timeViews.ts";

import {
  decodeTimeValue,
  durationSeconds,
  encodeTimeValue,
  parseTimeAxis,
} from "@/lib/analysis/calendar.ts";
import {
  cellMethodSteps,
  namedIntervals,
  stepsByAxis,
  timeCellMethod,
} from "@/lib/analysis/cellMethods.ts";
import {
  matchMode,
  observationKeys,
  overCells,
  unknownCell,
} from "@/lib/analysis/companionAlign.ts";
import { rateKind } from "@/lib/analysis/displayUnits.ts";
import { converter, sameUnits } from "@/lib/analysis/unitConvert.ts";

/**
 * A series as dates (YYYY-MM-DD hh:mm:ss.mmm) and values; `exact` for
 * raw offsets of a calendar without a decoder, which match only as
 * written (with their units and calendar), never by day or month.
 */
export type TDatedSeries = {
  dates: string[];
  values: number[];
  exact?: boolean;
  /** The CF calendar the dates are of (360_day: 30 days a month). */
  calendar?: string;
  /**
   * Whether its declared time cells are each a month: only such series are
   * averaged by month.
   */
  monthlyCells?: boolean;
  /**
   * The axis itself (raw offsets, units, calendar, bounds, cell methods): pairs
   * are then matched as Against matches them, by observation.
   */
  time?: {
    raw: number[];
    units?: string;
    calendar?: string;
    bounds?: number[];
    cellMethods?: string;
    /** The time dimension's name, which cell_methods may use for time. */
    dimension?: string;
    /** Why its declared bounds could not be read, when they could not. */
    boundsUnread?: string;
    /** Intensive or extensive: what bounds without cell_methods mean. */
    quantity?: "intensive" | "extensive";
  };
};

type TForecastAxis = {
  raw: number[];
  units?: string;
  bounds?: number[];
  standardName?: string;
  /** Valid times the source publishes beside its reference times. */
  valid?: number[];
  validBounds?: number[];
  validBoundsUnread?: string;
  clockProblem?: string;
};

/** Published valid times of each row, when the source gives them all. */
function publishedValid(time: Pick<TForecastAxis, "raw" | "valid">) {
  return time.valid && time.valid.length === time.raw.length
    ? time.valid
    : undefined;
}
type TLeadSelection = {
  standardName?: string;
  value?: number;
  units?: string;
  seconds?: number;
  valueBounds?: [number, number];
  valueBoundsUnknown?: true;
};

/** A lead declaring an interval it could not read. */
const UNKNOWN_SUPPORT =
  "its lead declares an interval that could not be read, so which hours each value covers is unknown";

/**
 * A forecast plot's axis at its valid times (reference + fixed lead, and an
 * accumulation's lead interval as bounds), so plots pair by the moment
 * forecast, not by initialization; without a known lead, why it cannot be
 * compared.
 */
/** Why a forecast's valid times are unknown, without building them. */
export function validTimeProblem(
  time: Pick<TForecastAxis, "standardName" | "units" | "raw" | "valid">,
  selections: TLeadSelection[] = []
) {
  if (time.standardName !== "forecast_reference_time" || publishedValid(time)) {
    return undefined;
  }
  const lead = selections.find(
    (s) => s.standardName === "forecast_period" && s.value !== undefined
  );
  const seconds = lead?.seconds ?? durationSeconds(lead?.units);
  return !lead || !durationSeconds(time.units) || seconds === undefined
    ? "its times are forecast initializations with no known lead, so its valid times are unknown"
    : lead.valueBoundsUnknown
      ? UNKNOWN_SUPPORT
      : undefined;
}

// eslint-disable-next-line max-lines-per-function
export function validTimeAxis<T extends TForecastAxis>(
  time: T,
  selections: TLeadSelection[] = []
): T | { reason: string } {
  if (time.standardName !== "forecast_reference_time") {
    return time;
  }
  if (time.clockProblem) {
    return { reason: time.clockProblem };
  }
  // Published valid times: those, as the source dates each row, with the cells
  // published beside them.
  const valid = publishedValid(time);
  if (valid) {
    if (time.validBoundsUnread) {
      return { reason: UNKNOWN_SUPPORT };
    }
    return {
      ...time,
      raw: valid,
      bounds: time.validBounds,
      standardName: "time",
    };
  }
  const lead = selections.find(
    (s) => s.standardName === "forecast_period" && s.value !== undefined
  );
  const perUnit = durationSeconds(time.units);
  const seconds = lead?.seconds ?? durationSeconds(lead?.units);
  if (!lead || !perUnit || seconds === undefined) {
    return {
      reason:
        "its times are forecast initializations with no known lead, so its valid times are unknown",
    };
  }
  if (lead.valueBoundsUnknown) {
    return { reason: UNKNOWN_SUPPORT };
  }
  const scale = seconds / perUnit;
  const shift = lead.value! * scale;
  const interval = lead.valueBounds;
  return {
    ...time,
    raw: time.raw.map((v) => v + shift),
    bounds: interval
      ? time.raw.flatMap((v) => [
          v + interval[0] * scale,
          v + interval[1] * scale,
        ])
      : time.bounds?.map((v) => v + shift),
    standardName: "time",
  };
}

/**
 * Values keyed by their full time stamp, day or month (a prefix of the
 * date); a day or month key averages the values within it.
 */
function keyed(series: TDatedSeries, length?: number) {
  const sums = new Map<string, { sum: number; n: number }>();
  series.dates.forEach((date, at) => {
    const value = series.values[at];
    if (!Number.isFinite(value) || !date) {
      return;
    }
    const key = date.slice(0, length);
    const entry = sums.get(key) ?? { sum: 0, n: 0 };
    entry.sum += value;
    entry.n++;
    sums.set(key, entry);
  });
  return new Map([...sums].map(([key, { sum, n }]) => [key, sum / n]));
}

const MATCHES = [
  { length: undefined, by: "time" },
  { length: 10, by: "day" },
  { length: 7, by: "month" },
] as const;

/** Whether a series has at most one value per month: monthly means. */
function monthly(series: TDatedSeries) {
  const months = new Set<string>();
  for (const [at, date] of series.dates.entries()) {
    if (date && Number.isFinite(series.values[at])) {
      const month = dateKey(date, 7);
      if (months.has(month)) {
        return false;
      }
      months.add(month);
    }
  }
  return months.size > 0;
}

/**
 * The reference and a series at their common times, in time order: at the
 * same time stamps (to the millisecond) when they share three or more
 * (subdaily series stay subdaily), else as daily means; as monthly means
 * only when both are monthly (monthly means stamped on different days).
 * Otherwise the finest matching with the most common times.
 */
export function pairSeries(reference: TDatedSeries, other: TDatedSeries) {
  // Nothing to pair with: no reference date is keyed.
  if (!other.values.length || !reference.values.length) {
    return noPairs(reference);
  }
  if (reference.time && other.time) {
    return pairObservations(reference, other);
  }
  const exact = reference.exact || other.exact;
  const both =
    monthly(reference) &&
    monthly(other) &&
    Boolean(reference.monthlyCells && other.monthlyCells);
  // Dates of two calendars name different days (2001-02-30 is none of the
  // standard calendar's): only monthly means are paired across them, by month.
  const across = calendarOf(reference) !== calendarOf(other);
  let best: ReturnType<typeof pairAt> | undefined;
  for (const { length, by } of MATCHES) {
    if (
      (exact && by !== "time") ||
      (by === "month" && !both) ||
      (across && by !== "month")
    ) {
      continue;
    }
    const pair = pairAt(reference, other, length, by);
    if (pair.keys.length >= 3) {
      return pair;
    }
    best = best && best.keys.length >= pair.keys.length ? best : pair;
  }
  return (
    best ?? {
      keys: [],
      by: "time" as const,
      calendar: reference.calendar,
      reference: [],
      other: [],
    }
  );
}

const noPairs = (reference: TDatedSeries) => ({
  keys: [] as string[],
  by: "time" as "time" | "interval" | "month" | "day",
  calendar: reference.calendar,
  reference: [] as number[],
  other: [] as number[],
});

/**
 * Pairs by observation, one rule with Against: the same instant to the
 * microsecond, or, for statistics over declared cells on both sides, the same
 * interval. Nothing is averaged to make pairs: two readings a microsecond apart
 * are not one observation. Across calendars only statistics over whole calendar
 * months are paired, by month.
 */
// eslint-disable-next-line max-lines-per-function
function pairObservations(reference: TDatedSeries, other: TDatedSeries) {
  const [a, b] = [reference.time!, other.time!];
  // Statistics over cells whose bounds could not be read: their intervals are
  // unknown, so no stamp says which observation they are. Readings at instants
  // need no bounds: a point method, or an intensive quantity without one.
  const unread = (time: typeof a) => {
    const method = timeCellMethod(time.cellMethods, time.dimension);
    const instants =
      method === "point" ||
      (method === undefined && time.quantity === "intensive");
    // Some rows' bounds known: those pair, the unknown ones match nothing.
    const someKnown = time.bounds?.some(Number.isFinite) ?? false;
    return Boolean(time.boundsUnread) && !instants && !someKnown;
  };
  if (unread(a) || unread(b)) {
    return noPairs(reference);
  }
  if (calendarOf(reference) !== calendarOf(other)) {
    // By the month each cell covers, from its bounds in its own calendar, not
    // by its stamp.
    const [ma, mb] = [calendarMonths(reference), calendarMonths(other)];
    return overCells(a) && overCells(b) && ma && mb
      ? pairByKey(reference, other, ma, mb)
      : noPairs(reference);
  }
  // An interval statistic and a reading at an instant are no one observation:
  // no error scores between them.
  if (overCells(a) !== overCells(b)) {
    return noPairs(reference);
  }
  const mode = matchMode(a, b);
  const [ka, kb] = [observationKeys(a, mode), observationKeys(b, mode)];
  // A key repeated on either side is ambiguous: it pairs nothing.
  const count = (keys: string[]) => {
    const n = new Map<string, number>();
    keys.forEach((key) => n.set(key, (n.get(key) ?? 0) + 1));
    return n;
  };
  const [na, nb] = [count(ka), count(kb)];
  const at = new Map(kb.map((key, index) => [key, index]));
  const rows = ka
    .map((key, index) => ({ index, partner: at.get(key), key }))
    .filter(
      ({ index, partner, key }) =>
        partner !== undefined &&
        !unknownCell(key) &&
        na.get(key) === 1 &&
        nb.get(key) === 1 &&
        Number.isFinite(reference.values[index]) &&
        Number.isFinite(other.values[partner])
    )
    .sort((x, y) => a.raw[x.index] - a.raw[y.index]);
  return {
    keys: rows.map(({ index }) => preciseLabel(reference, index)),
    by: mode === "intervals" ? ("interval" as const) : ("time" as const),
    calendar: reference.calendar,
    reference: rows.map(({ index }) => reference.values[index]),
    other: rows.map(({ partner }) => other.values[partner!]),
    // The month each cell covers (its middle), not its stamp's: a February mean
    // stamped 1 March is winter.
    ...(mode === "intervals"
      ? { months: rows.map(({ index }) => coveredMonth(reference, index)) }
      : {}),
  };
}

/** The calendar month (1–12) of the middle of a row's declared cell. */
function coveredMonth(series: TDatedSeries, at: number) {
  const time = series.time!;
  const axis = parseTimeAxis(
    time.units ?? "",
    time.calendar ?? series.calendar
  );
  const [low, high] = [time.bounds![2 * at], time.bounds![2 * at + 1]];
  return "unsupported" in axis || !Number.isFinite(low + high)
    ? undefined
    : decodeTimeValue(axis, (low + high) / 2).month;
}

/**
 * Each row's calendar month ("YYYY-MM") when every row with a value is a
 * whole calendar month of its own calendar: its bounds run from the first
 * instant of a month to the first of the next. Undefined otherwise (a
 * 30-day window shifted by two weeks is no calendar month).
 */
function calendarMonths(series: TDatedSeries) {
  const time = series.time;
  if (!time?.bounds || !time.units) {
    return undefined;
  }
  const axis = parseTimeAxis(time.units, time.calendar ?? series.calendar);
  if ("unsupported" in axis) {
    return undefined;
  }
  const keys: (string | undefined)[] = [];
  const seen = new Set<string>();
  for (let at = 0; at < time.raw.length; at++) {
    if (!Number.isFinite(series.values[at])) {
      keys.push(undefined);
      continue;
    }
    const [low, high] = [time.bounds[2 * at], time.bounds[2 * at + 1]];
    // An unknown cell pairs nothing, the known months still do.
    if (!Number.isFinite(low) || !Number.isFinite(high)) {
      keys.push(undefined);
      continue;
    }
    const [from, to] = [
      decodeTimeValue(axis, Math.min(low, high)),
      decodeTimeValue(axis, Math.max(low, high)),
    ];
    const first = (d: typeof from) =>
      d.day === 1 && d.hour === 0 && d.minute === 0 && d.second === 0;
    const next = to.year * 12 + to.month === from.year * 12 + from.month + 1;
    if (!first(from) || !first(to) || !next) {
      return undefined;
    }
    const key = `${from.year < 0 ? "-" : ""}${String(Math.abs(from.year)).padStart(4, "0")}-${String(from.month).padStart(2, "0")}`;
    if (seen.has(key)) {
      return undefined;
    }
    seen.add(key);
    keys.push(key);
  }
  return seen.size ? keys : undefined;
}

/** Pairs where both series have a value under the same key. */
function pairByKey(
  reference: TDatedSeries,
  other: TDatedSeries,
  ka: (string | undefined)[],
  kb: (string | undefined)[]
) {
  const at = new Map(
    kb.flatMap((key, index) => (key === undefined ? [] : [[key, index]]))
  );
  const rows = ka
    .flatMap((key, index) =>
      key !== undefined && at.has(key)
        ? [{ key, index, partner: at.get(key)! }]
        : []
    )
    .filter(
      ({ index, partner }) =>
        Number.isFinite(reference.values[index]) &&
        Number.isFinite(other.values[partner])
    )
    .sort((x, y) => (x.key < y.key ? -1 : x.key > y.key ? 1 : 0));
  return {
    keys: rows.map(({ key }) => key),
    by: "month" as const,
    calendar: reference.calendar,
    reference: rows.map(({ index }) => reference.values[index]),
    other: rows.map(({ partner }) => other.values[partner]),
  };
}

/**
 * A row's date as a pair key: its label, with microseconds when it has time
 * below the millisecond.
 */
function preciseLabel(series: TDatedSeries, index: number) {
  const label = series.dates[index];
  const time = series.time;
  if (!time?.units) {
    return label;
  }
  const axis = parseTimeAxis(time.units, time.calendar ?? series.calendar);
  if ("unsupported" in axis) {
    return label;
  }
  // Microseconds into the second, from the raw value (decoding rounds
  // to the millisecond), then the whole second decoded.
  const ref = axis.reference;
  const seconds =
    time.raw[index] * axis.unitSeconds +
    ref.hour * 3600 +
    ref.minute * 60 +
    ref.second;
  const micro =
    ((Math.round(seconds * 1e6) % 1_000_000) + 1_000_000) % 1_000_000;
  if (micro % 1000 === 0) {
    return label;
  }
  const d = decodeTimeValue(
    axis,
    time.raw[index] - micro / 1e6 / axis.unitSeconds
  );
  const whole = Math.round(d.second);
  const pad = (v: number, n = 2) => String(v).padStart(n, "0");
  return `${pad(d.year, 4)}-${pad(d.month)}-${pad(d.day)} ${pad(d.hour)}:${pad(d.minute)}:${pad(whole)}.${pad(micro, 6)}`;
}

/** A series' calendar, its aliases as one name. */
function calendarOf(series: TDatedSeries) {
  const name = (series.calendar ?? "standard").trim().toLowerCase();
  const alias: Record<string, string> = {
    gregorian: "standard",
    // eslint-disable-next-line camelcase -- a CF calendar name.
    proleptic_gregorian: "proleptic_gregorian",
    "365_day": "noleap",
    "366_day": "all_leap",
  };
  return alias[name] ?? name;
}

function pairAt(
  reference: TDatedSeries,
  other: TDatedSeries,
  length: number | undefined,
  by: (typeof MATCHES)[number]["by"]
) {
  const a = keyed(reference, length);
  const b = keyed(other, length);
  const order = byTime(reference.calendar);
  const keys = [...a.keys()].filter((key) => b.has(key)).sort(order);
  return {
    keys,
    by,
    calendar: reference.calendar,
    reference: keys.map((key) => a.get(key)!),
    other: keys.map((key) => b.get(key)!),
  };
}

/**
 * A key's position in days, for drawing by elapsed time: a date (to the
 * millisecond), a day or a month; a raw offset as its number.
 */
export function keyDays(key: string, calendar?: string) {
  const m =
    /^(-?\d+)-(\d\d)(?:-(\d\d)(?: (\d\d):(\d\d):(\d\d)(?:\.(\d+))?)?)?$/.exec(
      key
    );
  if (!m) {
    return Number(key.split(" ")[0]);
  }
  const [y, mo, d, h, mi, sec] = m
    .slice(1, 7)
    .map((part, at) => Number(part ?? (at === 2 ? 1 : 0)));
  // The whole fraction: microseconds apart are apart.
  const fraction = Number(`0.${m[7] ?? "0"}`);
  const within = (h + mi / 60 + (sec + fraction) / 3600) / 24;
  // In the series' own calendar: 2001-02-30 comes before 2001-03-01 in a
  // 360-day year, and no JavaScript date rolls it over.
  const name = (calendar ?? "standard").toLowerCase();
  const fixed: Record<string, number[]> = {
    "360_day": Array.from({ length: 12 }, () => 30),
    noleap: [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
    "365_day": [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
    all_leap: [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31], // eslint-disable-line camelcase
    "366_day": [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
  };
  const months = fixed[name];
  if (months) {
    const year = months.reduce((p, n) => p + n, 0);
    const before = months.slice(0, mo - 1).reduce((p, n) => p + n, 0);
    // From year 2000, not year 0: about 720,000 days hold a fraction only to
    // about 10 µs.
    return (y - 2000) * year + before + (d - 1) + within;
  }
  // The calendar dates were decoded in (Julian before 15 October 1582 on the
  // standard one), not JavaScript's proleptic Gregorian.
  const axis = dayAxis(name);
  try {
    if (!("unsupported" in axis)) {
      const day = { year: y, month: mo, day: d, hour: 0, minute: 0, second: 0 };
      return encodeTimeValue(axis, day) + within;
    }
  } catch {
    // Not a date of that calendar: counted as JavaScript would, below.
  }
  const date = new Date(0);
  date.setUTCFullYear(y, mo - 1, d);
  date.setUTCHours(0, 0, 0, 0);
  return date.getTime() / 86400000 + within;
}

/** "days since 1970-01-01" in each calendar, parsed once. */
const dayAxes = new Map<string, ReturnType<typeof parseTimeAxis>>();
function dayAxis(calendar: string) {
  let axis = dayAxes.get(calendar);
  if (!axis) {
    axis = parseTimeAxis("days since 1970-01-01", calendar);
    dayAxes.set(calendar, axis);
  }
  return axis;
}

const byTime = (calendar?: string) => (a: string, b: string) =>
  keyDays(a, calendar) - keyDays(b, calendar) || (a < b ? -1 : a > b ? 1 : 0);

const mean = (values: number[]) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/**
 * Taylor statistics of `test` against `reference` (same length): Pearson
 * correlation, both standard deviations (population), the centred RMS
 * difference (anomalies about each mean) and the mean bias.
 */
export function taylorStats(reference: number[], test: number[]) {
  const n = reference.length;
  if (n < 2) {
    return undefined;
  }
  // Spreads about one observation of each: a constant series has none exactly.
  const [r0, t0] = [reference[0], test[0]];
  const mr = mean(reference.map((v) => v - r0));
  const mt = mean(test.map((v) => v - t0));
  let srr = 0;
  let stt = 0;
  let srt = 0;
  let diff = 0;
  for (let at = 0; at < n; at++) {
    const r = reference[at] - r0 - mr;
    const t = test[at] - t0 - mt;
    srr += r * r;
    stt += t * t;
    srt += r * t;
    diff += (t - r) ** 2;
  }
  const stdRef = Math.sqrt(srr / n);
  const stdTest = Math.sqrt(stt / n);
  return {
    n,
    correlation: stdRef && stdTest ? srt / Math.sqrt(srr * stt) : Number.NaN,
    stdRef,
    stdTest,
    crmsd: Math.sqrt(diff / n),
    bias: t0 - r0 + (mt - mr),
  };
}

/**
 * Whether a Taylor point is defined: both series vary over their common
 * dates (a constant reference has no spread to normalise by, and no
 * correlation). Bias and RMS difference stay defined either way.
 */
export function onTaylor(s: NonNullable<ReturnType<typeof taylorStats>>) {
  return (
    s.stdRef > 0 &&
    Number.isFinite(s.stdTest / s.stdRef) &&
    Number.isFinite(s.correlation)
  );
}

/** The diagram's outer ratio: 1.25 at least, a margin past the widest. */
export function taylorReach(ratios: number[]) {
  let most = 1.25;
  for (const ratio of ratios) {
    most = Number.isFinite(ratio) ? Math.max(most, ratio) : most;
  }
  return Math.ceil(most * 1.1 * 4) / 4;
}

/** About five rings at round ratios and the reference's (1): bounded. */
export function taylorRings(reach: number) {
  return [...new Set([...niceTicks(0, reach, 5), 1])]
    .filter((r) => r > 0 && r <= reach)
    .sort((a, b) => a - b);
}

export const SEASONS = [
  { name: "DJF", months: [12, 1, 2] },
  { name: "MAM", months: [3, 4, 5] },
  { name: "JJA", months: [6, 7, 8] },
  { name: "SON", months: [9, 10, 11] },
  { name: "All", months: [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12] },
];

/**
 * A portrait (Gleckler) of errors: per series and season the RMS error
 * against the reference, and that error relative to the median across
 * series for the season ((E − median) / median: negative is better).
 */
export function portrait(
  pairs: {
    keys: string[];
    reference: number[];
    other: number[];
    /** Each pair's covered month, where its stamp may say another. */
    months?: (number | undefined)[];
  }[]
) {
  const errors = pairs.map((pair) =>
    SEASONS.map(({ months }) => {
      let sum = 0;
      let n = 0;
      pair.keys.forEach((key, at) => {
        if (months.includes(pair.months?.[at] ?? Number(monthOf(key)))) {
          sum += (pair.other[at] - pair.reference[at]) ** 2;
          n++;
        }
      });
      return n ? Math.sqrt(sum / n) : Number.NaN;
    })
  );
  const relative = errors.map((row) =>
    row.map((error, season) => {
      const column = errors
        .map((other) => other[season])
        .filter(Number.isFinite)
        .sort((a, b) => a - b);
      const middle = column.length
        ? column.length % 2
          ? column[(column.length - 1) / 2]
          : (column[column.length / 2 - 1] + column[column.length / 2]) / 2
        : Number.NaN;
      return middle > 0 ? (error - middle) / middle : Number.NaN;
    })
  );
  return { errors, relative };
}

/** A paired series: the reference and another at their common dates. */
export type TPair = ReturnType<typeof pairSeries>;

/** The difference from the reference at each common date (a bias series). */
export function biasSeries(pair: TPair) {
  return {
    keys: pair.keys,
    values: pair.other.map((value, at) => value - pair.reference[at]),
  };
}

/** The value at fraction `p` of sorted values (linear between ranks). */
function quantile(sorted: number[], p: number) {
  const k = (sorted.length - 1) * p;
  const lo = Math.floor(k);
  return sorted[lo] + (sorted[Math.ceil(k)] - sorted[lo]) * (k - lo);
}

/**
 * A Q–Q plot's points: the 1st to 99th percentiles of the reference and of
 * the other series, from the paired values (so both cover the same dates).
 */
export function quantilePairs(pair: TPair, count = 99) {
  const a = [...pair.reference].sort((x, y) => x - y);
  const b = [...pair.other].sort((x, y) => x - y);
  if (a.length < 2) {
    return [];
  }
  return Array.from({ length: count }, (_, k) => {
    const p = (k + 1) / (count + 1);
    return { p, reference: quantile(a, p), other: quantile(b, p) };
  });
}

/**
 * Parallel coordinates of the scores, each axis oriented so that the top
 * is better: correlation (1 best), σ/σref (1 best: drawn as closeness
 * |1 − ratio|, inverted), centred RMS difference and |bias| relative to
 * σref (0 best, inverted). Each value is placed 0–1 along its axis, spread
 * over the plots' own range (the reference's ideal included).
 */
const PARALLEL_AXES = [
  { name: "Correlation", ideal: 1 },
  { name: "|1 − σ/σref|", ideal: 0 },
  { name: "cRMSD / σref", ideal: 0 },
  { name: "|bias| / σref", ideal: 0 },
] as const;

export function parallelScores(
  stats: NonNullable<ReturnType<typeof taylorStats>>[]
) {
  const raw = stats.map((s) => [
    s.correlation,
    Math.abs(1 - s.stdTest / s.stdRef),
    s.crmsd / s.stdRef,
    Math.abs(s.bias) / s.stdRef,
  ]);
  const axes = PARALLEL_AXES.map((axis, k) => {
    const values = [axis.ideal, ...raw.map((row) => row[k])].filter(
      Number.isFinite
    );
    return { ...axis, min: Math.min(...values), max: Math.max(...values) };
  });
  // 1 at the top for the better end: high correlation, small errors.
  // An undefined score (a constant reference) is not placed: NaN.
  const place = (value: number, k: number) => {
    if (!Number.isFinite(value)) {
      return Number.NaN;
    }
    const { min, max } = axes[k];
    // Every value equals the ideal (the axis spans it): all are best.
    if (!(max > min)) {
      return 1;
    }
    const t = (value - min) / (max - min);
    return k === 0 ? t : 1 - t;
  };
  return {
    axes,
    rows: raw.map((row) => ({
      values: row,
      placed: row.map((value, k) => place(value, k)),
    })),
    ideal: PARALLEL_AXES.map((axis, k) => place(axis.ideal, k)),
  };
}

/** A CSV cell: finite numbers as written, missing ones empty; text quoted when needed. */
export function csvCell(value: unknown) {
  if (typeof value === "number") {
    return Number.isFinite(value) ? String(value) : "";
  }
  if (value === undefined || value === null) {
    return "";
  }
  const text = String(value);
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

type TViewRow = {
  label: string;
  pair: TPair;
  stats: NonNullable<ReturnType<typeof taylorStats>>;
  /** The plot's own units, when its values were converted to the reference's. */
  from?: string;
};

/** The reference plot: its label and the units every value is in. */
type TReference = string | { label: string; units?: string };

/** A header with the values' units: "difference (K)". */
export function withUnits(name: string, units?: string) {
  return units ? `${name} (${units})` : name;
}

/**
 * The numbers behind one Compare view as CSV: the pairs (bias over time,
 * scatter: date, reference, plot, difference), the percentiles (Q–Q) or
 * the scores (parallel coordinates), one block of rows per plot.
 */
export function compareViewCsv(
  view: TCsvView,
  rows: TViewRow[],
  reference: TReference
) {
  return [...viewLines(view, rows, reference)].join("\n");
}

type TCsvView = "bias" | "scatter" | "qq" | "parallel";

/** A view's CSV lines, one at a time (a pair table is not built whole). */
function* viewLines(view: TCsvView, rows: TViewRow[], reference: TReference) {
  const ref = typeof reference === "string" ? { label: reference } : reference;
  const lines =
    view === "bias" || view === "scatter"
      ? pairRows(rows, ref)
      : view === "qq"
        ? quantileRows(rows, ref)
        : scoreRows(rows, ref.label);
  for (const line of lines) {
    yield line.map(csvCell).join(",");
  }
}

/** Lines per part of a large CSV between turns of the page. */
const LINES_PER_PART = 20_000;

/**
 * The same CSV as parts of at most LINES_PER_PART lines for a Blob, the
 * page given a turn between parts (200,000 pairs no longer stall it for a
 * second); stops when `signal` aborts.
 */
export async function compareViewCsvParts(
  view: TCsvView,
  rows: TViewRow[],
  reference: TReference,
  signal?: AbortSignal
) {
  const parts: string[] = [];
  let batch: string[] = [];
  for (const line of viewLines(view, rows, reference)) {
    batch.push(line);
    if (batch.length >= LINES_PER_PART) {
      parts.push(`${batch.join("\n")}\n`);
      batch = [];
      await new Promise((resolve) => setTimeout(resolve, 0));
      if (signal?.aborted) {
        return undefined;
      }
    }
  }
  parts.push(batch.join("\n"));
  return parts;
}

/** "converted_from": only when a plot's values were converted. */
const convertedColumn = (rows: TViewRow[]) =>
  rows.some((row) => row.from) ? ["plot_converted_from"] : [];

function* pairRows(
  rows: TViewRow[],
  reference: { label: string; units?: string }
) {
  const converted = convertedColumn(rows);
  yield [
    "plot",
    "reference_plot",
    "time",
    "matched_by",
    withUnits("reference", reference.units),
    withUnits("plot_value", reference.units),
    withUnits("difference", reference.units),
    ...converted,
  ];
  for (const row of rows) {
    const { keys, by } = row.pair;
    const from = converted.length ? [row.from] : [];
    for (let at = 0; at < keys.length; at++) {
      const [r, o] = [row.pair.reference[at], row.pair.other[at]];
      yield [row.label, reference.label, keys[at], by, r, o, o - r, ...from];
    }
  }
}

function quantileRows(
  rows: TViewRow[],
  reference: { label: string; units?: string }
) {
  const converted = convertedColumn(rows);
  const lines: unknown[][] = [
    [
      "plot",
      "reference_plot",
      "percentile",
      withUnits("reference", reference.units),
      withUnits("plot_value", reference.units),
      ...converted,
    ],
  ];
  for (const row of rows) {
    const from = converted.length ? [row.from] : [];
    for (const q of quantilePairs(row.pair)) {
      lines.push([
        row.label,
        reference.label,
        Math.round(q.p * 100),
        q.reference,
        q.other,
        ...from,
      ]);
    }
  }
  return lines;
}

function scoreRows(rows: TViewRow[], reference: string) {
  const scores = parallelScores(rows.map((row) => row.stats));
  const lines: unknown[][] = [
    [
      "plot",
      "reference_plot",
      ...scores.axes.map((axis) => axis.name),
      ...scores.axes.map((axis) => `${axis.name} (placed, 1 best)`),
    ],
  ];
  scores.rows.forEach((scored, at) =>
    lines.push([rows[at].label, reference, ...scored.values, ...scored.placed])
  );
  return lines;
}

/** One side of a comparison, as its quantity is judged. */
type TQuantitySide = {
  variable: string;
  standardName?: string;
  units?: string;
  cellMethods?: string;
  timeDimension?: string;
  /** CF `units_metadata` ("temperature: on_scale", "…: unknown"). */
  unitsMetadata?: string;
};

/**
 * Why two plots are of different physical quantities or statistics, when
 * their metadata say so; undefined when they may be compared.
 */
export function quantityProblem(w: TQuantitySide, ref: TQuantitySide) {
  const [a, b] = [w.standardName, ref.standardName];
  // CF's aliases are one quantity: convective_precipitation_rate is
  // lwe_convective_precipitation_rate; not every lwe_ name is another's.
  if (a && b && canonicalName(a) !== canonicalName(b)) {
    return `${a} is another quantity than ${b}: not compared`;
  }
  // A temperature scale declared unknown against any other meaning: its zero is
  // not known.
  const unknown = (side: TQuantitySide) =>
    /temperature:\s*unknown/i.test(side.unitsMetadata ?? "");
  if (
    (unknown(w) || unknown(ref)) &&
    (unknown(w) !== unknown(ref) || !sameUnits(w.units, ref.units))
  ) {
    const which = unknown(w) ? w.variable : ref.variable;
    return `${which} is a temperature of unknown scale: not compared`;
  }
  const [ka, kb] = [w, ref].map((side) =>
    rateKind(side.variable.split("/").pop(), side.standardName)
  );
  if (ka && kb && ka !== kb) {
    return `${w.variable} and ${ref.variable} are different kinds of quantity: not compared`;
  }
  // A speed beside something that is no speed: no water equivalent makes a
  // current of a carbon flux.
  const speed = (side: TQuantitySide) =>
    Boolean(converter(side.units, "m s-1"));
  if ((ka === "speed" || kb === "speed") && !(speed(w) && speed(ref))) {
    return `${w.variable} and ${ref.variable} are not both speeds: not compared`;
  }
  // Errors between one statistic and another (monthly maxima against monthly
  // means) are no errors; nor between means of daily maxima and of daily means,
  // or means over land and over sea: every step on an axis both state.
  const [sa, sb] = [w, ref].map((side) =>
    stepsByAxis(side.cellMethods, side.timeDimension)
  );
  for (const [axis, steps] of sa) {
    const other = sb.get(axis);
    if (other && steps.join(", then ") !== other.join(", then ")) {
      return `${w.variable} holds ${axis}: ${steps.join(", then ")} values, ${ref.variable} ${axis}: ${other.join(", then ")} ones: not compared`;
    }
  }
  return orderProblem(w, ref);
}

/**
 * The rest of what two method chains say: a statistic over an axis that only
 * one states, other than a mean or a sample (an area maximum is no cell's
 * value); the same steps in another order or grouping, when any is no mean,
 * sample or sum (an area mean of time maxima is not a time maximum of area
 * means); and other stated sampling intervals of one step (maxima of hourly and
 * of daily values).
 */
// eslint-disable-next-line max-lines-per-function
function orderProblem(w: TQuantitySide, ref: TQuantitySide) {
  const steps = (side: TQuantitySide) =>
    cellMethodSteps(side.cellMethods).map((step) => ({
      ...step,
      axes: step.names
        .map((name) => (name === side.timeDimension ? "time" : name))
        .sort(),
    }));
  const [sa, sb] = [steps(w), steps(ref)];
  const axesOf = (list: typeof sa) => new Set(list.flatMap((x) => x.axes));
  for (const [mine, theirs, side] of [
    [sa, sb, w],
    [sb, sa, ref],
  ] as const) {
    const stated = axesOf(theirs);
    for (const step of mine) {
      const alone = step.axes.find((axis) => !stated.has(axis));
      if (alone && step.method !== "mean" && step.method !== "point") {
        return `${side.variable} is a ${step.method} over ${alone}, the other states none: not compared`;
      }
      // A mean over part of the domain is another quantity than one over all of
      // it.
      if (alone && /\bwhere\b/.test(step.qualifier)) {
        return `${side.variable} is a ${step.method} ${step.qualifier} over ${alone}, the other states no such restriction: not compared`;
      }
    }
  }
  const [both] = [axesOf(sa)].map(
    (a) => new Set([...a].filter((axis) => axesOf(sb).has(axis)))
  );
  const shared = (list: typeof sa) =>
    list
      .filter((step) => step.axes.some((axis) => both.has(axis)))
      .map((step) =>
        `${step.axes.join(" ")}: ${step.method} ${step.qualifier}`.trim()
      );
  const [oa, ob] = [shared(sa), shared(sb)];
  // Only samples commute: means over two axes differ by their order where
  // values are missing.
  const commuting = [...sa, ...sb].every((step) => step.method === "point");
  if (!commuting && oa.join(", then ") !== ob.join(", then ")) {
    return `${w.variable} is ${oa.join(", then ")}, ${ref.variable} ${ob.join(", then ")}: other orders or groupings of a statistic, not compared`;
  }
  // The same statistic over the same axes, wherever it stands in the list,
  // sampled at the same interval, in any units of time. Repeated steps by
  // occurrence: the second mean over time against the other's second, not its
  // first.
  const kind = (x: (typeof sa)[number]) =>
    `${x.axes.join()} ${x.method} ${x.qualifier}`;
  const seen = new Map<string, number>();
  for (const step of sa) {
    const k = seen.get(kind(step)) ?? 0;
    seen.set(kind(step), k + 1);
    const other = sb.filter((x) => kind(x) === kind(step))[k];
    // Each axis's own interval (CF §7.3.2, by position), in one unit.
    if (other?.intervals?.length && step.intervals?.length) {
      const rename = (name: string, side: TQuantitySide) =>
        name === side.timeDimension ? "time" : name;
      const mine = namedIntervals(step, (n) => rename(n, w));
      const theirs = namedIntervals(other, (n) => rename(n, ref));
      if (mine.join() !== theirs.join()) {
        return `${w.variable} is a ${step.method} of values every ${step.intervals.join(", ")}, ${ref.variable} every ${other.intervals.join(", ")}: not compared`;
      }
    }
  }
  return undefined;
}

/**
 * CF standard name aliases as one name (CF standard name table, its
 * <alias> entries; a selection): the precipitation rates written without
 * their lwe_ prefix, large_scale renamed stratiform, and the sea-level pressure
 * and sea-floor depth names, as table version 95 lists them. Other names stay
 * as they are.
 */
/* eslint-disable camelcase -- CF standard names as keys. */
const ALIASES: Record<string, string> = {
  convective_precipitation_rate: "lwe_convective_precipitation_rate",
  large_scale_precipitation_rate: "lwe_stratiform_precipitation_rate",
  lwe_large_scale_precipitation_rate: "lwe_stratiform_precipitation_rate",
  air_pressure_at_sea_level: "air_pressure_at_mean_sea_level",
  sea_floor_depth: "sea_floor_depth_below_geoid",
  sea_floor_depth_below_sea_level: "sea_floor_depth_below_mean_sea_level",
};
/* eslint-enable camelcase */
function canonicalName(name: string) {
  const known = ALIASES[name] ?? name;
  return known.replace(/large_scale/g, "stratiform");
}
