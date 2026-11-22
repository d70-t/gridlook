/**
 * Ways to look at a time series without reading anything again: anomalies
 * against the series' own monthly climatology, the annual or diurnal cycle
 * (each month or hour across years or days: mean and range), a running
 * mean, the cumulative total, the count above a value per year, boxes per
 * month, the spectrum, return levels, and a linear trend. Dates come as the
 * source calendar writes them ("YYYY-MM-DD hh…"), so 360-day and no-leap
 * calendars fold correctly; durations come from the raw time coordinate.
 */
import { parseTimeAxis } from "@/lib/analysis/calendar.ts";
import { timeCellMethod } from "@/lib/analysis/cellMethods.ts";
import { converter } from "@/lib/analysis/unitConvert.ts";

export const TIME_VIEWS = {
  ANOMALY: "anomaly",
  ANNUAL: "annual",
  DIURNAL: "diurnal",
  RUNNING: "running",
  CUMULATIVE: "cumulative",
  COUNT: "count",
  BOXES: "boxes",
  SPECTRUM: "spectrum",
  RETURN: "return",
} as const;

export type TTimeView = (typeof TIME_VIEWS)[keyof typeof TIME_VIEWS];

export const MONTHS = [
  "Jan",
  "Feb",
  "Mar",
  "Apr",
  "May",
  "Jun",
  "Jul",
  "Aug",
  "Sep",
  "Oct",
  "Nov",
  "Dec",
];

/**
 * A date label's parts, its sign kept: CF calendars allow negative years
 * ("-0006-01-01"), which fixed character positions read as year 0 and month
 * "6-".
 */
const unsignedDate = (date: string) =>
  date.startsWith("-") ? date.slice(1) : date;
/**
 * Digits past four in a date's year: a model year 12001 is written in full, and
 * every later field moves along.
 */
const longYear = (d: string) => {
  const end = d.indexOf("-");
  return end > 4 ? end - 4 : 0;
};
const parts = (date: string) => {
  const d0 = unsignedDate(date);
  const d = d0.slice(longYear(d0));
  return {
    year:
      Number(d0.slice(0, 4 + longYear(d0))) * (date.startsWith("-") ? -1 : 1),
    month: Number(d.slice(5, 7)),
    day: Number(d.slice(8, 10)),
    hour: Number(d.slice(11, 13)) || 0,
    minute: Number(d.slice(14, 16)) || 0,
    second: Number(d.slice(17, 19)) || 0,
  };
};

/**
 * The first `length` characters of a date after its sign, signed, as if
 * its year had four digits: 4 its year, 7 its month, 10 its day, 13 its
 * hour.
 */
export function dateKey(date: string, length: number) {
  const d = unsignedDate(date);
  return (date.startsWith("-") ? "-" : "") + d.slice(0, length + longYear(d));
}

/** A date's month, "01" to "12", whatever the sign of its year. */
export const monthOf = (date: string) => {
  const d = unsignedDate(date);
  return d.slice(5 + longYear(d), 7 + longYear(d));
};

/** Whether a series is sampled more often than daily (a diurnal cycle). */
export function subDaily(dates: string[]) {
  const days = new Set(dates.map((date) => dateKey(date, 10)));
  return dates.length > days.size * 1.5;
}

/** Whether a series spans several months (an annual cycle, anomalies). */
export function spansMonths(dates: string[]) {
  return new Set(dates.map(monthOf)).size >= 3;
}

/**
 * The duration of each date's cell, for dates that stand for interval means
 * (see periodDates): averages over them weight each value by its support, so
 * splitting a constant cell into days changes nothing.
 */
export const dateDurations = new WeakMap<string[], number[]>();

/**
 * Rows whose cell overlaps another's (a mean over [0, 10] and one over [2, 6]
 * inside it): weighting both counts [2, 6] twice, and which is the product
 * meant is not said, so no mean of a period holding them is made.
 */
export const dateOverlaps = new WeakMap<string[], ArrayLike<number>>();

/** The rows of `bounds` ([low, high] per row, flat) overlapping another. */
export function overlappingCells(
  bounds: ArrayLike<number>,
  /** The rows taking part (those with an observed value); all by default. */
  include: (at: number) => boolean = () => true
) {
  // Rows taking part, by index; sorted by start only when out of order.
  const n = Math.floor(bounds.length / 2);
  const rows = new Uint32Array(n);
  const lows = new Float64Array(n);
  const highs = new Float64Array(n);
  let count = 0;
  let ordered = true;
  for (let at = 0; at < n; at++) {
    const [a, b] = [bounds[2 * at], bounds[2 * at + 1]];
    if (Number.isFinite(a) && Number.isFinite(b) && a !== b && include(at)) {
      lows[at] = Math.min(a, b);
      highs[at] = Math.max(a, b);
      ordered &&= count === 0 || lows[at] >= lows[rows[count - 1]];
      rows[count++] = at;
    }
  }
  const order = ordered
    ? rows.subarray(0, count)
    : rows.subarray(0, count).sort((x, y) => lows[x] - lows[y] || x - y);
  const found = new Set<number>();
  let reach = -Infinity;
  let holder = -1;
  for (const at of order) {
    const [low, high] = [lows[at], highs[at]];
    // Cells that only touch (a rounding apart) do not overlap: apart by more
    // than the coordinate's own precision, whatever its origin.
    if (
      low <
      reach - 16 * Number.EPSILON * Math.max(Math.abs(low), Math.abs(reach))
    ) {
      found.add(at);
      found.add(holder);
    }
    if (high > reach) {
      [reach, holder] = [high, at];
    }
  }
  return found;
}

/**
 * Cells over a month's end, split there: each piece's date (in its own month)
 * and length, by row. Folding a mean credits each month its own share, the
 * value taken constant over the cell.
 */
export const datePieces = new WeakMap<
  string[],
  Map<number, { date: string; length: number }[]>
>();

/**
 * Each date list's cells (their bounds and time axis), for pieces of another
 * grain than the month: a diurnal cycle splits at hours.
 */
export const dateCells = new WeakMap<
  string[],
  {
    ctx: { raw: number[]; timeUnits?: string; calendar?: string };
    bounds: number[];
    /**
     * An extreme (or other statistic not spread over its cell): it is of
     * an hour only when inside that hour, never split across hours.
     */
    whole?: boolean;
  }
>();

/** Pieces of each cell split at hours, for cells shorter than a day. */
let hourPiecesOf:
  | ((dates: string[]) => Map<number, { date: string; length: number }[]>)
  | undefined;
const hourKept = new WeakMap<
  string[],
  Map<number, { date: string; length: number }[]>
>();

/** How hour pieces are made (seriesViews registers its splitter). */
export function useHourPieces(
  split: (
    ctx: { raw: number[]; timeUnits?: string; calendar?: string },
    bounds: number[],
    whole?: boolean
  ) => Map<number, { date: string; length: number }[]>
) {
  hourPiecesOf = (dates) => {
    const kept = hourKept.get(dates);
    if (kept) {
      return kept;
    }
    const cells = dateCells.get(dates);
    const pieces = cells
      ? split(cells.ctx, cells.bounds, cells.whole)
      : new Map();
    hourKept.set(dates, pieces);
    return pieces;
  };
}

/**
 * Fold values by a key (month 1–12 or hour 0–23): first averaged within
 * each period (a month of a year, an hour of a day), then the mean, lowest
 * and highest of those across periods.
 */
/**
 * Folds kept per date list, values and grain: choosing the view again, or
 * redrawing it, folds nothing again.
 */
const foldKept = new WeakMap<
  string[],
  Map<string, { values: number[]; result: ReturnType<typeof foldNow> }>
>();

function fold(
  dates: string[],
  values: number[],
  keyOf: (date: string) => number,
  periodOf: (date: string) => string,
  keys: number[],
  grain: "month" | "hour" = "month"
) {
  const kept = foldKept.get(dates) ?? new Map();
  foldKept.set(dates, kept);
  const hit = kept.get(grain);
  if (hit?.values === values) {
    return hit.result;
  }
  const result = foldNow(dates, values, keyOf, periodOf, keys, grain);
  kept.set(grain, { values, result });
  return result;
}

// eslint-disable-next-line max-lines-per-function
function foldNow(
  dates: string[],
  values: number[],
  keyOf: (date: string) => number,
  periodOf: (date: string) => string,
  keys: number[],
  grain: "month" | "hour" = "month"
) {
  // Per period: weighted by known cell lengths, or plainly when one of its
  // cells has none (its own period only).
  const periods = new Map<
    string,
    {
      key: number;
      sum: number;
      n: number;
      plain: number;
      count: number;
      unknown: boolean;
    }
  >();
  const durations = dateDurations.get(dates);
  const pieces =
    grain === "hour" ? hourPiecesOf?.(dates) : datePieces.get(dates);
  // Overlaps among the cells with a value that are of this view: a fill-only
  // cell overlapping January erases nothing, nor does a daily mean beside its
  // hours in a diurnal cycle.
  const cells = dateOverlaps.get(dates);
  const overlaps =
    cells &&
    overlappingCells(
      cells,
      (at) => Number.isFinite(values[at]) && pieces?.get(at)?.length !== 0
    );
  const withheld = new Set<string>();
  /** Values of no part here (means over more than an hour, by hours). */
  let leftOut = 0;
  /** Cells split between periods, each taken constant over its cell. */
  let spread = 0;
  const add = (date: string, value: number, weight: number) => {
    const period = periodOf(date);
    const entry = periods.get(period) ?? {
      key: keyOf(date),
      sum: 0,
      n: 0,
      plain: 0,
      count: 0,
      unknown: false,
    };
    if (Number.isFinite(weight)) {
      entry.sum += value * weight;
      entry.n += weight;
    } else {
      entry.unknown = true;
    }
    // A cell of no length is no observation of its period's mean.
    if (weight !== 0) {
      entry.plain += value;
      entry.count++;
    }
    periods.set(period, entry);
  };
  dates.forEach((date, at) => {
    const value = values[at];
    if (!Number.isFinite(value) || !date) {
      return;
    }
    if (overlaps?.has(at)) {
      (pieces?.get(at) ?? [{ date }]).forEach((piece) =>
        withheld.add(periodOf(piece.date))
      );
      return;
    }
    const split = pieces?.get(at);
    if (split) {
      leftOut += split.length ? 0 : 1;
      spread += split.length > 1 ? 1 : 0;
      split.forEach((piece) => add(piece.date, value, piece.length));
    } else {
      add(date, value, durations ? durations[at] : 1);
    }
  });
  /** Periods whose values of unknown length were left out. */
  let unknownLeft = 0;
  // Running sum, count, lowest and highest per key: one pass, any length.
  const byKey = new Map<
    number,
    { sum: number; n: number; low: number; high: number }
  >();
  for (const [name, period] of periods) {
    // Only cells of no length: nothing observed in it. Overlapping cells:
    // no one mean of it.
    if ((!period.unknown && period.n === 0) || withheld.has(name)) {
      continue;
    }
    const { key } = period;
    // Over the known lengths when there are some, the others left out and said,
    // as the ensemble's period means are.
    const mean =
      period.n > 0 ? period.sum / period.n : period.plain / period.count;
    if (period.unknown && period.n > 0) {
      unknownLeft++;
    }
    const entry = byKey.get(key);
    if (entry) {
      entry.sum += mean;
      entry.n++;
      entry.low = Math.min(entry.low, mean);
      entry.high = Math.max(entry.high, mean);
    } else {
      byKey.set(key, { sum: mean, n: 1, low: mean, high: mean });
    }
  }
  const stat = (key: number, pick: "mean" | "low" | "high") => {
    const entry = byKey.get(key);
    if (!entry) {
      return Number.NaN;
    }
    return pick === "mean" ? entry.sum / entry.n : entry[pick];
  };
  return {
    x: keys,
    mean: keys.map((key) => stat(key, "mean")),
    low: keys.map((key) => stat(key, "low")),
    high: keys.map((key) => stat(key, "high")),
    count: keys.map((key) => byKey.get(key)?.n ?? 0),
    leftOut,
    unknownLeft,
    spread,
  };
}

/** Each month across years: the mean of monthly means, and their range. */
export function annualCycle(dates: string[], values: number[]) {
  return fold(
    dates,
    values,
    (date) => parts(date).month,
    (date) => dateKey(date, 7),
    MONTHS.map((_, at) => at + 1)
  );
}

/** Each hour across days: the mean of hourly values, and their range. */
export function diurnalCycle(dates: string[], values: number[]) {
  return fold(
    dates,
    values,
    (date) => parts(date).hour,
    (date) => dateKey(date, 13),
    Array.from({ length: 24 }, (_, hour) => hour),
    "hour"
  );
}

/** Values minus the series' own mean for their calendar month. */
export function anomalies(dates: string[], values: number[]) {
  const cycle = annualCycle(dates, values);
  // A cell across months against the months' baselines by the share of it in
  // each, as the baseline was built.
  const pieces = datePieces.get(dates);
  const baseline = (at: number) => {
    const split = pieces?.get(at);
    // Longer than a month: no month's baseline is its own.
    if (split && split.length === 0) {
      return Number.NaN;
    }
    if (!split || split.length < 2) {
      const month = parts(dates[at] ?? "").month;
      return month >= 1 ? cycle.mean[month - 1] : Number.NaN;
    }
    let [sum, total] = [0, 0];
    for (const piece of split) {
      const month = parts(piece.date).month;
      sum += piece.length * (month >= 1 ? cycle.mean[month - 1] : Number.NaN);
      total += piece.length;
    }
    return total > 0 ? sum / total : Number.NaN;
  };
  return values.map((value, at) =>
    Number.isFinite(value) ? value - baseline(at) : Number.NaN
  );
}

/** A date as years (months and days as fractions; 12 equal months). */
function yearsOf(date: string) {
  const { year, month, day, hour, minute, second } = parts(date);
  const hours = hour + minute / 60 + second / 3600;
  return year + (month - 1) / 12 + (day - 1 + hours / 24) / (12 * 30.4375);
}

/** The least-squares line through (xs, ys), and the span of xs. */
function leastSquares(xs: number[], ys: number[]) {
  const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
  const my = ys.reduce((a, b) => a + b, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  // Its span in this pass (a spread overflows the stack at 150,000).
  let [first, last] = [Infinity, -Infinity];
  xs.forEach((x, at) => {
    sxy += (x - mx) * (ys[at] - my);
    sxx += (x - mx) ** 2;
    first = Math.min(first, x);
    last = Math.max(last, x);
  });
  return { mx, my, slope: sxx ? sxy / sxx : Number.NaN, first, last };
}

/**
 * Ordinary least-squares line through the values against time: the
 * fitted values and the slope per decade (NaN with fewer than 3 values).
 * Time is the elapsed time from the raw coordinate in its units when they
 * are known (minutes and seconds count, any calendar), else the dates.
 */
export function linearTrend(
  dates: string[],
  values: number[],
  raw?: number[],
  timeUnits?: string,
  calendar?: string
) {
  const unit = secondsPerUnit(timeUnits);
  const year = secondsPerYear(calendar);
  const timeOf = (at: number) =>
    raw && unit !== undefined && Number.isFinite(raw[at])
      ? (raw[at] * unit) / year
      : dates[at]
        ? yearsOf(dates[at])
        : Number.NaN;
  const xs: number[] = [];
  const ys: number[] = [];
  values.forEach((value, at) => {
    const x = timeOf(at);
    if (Number.isFinite(value) && Number.isFinite(x)) {
      xs.push(x);
      ys.push(value);
    }
  });
  if (xs.length < 3) {
    const none = values.map(() => Number.NaN);
    return {
      fitted: none,
      perDecade: NaN,
      spanYears: NaN,
      daysPerYear: year / 86_400,
    };
  }
  const { mx, my, slope, first, last } = leastSquares(xs, ys);
  return {
    fitted: values.map((_, at) => my + slope * (timeOf(at) - mx)),
    perDecade: slope * 10,
    /** Years between the first and last value fitted. */
    spanYears: last - first,
    /** Days in a year of the series' calendar (360 for 360_day). */
    daysPerYear: year / 86_400,
  };
}

/**
 * The slope in a unit that suits the series: per day under a quarter of a
 * year (a two-week hourly record), per year under ten years, else per
 * decade ("−140 degC per decade" over two weeks said nothing).
 */
export function trendRate(t: {
  perDecade: number;
  spanYears: number;
  daysPerYear: number;
}) {
  if (t.spanYears < 0.25) {
    return { value: t.perDecade / 10 / t.daysPerYear, per: "day" };
  }
  if (t.spanYears < 10) {
    return { value: t.perDecade / 10, per: "year" };
  }
  return { value: t.perDecade, per: "decade" };
}

/** A year of the calendar, in seconds: a 360-day year is 360 days. */
function secondsPerYear(calendar?: string) {
  const days: Record<string, number> = {
    "360_day": 360,
    noleap: 365,
    "365_day": 365,
    all_leap: 366, // eslint-disable-line camelcase
    "366_day": 366,
  };
  return (days[calendar?.toLowerCase() ?? ""] ?? 365.25) * 86400;
}

/**
 * The step of a regularly sampled coordinate, in seconds: every spacing
 * within 15 % of the median (months of 28 to 31 days pass; skipped or
 * uneven samples do not). A spectrum needs it.
 */
export function regularStep(raw: number[], units?: string) {
  const step = stepSeconds(raw, units);
  const unit = secondsPerUnit(units);
  if (!step || !unit) {
    return undefined;
  }
  // In time order, whatever the storage order; each step of about the same
  // length: repeated dates are no regular sampling.
  const times = Float64Array.from(raw).sort();
  for (let at = 1; at < times.length; at++) {
    const gap = (times[at] - times[at - 1]) * unit;
    if (!(Math.abs(gap / step - 1) <= 0.15)) {
      return undefined;
    }
  }
  return times.length > 1 ? step : undefined;
}

/** Seconds per unit of a CF time coordinate ("days since …"), if known. */
/**
 * The CF cell method over time in `cell_methods` ("time: mean" → "mean"),
 * named `time` or by the time dimension (`record: point`).
 */
export function timeMethod(
  cellMethods: string | undefined,
  dimension?: string
) {
  return timeCellMethod(cellMethods, dimension);
}

export function secondsPerUnit(units?: string) {
  // The calendar's own parse first: milliseconds and microseconds too. The unit
  // alone, whatever the origin: "microseconds since 2001-02-30" is a valid
  // 360_day axis that the standard calendar refuses.
  if (/\ssince\s/i.test(units ?? "")) {
    const axis = parseTimeAxis(
      units!.replace(/\ssince\s.*$/i, " since 1970-01-01"),
      undefined
    );
    if (!("unsupported" in axis) && Number.isFinite(axis.unitSeconds)) {
      return axis.unitSeconds;
    }
  }
  const unit = (units ?? "").trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const table: Record<string, number> = {
    s: 1,
    sec: 1,
    secs: 1,
    second: 1,
    seconds: 1,
    min: 60,
    mins: 60,
    minute: 60,
    minutes: 60,
    h: 3600,
    hr: 3600,
    hrs: 3600,
    hour: 3600,
    hours: 3600,
    d: 86400,
    day: 86400,
    days: 86400,
  };
  return table[unit];
}

/** The median spacing of a time coordinate, in seconds (if its unit is known). */
export function stepSeconds(raw: number[], units?: string) {
  const unit = secondsPerUnit(units);
  if (!unit) {
    return undefined;
  }
  // Kept per axis: the view menu and its views each ask.
  const kept = stepsKept.get(raw);
  if (kept && kept.length === raw.length) {
    return kept.gap === undefined ? undefined : kept.gap * unit;
  }
  // In date order, however stored.
  const dated = Float64Array.from(raw.filter(Number.isFinite)).sort();
  const gaps = new Float64Array(Math.max(0, dated.length - 1));
  let count = 0;
  for (let at = 1; at < dated.length; at++) {
    const gap = dated[at] - dated[at - 1];
    if (gap > 0) {
      gaps[count++] = gap;
    }
  }
  const sorted = gaps.subarray(0, count).sort();
  const gap = count ? sorted[count >> 1] : undefined;
  stepsKept.set(raw, { length: raw.length, gap });
  return gap === undefined ? undefined : gap * unit;
}

/** The median step of an axis in its own units, per axis. */
const stepsKept = new WeakMap<object, { length: number; gap?: number }>();

/** The step in words, for a window length: "days", "months", "hours"… */
export function stepName(seconds?: number) {
  if (!seconds) {
    return "steps";
  }
  const near = (target: number) => Math.abs(seconds / target - 1) < 0.15;
  if (near(3600)) {
    return "hours";
  }
  if (near(86400)) {
    return "days";
  }
  if (seconds >= 27 * 86400 && seconds <= 32 * 86400) {
    return "months";
  }
  if (seconds >= 360 * 86400 && seconds <= 367 * 86400) {
    return "years";
  }
  return "steps";
}

/** A sensible running-mean length: a year of months, a week of days… */
export function defaultWindow(seconds?: number) {
  return (
    { hours: 24, days: 7, months: 12, years: 5, steps: 5 } as Record<
      string,
      number
    >
  )[stepName(seconds)];
}

/**
 * A centred running mean over `window` samples (NaN where the window
 * reaches past either end or holds fewer than half valid values).
 */
/** The running mean in time order, mapped back to the rows. */
export function runningMeanInTime(
  values: number[],
  raw: number[],
  window: number
) {
  const order = dateOrder(raw, values.length);
  const out = new Array<number>(values.length).fill(Number.NaN);
  // In elapsed time: n typical steps around each date, not n rows, so a "3-day"
  // mean in November never reaches back to January across a gap.
  const times = order.map((at) => raw[at]);
  const steps: number[] = [];
  for (let k = 1; k < times.length; k++) {
    if (times[k] > times[k - 1]) {
      steps.push(times[k] - times[k - 1]);
    }
  }
  steps.sort((a, b) => a - b);
  const step = steps[Math.floor(steps.length / 2)];
  if (!(step > 0)) {
    const inRows = runningMean(
      order.map((at) => values[at]),
      window
    );
    order.forEach((at, rank) => (out[at] = inRows[rank]));
    return out;
  }
  const n = Math.max(1, Math.round(window));
  // Half a step either side: a 31-day neighbour of a month among 30-day steps
  // is still the next month, a gap of two steps still not.
  const before = (Math.floor((n - 1) / 2) + 0.5) * step;
  const after = (n - 1 - Math.floor((n - 1) / 2) + 0.5) * step;
  const slack = -step * 1e-6;
  let [low, high, sum, count] = [0, 0, 0, 0];
  for (let rank = 0; rank < order.length; rank++) {
    const t = times[rank];
    while (high < order.length && times[high] <= t + after + slack) {
      const v = values[order[high++]];
      if (Number.isFinite(v)) {
        sum += v;
        count++;
      }
    }
    while (times[low] < t - before - slack) {
      const v = values[order[low++]];
      if (Number.isFinite(v)) {
        sum -= v;
        count--;
      }
    }
    // Half the window's dates observed at least, as before.
    out[order[rank]] = count * 2 >= n ? sum / count : Number.NaN;
  }
  return out;
}

/**
 * A running mean of means over declared cells: each weighed by the time it
 * shares with the window, as a mean over that window is. Undefined without a
 * step to size the window by.
 */

export function runningMeanOverCells(
  values: number[],
  raw: number[],
  bounds: number[],
  window: number
) {
  const order = dateOrder(raw, values.length);
  const steps: number[] = [];
  for (let k = 1; k < order.length; k++) {
    const d = raw[order[k]] - raw[order[k - 1]];
    if (d > 0) {
      steps.push(d);
    }
  }
  steps.sort((a, b) => a - b);
  const step = steps[Math.floor(steps.length / 2)];
  if (!(step > 0)) {
    return undefined;
  }
  const n = Math.max(1, Math.round(window));
  const before = (Math.floor((n - 1) / 2) + 0.5) * step;
  const after = (n - 1 - Math.floor((n - 1) / 2) + 0.5) * step;
  const cells = disjointCells(values, order, bounds);
  const out = new Array<number>(values.length).fill(Number.NaN);
  for (const at of order) {
    const [from, to] = [raw[at] - before, raw[at] + after];
    if (Number.isFinite(from)) {
      out[at] = cells.meanOver(from, to);
    }
  }
  return out;
}

type TCell = {
  low: number;
  high: number;
  v: number;
  ambiguous?: boolean;
  /**
   * Gaps of one cell its contained cells leave, sharing its remainder: only
   * their sum is known, so a window takes all of them or none.
   */
  group?: number;
};

/** A cell with the cells it contains (its children), resolved. */
type TNest = {
  cell: TCell;
  children: TNest[];
  /** Its own (leaf), withheld (ambiguous) or its parts in order. */
  kind?: "leaf" | "ambiguous" | "split";
  parts?: (TNest | TCell)[];
  integral?: number;
};

/**
 * Relative difference within which a coarse mean agrees with its tiles:
 * float32's rounding.
 */
const AGREEMENT = 2 ** -23;

/**
 * Nested cells made one support, depth by depth (inner nests first): a cell its
 * contained cells tile whole is replaced by them when they agree with it, and
 * withheld when they do not; one they tile part of keeps them, its remainder
 * spread over the rest (its integral less theirs). A second report of the same
 * interval with another value is withheld. Partly overlapping cells stay, to be
 * withheld. `list` ascends by start, longer first. Without recursion or copies
 * of the nested lists, linear in the cells.
 */
// eslint-disable-next-line max-lines-per-function
function resolvedNesting(list: TCell[]): TCell[] {
  // The containment forest, in list order (which is its pre-order).
  const nodes: TNest[] = [];
  const roots: TNest[] = [];
  const open: TNest[] = [];
  for (const cell of list) {
    while (open.length && cell.high > open[open.length - 1].cell.high) {
      open.pop();
    }
    const node: TNest = { cell, children: [] };
    (open.length ? open[open.length - 1].children : roots).push(node);
    open.push(node);
    nodes.push(node);
  }
  let groups = 0;
  // Children before their parents.
  for (let k = nodes.length - 1; k >= 0; k--) {
    const node = nodes[k];
    const outer = node.cell;
    const length = outer.high - outer.low;
    if (!node.children.length) {
      [node.kind, node.integral] = ["leaf", outer.v * length];
      continue;
    }
    let [end, covered, integral, overlapping] = [outer.low, 0, 0, false];
    const gaps: [number, number][] = [];
    for (const child of node.children) {
      const c = child.cell;
      overlapping ||=
        child.kind === "ambiguous" ||
        c.low < end ||
        (c.low === outer.low && c.high === outer.high);
      if (c.low > end) {
        gaps.push([end, c.low]);
      }
      covered += Math.max(0, c.high - Math.max(c.low, end));
      integral += child.integral ?? 0;
      end = Math.max(end, c.high);
    }
    if (end < outer.high) {
      gaps.push([end, outer.high]);
    }
    if (overlapping) {
      node.kind = "ambiguous";
      continue;
    }
    const rest = length - covered;
    if (rest <= length * 1e-12) {
      // Tiled whole: the finer record where it agrees with the coarser.
      const mean = integral / length;
      const agree =
        Math.abs(mean - outer.v) <=
        AGREEMENT * Math.max(1, Math.abs(mean), Math.abs(outer.v));
      [node.kind, node.parts, node.integral] = agree
        ? ["split", node.children, integral]
        : ["ambiguous", undefined, undefined];
      continue;
    }
    const v = (outer.v * length - integral) / rest;
    const group = gaps.length > 1 ? ++groups : undefined;
    const filled: TCell[] = gaps.map(([low, high]) => ({
      low,
      high,
      v,
      ...(group ? { group } : {}),
    }));
    // Children and gaps in order (both ascend), merged once.
    const parts: (TNest | TCell)[] = [];
    let g = 0;
    for (const child of node.children) {
      while (g < filled.length && filled[g].low < child.cell.low) {
        parts.push(filled[g++]);
      }
      parts.push(child);
    }
    while (g < filled.length) {
      parts.push(filled[g++]);
    }
    [node.kind, node.parts, node.integral] = ["split", parts, outer.v * length];
  }
  // Flattened, in order, with an explicit stack.
  const out: TCell[] = [];
  const pending: (TNest | TCell)[] = [...roots].reverse();
  while (pending.length) {
    const item = pending.pop()!;
    if (!("cell" in item)) {
      out.push(item);
    } else if (item.kind === "ambiguous") {
      out.push({ ...item.cell, ambiguous: true });
    } else if (item.kind === "leaf") {
      out.push(item.cell);
    } else {
      for (let k = item.parts!.length - 1; k >= 0; k--) {
        pending.push(item.parts![k]);
      }
    }
  }
  return out;
}

/**
 * Cells with a value, by start, for means over windows: each value read once;
 * an exact repeat (same interval and value) counted once; windows over cells
 * that overlap otherwise withheld, as their support is ambiguous. Means come
 * from running totals over the disjoint cells, not a pass over every covered
 * cell per window (a missing value over the whole axis made 1,000 days read
 * 503,002 values).
 */
// eslint-disable-next-line max-lines-per-function
function disjointCells(
  values: ArrayLike<number>,
  order: number[],
  bounds: number[]
) {
  const list: TCell[] = [];
  for (const at of order) {
    const v = values[at];
    const [p, q] = [bounds[2 * at], bounds[2 * at + 1]];
    const [low, high] = [Math.min(p, q), Math.max(p, q)];
    if (Number.isFinite(v) && Number.isFinite(low + high) && high > low) {
      list.push({ low, high, v });
    }
  }
  list.sort((x, y) => x.low - y.low || y.high - x.high || x.v - y.v);
  const cells = resolvedNesting(
    list.filter(
      (c, k) =>
        k === 0 ||
        !(
          c.low === list[k - 1].low &&
          c.high === list[k - 1].high &&
          c.v === list[k - 1].v
        )
    )
  );
  const n = cells.length;
  const reach = new Float64Array(n);
  const lows = new Float64Array(n);
  const flagged = new Int32Array(n + 1);
  const sumW = new Float64Array(n + 1);
  const sumVW = new Float64Array(n + 1);
  const overlaps = new Uint8Array(n);
  let owner = -1;
  for (let k = 0; k < n; k++) {
    const c = cells[k];
    lows[k] = c.low;
    if (c.ambiguous || (owner >= 0 && c.low < reach[k - 1])) {
      overlaps[k] = 1;
      if (owner >= 0 && c.low < reach[k - 1]) {
        overlaps[owner] = 1;
      }
    }
    if (k === 0 || c.high > reach[k - 1]) {
      reach[k] = c.high;
      owner = k;
    } else {
      reach[k] = reach[k - 1];
    }
  }
  // Each group's span: a window takes it whole or not at all.
  const spans = new Map<number, [number, number]>();
  const grouped = new Int32Array(n + 1);
  for (let k = 0; k < n; k++) {
    const { group, low, high } = cells[k];
    grouped[k + 1] = grouped[k] + (group ? 1 : 0);
    if (group) {
      const span = spans.get(group);
      spans.set(
        group,
        span ? [Math.min(span[0], low), Math.max(span[1], high)] : [low, high]
      );
    }
  }
  for (let k = 0; k < n; k++) {
    const w = cells[k].high - cells[k].low;
    flagged[k + 1] = flagged[k] + overlaps[k];
    sumW[k + 1] = sumW[k] + w;
    sumVW[k + 1] = sumVW[k] + cells[k].v * w;
  }
  /** First index with `array[k] > x` (array ascending). */
  const above = (array: Float64Array, x: number) => {
    let [lo, hi] = [0, n];
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (array[mid] > x) {
        hi = mid;
      } else {
        lo = mid + 1;
      }
    }
    return lo;
  };
  return {
    meanOver(from: number, to: number) {
      const first = above(reach, from);
      // Last cell starting before `to`.
      let last = above(lows, to) - 1;
      while (last >= 0 && lows[last] >= to) {
        last--;
      }
      if (first > last) {
        return Number.NaN;
      }
      if (flagged[last + 1] - flagged[first] > 0) {
        return Number.NaN;
      }
      if (grouped[last + 1] - grouped[first] > 0) {
        for (let k = first; k <= last; k++) {
          const span = cells[k].group ? spans.get(cells[k].group!)! : undefined;
          if (span && (span[0] < from || span[1] > to)) {
            return Number.NaN;
          }
        }
      }
      const part = (k: number) => {
        const c = cells[k];
        return Math.max(0, Math.min(c.high, to) - Math.max(c.low, from));
      };
      let [sum, weight] = [0, 0];
      for (const k of first === last ? [first] : [first, last]) {
        const share = part(k);
        sum += cells[k].v * share;
        weight += share;
      }
      if (last - first > 1) {
        sum += sumVW[last] - sumVW[first + 1];
        weight += sumW[last] - sumW[first + 1];
      }
      // Half the window observed at least, as by dates.
      return weight * 2 >= to - from ? sum / weight : Number.NaN;
    },
  };
}

export function runningMean(values: number[], window: number) {
  const n = Math.max(1, Math.round(window));
  const before = Math.floor((n - 1) / 2);
  const after = n - 1 - before;
  const out = new Array<number>(values.length).fill(Number.NaN);
  // A sliding sum and count of the finite values in the window: O(n) for
  // any length. The sum is recomputed every 4,096 steps against drift.
  let sum = 0;
  let count = 0;
  const add = (k: number, sign: 1 | -1) => {
    if (Number.isFinite(values[k])) {
      sum += sign * values[k];
      count += sign;
    }
  };
  for (let at = 0; at < values.length; at++) {
    add(at, 1);
    if (at >= n) {
      add(at - n, -1);
    }
    if (at % 4096 === 0 && at >= n - 1) {
      sum = 0;
      count = 0;
      for (let k = at - n + 1; k <= at; k++) {
        add(k, 1);
      }
    }
    const centre = at - after;
    if (at >= n - 1 && centre - before >= 0) {
      out[centre] = count * 2 >= n ? sum / count : Number.NaN;
    }
  }
  return out;
}

/**
 * The cumulative total, in date order whatever the file order. A rate
 * per second, hour or day (units ending in "s-1", "/s", "h-1", "d-1",
 * "day-1", "/day"…) is multiplied by each sample's duration (its declared
 * bounds, else the spacing to the next date) and loses that part of its
 * units: kg m-2 s-1 becomes kg m-2. Anything else is summed as it is.
 * Missing values add nothing. A rate whose declared bounds could not be
 * used (`boundsUnread`) is not totalled: spacing could be days for hours.
 */
// eslint-disable-next-line max-lines-per-function
export function accumulate(
  raw: number[],
  timeUnits: string | undefined,
  values: number[],
  units?: string,
  /** Declared cell bounds, [start, end] per sample, flat. */
  bounds?: number[],
  boundsUnread?: string,
  /** The CF cell method over time: "mean", "point", "sum", "maximum"… */
  method?: string
) {
  const unit = secondsPerUnit(timeUnits);
  const { perSeconds, total: rateTotal, factor } = rateOf(units);
  const isRate = perSeconds !== undefined && unit !== undefined;
  const totalUnits = isRate ? rateTotal : units;
  const none = (withheld: string) => ({
    y: values.map(() => Number.NaN),
    units: totalUnits,
    rate: isRate,
    withheld,
    amounts: false,
    gaps: 0,
    openEnd: false,
    covered: undefined as number | undefined,
    uncovered: undefined as number | undefined,
    held: false,
  });
  // Readings at instants are integrated by their spacing: bounds that could not
  // be read do not matter to them.
  const withheld = notTotalled(
    isRate,
    units,
    method === "point" ? undefined : boundsUnread,
    method
  );
  if (withheld) {
    return none(withheld);
  }
  const order = dateOrder(raw, values.length);
  // Readings at instants are not integrated over cells, whatever bounds say.
  const cells =
    method !== "point" && bounds && bounds.length === 2 * raw.length;
  const known = (at: number) =>
    Number.isFinite(bounds![2 * at]) && Number.isFinite(bounds![2 * at + 1]);
  // An amount whose cell is unknown may overlap the others: no total.
  if (
    cells &&
    !isRate &&
    order.some((at) => Number.isFinite(values[at]) && !known(at))
  ) {
    return none("a sample's time cell is unknown, so the total is not known");
  }
  // Coverage of the samples that hold a value, within the span of all declared
  // cells.
  const cover = cells
    ? cellCover(
        bounds,
        order.filter((at) => Number.isFinite(values[at])),
        unit,
        order
      )
    : undefined;
  // Overlapping cells do not identify a total, whether means or amounts.
  if (cover?.overlap) {
    return none("the samples' time cells overlap, so their total is not known");
  }
  const { y, gaps } = cells
    ? runningTotal(order, values, (rank, value) => {
        if (!isRate) {
          return value;
        }
        // A cell with unknown bounds adds nothing (and is not covered), never a
        // guessed duration.
        if (!known(order[rank])) {
          return Number.NaN;
        }
        const seconds = durationOf(raw, order, rank, bounds) * unit!;
        return Number.isFinite(seconds)
          ? (value * factor * seconds) / perSeconds!
          : 0;
      })
    : isRate
      ? heldTotal(
          raw,
          order,
          values,
          (value, seconds) => (value * factor * seconds) / perSeconds!,
          unit!
        )
      : runningTotal(order, values, (_, value) => value);
  // Without bounds each value holds until the next sample: the last one
  // starts an interval without an end and adds nothing.
  const openEnd = isRate && !cells && order.length > 0;
  const unknownCells = cells
    ? order.filter((at) => Number.isFinite(values[at]) && !known(at)).length
    : 0;
  return {
    y,
    units: totalUnits,
    rate: isRate,
    withheld: undefined,
    // Amounts per cell (time: sum) add up as they are: a real total.
    amounts: !isRate && method === "sum",
    gaps: isRate || method === "sum" ? gaps + unknownCells : 0,
    openEnd,
    // Declared cells: the time they cover and the time between them that
    // no sample covers (the total is then the observed subtotal), for
    // rates and amounts alike.
    covered: isRate || method === "sum" ? cover?.covered : undefined,
    uncovered: isRate || method === "sum" ? cover?.uncovered : undefined,
    held: isRate && !cells,
  };
}

/**
 * The time declared cells cover (their union) and the time between the
 * first start and the last end that none covers, in seconds; and whether
 * any two overlap.
 */
function cellCover(
  bounds: number[],
  order: number[],
  unit = 1,
  /** Every declared cell: the span the coverage is measured in. */
  all: number[] = order
) {
  let low = Infinity;
  let high = -Infinity;
  for (const at of all) {
    for (const edge of [bounds[2 * at], bounds[2 * at + 1]]) {
      if (Number.isFinite(edge)) {
        low = Math.min(low, edge);
        high = Math.max(high, edge);
      }
    }
  }
  const spans = order
    .map((at) => [bounds[2 * at], bounds[2 * at + 1]].sort((a, b) => a - b))
    .filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b))
    .sort((p, q) => p[0] - q[0]);
  let covered = 0;
  let overlap = false;
  let end = -Infinity;
  for (const [a, b] of spans) {
    const tolerance = 1e-9 * Math.max(1, Math.abs(b - a));
    if (a < end - tolerance) {
      overlap = true;
    }
    covered += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  const whole = high > low ? high - low : 0;
  return {
    overlap,
    covered: covered * unit,
    uncovered: Math.max(0, whole - covered) * unit,
  };
}

/**
 * A rate's total at each sample without declared cells: each value holds until
 * the next sample (forward hold), and the total at a sample is the time before
 * it only.
 */
function heldTotal(
  raw: number[],
  order: number[],
  values: number[],
  amount: (value: number, seconds: number) => number,
  unit: number
) {
  let total = 0;
  let gaps = 0;
  // Rows outside the order (undated) have no total.
  const y = new Array<number>(values.length).fill(Number.NaN);
  order.forEach((at, rank) => {
    if (rank > 0) {
      const before = order[rank - 1];
      const seconds = (raw[at] - raw[before]) * unit;
      if (Number.isFinite(values[before]) && Number.isFinite(seconds)) {
        total += amount(values[before], seconds);
      } else {
        gaps++;
      }
    }
    y[at] = total;
  });
  return { y, gaps };
}

/** Samples by date (file order among equal dates). */
function dateOrder(raw: number[], n: number) {
  const order = Array.from({ length: n }, (_, at) => at);
  if (raw.length !== n) {
    return order;
  }
  // Dated rows in time order; an undated row has no place in the order.
  return order
    .filter((at) => Number.isFinite(raw[at]))
    .sort((a, b) => raw[a] - raw[b] || a - b);
}

/**
 * Why a series is not totalled: a rate whose bounds could not be read, a
 * temperature (any spelling), or values that are a maximum, minimum or
 * spread over their cells (CF cell_methods).
 */
function notTotalled(
  isRate: boolean,
  units: string | undefined,
  boundsUnread: string | undefined,
  method: string | undefined
) {
  // Amounts too: without their cells, overlapping forecast sums from one origin
  // cannot be told apart.
  if (boundsUnread) {
    return `${boundsUnread}; read the plot again to retry`;
  }
  if (!isRate && converter(units, "K")) {
    return "a temperature is not added up";
  }
  if (method && !/^(mean|point|sum)$/.test(method)) {
    return `each value is the ${method.replace(/_/g, " ")} over its time`;
  }
  return undefined;
}

/**
 * Totals in date order (`order`), each sample adding `amount(rank, value)`;
 * a missing value adds nothing, and counts as a gap unless it is the last.
 */
function runningTotal(
  order: number[],
  values: number[],
  amount: (rank: number, value: number) => number
) {
  let total = 0;
  let gaps = 0;
  // Rows outside the order (undated) have no total.
  const y = new Array<number>(values.length).fill(Number.NaN);
  order.forEach((at, rank) => {
    const value = values[at];
    if (Number.isFinite(value)) {
      const add = amount(rank, value);
      total += Number.isFinite(add) ? add : 0;
    } else if (rank + 1 < order.length) {
      gaps++;
    }
    y[at] = total;
  });
  return { y, gaps };
}

/**
 * A rate's seconds per unit time, and the units of its total. A power in watts
 * is energy per second.
 */
function rateOf(units: string | undefined) {
  // One spelling of the exponent: kg m-2 s^-1 and s**-1 are s-1.
  const plain = (units ?? "").trim().replace(/\*\*|\^/g, "");
  // Watts with their prefix (kW m-2 is a thousand W m-2), any spelling.
  const watts = /^(k|M|G|m)?(?:W|watts?)\b(.*)$/.exec(plain);
  if (watts) {
    const prefix: Record<string, number> = { k: 1e3, M: 1e6, G: 1e9, m: 1e-3 };
    return {
      perSeconds: 1,
      total: `J${watts[2]}`,
      factor: watts[1] ? prefix[watts[1]] : 1,
    };
  }
  // Miles and nautical miles per hour, as offered for a wind: a distance per
  // hour.
  const perHour = /^(mph|knots?|kts?|kn)$/i.exec(plain);
  if (perHour) {
    return {
      perSeconds: 3600,
      total: /^m/i.test(perHour[1]) ? "mi" : "nmi",
      factor: 1,
    };
  }
  // Minutes too.
  const seconds: Record<string, number> = {
    s: 1,
    min: 60,
    h: 3600,
    hr: 3600,
    d: 86400,
    day: 86400,
  };
  // "per time" as a trailing "/day", or a factor "s-1" wherever it stands: kg
  // s-1 m-2 is kg m-2 s-1.
  const slash = /^(.*?)\s*\/\s*(s|min|h|hr|d|day)$/.exec(plain);
  if (slash) {
    return {
      perSeconds: seconds[slash[2]],
      total: slash[1].trim() || "1",
      factor: 1,
    };
  }
  const factors = plain.split(/\s+/).filter(Boolean);
  const at = factors.findIndex((f) => /^(s|min|h|hr|d|day)-1$/.test(f));
  if (at < 0) {
    return { perSeconds: undefined, total: units, factor: 1 };
  }
  const per = factors[at].slice(0, -2);
  const rest = factors.filter((_, k) => k !== at).join(" ");
  return { perSeconds: seconds[per], total: rest || "1", factor: 1 };
}

/**
 * The duration of the sample ranked `rank` by date, in its time units: its
 * declared bounds when published, else the spacing to the next date (the
 * last, without bounds, none).
 */
function durationOf(
  raw: number[],
  order: number[],
  rank: number,
  bounds?: number[]
) {
  const at = order[rank];
  if (bounds && bounds.length === 2 * raw.length) {
    const span = Math.abs(bounds[2 * at + 1] - bounds[2 * at]);
    // A declared cell of no length lasts no time; the spacing stands in only
    // where its bounds are missing.
    if (Number.isFinite(span)) {
      return span;
    }
  }
  const time = (r: number) => raw[order[r]];
  // To the next date; the last has no known end.
  return rank + 1 < order.length ? Math.abs(time(rank + 1) - time(rank)) : 0;
}

/** Per calendar year: samples above `threshold`, and samples with a value. */
export function countAbove(
  dates: string[],
  values: number[],
  threshold: number
) {
  const years = new Map<number, { above: number; valid: number }>();
  dates.forEach((date, at) => {
    const year = parts(date).year;
    if (!date || !Number.isFinite(year)) {
      return;
    }
    const entry = years.get(year) ?? { above: 0, valid: 0 };
    if (Number.isFinite(values[at])) {
      entry.valid++;
      entry.above += values[at] > threshold ? 1 : 0;
    }
    years.set(year, entry);
  });
  const x = [...years.keys()].sort((a, b) => a - b);
  return {
    x,
    above: x.map((year) => years.get(year)!.above),
    valid: x.map((year) => years.get(year)!.valid),
  };
}

/** Quartiles, median and extremes of finite values (sorted copy). */
function boxStats(list: number[]) {
  const sorted = list.filter(Number.isFinite).sort((a, b) => a - b);
  const at = (p: number) => {
    const k = (sorted.length - 1) * p;
    const lo = Math.floor(k);
    return sorted[lo] + (sorted[Math.ceil(k)] - sorted[lo]) * (k - lo);
  };
  return sorted.length
    ? {
        low: sorted[0],
        q1: at(0.25),
        median: at(0.5),
        q3: at(0.75),
        high: sorted[sorted.length - 1],
        count: sorted.length,
      }
    : undefined;
}

/** Every sample of each calendar month, across years, as a box. */
export function monthlyBoxes(dates: string[], values: number[]) {
  const byMonth = MONTHS.map(() => [] as number[]);
  // Only values that are of one month: a quarterly mean or maximum, or a mean
  // split across two months, is no sample of any.
  const pieces = datePieces.get(dates);
  dates.forEach((date, at) => {
    const own = pieces?.get(at);
    if (own && own.length !== 1) {
      return;
    }
    const month = parts(own ? own[0].date : date).month;
    if (month >= 1 && month <= 12 && Number.isFinite(values[at])) {
      byMonth[month - 1].push(values[at]);
    }
  });
  return byMonth.map(boxStats);
}

/** An in-place radix-2 FFT of a real series padded to a power of two. */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) {
      j ^= bit;
    }
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const angle = (-2 * Math.PI) / size;
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < size / 2; k++) {
        const cos = Math.cos(angle * k);
        const sin = Math.sin(angle * k);
        const a = start + k;
        const b = a + size / 2;
        const tr = re[b] * cos - im[b] * sin;
        const ti = re[b] * sin + im[b] * cos;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/**
 * The periodogram: how much of the series' variance sits at each period.
 * The series is taken as evenly spaced at its median step; missing values
 * become the mean; the mean and linear trend are removed and a Hann taper
 * applied before an FFT (zero-padded to a power of two). Returns periods
 * (in the step's seconds) from longest to shortest, each with its share of
 * the variance (%), and the period of the largest share.
 */
// eslint-disable-next-line max-lines-per-function
export function spectrum(
  values: number[],
  step: number
): { period: number[]; share: number[]; peak: number } | undefined {
  // Only the observed extent: fill-only ends are no record.
  const head = values.findIndex(Number.isFinite);
  let tail = values.length - 1;
  while (tail >= 0 && !Number.isFinite(values[tail])) {
    tail--;
  }
  if (head > 0 || (tail >= 0 && tail < values.length - 1)) {
    return spectrum(values.slice(head, tail + 1), step);
  }
  const valid = values.filter(Number.isFinite);
  if (valid.length < 8 || !(step > 0)) {
    return undefined;
  }
  // Observations on a coarser regular lattice (every second day, the rest
  // fill): their own cadence, so no period below their Nyquist limit is
  // claimed. Nearly all on one: that one, the few others left out.
  const lattice = observedLattice(values);
  const near =
    lattice.every > 1 ? undefined : nearLattice(values, valid.length);
  if (near) {
    return spectrum(
      values.map((v, at) => (at % near.every === near.first ? v : Number.NaN)),
      step
    );
  }
  if (lattice.every > 1) {
    const picked: number[] = [];
    for (let at = lattice.first; at < values.length; at += lattice.every) {
      picked.push(values[at]);
    }
    return spectrum(picked, step * lattice.every);
  }
  // Identical observations have no variance at any period; summing 273.15 128
  // times leaves a residual a window would turn into a 128-day "peak".
  // Departures from one observation are exact for a constant and keep small
  // real signals.
  const ref = valid[0];
  if (valid.every((v) => v === ref)) {
    return undefined;
  }
  // The linear trend fitted on the observations alone (least squares on their
  // indices), then gaps filled with no departure from it: filling them with the
  // mean first made a perfectly linear series with every fourth day missing
  // show a 3.765-day peak.
  let [count, sx, sy] = [0, 0, 0];
  values.forEach((v, at) => {
    if (Number.isFinite(v)) {
      count++;
      sx += at;
      sy += v - ref;
    }
  });
  const [mx, mean] = [sx / count, sy / count];
  let sxy = 0;
  let sxx = 0;
  values.forEach((v, at) => {
    if (Number.isFinite(v)) {
      sxy += (at - mx) * (v - ref - mean);
      sxx += (at - mx) ** 2;
    }
  });
  const slope = sxx ? sxy / sxx : 0;
  const n = values.length;
  let size = 1;
  while (size < n) {
    size <<= 1;
  }
  const re = new Float64Array(size);
  const im = new Float64Array(size);
  let [spread, scale] = [0, 0];
  values.forEach((v, at) => {
    const hann = 0.5 - 0.5 * Math.cos((2 * Math.PI * at) / Math.max(1, n - 1));
    const residual = Number.isFinite(v)
      ? v - ref - mean - slope * (at - mx)
      : 0;
    spread = Math.max(spread, Math.abs(residual));
    scale = Math.max(scale, Number.isFinite(v) ? Math.abs(v - ref) : 0);
    re[at] = residual * hann;
  });
  // Nothing beyond the trend but rounding: no period to name.
  if (spread <= 1e-9 * scale) {
    return undefined;
  }
  fft(re, im);
  // One-sided: an interior bin holds its negative-frequency partner's power too
  // (twice), the Nyquist bin has none (once), as a periodogram counts them.
  const power: number[] = [];
  const period: number[] = [];
  for (let k = 1; k <= size / 2; k++) {
    power.push((k < size / 2 ? 2 : 1) * (re[k] ** 2 + im[k] ** 2));
    period.push((size / k) * step);
  }
  const total = power.reduce((a, b) => a + b, 0);
  // No variance (a constant record): no peak to name.
  if (!(total > 0)) {
    return undefined;
  }
  const share = power.map((p) => (100 * p) / total);
  // Periods longer than the record are not resolved: dropped.
  const keep = period.map((p) => p <= n * step);
  const x = period.filter((_, at) => keep[at]);
  const y = share.filter((_, at) => keep[at]);
  let peak = 0;
  y.forEach((value, at) => {
    if (value > y[peak]) {
      peak = at;
    }
  });
  return { period: x, share: y, peak: x[peak] };
}

/** Share of the values a coarser lattice must hold to be theirs. */
const LATTICE_SHARE = 0.95;

/** A coarser lattice holding nearly every finite value, if one does. */
function nearLattice(values: number[], valid: number) {
  for (let every = 8; every >= 2; every--) {
    const counts = new Array<number>(every).fill(0);
    values.forEach((v, at) => {
      counts[at % every] += Number.isFinite(v) ? 1 : 0;
    });
    const first = counts.indexOf(Math.max(...counts));
    if (counts[first] >= 8 && counts[first] >= LATTICE_SHARE * valid) {
      return { every, first };
    }
  }
  return undefined;
}

/** The coarsest regular lattice holding every finite value. */
function observedLattice(values: number[]) {
  const gcd = (a: number, b: number): number => {
    while (b) {
      [a, b] = [b, a % b];
    }
    return a;
  };
  let [first, last, every] = [-1, -1, 0];
  values.forEach((v, at) => {
    if (Number.isFinite(v)) {
      if (first < 0) {
        first = at;
      } else {
        every = gcd(every, at - last);
      }
      last = at;
    }
  });
  return { first: Math.max(0, first), every: Math.max(1, every) };
}

/** Euler–Mascheroni constant, for the Gumbel location. */
const EULER = 0.5772156649;

/**
 * Return levels from yearly maxima with a Gumbel fit by the method of moments
 * (scale β = s × √6 / π, location μ = mean − γβ): the level reached on average
 * once every T years, x_T = μ − β × ln(−ln(1 − 1/T)). Each year counts when it
 * holds at least half as many values as the fullest year, unless the caller has
 * already qualified the years by their coverage (`qualified`): then each year's
 * maximum counts once, however many values gave it. The yearly maxima come back
 * at Gringorten plotting positions, T = (n + 0.12) / (rank − 0.44), rank 1 the
 * largest.
 */
export function returnLevels(
  dates: string[],
  values: number[],
  periods: number[] = [2, 5, 10, 20, 50, 100, 200],
  qualified = false
) {
  const years = new Map<number, { max: number; n: number }>();
  dates.forEach((date, at) => {
    const year = parts(date).year;
    if (!date || !Number.isFinite(values[at])) {
      return;
    }
    const entry = years.get(year) ?? { max: -Infinity, n: 0 };
    entry.max = Math.max(entry.max, values[at]);
    entry.n++;
    years.set(year, entry);
  });
  // One pass, no spread of every year as arguments.
  let fullest = 0;
  for (const e of years.values()) {
    fullest = Math.max(fullest, e.n);
  }
  const maxima = [...years.values()]
    .filter((e) => qualified || e.n * 2 >= fullest)
    .map((e) => e.max);
  if (maxima.length < 5) {
    return undefined;
  }
  const n = maxima.length;
  const mean = maxima.reduce((a, b) => a + b, 0) / n;
  const sd = Math.sqrt(
    maxima.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1)
  );
  const beta = (sd * Math.sqrt(6)) / Math.PI;
  const mu = mean - EULER * beta;
  const level = (t: number) => mu - beta * Math.log(-Math.log(1 - 1 / t));
  const sorted = [...maxima].sort((a, b) => b - a);
  return {
    periods,
    levels: periods.map(level),
    observed: sorted.map((value, at) => ({
      period: (n + 0.12) / (at + 1 - 0.44),
      value,
    })),
    years: n,
    location: mu,
    scale: beta,
  };
}
