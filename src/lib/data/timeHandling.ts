import dayjs, { Dayjs } from "dayjs";
import utc from "dayjs/plugin/utc";
import * as zarr from "zarrita";

dayjs.extend(utc);

/**
 * Parses CF-style time units string (e.g., "seconds since 2020-01-01T00:00:00")
 * Returns the interval unit and reference datetime.
 */
function parseTimeUnits(units: string): { interval: string; ref: Dayjs } {
  const unitsRegEx = /([a-zA-Z]+) since (.+)$/i;
  const regExMatch = units.match(unitsRegEx);
  if (!regExMatch) {
    throw new Error("time units not recognized");
  }
  const interval = regExMatch[1];
  let refdate = regExMatch[2];
  if (refdate.indexOf(" ") !== refdate.lastIndexOf(" ")) {
    // if there are multiple spaces, it's likely because the timezone is included
    // remove the timezone for dayjs parsing
    const lastSpace = refdate.lastIndexOf(" ");
    refdate = refdate.substring(0, lastSpace);
  }
  const ref = dayjs.utc(refdate);
  return { interval, ref };
}

/**
 * Converts a datetime to a numeric time value using the given units.
 * Assumes standard calendar (no leap seconds unless stated otherwise).
 */
export function encodeTime(datetime: Dayjs, attrs: zarr.Attributes): number {
  const units: string = attrs.units as string;
  const { interval, ref } = parseTimeUnits(units);

  const intervalLower = interval.toLowerCase();

  // Convert to the target unit
  switch (intervalLower) {
    case "nanosecond":
    case "nanoseconds":
    case "ns": {
      // Calculate the difference in milliseconds first
      const diffMs = datetime.diff(ref, "millisecond");
      return diffMs * 1e6;
    }
    default:
      // Fall back to dayjs diff for other units (month, year, etc.)
      return datetime.diff(ref, interval as dayjs.ManipulateType);
  }
}

/**
 * Converts a bigint or number to a number, handling BigInt64Array values.
 */
function toNumber(value: number | bigint): number {
  return typeof value === "bigint" ? Number(value) : value;
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
  timeArray: ArrayLike<number | bigint>,
  attrs: zarr.Attributes
): number {
  const target = dayjs.utc(targetDatetime);
  const targetValue = encodeTime(target, attrs);

  const n = timeArray.length;
  if (n === 0) {
    throw new Error("Time array is empty");
  }
  if (n === 1) {
    return 0;
  }

  const firstValue = toNumber(timeArray[0]);
  const lastValue = toNumber(timeArray[n - 1]);

  // Handle out-of-bounds cases: clamp to array bounds
  if (targetValue < firstValue) {
    return 0;
  }
  if (targetValue >= lastValue) {
    return n - 1;
  }

  // Heuristic: assume uniform time steps
  const delta = toNumber(timeArray[1]) - firstValue;
  if (delta <= 0) {
    throw new Error("Time array must be monotonically increasing");
  }

  // Estimate index based on uniform step assumption (use floor for floor-index)
  let estimatedIndex = Math.floor((targetValue - firstValue) / delta);
  estimatedIndex = Math.max(0, Math.min(n - 1, estimatedIndex));

  // Validate the estimate
  const valueAtEstimate = toNumber(timeArray[estimatedIndex]);

  // Check if estimate is valid (valueAtEstimate <= targetValue < next value)
  if (valueAtEstimate <= targetValue) {
    const nextIndex = estimatedIndex + 1;
    if (nextIndex >= n || toNumber(timeArray[nextIndex]) > targetValue) {
      return estimatedIndex;
    }
  }

  // Heuristic failed (non-uniform steps), fall back to binary search
  return binarySearchFloor(targetValue, timeArray);
}

/**
 * Binary search to find the floor index (last index where value <= target).
 */
function binarySearchFloor(
  targetValue: number,
  timeArray: ArrayLike<number | bigint>
): number {
  let left = 0;
  let right = timeArray.length - 1;

  while (left < right) {
    // Use ceiling division to avoid infinite loop when left + 1 === right
    const mid = Math.ceil((left + right) / 2);
    const midValue = toNumber(timeArray[mid]);

    if (midValue <= targetValue) {
      left = mid;
    } else {
      right = mid - 1;
    }
  }

  return left;
}

export function decodeTime(value: number, attrs: zarr.Attributes) {
  const units: string = attrs.units as string;
  const { interval, ref } = parseTimeUnits(units);

  let adjustedValue = value;
  let adjustedInterval = interval;

  // dayjs does not support nanoseconds, so convert to milliseconds
  if (["nanosecond", "nanoseconds", "ns"].includes(interval.toLowerCase())) {
    adjustedValue = value / 1e6;
    adjustedInterval = "millisecond";
  }
  const timepoint = ref.add(
    adjustedValue,
    adjustedInterval as dayjs.ManipulateType
  );
  return timepoint;
}
