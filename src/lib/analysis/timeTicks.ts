import {
  decodeTimeValue,
  encodeTimeValue,
  type TCalendarDate,
  type TTimeAxis,
} from "./calendar.ts";

/**
 * Time-axis ticks placed at the calendar instants they name (midnight,
 * first of a month, a new year), in the source calendar, with labels whose
 * precision follows the tick spacing.
 */
export type TTimeTick = { value: number; label: string };

const MONTHS = [
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
const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

type TStep =
  | { unit: "year"; size: number }
  | { unit: "month"; size: number }
  | { unit: "second"; size: number };

const DAY = 86400;
// Candidate spacings, finest first; months and years follow the calendar.
const STEPS: TStep[] = [
  ...[1, 5, 15, 30].map((size) => ({ unit: "second" as const, size })),
  ...[1, 5, 15, 30].map((size) => ({
    unit: "second" as const,
    size: size * 60,
  })),
  ...[1, 2, 3, 6, 12].map((size) => ({
    unit: "second" as const,
    size: size * 3600,
  })),
  ...[1, 2, 5, 10].map((size) => ({
    unit: "second" as const,
    size: size * DAY,
  })),
  ...[1, 2, 3, 6].map((size) => ({ unit: "month" as const, size })),
  ...[1, 2, 5, 10, 20, 50, 100, 200, 500, 1000].map((size) => ({
    unit: "year" as const,
    size,
  })),
];

function approximateSeconds(step: TStep) {
  return step.unit === "year"
    ? step.size * 365 * DAY
    : step.unit === "month"
      ? step.size * 30 * DAY
      : step.size;
}

function pad(value: number) {
  return String(value).padStart(2, "0");
}

function midnight(date: TCalendarDate) {
  return date.hour === 0 && date.minute === 0 && date.second === 0;
}

function labelOf(date: TCalendarDate, step: TStep) {
  if (step.unit === "year") {
    return String(date.year);
  }
  if (step.unit === "month") {
    return date.month === 1
      ? `${MONTHS[0]} ${date.year}`
      : MONTHS[date.month - 1];
  }
  const day = `${date.day} ${MONTHS[date.month - 1]}`;
  if (step.size >= DAY) {
    return day;
  }
  const clock = `${pad(date.hour)}:${pad(date.minute)}${step.size < 60 ? `:${pad(Math.floor(date.second))}` : ""}`;
  return midnight(date) ? day : clock;
}

/** The first tick instant at or after `date` for this step. */
function firstTick(date: TCalendarDate, step: TStep): TCalendarDate {
  if (step.unit === "year") {
    const year = Math.ceil(date.year / step.size) * step.size;
    const exact =
      year === date.year &&
      date.month === 1 &&
      date.day === 1 &&
      midnight(date);
    return {
      year: exact ? year : year === date.year ? year + step.size : year,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    };
  }
  const months = date.year * 12 + (date.month - 1);
  let start = Math.ceil(months / step.size) * step.size;
  if (start === months && !(date.day === 1 && midnight(date))) {
    start += step.size;
  }
  return {
    year: Math.floor(start / 12),
    month: (start % 12) + 1,
    day: 1,
    hour: 0,
    minute: 0,
    second: 0,
  };
}

function addCalendar(date: TCalendarDate, step: TStep): TCalendarDate {
  if (step.unit === "year") {
    return { ...date, year: date.year + step.size };
  }
  const months = date.year * 12 + (date.month - 1) + step.size;
  return { ...date, year: Math.floor(months / 12), month: (months % 12) + 1 };
}

/**
 * Ticks between raw coordinates `from` and `to` (at most about `maxTicks`).
 * `context` names the shared year or month when every tick lies in one.
 */
// eslint-disable-next-line max-lines-per-function
export function timeTicks(
  axis: TTimeAxis,
  from: number,
  to: number,
  maxTicks: number
): { ticks: TTimeTick[]; context: string } {
  const low = Math.min(from, to);
  const high = Math.max(from, to);
  const span = (high - low) * axis.unitSeconds;
  const step =
    STEPS.find(
      (candidate) => approximateSeconds(candidate) * maxTicks >= span
    ) ?? STEPS[STEPS.length - 1];
  const ticks: TTimeTick[] = [];
  const first = decodeTimeValue(axis, low);
  if (step.unit === "second") {
    // Days are uniform in every supported calendar: step in raw units from
    // a boundary of the step (midnight-aligned for steps of a day or less).
    const dayStart = encodeTimeValue(axis, {
      ...first,
      hour: 0,
      minute: 0,
      second: 0,
    });
    const stepRaw = step.size / axis.unitSeconds;
    let value =
      dayStart + Math.ceil((low - dayStart) / stepRaw - 1e-9) * stepRaw;
    for (let guard = 0; value <= high + 1e-9 && guard < 1000; guard++) {
      ticks.push({ value, label: labelOf(decodeTimeValue(axis, value), step) });
      value += stepRaw;
    }
  } else {
    let date = firstTick(first, step);
    for (let guard = 0; guard < 1000; guard++) {
      const value = encodeTimeValue(axis, date);
      if (value > high + 1e-9) {
        break;
      }
      ticks.push({ value, label: labelOf(date, step) });
      date = addCalendar(date, step);
    }
  }
  const last = decodeTimeValue(axis, high);
  const sameYear = first.year === last.year;
  const context =
    step.unit === "year"
      ? ""
      : sameYear && first.month === last.month && step.unit === "second"
        ? `${MONTH_NAMES[first.month - 1]} ${first.year}`
        : sameYear
          ? String(first.year)
          : `${first.year}–${last.year}`;
  return { ticks, context };
}
