import type { TPreparedScalarFrame } from "./scalarFrame.ts";

import { formatTimeCoordinate, isTimeUnits } from "@/lib/data/timeHandling.ts";

export const SCALAR_INTERPOLATION = {
  ORIGINAL: "original",
  LINEAR: "linear",
  SMOOTHSTEP: "smoothstep",
} as const;
export type TScalarInterpolation =
  (typeof SCALAR_INTERPOLATION)[keyof typeof SCALAR_INTERPOLATION];

/** Cubic Hermite with zero endpoint slopes; alpha is normalized source time. */
export function scalarInterpolationWeight(
  alpha: number,
  mode: TScalarInterpolation
) {
  return mode === SCALAR_INTERPOLATION.SMOOTHSTEP
    ? alpha * alpha * (3 - 2 * alpha)
    : alpha;
}

export function scalarPresentationCount(
  keyframes: number,
  intermediate: number
) {
  const count = (keyframes - 1) * (intermediate + 1) + 1;
  return keyframes >= 2 &&
    Number.isSafeInteger(intermediate) &&
    intermediate >= 0 &&
    Number.isSafeInteger(count)
    ? count
    : 0;
}

export function scalarPresentationFrame(
  index: number,
  keyframes: number,
  intermediate: number
) {
  const count = scalarPresentationCount(keyframes, intermediate);
  if (!Number.isSafeInteger(index) || index < 0 || index >= count) {
    throw new Error("Invalid animation frame.");
  }
  const first = Math.min(Math.floor(index / (intermediate + 1)), keyframes - 2);
  return {
    first,
    next: first + 1,
    alpha: (index - first * (intermediate + 1)) / (intermediate + 1),
  };
}

// eslint-disable-next-line max-lines-per-function
export function createScalarTimeline(
  frame: TPreparedScalarFrame,
  dimension: number,
  start: number,
  end: number
) {
  const attrs = frame.info.attrs;
  if (
    attrs.flag_values !== undefined ||
    attrs.flag_masks !== undefined ||
    attrs.flag_meanings !== undefined ||
    /(?:^|\s)time:\s*(?:sum|integral)\b/i.test(
      String(attrs.cell_methods ?? "")
    ) ||
    attrs.GRIB_stepType === "accum"
  ) {
    throw new Error(
      "Interpolation is unavailable for flagged categorical or accumulated quantities. Use original timesteps."
    );
  }
  const time = frame.info.dimInfo[dimension];
  if (
    !time ||
    !("values" in time) ||
    !time.values ||
    !isTimeUnits(time.attrs?.units)
  ) {
    throw new Error(
      "Interpolation requires numeric source timestamps with time units."
    );
  }
  const units = String(time.attrs.units);
  if (
    !/^(?:weeks?|days?|hours?|minutes?|seconds?|milliseconds?|nanoseconds?|w|d|h|m|s|ms|ns) since /i.test(
      units
    ) ||
    units.startsWith("M since ")
  ) {
    throw new Error("Interpolation requires fixed-duration time units.");
  }
  const values: number[] = [];
  let unequalGaps = false;
  let gap = 0;
  for (let i = start; i <= end; i++) {
    const value = Number(time.values[i]);
    if (
      !Number.isFinite(value) ||
      (values.length && value <= values[values.length - 1])
    ) {
      throw new Error(
        "Interpolation requires finite, strictly increasing source timestamps."
      );
    }
    if (values.length) {
      const interval = value - values[values.length - 1];
      if (values.length === 1) {
        gap = interval;
      } else if (Math.abs(interval - gap) > Math.abs(gap) * 1e-6) {
        unequalGaps = true;
      }
    }
    values.push(value);
  }
  return {
    values,
    unequalGaps,
    label(first: number, alpha: number) {
      const value = values[first] * (1 - alpha) + values[first + 1] * alpha;
      return formatTimeCoordinate(value, time.attrs);
    },
  };
}
