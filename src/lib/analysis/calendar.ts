/**
 * CF time decoding with calendars. Only calendars with an independently
 * tested decoder are supported; other calendars fall back to raw coordinate
 * values (and model indices) rather than plausible-looking wrong dates.
 */

export const CALENDARS = {
  STANDARD: "standard",
  PROLEPTIC_GREGORIAN: "proleptic_gregorian",
  NOLEAP: "noleap",
  DAY360: "360_day",
} as const;

export type TCalendar = (typeof CALENDARS)[keyof typeof CALENDARS];

const CALENDAR_ALIASES: Record<string, TCalendar> = {
  standard: CALENDARS.STANDARD,
  gregorian: CALENDARS.STANDARD,
  proleptic_gregorian: CALENDARS.PROLEPTIC_GREGORIAN, // eslint-disable-line camelcase
  noleap: CALENDARS.NOLEAP,
  "365_day": CALENDARS.NOLEAP,
  "360_day": CALENDARS.DAY360,
};

export type TCalendarDate = {
  year: number;
  month: number;
  day: number;
  hour: number;
  minute: number;
  second: number;
};

export type TTimeAxis = {
  calendar: TCalendar;
  /** Seconds per unit of the raw coordinate. */
  unitSeconds: number;
  unit: string;
  reference: TCalendarDate;
};

const UNIT_SECONDS: Record<string, number> = {
  day: 86400,
  d: 86400,
  hour: 3600,
  hr: 3600,
  h: 3600,
  minute: 60,
  min: 60,
  second: 1,
  sec: 1,
  s: 1,
  millisecond: 0.001,
  ms: 0.001,
  microsecond: 1e-6,
  us: 1e-6,
};

/**
 * Seconds in one unit of a duration (`hours`, `h`, `microseconds`, or the
 * unit of `<unit> since <date>`); undefined for none of fixed length.
 */
export function durationSeconds(units: unknown) {
  if (typeof units !== "string") {
    return undefined;
  }
  const word = units.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  const unit = word.length > 3 ? word.replace(/s$/, "") : word;
  return UNIT_SECONDS[
    unit === "hrs"
      ? "hr"
      : unit === "mins"
        ? "min"
        : unit === "secs"
          ? "sec"
          : unit
  ];
}

const UNITS_REGEX =
  /^\s*([a-zA-Z]+)\s+since\s+(-?\d{1,6})-(\d{1,2})-(\d{1,2})(?:[T\s]+(\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d*)?))?)?\s*(Z|UTC|[+-]?\d{1,2}(?::?\d{2})?)?\s*$/i;

/** The calendar and units of a CF time coordinate, or why it is unsupported. */
export function parseTimeAxis(
  units: unknown,
  calendar: unknown
): TTimeAxis | { unsupported: string } {
  const calendarName = String(calendar ?? "standard").toLowerCase();
  const resolved = CALENDAR_ALIASES[calendarName];
  if (!resolved) {
    return {
      unsupported: `Calendar "${calendarName}" has no tested decoder; raw time values are shown.`,
    };
  }
  const match = typeof units === "string" ? units.match(UNITS_REGEX) : null;
  if (!match) {
    return {
      unsupported: `Time units "${String(units)}" are not CF "<unit> since <date>".`,
    };
  }
  const unitWord = match[1].toLowerCase();
  const unit = unitWord.length > 3 ? unitWord.replace(/s$/, "") : unitWord;
  const unitSeconds = UNIT_SECONDS[unit];
  if (unitSeconds === undefined) {
    return {
      unsupported: `Time unit "${match[1]}" has no fixed length; raw time values are shown.`,
    };
  }
  const zone = match[8];
  if (zone && !/^(z|utc|[+-]?0{1,2}(:?00)?)$/i.test(zone)) {
    return { unsupported: `Time zone offset "${zone}" is not supported.` };
  }
  const reference: TCalendarDate = {
    year: Number(match[2]),
    month: Number(match[3]),
    day: Number(match[4]),
    hour: Number(match[5] ?? 0),
    minute: Number(match[6] ?? 0),
    second: Number(match[7] ?? 0),
  };
  const problem = referenceProblem(
    resolved,
    reference,
    String(units),
    calendarName
  );
  if (problem) {
    return { unsupported: problem };
  }
  return { calendar: resolved, unitSeconds, unit, reference };
}

/** Why a reference date/time is not one of its calendar, if it is not. */
function referenceProblem(
  calendar: TCalendar,
  reference: TCalendarDate,
  units: string,
  calendarName: string
) {
  if (
    reference.hour > 23 ||
    reference.minute > 59 ||
    !(reference.second < 60)
  ) {
    return `Time reference "${units}" has no valid clock time; raw time values are shown.`;
  }
  try {
    daysFromDate(calendar, reference);
  } catch {
    return `Time reference "${units}" is not a date of the ${calendarName} calendar; raw time values are shown.`;
  }
  return undefined;
}

const NOLEAP_MONTHS = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];

function floorDiv(a: number, b: number) {
  return Math.floor(a / b);
}

/** Julian day number of a proleptic Gregorian date. */
function gregorianJdn(y: number, m: number, d: number) {
  const a = floorDiv(14 - m, 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return (
    d +
    floorDiv(153 * mm + 2, 5) +
    365 * yy +
    floorDiv(yy, 4) -
    floorDiv(yy, 100) +
    floorDiv(yy, 400) -
    32045
  );
}

/** Julian day number of a (proleptic) Julian-calendar date. */
function julianJdn(y: number, m: number, d: number) {
  const a = floorDiv(14 - m, 12);
  const yy = y + 4800 - a;
  const mm = m + 12 * a - 3;
  return d + floorDiv(153 * mm + 2, 5) + 365 * yy + floorDiv(yy, 4) - 32083;
}

function fromGregorianJdn(jdn: number) {
  const a = jdn + 32044;
  const b = floorDiv(4 * a + 3, 146097);
  const c = a - floorDiv(146097 * b, 4);
  const d = floorDiv(4 * c + 3, 1461);
  const e = c - floorDiv(1461 * d, 4);
  const m = floorDiv(5 * e + 2, 153);
  return {
    day: e - floorDiv(153 * m + 2, 5) + 1,
    month: m + 3 - 12 * floorDiv(m, 10),
    year: 100 * b + d - 4800 + floorDiv(m, 10),
  };
}

function fromJulianJdn(jdn: number) {
  const c = jdn + 32082;
  const d = floorDiv(4 * c + 3, 1461);
  const e = c - floorDiv(1461 * d, 4);
  const m = floorDiv(5 * e + 2, 153);
  return {
    day: e - floorDiv(153 * m + 2, 5) + 1,
    month: m + 3 - 12 * floorDiv(m, 10),
    year: d - 4800 + floorDiv(m, 10),
  };
}

// First Gregorian day of the standard calendar: 1582-10-15.
const GREGORIAN_START_JDN = 2299161;

function assertDayInMonth(date: TCalendarDate, monthLength: number) {
  if (
    !Number.isInteger(date.month) ||
    date.month < 1 ||
    date.month > 12 ||
    !Number.isInteger(date.day) ||
    date.day < 1 ||
    date.day > monthLength
  ) {
    throw new Error(
      `${date.year}-${date.month}-${date.day} is not a date of this calendar.`
    );
  }
}

function isGregorianLeap(y: number) {
  return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;
}

export function dayNumberOfDate(calendar: TCalendar, date: TCalendarDate) {
  const { year: y, month: m, day: d } = date;
  if (calendar === CALENDARS.DAY360) {
    assertDayInMonth(date, 30);
    return y * 360 + (m - 1) * 30 + (d - 1);
  }
  if (calendar === CALENDARS.NOLEAP) {
    assertDayInMonth(date, NOLEAP_MONTHS[m - 1] ?? 0);
    let days = y * 365 + d - 1;
    for (let month = 1; month < m; month++) {
      days += NOLEAP_MONTHS[month - 1];
    }
    return days;
  }
  const leap =
    calendar === CALENDARS.STANDARD &&
    gregorianJdn(y, m, d) < GREGORIAN_START_JDN
      ? y % 4 === 0
      : isGregorianLeap(y);
  assertDayInMonth(date, m === 2 && leap ? 29 : (NOLEAP_MONTHS[m - 1] ?? 0));
  if (calendar === CALENDARS.PROLEPTIC_GREGORIAN) {
    return gregorianJdn(y, m, d);
  }
  const gregorian = gregorianJdn(y, m, d);
  if (gregorian >= GREGORIAN_START_JDN) {
    return gregorian;
  }
  const julian = julianJdn(y, m, d);
  if (julian >= GREGORIAN_START_JDN) {
    throw new Error(
      `${y}-${m}-${d} falls in the 1582 gap of the standard calendar.`
    );
  }
  return julian;
}

function dateOfDayNumber(calendar: TCalendar, days: number) {
  if (calendar === CALENDARS.DAY360) {
    const year = floorDiv(days, 360);
    const rest = days - year * 360;
    return { year, month: floorDiv(rest, 30) + 1, day: (rest % 30) + 1 };
  }
  if (calendar === CALENDARS.NOLEAP) {
    const year = floorDiv(days, 365);
    let rest = days - year * 365;
    let month = 1;
    while (rest >= NOLEAP_MONTHS[month - 1]) {
      rest -= NOLEAP_MONTHS[month - 1];
      month++;
    }
    return { year, month, day: rest + 1 };
  }
  if (calendar === CALENDARS.STANDARD && days < GREGORIAN_START_JDN) {
    return fromJulianJdn(days);
  }
  return fromGregorianJdn(days);
}

function daysFromDate(calendar: TCalendar, date: TCalendarDate) {
  return (
    dayNumberOfDate(calendar, date) +
    (date.hour * 3600 + date.minute * 60 + date.second) / 86400
  );
}

/**
 * Days in a year of a calendar (360 in `360_day`, 366 in a leap year of
 * the standard calendar); undefined for a calendar without a decoder.
 */
export function daysInYear(calendar: unknown, year: number) {
  const resolved =
    CALENDAR_ALIASES[String(calendar ?? "standard").toLowerCase()];
  if (!resolved || !Number.isInteger(year)) {
    return undefined;
  }
  const first = (y: number) =>
    dayNumberOfDate(resolved, {
      year: y,
      month: 1,
      day: 1,
      hour: 0,
      minute: 0,
      second: 0,
    });
  return first(year + 1) - first(year);
}

/**
 * The calendar date of a raw coordinate value, to the microsecond: whole days
 * and the time within them apart, as instantKey does, so a large day count
 * keeps its fraction.
 */
export function decodeTimeValue(axis: TTimeAxis, value: number): TCalendarDate {
  const DAY_US = 86_400_000_000;
  const seconds = value * axis.unitSeconds;
  const days = Math.floor(seconds / 86400);
  const reference = Math.round(
    (axis.reference.hour * 3600 +
      axis.reference.minute * 60 +
      axis.reference.second) *
      1e6
  );
  let us = Math.round((seconds - days * 86400) * 1e6) + reference;
  // Carried across midnight.
  const carry = Math.floor(us / DAY_US);
  us -= carry * DAY_US;
  const date = dateOfDayNumber(
    axis.calendar,
    dayNumberOfDate(axis.calendar, axis.reference) + days + carry
  );
  const hour = Math.floor(us / 3_600_000_000);
  us -= hour * 3_600_000_000;
  const minute = Math.floor(us / 60_000_000);
  us -= minute * 60_000_000;
  return { ...date, hour, minute, second: us / 1e6 };
}

/**
 * An instant as its calendar, day number and microsecond of that day: the same
 * time gives the same key whatever units encode it.
 */
export function instantKey(axis: TTimeAxis, value: number) {
  const DAY_US = 86_400_000_000;
  const seconds = value * axis.unitSeconds;
  const days = Math.floor(seconds / 86400);
  const reference = Math.round(
    (axis.reference.hour * 3600 +
      axis.reference.minute * 60 +
      axis.reference.second) *
      1e6
  );
  let us = Math.round((seconds - days * 86400) * 1e6) + reference;
  const carry = Math.floor(us / DAY_US);
  us -= carry * DAY_US;
  const day = dayNumberOfDate(axis.calendar, axis.reference) + days + carry;
  return `${axis.calendar}:${day}:${us}`;
}

/** The raw coordinate value of a calendar date (inverse of decoding). */
export function encodeTimeValue(axis: TTimeAxis, date: TCalendarDate) {
  // Whole days and the seconds within them apart: a day count near 700,000
  // holds a fraction of a day only to about 10 µs.
  const clock = (d: TCalendarDate) => d.hour * 3600 + d.minute * 60 + d.second;
  const seconds =
    (dayNumberOfDate(axis.calendar, date) -
      dayNumberOfDate(axis.calendar, axis.reference)) *
      86400 +
    (clock(date) - clock(axis.reference));
  return seconds / axis.unitSeconds;
}

/**
 * A typed date as a time value, or why it is no date of the axis's
 * calendar (31 January in 360_day, a day in the 1582 gap).
 */
export function encodeTypedDate(
  axis: TTimeAxis,
  date: TCalendarDate
): { value: number } | { problem: string } {
  try {
    return { value: encodeTimeValue(axis, date) };
  } catch (error) {
    return {
      problem: `${(error as Error).message.replace(/\.$/, "")} (${axis.calendar}).`,
    };
  }
}

function pad(value: number, width = 2) {
  const sign = value < 0 ? "-" : "";
  return sign + String(Math.abs(value)).padStart(width, "0");
}

export function formatCalendarDate(date: TCalendarDate) {
  const whole = Math.floor(date.second);
  // Milliseconds, or microseconds when there is less than a millisecond.
  const micros = Math.round((date.second - whole) * 1e6);
  const fraction = !micros
    ? ""
    : micros % 1000
      ? `.${String(micros).padStart(6, "0")}`
      : `.${String(micros / 1000).padStart(3, "0")}`;
  const time = `${pad(date.hour)}:${pad(date.minute)}:${pad(whole)}`;
  return `${pad(date.year, 4)}-${pad(date.month)}-${pad(date.day)} ${time}${fraction}`;
}

export function parseCalendarDate(text: string): TCalendarDate | undefined {
  const match = text
    .trim()
    .match(
      /^(-?\d{1,6})-(\d{1,2})-(\d{1,2})(?:[T\s](\d{1,2}):(\d{1,2})(?::(\d{1,2}(?:\.\d*)?))?)?Z?$/
    );
  if (!match) {
    return undefined;
  }
  const date = {
    year: Number(match[1]),
    month: Number(match[2]),
    day: Number(match[3]),
    hour: Number(match[4] ?? 0),
    minute: Number(match[5] ?? 0),
    second: Number(match[6] ?? 0),
  };
  // Clock and date fields must be in range (day 31 is checked per month by
  // the calendar when the date is encoded).
  const valid =
    date.month >= 1 &&
    date.month <= 12 &&
    date.day >= 1 &&
    date.day <= 31 &&
    date.hour <= 23 &&
    date.minute <= 59 &&
    date.second < 60;
  return valid ? date : undefined;
}

/**
 * Matching rule for a date entered in a control: the source coordinate
 * nearest to it; a tie goes to the earlier time (also on a descending
 * axis, where the earlier time has the larger index).
 */
export function nearestTimeIndex(values: ArrayLike<number>, target: number) {
  let best = -1;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (let at = 0; at < values.length; at++) {
    const distance = Math.abs(values[at] - target);
    if (
      distance < bestDistance ||
      (distance === bestDistance && values[at] < values[best])
    ) {
      best = at;
      bestDistance = distance;
    }
  }
  return best;
}

const labelers = new Map<string, (raw: number) => string>();

/**
 * The readable label of one time coordinate value in its units and
 * calendar ("2020-06-01 00:00:00"), or the raw value when the calendar or
 * units are not supported. Formatters are shared per units and calendar.
 */
export function timeLabelOf(
  time: { units?: string; calendar?: string } | undefined,
  raw: number | undefined
) {
  if (!time || raw === undefined || Number.isNaN(raw)) {
    return "";
  }
  const key = `${time.units}|${time.calendar}`;
  let labeler = labelers.get(key);
  if (!labeler) {
    const axis = parseTimeAxis(time.units, time.calendar);
    labeler =
      "unsupported" in axis
        ? String
        : (value: number) => formatCalendarDate(decodeTimeValue(axis, value));
    labelers.set(key, labeler);
  }
  return labeler(raw);
}

const axisLabels = new WeakMap<object, string[]>();

/**
 * Every label of a time axis, formatted once per axis object: a streaming
 * result keeps its axis while values arrive, so updates reuse the labels.
 */
export function timeLabels(
  time: { raw: number[]; units?: string; calendar?: string } | undefined
) {
  if (!time) {
    return [];
  }
  let labels = axisLabels.get(time);
  if (!labels || labels.length !== time.raw.length) {
    labels = time.raw.map((raw) => timeLabelOf(time, raw));
    axisLabels.set(time, labels);
  }
  return labels;
}

/** The label of the time at an index of a summarized time axis. */
export function timeLabelAt(
  time: { raw: number[]; units?: string; calendar?: string } | undefined,
  index: number
) {
  return timeLabelOf(time, time?.raw[index]);
}

/**
 * Two durations in seconds alike to a microsecond: 48 h and 2 days pair, 48 h
 * and 48 h 100 ms do not.
 */
export function sameDuration(a: number, b: number) {
  return Math.abs(a - b) <= Math.max(1e-6, 1e-12 * Math.abs(b));
}
