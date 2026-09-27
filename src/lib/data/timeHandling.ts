import dayjs, { Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc.js";
import * as zarr from "zarrita";

dayjs.extend(utc);

const unitsRegEx = /([a-zA-Z]+) since (.+)$/i;

export function isTimeUnits(units: unknown): units is string {
  return typeof units === "string" && unitsRegEx.test(units);
}

/** Identify absolute time coordinates; forecast periods describe durations. */
export function isTimeCoordinate(
  dimensionName: string,
  attrs: zarr.Attributes
) {
  if (attrs.standard_name === "forecast_period") {
    return false;
  }
  return (
    dimensionName.toLowerCase() === "time" ||
    attrs.standard_name === "time" ||
    attrs.standard_name === "forecast_reference_time" ||
    attrs.axis === "T" ||
    isTimeUnits(attrs.units)
  );
}

/**
 * Parses CF-style time units string (e.g., "seconds since 2020-01-01T00:00:00")
 * Returns the interval unit and reference datetime.
 */
function parseTimeUnits(units: string): { interval: string; ref: Dayjs } {
  const regExMatch = units.match(unitsRegEx);
  if (!regExMatch) {
    throw new Error("time units not recognized");
  }
  const interval = regExMatch[1];
  let refdate = regExMatch[2];
  if (refdate.indexOf(" ") !== refdate.lastIndexOf(" ")) {
    // If there are multiple spaces, it's likely because the timezone is included.
    // For example, CF-style units may look like:
    //   "seconds since 2001-01-01 00:00:00.0 0:00"
    // where "2001-01-01 00:00:00.0" is the reference datetime and "0:00" is the timezone.
    // In that case, we remove the trailing timezone substring for dayjs parsing.
    const lastSpace = refdate.lastIndexOf(" ");
    refdate = refdate.substring(0, lastSpace);
  }
  const ref = dayjs.utc(refdate);
  return { interval, ref };
}

/** Fixed-duration units; calendar months and years retain Day.js arithmetic. */
function millisecondsPerUnit(interval: string): number | undefined {
  // Short forms are case-sensitive: "M" means month, "m" means minute.
  if (interval === "M") {
    return undefined;
  }
  const unit =
    interval.length > 2
      ? interval.toLowerCase().replace(/s$/, "")
      : interval.toLowerCase();
  switch (unit) {
    case "week":
    case "w":
      return 604800000;
    case "day":
    case "d":
      return 86400000;
    case "hour":
    case "h":
      return 3600000;
    case "minute":
    case "m":
      return 60000;
    case "second":
    case "s":
      return 1000;
    case "millisecond":
    case "ms":
      return 1;
    case "nanosecond":
    case "ns":
      return 1e-6;
    default:
      return undefined;
  }
}

/**
 * Converts a bigint or number to a number, handling BigInt64Array values.
 */
function toNumber(value: number | bigint | string): number {
  return typeof value === "bigint"
    ? Number(value)
    : typeof value === "string"
      ? Number(value)
      : value;
}

/**
 * Finds the floor index in the time array for the target datetime.
 * Returns the last index whose time value is <= the target time.
 *
 * Example: If index i has time 2021-01-03T00:00:00Z and index j has 2021-01-04T00:00:00Z,
 * searching for 2021-01-03T21:00:00Z will return i (since the target falls within [i, j)).
 *
 * Assumptions:
 * - Standard calendar with no leap seconds
 * - Time array is monotonically increasing
 * - Uses uniform step heuristic first, then validates with binary search if needed
 *
 * @param targetDatetime - The target datetime (as Dayjs object or ISO string)
 * @param timeArray - The numeric time array from the Zarr dataset (can be BigInt64Array)
 * @param attrs - Zarr attributes containing the "units" field
 * @returns The floor index (last index where time <= target)
 */
export function findTimeIndex(
  targetDatetime: Dayjs | string | Date,
  timeArray: ArrayLike<number | bigint | string>,
  attrs: zarr.Attributes
): number {
  const target = dayjs.utc(targetDatetime);
  const { interval, ref } = parseTimeUnits(attrs.units as string);
  const scale = millisecondsPerUnit(interval);
  const targetValue =
    scale === undefined
      ? target.diff(ref, interval as dayjs.ManipulateType)
      : (target.valueOf() - ref.valueOf()) / (scale < 1 ? scale : 1);
  // Round fixed-duration coordinates to Date precision to remove floating-point residue.
  // Keep nanoseconds in their original units for sub-millisecond floor comparisons.
  const valueAt = (index: number) => {
    const value = toNumber(timeArray[index]);
    return scale === undefined || scale < 1 ? value : Math.round(value * scale);
  };

  const n = timeArray.length;
  if (n === 0) {
    throw new Error("Time array is empty");
  }
  if (n === 1) {
    return 0;
  }

  const firstValue = valueAt(0);
  const lastValue = valueAt(n - 1);

  if (isNaN(targetValue) || isNaN(firstValue) || isNaN(lastValue)) {
    throw new Error("Time array contains invalid values");
  }

  // Handle out-of-bounds cases: clamp to array bounds
  if (targetValue < firstValue) {
    return 0;
  }
  if (targetValue >= lastValue) {
    return n - 1;
  }

  // Heuristic: assume uniform time steps
  const delta = valueAt(1) - firstValue;
  if (delta <= 0) {
    throw new Error(
      "Time array must be monotonically increasing (found duplicate or decreasing values)"
    );
  }

  // Estimate index based on uniform step assumption (use floor for floor-index)
  let estimatedIndex = Math.floor((targetValue - firstValue) / delta);
  estimatedIndex = Math.max(0, Math.min(n - 1, estimatedIndex));

  // Check if the target falls between this value and the next.
  if (valueAt(estimatedIndex) <= targetValue) {
    const nextIndex = estimatedIndex + 1;
    if (nextIndex >= n || valueAt(nextIndex) > targetValue) {
      return estimatedIndex;
    }
  }

  // Heuristic failed (non-uniform steps), fall back to binary search
  return binarySearchFloor(targetValue, n, valueAt);
}

/**
 * Binary search to find the floor index (last index where value <= target).
 */
function binarySearchFloor(
  targetValue: number,
  length: number,
  valueAt: (index: number) => number
): number {
  let left = 0;
  let right = length - 1;

  while (left < right) {
    // Use ceiling division to avoid infinite loop when left + 1 === right
    const mid = Math.ceil((left + right) / 2);
    const midValue = valueAt(mid);

    if (midValue <= targetValue) {
      left = mid;
    } else {
      right = mid - 1;
    }
  }

  return left;
}

export function decodeTime(
  value: number | bigint | string,
  attrs: zarr.Attributes
) {
  const units: string = attrs.units as string;
  const { interval, ref } = parseTimeUnits(units);

  const numericValue = toNumber(value);
  const scale = millisecondsPerUnit(interval);
  if (scale !== undefined) {
    // Date resolves milliseconds; finer display precision needs another date representation.
    const offset =
      scale < 1 ? numericValue / 1e6 : Math.round(numericValue * scale);
    return dayjs.utc(ref.valueOf() + offset);
  }
  return ref.add(numericValue, interval as dayjs.ManipulateType);
}

const MODEL_CALENDAR_MONTHS: Record<string, readonly number[]> = {
  "360_day": Array(12).fill(30),
  "365_day": [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
  "366_day": [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31],
};
const MODEL_CALENDAR_ALIASES: Record<string, string> = {
  noleap: "365_day",
  ["all_leap"]: "366_day",
};

/** Format CF model dates without passing them through the Gregorian calendar. */
// eslint-disable-next-line max-lines-per-function
function formatModelTime(value: number, units: string, calendar: string) {
  const key = MODEL_CALENDAR_ALIASES[calendar] ?? calendar;
  if (!Object.hasOwn(MODEL_CALENDAR_MONTHS, key)) {
    return;
  }
  const parts = units.match(unitsRegEx);
  const scale = parts && millisecondsPerUnit(parts[1]);
  // ponytail: Nonzero model-calendar timezone offsets retain the CF label until
  // calendar-aware timezone arithmetic is needed. UTC references cover our datasets.
  const ref = parts?.[2].match(
    /^([+-]?\d+)-(\d{1,2})-(\d{1,2})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}(?:\.\d+)?))?)?(?:\s*(?:Z|[+-]?0{1,2}:?00))?$/i
  );
  if (!ref || scale === undefined || scale === null) {
    return;
  }
  const [year, month, day, hour, minute, second] = ref
    .slice(1)
    .map((v) => Number(v ?? 0));
  const months = MODEL_CALENDAR_MONTHS[key];
  if (
    !Number.isSafeInteger(year) ||
    month < 1 ||
    month > 12 ||
    day < 1 ||
    day > months[month - 1] ||
    hour >= 24 ||
    minute >= 60 ||
    second >= 60
  ) {
    return;
  }
  const dayMs = 86400000;
  let dayOfYear = day - 1;
  for (let i = 0; i < month - 1; i++) {
    dayOfYear += months[i];
  }
  const offset = Math.round(
    value * scale + ((hour * 60 + minute) * 60 + second) * 1000
  );
  if (!Number.isSafeInteger(offset)) {
    return;
  }
  const totalDays = dayOfYear + Math.floor(offset / dayMs);
  const yearDays = months.reduce((sum, length) => sum + length, 0);
  const yearOffset = Math.floor(totalDays / yearDays);
  let remaining = totalDays - yearOffset * yearDays;
  let targetMonth = 0;
  while (remaining >= months[targetMonth]) {
    remaining -= months[targetMonth++];
  }
  const time = dayjs.utc(0).add(((offset % dayMs) + dayMs) % dayMs, "ms");
  const targetYear = year + yearOffset;
  const yearText = `${targetYear < 0 ? "-" : ""}${String(Math.abs(targetYear)).padStart(4, "0")}`;
  const date = `${String(remaining + 1).padStart(2, "0")} ${dayjs.utc("2000-01-01").month(targetMonth).format("MMM")} ${yearText}`;
  return `${date} • ${time.format(time.millisecond() ? "HH:mm:ss.SSS" : "HH:mm:ss")} (${calendar})`;
}

/** One display format for both source timesteps and interpolated coordinates. */
export function formatTimeCoordinate(
  value: number | bigint | string,
  attrs: zarr.Attributes
): string {
  const units = String(attrs.units ?? "");
  const calendar = String(attrs.calendar ?? "standard").toLowerCase();
  const numeric = Number(value);
  if (Number.isFinite(numeric) && isTimeUnits(units)) {
    if (["standard", "gregorian", "proleptic_gregorian"].includes(calendar)) {
      const decoded = decodeTime(value, attrs);
      if (decoded.isValid()) {
        return decoded.format(
          decoded.millisecond()
            ? "DD MMM YYYY • HH:mm:ss.SSS"
            : "DD MMM YYYY • HH:mm:ss"
        );
      }
    } else {
      const formatted = formatModelTime(numeric, units, calendar);
      if (formatted) {
        return formatted;
      }
    }
  }
  return `${value} ${units}${calendar === "standard" ? "" : ` (${calendar})`}`.trim();
}
