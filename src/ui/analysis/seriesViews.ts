/**
 * Chart specs for the time views that reshape a series: running mean,
 * cumulative total, count above a value per year, boxes by month, the
 * spectrum and return levels. Each takes the series as read (its spec,
 * dates and raw time coordinate) and draws from it: nothing is read again.
 */
import type { TSeriesSpec } from "./plotFigure.ts";
import {
  accumulate,
  countAbove,
  monthlyBoxes,
  MONTHS,
  dateCells,
  dateDurations,
  dateOverlaps,
  datePieces,
  overlappingCells,
  dateKey,
  monthOf,
  regularStep,
  returnLevels,
  runningMeanInTime,
  runningMeanOverCells,
  secondsPerUnit,
  timeMethod,
  spectrum,
  stepName,
  stepSeconds,
  TIME_VIEWS,
  useHourPieces,
  type TTimeView,
} from "./timeViews.ts";

import {
  daysInYear,
  decodeTimeValue,
  encodeTimeValue,
  parseTimeAxis,
  timeLabels,
} from "@/lib/analysis/calendar.ts";
import { quantityKind } from "@/lib/analysis/cellMethods.ts";
import { formatValue } from "@/utils/formatValue.ts";

/** What the views need besides the spec: dates, raw times, units. */
export type TSeriesContext = {
  dates: string[];
  raw: number[];
  /** Declared time bounds, [start, end] per sample, flat. */
  bounds?: number[];
  /** Why declared time bounds could not be used. */
  boundsUnread?: string;
  timeUnits?: string;
  units?: string;
  /** CF cell_methods of the series: decides what a total means. */
  cellMethods?: string;
  /** Its CF standard name: whether it is read at instants by default. */
  standardName?: string;
  /** Intensive or extensive, as the source said (else from units). */
  quantity?: "intensive" | "extensive";
  /** The time dimension's name (cell_methods may name it for time). */
  timeDimension?: string;
  /** The time axis' CF calendar: years of declared cells are its own. */
  calendar?: string;
  /** Running-mean length in samples. */
  window: number;
  /** The value counted above. */
  threshold: number;
  /**
   * The values shown (missing ones NaN): annual coverage counts only the
   * samples that hold one.
   */
  values?: ArrayLike<number>;
};

/** Labels of extremes without bounds, apart from the shared ones. */
const undatedExtremes = new WeakMap<string[], string[]>();

/**
 * The date each value belongs to in calendar groups (months, years, hours of
 * the day): the middle of its declared cell when it is a statistic over that
 * cell, else its own time stamp. A January mean stamped at its end (1 February)
 * is January's. A cell across a group boundary belongs to the group holding its
 * middle.
 */
// eslint-disable-next-line max-lines-per-function
export function periodDates(
  ctx: Pick<
    TSeriesContext,
    | "dates"
    | "raw"
    | "bounds"
    | "timeUnits"
    | "calendar"
    | "cellMethods"
    | "timeDimension"
    | "units"
    | "standardName"
    | "quantity"
  >
) {
  const b = ctx.bounds;
  // An extreme with no bounds at all: when it happened within its cell is
  // unknown, so it is of no hour of the day. As a missing row of a bounds array
  // already was. Its own copy of the labels: they may be shared with another
  // variable's points, which keep their hours.
  if (!b && ["maximum", "minimum"].includes(methodOf(ctx) ?? "")) {
    let own = undatedExtremes.get(ctx.dates);
    if (!own) {
      own = ctx.dates.slice();
      undatedExtremes.set(ctx.dates, own);
      dateCells.set(own, {
        ctx,
        bounds: new Array<number>(2 * ctx.raw.length).fill(Number.NaN),
        whole: true,
      });
    }
    return own;
  }
  if (!b || b.length !== 2 * ctx.raw.length || methodOf(ctx) === "point") {
    return ctx.dates;
  }
  // Kept per axis with all it was made from: the same numbers in another
  // calendar are other dates.
  const kept = periodKept.get(ctx.raw);
  if (
    kept?.bounds === b &&
    kept.units === ctx.timeUnits &&
    kept.calendar === ctx.calendar &&
    kept.cellMethods === ctx.cellMethods
  ) {
    return kept.dates;
  }
  const middles = ctx.raw.map((raw, at) => {
    const [low, high] = [b[2 * at], b[2 * at + 1]];
    return Number.isFinite(low) && Number.isFinite(high)
      ? (low + high) / 2
      : raw;
  });
  const dates = timeLabels({
    raw: middles,
    units: ctx.timeUnits,
    calendar: ctx.calendar,
  });
  // Means over cells of known length are weighted by it in a month's or an
  // hour's average; any unknown length leaves them equal. Each cell's own:
  // either order of its bounds (a decreasing axis), and an unknown one only in
  // its own month.
  if (methodOf(ctx) === "mean") {
    // A cell of no length holds no time: weight 0, not unknown.
    const durations = ctx.raw.map((_, at) => {
      const d = Math.abs(b[2 * at + 1] - b[2 * at]);
      return Number.isFinite(d) ? d : Number.NaN;
    });
    // Kept as bounds: which overlap depends on which have values.
    if (overlappingCells(b).size) {
      dateOverlaps.set(dates, b);
    }
    // Known lengths, positive or none: cells of no length only give no mean of
    // their period.
    if (durations.some(Number.isFinite)) {
      dateDurations.set(dates, durations);
    }
    if (durations.some((d) => d > 0)) {
      const pieces = cellPieces(ctx, b, "month");
      if (pieces.size) {
        datePieces.set(dates, pieces);
      }
      // The hours too, when a diurnal cycle asks (timeViews).
      dateCells.set(dates, { ctx, bounds: b });
    }
  } else {
    // Other statistics are of an hour only inside it (a maximum over
    // more than its hour, or across two, says when nothing happened).
    dateCells.set(dates, { ctx, bounds: b, whole: true });
    // And of a month only inside it: a quarterly maximum is no February one, an
    // annual one no July one.
    const pieces = cellPieces(ctx, b, "month", true);
    if (pieces.size) {
      datePieces.set(dates, pieces);
    }
  }
  periodKept.set(ctx.raw, {
    bounds: b,
    units: ctx.timeUnits,
    calendar: ctx.calendar,
    cellMethods: ctx.cellMethods,
    dates,
  });
  return dates;
}
/**
 * Each cell that spans the start of a month (or an hour), split at every such
 * start inside it: the pieces' dates (their middles, as labels) and lengths.
 * The starts are found from each cell's own ends, not across the whole axis.
 */
// eslint-disable-next-line max-lines-per-function
function cellPieces(
  ctx: Pick<TSeriesContext, "raw" | "timeUnits" | "calendar">,
  b: number[],
  grain: "month" | "hour",
  /** An extreme: of an hour only when inside it, never split. */
  whole = false
) {
  const out = new Map<number, { date: string; length: number }[]>();
  const axis = ctx.timeUnits
    ? parseTimeAxis(ctx.timeUnits, ctx.calendar)
    : undefined;
  if (!axis || "unsupported" in axis) {
    return out;
  }
  // Month starts over the cells' whole span, found once and searched, when that
  // span is not many more months than cells: else each cell's own, as one row
  // far off does not make the axis' span long.
  const starts = grain === "month" ? monthStarts(axis, b) : undefined;
  const [cellsOf, middles, lengths]: number[][] = [[], [], []];
  ctx.raw.forEach((_, at) => {
    const [low, high] = [
      Math.min(b[2 * at], b[2 * at + 1]),
      Math.max(b[2 * at], b[2 * at + 1]),
    ];
    if (!(high > low)) {
      // An extreme or total whose interval is unknown locates no event: left
      // out, not placed at its stamp.
      if (whole && !Number.isFinite(high - low)) {
        out.set(at, []);
      }
      return;
    }
    // A mean over more than an hour says nothing of its hours: no part of a
    // diurnal cycle, wherever it starts.
    if (grain === "hour" && (high - low) * axis.unitSeconds > 3600 + 1e-6) {
      out.set(at, []);
      return;
    }
    // Likewise a mean over more than a month says nothing of its months: a
    // quarter is no three observed months, a century no 99 Januaries.
    if (
      grain === "month" &&
      (high - low) * axis.unitSeconds > longestMonth(ctx.calendar) + 1e-6
    ) {
      out.set(at, []);
      return;
    }
    const cuts = starts
      ? startsBetween(starts, low, high)
      : grain === "hour"
        ? hourStartsWithin(axis, low, high)
        : startsWithin(axis, low, high, grain);
    if (!cuts.length) {
      return;
    }
    // A maximum over a window across hours locates no event in either: left
    // out.
    if (whole) {
      out.set(at, []);
      return;
    }
    const edges = [low, ...cuts, high];
    for (let k = 1; k < edges.length; k++) {
      cellsOf.push(at);
      middles.push((edges[k] + edges[k - 1]) / 2);
      lengths.push(edges[k] - edges[k - 1]);
    }
  });
  // Every piece's date in one pass, not a decode per cell.
  const labels = timeLabels({
    raw: middles,
    units: ctx.timeUnits,
    calendar: ctx.calendar,
  });
  labels.forEach((date, k) => {
    const at = cellsOf[k];
    const list = out.get(at) ?? out.set(at, []).get(at)!;
    list.push({ date, length: lengths[k] });
  });
  return out;
}

/**
 * The longest month of the calendar: 31 days, 30 on a 360-day one. A longer
 * cell is no month's.
 */
function longestMonth(calendar?: string) {
  return (/^360_?day$/i.test(calendar ?? "") ? 30 : 31) * 86400;
}

/**
 * Every month start from the first finite edge's month to after the last,
 * or undefined when that is many more than there are cells.
 */
function monthStarts(
  axis: Exclude<ReturnType<typeof parseTimeAxis>, { unsupported: string }>,
  b: number[]
) {
  let [min, max] = [Infinity, -Infinity];
  for (const edge of b) {
    if (Number.isFinite(edge)) {
      [min, max] = [Math.min(min, edge), Math.max(max, edge)];
    }
  }
  if (!Number.isFinite(min)) {
    return undefined;
  }
  const [first, last] = [
    decodeTimeValue(axis, min),
    decodeTimeValue(axis, max),
  ];
  const months = (last.year - first.year) * 12 + (last.month - first.month) + 2;
  if (months > b.length / 2 + 16) {
    return undefined;
  }
  return Float64Array.from({ length: months + 1 }, (_, k) => {
    const m = first.month - 1 + k;
    return encodeTimeValue(axis, {
      year: first.year + Math.floor(m / 12),
      month: (m % 12) + 1,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    });
  });
}

/** The starts strictly inside (low, high), by search (as startsWithin). */
function startsBetween(starts: Float64Array, low: number, high: number) {
  let [lo, hi] = [0, starts.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid] <= low) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const found: number[] = [];
  for (let k = lo; k < starts.length && starts[k] < high; k++) {
    found.push(starts[k]);
  }
  return found;
}

/**
 * The hour starts strictly inside (low, high), by arithmetic: every calendar's
 * days are 24 equal hours from the reference's midnight, so no date is decoded.
 */
function hourStartsWithin(
  axis: Exclude<ReturnType<typeof parseTimeAxis>, { unsupported: string }>,
  low: number,
  high: number
) {
  const { hour, minute, second } = axis.reference;
  const offset = hour * 3600 + minute * 60 + second;
  const unit = axis.unitSeconds;
  const out: number[] = [];
  let k = Math.floor((low * unit + offset) / 3600) + 1;
  for (let guard = 0; guard < 1200; guard++, k++) {
    const start = (k * 3600 - offset) / unit;
    if (!(start < high)) {
      return out;
    }
    if (start > low) {
      out.push(start);
    }
  }
  return [];
}

/** The month (or hour) starts strictly inside (low, high), at most 1,200. */
function startsWithin(
  axis: Exclude<ReturnType<typeof parseTimeAxis>, { unsupported: string }>,
  low: number,
  high: number,
  grain: "month" | "hour"
) {
  const first = decodeTimeValue(axis, low);
  const starts: number[] = [];
  let { year, month, day, hour } = first;
  for (let guard = 0; guard < 1200; guard++) {
    if (grain === "month") {
      [year, month] = month === 12 ? [year + 1, 1] : [year, month + 1];
      [day, hour] = [1, 0];
    } else {
      hour += 1;
    }
    const start = encodeTimeValue(axis, {
      year,
      month,
      day,
      hour,
      minute: 0,
      second: 0,
    });
    if (!(start < high)) {
      return starts;
    }
    if (start > low) {
      starts.push(start);
    }
  }
  return [];
}

// A diurnal cycle splits cells at hours.
useHourPieces((ctx, bounds, whole) => cellPieces(ctx, bounds, "hour", whole));

const periodKept = new WeakMap<
  object,
  {
    bounds: number[];
    units?: string;
    calendar?: string;
    cellMethods?: string;
    dates: string[];
  }
>();

/**
 * The time cell method, CF's default made explicit: an intensive quantity
 * without one is read at instants (CF §7.3), its bounds notwithstanding.
 */
function methodOf(
  ctx: Pick<
    TSeriesContext,
    "cellMethods" | "timeDimension" | "units" | "standardName" | "quantity"
  >
) {
  return (
    timeMethod(ctx.cellMethods, ctx.timeDimension) ??
    ((ctx.quantity ?? quantityKind(ctx.units, ctx.standardName)) === "intensive"
      ? "point"
      : undefined)
  );
}

const u = (units?: string) => (units ? ` ${units}` : "");
const singular = (word: string) => word.replace(/s$/, "");

const DATED = /^-?\d{4,}-\d{2}-\d{2}/;

/**
 * The calendar years whose values give an annual maximum, and what that maximum
 * is of:
 *
 * - a published annual maximum: one value a year whose declared cell is a
 *   year and whose cell method is `time: maximum`;
 * - the largest of a year's shorter values, when they cover nine-tenths
 *   of it or more (declared cells, else the typical spacing): the annual
 *   maximum of daily, hourly… values, as said in the title.
 *
 * Annual means, sums or values of unknown statistic are no maxima. Dates
 * without a calendar are no years.
 */
export function maximaYears(ctx: TSeriesContext) {
  // Kept per series (its times, cells and plotted values), so the view menu
  // does not test 200,000 dates again on every change of the window or a
  // threshold.
  const key = [
    ctx.dates,
    ctx.bounds,
    ctx.values,
    ctx.timeUnits,
    ctx.calendar,
    ctx.cellMethods,
    ctx.timeDimension,
    ctx.boundsUnread,
  ];
  const kept = maximaKept.get(ctx.raw);
  if (kept && kept.key.every((part, at) => part === key[at])) {
    return kept.value;
  }
  const value = maximaOf(ctx);
  maximaKept.set(ctx.raw, { key, value });
  return value;
}

const maximaKept = new WeakMap<
  object,
  { key: unknown[]; value: ReturnType<typeof maximaOf> }
>();

/**
 * Whether a cell is of the support a fit's title names: a calendar day or hour
 * to the second, a calendar month of 28 to 31 days, a year of 360 to 366, else
 * within a hundredth.
 */
function sameSupport(length: number, typical: number) {
  const DAY = 86400;
  const near = (unit: number) => Math.abs(typical - unit) <= 1;
  if (near(DAY) || near(3600)) {
    return Math.abs(length - typical) <= 1;
  }
  if (typical >= 28 * DAY - 1 && typical <= 31 * DAY + 1) {
    return length >= 28 * DAY - 1 && length <= 31 * DAY + 1;
  }
  if (typical >= 360 * DAY - 1 && typical <= 366 * DAY + 1) {
    return length >= 360 * DAY - 1 && length <= 366 * DAY + 1;
  }
  return Math.abs(length / typical - 1) <= 0.01;
}

// eslint-disable-next-line max-lines-per-function
function maximaOf(ctx: TSeriesContext) {
  const unit = secondsPerUnit(ctx.timeUnits);
  const method = methodOf(ctx);
  const step = stepSeconds(ctx.raw, ctx.timeUnits);
  const b = ctx.bounds;
  // Readings at instants cover their cadence and belong to their stamp's year,
  // whatever nominal cells say.
  const declared =
    method !== "point" &&
    Boolean(b && unit && b.length === 2 * ctx.dates.length);
  // Each sample's support in seconds: its declared cell, else the typical
  // spacing centred on it. Declared cells that cannot be read: their support is
  // unknown, and the cadence does not stand in for it. Bounds read but some
  // missing: each cell by its own.
  const unknown = Boolean(ctx.boundsUnread) && method !== "point" && !declared;
  const supportOf = (at: number): [number, number] | undefined => {
    if (unknown) {
      return undefined;
    }
    if (declared) {
      const [p, q] = [b![2 * at] * unit!, b![2 * at + 1] * unit!];
      return Number.isFinite(p) && Number.isFinite(q)
        ? [Math.min(p, q), Math.max(p, q)]
        : undefined;
    }
    const t = ctx.raw[at] * (unit ?? Number.NaN);
    return step && Number.isFinite(t)
      ? [t - step / 2, t + step / 2]
      : undefined;
  };
  // Each row's support once, in two flat arrays (NaN: unknown): the median and
  // the years read it, with no pair made per row and call.
  const spanLo = new Float64Array(ctx.dates.length);
  const spanHi = new Float64Array(ctx.dates.length);
  for (let at = 0; at < ctx.dates.length; at++) {
    const span = supportOf(at);
    spanLo[at] = span ? span[0] : Number.NaN;
    spanHi[at] = span ? span[1] : Number.NaN;
  }
  const support = (at: number): [number, number] | undefined =>
    Number.isNaN(spanLo[at]) ? undefined : [spanLo[at], spanHi[at]];
  // Per year, flat: each support's start and end.
  const byYear = new Map<
    string,
    {
      lo: number[];
      hi: number[];
      values: number;
      /** Distinct observation times (a repeated stamp counts once), to 12. */
      times: Set<number>;
      annual: boolean;
      /** Its published annual values, and the most of its other ones. */
      annuals: Set<number>;
      others: number;
    }
  >();
  // A calendar year in seconds of the axis, to clip each support to it.
  const axis = ctx.timeUnits
    ? parseTimeAxis(ctx.timeUnits, ctx.calendar)
    : undefined;
  const start = (year: number) =>
    axis && !("unsupported" in axis) && unit
      ? encodeTimeValue(axis, {
          year,
          month: 1,
          day: 1,
          hour: 0,
          minute: 0,
          second: 0,
        }) * unit
      : Number.NaN;
  /** The time a year's supports cover together, inside the year. */
  const covered = (e: { lo: number[]; hi: number[] }, year: number) => {
    const [from, to] = [start(year), start(year + 1)];
    const clip = Number.isFinite(from) && Number.isFinite(to);
    return union(e.lo, e.hi, clip ? from : -Infinity, clip ? to : Infinity);
  };
  const cellYear = declaredYears(ctx);
  // What each value is: its cell's length when declared (30-day means a day
  // apart are 30-day means), else the spacing. Of the rows with a value: fill
  // rows of another support name nothing.
  const cells = declared
    ? medianOf(
        Float64Array.from({ length: ctx.dates.length }, (_, at) =>
          !ctx.values || Number.isFinite(ctx.values[at])
            ? spanHi[at] - spanLo[at]
            : Number.NaN
        )
      )
    : undefined;
  // Each row's part, decided once for the years and the fit alike: a value of
  // another support than the one the title names (a one-minute mean among daily
  // ones: 462 mm/day for 4.85), or of none known (a 999 mm row without bounds,
  // fitted as 2003's maximum), is no annual maximum of it. Monthly means are
  // calendar months by their bounds, not 28 to 31 days of anything. Which by
  // the bounds themselves: thirteen 28-day means a year are no calendar months.
  let [valued, monthly] = [0, 0];
  if (cellYear) {
    ctx.dates.forEach((_, at) => {
      if (!ctx.values || Number.isFinite(ctx.values[at])) {
        valued++;
        monthly += cellYear[at]?.monthly ? 1 : 0;
      }
    });
  }
  const monthlyFit =
    cells !== undefined &&
    cells >= 28 * 86400 - 1 &&
    cells <= 31 * 86400 + 1 &&
    Boolean(cellYear) &&
    2 * monthly >= valued;
  const ofStatistic = (span: [number, number] | undefined, at: number) => {
    if (!span) {
      return false;
    }
    // A maximum over any part of a year bounds that year's maximum (four
    // quarterly maxima make a year as twelve monthly ones do); a mean or
    // sum is one of the length the title names.
    const length = span[1] - span[0];
    return (
      method === "maximum" ||
      cells === undefined ||
      !Number.isFinite(cells) ||
      (length > 0 &&
        (monthlyFit
          ? sameSupport(length, cells) && Boolean(cellYear?.[at]?.monthly)
          : // A fixed 28-day product is not calendar months: its own
            // length only.
            cells >= 28 * 86400 - 1 && cells <= 31 * 86400 + 1
            ? Math.abs(length - cells) <= 1
            : sameSupport(length, cells)))
    );
  };
  // A published annual value stands for its year only as its maximum: an annual
  // mean or total beside daily ones is another support, left out.
  const annualMax = (at: number) =>
    method === "maximum" && Boolean(cellYear?.[at]?.wholeYear);
  const rowYear = new Array<string | undefined>(ctx.dates.length);
  const unsupported: number[] = [];
  ctx.dates.forEach((d, at) => {
    // Only samples that hold a value count.
    const value = ctx.values?.[at];
    if (!DATED.test(d) || (ctx.values && !Number.isFinite(value))) {
      return;
    }
    const span = support(at);
    // Cells longer than a year date no event in any year; the years they reach
    // are withheld where they exceed their own maxima (withholdAmbiguous), the
    // others kept.
    if (span && span[1] - span[0] > 366 * 86400) {
      return;
    }
    if (!ofStatistic(span, at) && !annualMax(at)) {
      if (!span) {
        unsupported.push(at);
      }
      return;
    }
    // The year of its cell, not of its stamp.
    const year = cellYear?.[at]?.year ?? dateKey(d, 4);
    const entry = byYear.get(year) ?? {
      lo: [],
      hi: [],
      values: 0,
      times: new Set<number>(),
      annual: false,
      annuals: new Set<number>(),
      others: Number.NEGATIVE_INFINITY,
    };
    if (annualMax(at)) {
      entry.annuals.add(value ?? Number.NaN);
    } else {
      entry.others = Math.max(entry.others, value ?? Number.NaN);
    }
    entry.values++;
    if (!cellYear?.[at]?.crossing) {
      rowYear[at] = year;
    }
    if (entry.times.size < 12) {
      entry.times.add(ctx.raw[at]);
    }
    if (span) {
      entry.lo.push(span[0]);
      entry.hi.push(span[1]);
      // A published annual value: exactly one calendar year.
      entry.annual ||= annualMax(at);
    }
    byYear.set(year, entry);
  });
  const years = new Set<string>();
  let published = false;
  const publishedYears = new Set<string>();
  for (const [year, e] of byYear) {
    if (e.annual) {
      // A year's own statistic: a maximum only when declared one; maxima of its
      // parts beside it are redundant where they do not exceed it.
      if (
        method === "maximum" &&
        e.annuals.size === 1 &&
        !(e.others > [...e.annuals][0])
      ) {
        years.add(year);
        publishedYears.add(year);
        published = true;
      }
    } else if (
      // Nine-tenths of this year of this calendar, counting only the time
      // inside it.
      covered(e, Number(year)) >=
        0.9 * (daysInYear(ctx.calendar, Number(year)) ?? 365) * 86400 &&
      // Twelve observation times, not twelve rows. Declared cells are their own
      // evidence: four quarterly maxima cover a year as twelve monthly ones do.
      ((declared && method === "maximum") || e.times.size >= 12)
    ) {
      // The time the valid samples cover together, not the sum of their
      // lengths (twelve overlapping 30-day means starting on 1–12 January
      // cover 41 days, not 360).
      years.add(year);
    }
  }
  if (method === "maximum" && cellYear) {
    withholdAmbiguous(years, ctx, cellYear);
  }
  // A value of unknown support above its stamp's year's own maximum may be
  // that year's: the year is withheld, and said, not fitted with it.
  const own = new Map<string, number>();
  rowYear.forEach((year, at) => {
    const v = ctx.values?.[at] ?? Number.NaN;
    if (year !== undefined && Number.isFinite(v)) {
      own.set(year, Math.max(own.get(year) ?? -Infinity, v));
    }
  });
  const withheld = new Set<string>();
  for (const at of unsupported) {
    const year = cellYear?.[at]?.year ?? dateKey(ctx.dates[at], 4);
    const v = ctx.values?.[at] ?? Number.NaN;
    if (years.has(year) && v > (own.get(year) ?? -Infinity)) {
      years.delete(year);
      withheld.add(year);
    }
  }
  const every: Record<string, string> = {
    hours: "hourly ",
    days: "daily ",
    months: "monthly ",
  };
  const length =
    cells && Number.isFinite(cells)
      ? Math.abs(cells - 86400) < 60
        ? "daily "
        : Math.abs(cells - 3600) < 1
          ? "hourly "
          : cells > 27 * 86400 &&
              cells < 32 * 86400 &&
              (cellYear?.every((c) => !c || c.monthly) ?? true)
            ? "monthly "
            : `${Number((cells / 86400).toPrecision(3))}-day `
      : (every[stepName(step)] ?? "");
  const statistic =
    { mean: "means", sum: "sums", maximum: "maxima" }[method ?? ""] ?? "values";
  // Each year by what gave it: all published, or a mix said as one, of the
  // years finally kept.
  for (const year of publishedYears) {
    if (!years.has(year)) {
      publishedYears.delete(year);
    }
  }
  published = publishedYears.size > 0;
  const mixed = published && publishedYears.size < years.size;
  const of = !published
    ? `annual maxima of ${length}${statistic}`
    : mixed
      ? `annual maxima, published for ${publishedYears.size} of ${years.size} years, else of ${length}${statistic}`
      : "published annual maxima";
  return { years, of, rowYear, withheld: [...withheld].sort() };
}

/** A year as dates write it: "-0006", "0394", "2001". */
function yearKey(year: number) {
  return `${year < 0 ? "-" : ""}${String(Math.abs(year)).padStart(4, "0")}`;
}

/**
 * Each declared cell's year (of its middle, in the axis' calendar) and whether
 * it is exactly that calendar year; undefined without cells. Kept per axis: the
 * view menu and the fit ask for the same cells.
 */
function declaredYears(ctx: TSeriesContext) {
  const b = ctx.bounds;
  if (
    !b ||
    b.length !== 2 * ctx.raw.length ||
    !ctx.timeUnits ||
    methodOf(ctx) === "point"
  ) {
    return undefined;
  }
  const axis = parseTimeAxis(ctx.timeUnits, ctx.calendar);
  if ("unsupported" in axis) {
    return undefined;
  }
  const key = [b, ctx.timeUnits, ctx.calendar, ctx.cellMethods];
  const kept = yearsKept.get(ctx.raw);
  if (kept && kept.key.every((part, at) => part === key[at])) {
    return kept.value;
  }
  const value = cellYears(ctx.raw.length, b, axis, ctx.timeUnits);
  yearsKept.set(ctx.raw, { key, value });
  return value;
}

type TCellYear = {
  year: string;
  wholeYear: boolean;
  crossing?: [number, number];
  monthly: boolean;
};

const yearsKept = new WeakMap<
  object,
  { key: unknown[]; value: (TCellYear | undefined)[] }
>();

// eslint-disable-next-line max-lines-per-function
function cellYears(
  n: number,
  b: number[],
  axis: Exclude<ReturnType<typeof parseTimeAxis>, { unsupported: string }>,
  units: string
) {
  const first = (d: ReturnType<typeof decodeTimeValue>) =>
    d.month === 1 &&
    d.day === 1 &&
    d.hour === 0 &&
    d.minute === 0 &&
    d.second === 0;
  // The years' starts on the axis: a cell's years by search, and a date
  // decoded only within a second of a new year or for a month-long cell.
  const unit = secondsPerUnit(units);
  let [min, max] = [Infinity, -Infinity];
  for (const edge of b) {
    if (Number.isFinite(edge)) {
      [min, max] = [Math.min(min, edge), Math.max(max, edge)];
    }
  }
  const y0 = Number.isFinite(min) ? decodeTimeValue(axis, min).year - 1 : 0;
  const span = Number.isFinite(max)
    ? decodeTimeValue(axis, max).year - y0 + 2
    : 0;
  const starts =
    unit && span > 0 && span <= 4 * n + 16
      ? Float64Array.from({ length: span + 1 }, (_, k) =>
          encodeTimeValue(axis, {
            year: y0 + k,
            month: 1,
            day: 1,
            hour: 0,
            minute: 0,
            second: 0,
          })
        )
      : undefined;
  const second = unit ? 1 / unit : 0;
  // Whether the last value placed opens its year.
  let opens = false;
  /** A value's year (and `opens`); decoded only near a new year. */
  const yearOf = (v: number) => {
    let lo = 0;
    if (starts) {
      let hi = starts.length - 1;
      while (lo < hi) {
        const mid = (lo + hi + 1) >> 1;
        if (starts[mid] <= v) {
          lo = mid;
        } else {
          hi = mid - 1;
        }
      }
    }
    if (
      !starts ||
      Math.abs(v - starts[lo]) <= second ||
      (lo + 1 < starts.length && Math.abs(starts[lo + 1] - v) <= second)
    ) {
      const d = decodeTimeValue(axis, v);
      opens = first(d);
      return d.year;
    }
    opens = false;
    return y0 + lo;
  };
  // One record per kind of cell: 200,000 hours of 22 years share 22.
  const records = new Map<string, TCellYear>();
  let last:
    | {
        middle: number;
        wholeYear: boolean;
        monthly: boolean;
        crossFrom: number;
        crossTo: number;
        record: TCellYear;
      }
    | undefined;
  const out = new Array<TCellYear | undefined>(n);
  for (let at = 0; at < n; at++) {
    const p = b[2 * at];
    const q = b[2 * at + 1];
    if (!Number.isFinite(p) || !Number.isFinite(q)) {
      continue;
    }
    const low = p <= q ? p : q;
    const high = p <= q ? q : p;
    const fromYear = yearOf(low);
    const fromOpens = opens;
    const endYear = yearOf(high);
    const toOpens = opens;
    // Half open: a cell ending at midnight on 1 January is none of that year.
    const toYear = toOpens && endYear > fromYear ? endYear - 1 : endYear;
    const middle = fromYear === toYear ? fromYear : yearOf((low + high) / 2);
    const ends = toOpens && endYear === fromYear + 1;
    // A calendar month (a rolling 30 days is none): only a cell of about
    // a month's length can be one.
    const days = unit ? ((high - low) * unit) / 86400 : 30;
    let monthly = false;
    if (days > 27 && days < 32) {
      const [f, t] = [decodeTimeValue(axis, low), decodeTimeValue(axis, high)];
      monthly =
        f.day === 1 &&
        t.day === 1 &&
        f.hour === 0 &&
        t.hour === 0 &&
        t.year * 12 + t.month === f.year * 12 + f.month + 1;
    }
    const crossing = toYear > fromYear;
    const wholeYear = fromOpens && ends;
    const [crossFrom, crossTo] = crossing ? [fromYear, toYear] : [0, 0];
    if (
      !last ||
      last.middle !== middle ||
      last.wholeYear !== wholeYear ||
      last.monthly !== monthly ||
      last.crossFrom !== crossFrom ||
      last.crossTo !== crossTo
    ) {
      const id = `${middle} ${wholeYear} ${monthly} ${crossFrom} ${crossTo}`;
      const record = records.get(id) ?? {
        // Signed as dates are ("-0006"), not padded through the sign.
        year: yearKey(middle),
        wholeYear,
        // Its years, when it reaches over a new year: its maximum dates no
        // event.
        ...(crossing
          ? { crossing: [fromYear, toYear] as [number, number] }
          : {}),
        monthly,
      };
      records.set(id, record);
      last = { middle, wholeYear, monthly, crossFrom, crossTo, record };
    }
    out[at] = last.record;
  }
  return out;
}

/**
 * Years a maximum over a new year could raise: its value counts in none,
 * and a year it overlaps is withheld where it exceeds that year's own
 * largest value (it may have happened in that year).
 */
function withholdAmbiguous(
  years: Set<string>,
  ctx: TSeriesContext,
  cellYear: NonNullable<ReturnType<typeof declaredYears>>
) {
  const own = new Map<string, number>();
  const reaching = new Map<string, number>();
  cellYear.forEach((cell, at) => {
    const value = ctx.values?.[at];
    if (!cell || !Number.isFinite(value)) {
      return;
    }
    if (!cell.crossing) {
      own.set(cell.year, Math.max(own.get(cell.year) ?? -Infinity, value!));
      return;
    }
    // The candidate years it reaches, not every year between.
    const [from, to] = cell.crossing;
    const reach = (key: string) =>
      reaching.set(key, Math.max(reaching.get(key) ?? -Infinity, value!));
    if (to - from + 1 <= years.size) {
      for (let y = from; y <= to; y++) {
        reach(yearKey(y));
      }
    } else {
      for (const key of years) {
        const y = Number(key);
        if (y >= from && y <= to) {
          reach(key);
        }
      }
    }
  });
  for (const [year, most] of reaching) {
    if (most > (own.get(year) ?? -Infinity)) {
      years.delete(year);
    }
  }
}

/** The length the intervals cover together. */
/**
 * The length of the union of intervals [lo, hi], each clipped to [from,
 * to]; sorted only when they are not in order already.
 */
function union(lo: number[], hi: number[], from = -Infinity, to = Infinity) {
  let order: ArrayLike<number> | undefined;
  for (let k = 1; k < lo.length; k++) {
    if (lo[k] < lo[k - 1]) {
      order = Uint32Array.from(lo, (_, j) => j).sort((x, y) => lo[x] - lo[y]);
      break;
    }
  }
  let total = 0;
  let end = -Infinity;
  for (let k = 0; k < lo.length; k++) {
    const at = order ? order[k] : k;
    const a = Math.max(lo[at], from);
    const b = Math.max(a, Math.min(hi[at], to));
    total += Math.max(0, b - Math.max(a, end));
    end = Math.max(end, b);
  }
  return total;
}

function medianOf(list: ArrayLike<number>) {
  // The upper median, by selection: no sort of every row.
  const finite = Float64Array.from(
    Array.prototype.filter.call(list, Number.isFinite) as number[]
  );
  if (!finite.length) {
    return Number.NaN;
  }
  const k = finite.length >> 1;
  let [lo, hi] = [0, finite.length - 1];
  while (hi > lo) {
    const pivot = finite[(lo + hi) >> 1];
    let [i, j] = [lo, hi];
    while (i <= j) {
      while (finite[i] < pivot) {
        i++;
      }
      while (finite[j] > pivot) {
        j--;
      }
      if (i <= j) {
        [finite[i], finite[j]] = [finite[j], finite[i]];
        i++;
        j--;
      }
    }
    if (k <= j) {
      hi = j;
    } else if (k >= i) {
      lo = i;
    } else {
      break;
    }
  }
  return finite[k];
}

/** The views offered for a series of these dates and times. */
export function reshapeViews(ctx: TSeriesContext): TTimeView[] {
  // A spectrum assumes even spacing: irregular dates get none.
  const step = regularStep(ctx.raw, ctx.timeUnits);
  const enough = ctx.dates.length >= 3;
  // Counts per year and boxes per month need calendar dates.
  const dated = ctx.dates.length > 0 && ctx.dates.every((d) => DATED.test(d));
  return [
    ...(enough ? [TIME_VIEWS.RUNNING, TIME_VIEWS.CUMULATIVE] : []),
    ...(enough && dated ? [TIME_VIEWS.COUNT] : []),
    ...(dated && new Set(ctx.dates.map(monthOf)).size >= 3
      ? [TIME_VIEWS.BOXES]
      : []),
    ...(step && ctx.dates.length >= 16 ? [TIME_VIEWS.SPECTRUM] : []),
    // Five calendar years with a dozen values or more each: annual maxima need
    // dates and sampling within each year.
    ...(maximaYears(ctx).years.size >= 5 ? [TIME_VIEWS.RETURN] : []),
  ];
}

/** The series with its running mean over it (solid, read out). */
function runningSpec(base: TSeriesSpec, ctx: TSeriesContext): TSeriesSpec {
  // Means over declared cells by the time each shares with the window.
  const b = ctx.bounds;
  const values =
    (methodOf(ctx) === "mean" && b && b.length === 2 * ctx.raw.length
      ? runningMeanOverCells(base.y, ctx.raw, b, ctx.window)
      : undefined) ?? runningMeanInTime(base.y, ctx.raw, ctx.window);
  const word = singular(stepName(stepSeconds(ctx.raw, ctx.timeUnits)));
  const label = `${ctx.window}-${word} running mean`;
  return {
    ...base,
    overlay: { values, label },
    readout: (index: number) => [
      ...base.readout(index),
      `${label}: ${Number.isFinite(values[index]) ? `${formatValue(values[index])}${u(ctx.units)}` : "not enough values"}`,
    ],
  };
}

/** The running total; a rate is multiplied by each sample's duration. */
// eslint-disable-next-line max-lines-per-function
function cumulativeSpec(base: TSeriesSpec, ctx: TSeriesContext): TSeriesSpec {
  const total = accumulate(
    ctx.raw,
    ctx.timeUnits,
    base.y,
    ctx.units,
    ctx.bounds,
    ctx.boundsUnread,
    methodOf(ctx)
  );
  const name = base.yTitle.replace(/\s*\([^)]*\)$/, "");
  // A rate is integrated over time; anything else is a sum of the samples as
  // they are, and says so. Cells with time between them that no sample covers:
  // the total is of the observed time only.
  const uncovered = total.uncovered ?? 0;
  const partial = uncovered > 0.01 * Math.max(total.covered ?? 0, 3600);
  const what = partial
    ? "Observed subtotal of"
    : total.rate || total.amounts
      ? "Cumulative"
      : "Sum of samples of";
  const days = (seconds: number) =>
    `${formatValue(seconds / 86400)} day${Math.abs(seconds / 86400 - 1) < 1e-9 ? "" : "s"}`;
  return {
    ...base,
    y: total.y,
    yTitle: total.withheld
      ? `${what} ${name}: not totalled`
      : `${what} ${name}${total.units ? ` (${total.units})` : ""}`,
    units: total.units,
    band: undefined,
    members: undefined,
    readout: (index: number) => [
      ...base.readout(index).slice(0, 2),
      total.withheld
        ? total.rate
          ? `No total: ${total.withheld}, so the duration of each sample is unknown`
          : `No total: ${total.withheld}`
        : `Total so far ${formatValue(total.y[index])}${u(total.units)}${total.rate ? " (rate × duration)" : ""}`,
      // What the total leaves out, said where it is read.
      ...(total.gaps
        ? [
            `${total.gaps.toLocaleString("en-US")} intervals without a value add nothing`,
          ]
        : []),
      ...(partial
        ? [
            `Covers ${days(total.covered ?? 0)}; ${days(uncovered)} between them have no sample`,
          ]
        : []),
      ...(total.held
        ? [
            "No declared cells: each value holds until the next sample; a date's total is the time before it",
          ]
        : []),
      ...(total.openEnd
        ? ["The last sample's interval has no declared end: it adds nothing"]
        : []),
    ],
  };
}

/** Per year: how many samples exceed the value. */
function countSpec(base: TSeriesSpec, ctx: TSeriesContext): TSeriesSpec {
  // Records of one support: those over another interval (a two-day mean beside
  // daily ones) are no more days, and are left out. Each interval once: an
  // exact repeat is no further day.
  const other = otherSupport(ctx, base.y);
  const values = base.y.map((v, at) => (other?.has(at) ? Number.NaN : v));
  const counted = countAbove(periodDates(ctx), values, ctx.threshold);
  const word = stepName(stepSeconds(ctx.raw, ctx.timeUnits));
  const what = word === "steps" ? "samples" : word;
  const above = `above ${formatValue(ctx.threshold)}${u(ctx.units)}`;
  const left = other
    ? [...other].filter((at) => Number.isFinite(base.y[at])).length
    : 0;
  return {
    mode: "cycle",
    x: counted.x,
    y: counted.above,
    xTitle: "Year",
    yTitle: `${what[0].toUpperCase()}${what.slice(1)} ${above}`,
    xLabel: (value: number) => (Number.isInteger(value) ? String(value) : ""),
    xStep: Math.max(1, Math.ceil(counted.x.length / 10)),
    markers: true,
    readout: (index: number) => [
      String(counted.x[index]),
      `${counted.above[index]} of ${counted.valid[index]} ${what} ${above}`,
      ...(left
        ? [
            `${left.toLocaleString("en-US")} ${left === 1 ? "record" : "records"} over other intervals left out`,
          ]
        : []),
    ],
  };
}

/**
 * Rows whose declared cell lasts other than most valid ones do (the series' own
 * support), and repeats of an interval already counted, when bounds are
 * published; undefined when all agree. Calendar months (28 to 31 days) are one
 * support, as are years.
 */
function otherSupport(ctx: TSeriesContext, values: ArrayLike<number>) {
  const b = ctx.bounds;
  if (!b || b.length !== 2 * ctx.raw.length) {
    return undefined;
  }
  const unit = secondsPerUnit(ctx.timeUnits) ?? 0;
  const DAY = 86400;
  const classOf = (span: number) => {
    const seconds = span * unit;
    if (seconds >= 28 * DAY && seconds <= 31 * DAY) {
      return "month";
    }
    if (seconds >= 365 * DAY && seconds <= 366 * DAY) {
      return "year";
    }
    return String(span);
  };
  const classes = ctx.raw.map((_, at) => {
    const span = Math.abs(b[2 * at + 1] - b[2 * at]);
    return Number.isFinite(span) && Number.isFinite(values[at])
      ? classOf(span)
      : undefined;
  });
  const tally = new Map<string, number>();
  for (const kind of classes) {
    if (kind !== undefined) {
      tally.set(kind, (tally.get(kind) ?? 0) + 1);
    }
  }
  const other = new Set<number>();
  const seen = new Set<string>();
  const usual = [...tally].sort((x, y) => y[1] - x[1])[0]?.[0];
  classes.forEach((kind, at) => {
    if (kind === undefined) {
      return;
    }
    const interval = `${Math.min(b[2 * at], b[2 * at + 1])},${Math.max(b[2 * at], b[2 * at + 1])}`;
    if (kind !== usual || seen.has(interval)) {
      other.add(at);
    }
    seen.add(interval);
  });
  return other.size ? other : undefined;
}

/** Every sample of each month across years, as a box. */
function boxesSpec(base: TSeriesSpec, ctx: TSeriesContext): TSeriesSpec {
  const boxes = monthlyBoxes(periodDates(ctx), base.y);
  return {
    mode: "cycle",
    x: MONTHS.map((_, at) => at + 1),
    y: boxes.map((box) => box?.median ?? Number.NaN),
    xTitle: "Month",
    yTitle: base.yTitle,
    xLabel: (value: number) =>
      Number.isInteger(value) ? (MONTHS[value - 1] ?? "") : "",
    units: ctx.units,
    boxes,
    readout: (index: number) => {
      const box = boxes[index];
      return box
        ? [
            MONTHS[index],
            `Median ${formatValue(box.median)}${u(ctx.units)}, middle half ${formatValue(box.q1)} to ${formatValue(box.q3)}`,
            `Range ${formatValue(box.low)} to ${formatValue(box.high)} over ${box.count} values`,
          ]
        : [MONTHS[index], "No values"];
    },
  };
}

/**
 * Period units for a step: the step's own unit, years for long records; months
 * and years of the dataset's calendar.
 */
function periodUnit(step: number, calendar?: string) {
  const word = stepName(step);
  const unit = word === "steps" ? "days" : word;
  const fixed = calendarYearDays(calendar);
  const seconds = {
    hours: 3600,
    days: 86400,
    months: (fixed ? fixed / 12 : 30.4375) * 86400,
    years: (fixed ?? 365.25) * 86400,
  }[unit] as number;
  return { unit, seconds };
}

/** Days in every year of a fixed-length calendar (360, 365 or 366). */
function calendarYearDays(calendar?: string) {
  const name = (calendar ?? "").toLowerCase();
  return /^360_?day$/.test(name)
    ? 360
    : /^(365_?day|noleap)$/.test(name)
      ? 365
      : /^(366_?day|all_?leap)$/.test(name)
        ? 366
        : undefined;
}

/** Share of the variance at each period, on a log axis. */
function spectrumSpec(base: TSeriesSpec, ctx: TSeriesContext): TSeriesSpec {
  const step = stepSeconds(ctx.raw, ctx.timeUnits)!;
  // The values in time order (a file may store them otherwise).
  // Dated rows only: an undated one has no place in time.
  const order = Array.from(ctx.raw, (_, at) => at)
    .filter((at) => Number.isFinite(ctx.raw[at]))
    .sort((a, b) => ctx.raw[a] - ctx.raw[b] || a - b);
  const s = spectrum(
    order.map((at) => base.y[at]),
    step
  );
  const { unit, seconds } = periodUnit(step, ctx.calendar);
  const x = (s?.period ?? []).map((p) => p / seconds);
  const reversed = [...x].reverse();
  const share = [...(s?.share ?? [])].reverse();
  return {
    mode: "cycle",
    x: reversed,
    y: share,
    xTitle: `Period (${unit})`,
    yTitle: "Share of variance (%)",
    xLog: true,
    xLabel: (value: number) => formatValue(value),
    readout: (index: number) => [
      `Period ${formatValue(reversed[index])} ${unit}`,
      `${formatValue(share[index])} % of the variance`,
      ...(s ? [`Largest at ${formatValue(s.peak / seconds)} ${unit}`] : []),
    ],
  };
}

/**
 * The fit and what it is of, kept per series as plotted: choosing Return levels
 * again, or after another view, fits nothing again.
 */
const fitsKept = new WeakMap<
  object,
  { key: unknown[]; value: ReturnType<typeof fitNow> }
>();

function fitOf(base: TSeriesSpec, ctx: TSeriesContext) {
  const key = [
    base.y,
    ctx.values,
    ctx.dates,
    ctx.bounds,
    ctx.timeUnits,
    ctx.calendar,
    ctx.cellMethods,
    ctx.timeDimension,
  ];
  const kept = fitsKept.get(ctx.raw);
  if (kept && kept.key.every((part, at) => part === key[at])) {
    return kept.value;
  }
  const value = fitNow(base, ctx);
  fitsKept.set(ctx.raw, { key, value });
  return value;
}

function fitNow(base: TSeriesSpec, ctx: TSeriesContext) {
  // Only the years whose values give a maximum, and saying of what: the values
  // as plotted, below the coverage cutoff hidden, decide which years were
  // observed, as they decide the fit.
  const plotted = base.y.map((v, at) =>
    Number.isFinite(v) && (!ctx.values || Number.isFinite(ctx.values[at]))
      ? v
      : Number.NaN
  );
  // The same values as the menu's: its years, already found.
  const values = ctx.values;
  const same =
    values?.length === plotted.length &&
    plotted.every(
      (v, at) =>
        v === values[at] || (Number.isNaN(v) && Number.isNaN(values[at]))
    );
  const { years, of, rowYear, withheld } = maximaYears(
    same ? ctx : { ...ctx, values: plotted }
  );
  // The rows the years were found from, in the same years (a cell's, not
  // its stamp's); a maximum over a new year dates no event, in no year.
  const keep = rowYear.map((year) => year !== undefined && years.has(year));
  const r = returnLevels(
    rowYear.flatMap((year, at) => (keep[at] ? [`${year}-07-01`] : [])),
    plotted.filter((_, at) => keep[at]),
    undefined,
    true
  );
  return { r, of, withheld };
}

/** Gumbel return levels from yearly maxima, with the maxima themselves. */
function returnSpec(base: TSeriesSpec, ctx: TSeriesContext): TSeriesSpec {
  const { r, of, withheld } = fitOf(base, ctx);
  const unsure = withheld.length
    ? [
        `${withheld.join(", ")} withheld: a value of unknown time support there is above that year's own maximum`,
      ]
    : [];
  if (!r) {
    return {
      ...base,
      readout: (index: number) => [
        ...base.readout(index),
        "Return levels need five years of annual maxima (published, or values covering nine-tenths of each year).",
        ...unsure,
      ],
    };
  }
  return {
    mode: "cycle",
    x: r.periods,
    y: r.levels,
    xTitle: "Return period (years)",
    yTitle: `Return level of ${base.yTitle}`,
    xLog: true,
    xLabel: (value: number) => formatValue(value),
    units: ctx.units,
    points: {
      x: r.observed.map((o) => o.period),
      y: r.observed.map((o) => o.value),
      label: of,
    },
    readout: (index: number) => [
      `${formatValue(r.periods[index])}-year return level`,
      `${formatValue(r.levels[index])}${u(ctx.units)} (Gumbel fit to ${r.years} ${of})`,
      ...(r.periods[index] > 2 * r.years
        ? ["Beyond twice the record: uncertain"]
        : []),
      ...unsure,
    ],
  };
}

/** The spec of a reshaping view, or undefined for another view. */
export function reshapedSpec(
  view: TTimeView,
  base: TSeriesSpec,
  ctx: TSeriesContext
): TSeriesSpec | undefined {
  const build: Partial<
    Record<TTimeView, (b: TSeriesSpec, c: TSeriesContext) => TSeriesSpec>
  > = {
    [TIME_VIEWS.RUNNING]: runningSpec,
    [TIME_VIEWS.CUMULATIVE]: cumulativeSpec,
    [TIME_VIEWS.COUNT]: countSpec,
    [TIME_VIEWS.BOXES]: boxesSpec,
    [TIME_VIEWS.SPECTRUM]: spectrumSpec,
    [TIME_VIEWS.RETURN]: returnSpec,
  };
  return build[view]?.(base, ctx);
}
