/**
 * An ensemble series in summary: per time step the median and the 10th and
 * 90th percentiles across members, and each member's mean over the period
 * (for the dots and box beside the chart). Missing values are left out;
 * a step where no member has a value stays missing.
 */

import { overlappingCells, timeMethod } from "./timeViews.ts";

/**
 * The durations of a series' declared interval means, or undefined when
 * it holds no means over time or any interval is unknown (equal weights).
 */
export function meanDurations(result: {
  cellMethods?: string;
  time?: { dimension?: string; bounds?: number[]; raw: number[] };
}) {
  const time = result.time;
  const b = time?.bounds;
  if (
    !time ||
    !b ||
    b.length !== 2 * time.raw.length ||
    timeMethod(result.cellMethods, time.dimension) !== "mean"
  ) {
    return undefined;
  }
  // Each step's own; an unknown one is NaN, and counts only where a member has
  // a value there.
  const durations: TDurations = time.raw.map((_, at) =>
    Math.abs(b[2 * at + 1] - b[2 * at])
  );
  // Cells inside others, among the steps a member has a value at: no one period
  // mean; a fill row overlaps nothing. Checked in memberStats, which has the
  // values. Interval means with every length unknown: a mean of the samples,
  // not of the period. Both kept beside the lengths, not among them.
  Object.defineProperties(durations, {
    bounds: { value: b },
    unknown: { value: !durations.some(Number.isFinite) },
  });
  return durations;
}

type TDurations = number[] & {
  overlap?: boolean;
  bounds?: ArrayLike<number>;
  /** Every length unknown: equal weights, a sample mean. */
  unknown?: boolean;
};

/** Linear-interpolated percentile (0–1) of sorted values. */
export function percentileOf(sorted: number[], fraction: number) {
  if (!sorted.length) {
    return Number.NaN;
  }
  const at = (sorted.length - 1) * fraction;
  const low = Math.floor(at);
  const high = Math.ceil(at);
  return sorted[low] + (sorted[high] - sorted[low]) * (at - low);
}

/**
 * The same percentile of finite values in any order, by selection: no
 * sort of the whole series (100,000 rows for a default threshold).
 */
export function percentileOfValues(
  values: ArrayLike<number>,
  fraction: number
) {
  // The finite values compacted into one buffer: no filtered array beside a
  // copy.
  let count = 0;
  for (let k = 0; k < values.length; k++) {
    count += Number.isFinite(values[k]) ? 1 : 0;
  }
  const finite = new Float64Array(count);
  for (let k = 0, at = 0; k < values.length; k++) {
    if (Number.isFinite(values[k])) {
      finite[at++] = values[k];
    }
  }
  if (!finite.length) {
    return Number.NaN;
  }
  const at = (finite.length - 1) * fraction;
  const low = Math.floor(at);
  const lowValue = select(finite, low);
  if (at === low) {
    return lowValue;
  }
  // The next value up: the least of those above position `low`.
  let next = Infinity;
  for (let k = low + 1; k < finite.length; k++) {
    next = Math.min(next, finite[k]);
  }
  return lowValue + (next - lowValue) * (at - low);
}

/** Quickselect: the `k`-th smallest lands at `k` (smaller before it). */
function select(a: Float64Array, k: number) {
  let [lo, hi] = [0, a.length - 1];
  while (hi > lo) {
    const pivot = a[(lo + hi) >> 1];
    let [i, j] = [lo, hi];
    while (i <= j) {
      while (a[i] < pivot) {
        i++;
      }
      while (a[j] > pivot) {
        j--;
      }
      if (i <= j) {
        [a[i], a[j]] = [a[j], a[i]];
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
  return a[k];
}

// eslint-disable-next-line max-lines-per-function
export function memberStats(
  series: number[][],
  length: number,
  /** Each step's duration, for interval means: their period mean weighs it. */
  durations?: TDurations
) {
  const p10 = new Array<number>(length);
  const p50 = new Array<number>(length);
  const p90 = new Array<number>(length);
  for (let step = 0; step < length; step++) {
    const values = series
      .map((member) => member[step])
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    p10[step] = percentileOf(values, 0.1);
    p50[step] = percentileOf(values, 0.5);
    p90[step] = percentileOf(values, 0.9);
  }
  // A one-day mean beside a nine-day one counts a ninth as much. A step of no
  // length weighs nothing. A value of unknown length is left out of a period
  // mean over known lengths, and said so; equal weights only when no step has a
  // known length.
  const known = Boolean(durations?.some((d) => Number.isFinite(d) && d > 0));
  // Declared cells with no positive length (all of no length, or of no length
  // and unknown): no time to average over; nor overlapping cells. Overlaps
  // member by member: each member's own observed cells, not the union of all
  // members'.
  const overlapOf = (member: number[]) =>
    Boolean(
      durations?.overlap ||
      (durations?.bounds &&
        overlappingCells(durations.bounds, (step) =>
          Number.isFinite(member[step])
        ).size > 0)
    );
  const unlengthed = Boolean(
    durations && !known && durations.some((d) => Number.isFinite(d))
  );
  const overlapping = series.map(overlapOf);
  const withheld = unlengthed || overlapping.some(Boolean);
  let leftOut = 0;
  const means = series.map((member, at) => {
    if (unlengthed || overlapping[at]) {
      return Number.NaN;
    }
    let [sum, weight, out] = [0, 0, 0];
    for (let step = 0; step < length; step++) {
      const value = member[step];
      if (!Number.isFinite(value)) {
        continue;
      }
      const w = known ? durations![step] : 1;
      if (Number.isFinite(w)) {
        sum += value * w;
        weight += w;
      } else {
        out++;
      }
    }
    leftOut = Math.max(leftOut, out);
    return weight > 0 ? sum / weight : Number.NaN;
  });
  return {
    p10,
    p50,
    p90,
    means,
    leftOut,
    withheld,
    ...(durations?.unknown ? { sample: true } : {}),
  };
}

/** Quartiles and extremes of the members' period means. */
export function boxOf(means: number[]) {
  const sorted = means.filter(Number.isFinite).sort((a, b) => a - b);
  return {
    min: sorted[0],
    q1: percentileOf(sorted, 0.25),
    median: percentileOf(sorted, 0.5),
    q3: percentileOf(sorted, 0.75),
    max: sorted[sorted.length - 1],
    count: sorted.length,
  };
}

/**
 * Per step, the share (%) of members with a value above `threshold`, and
 * how many members had a value (NaN share where none had).
 */
export function chanceAbove(
  series: number[][],
  threshold: number,
  length: number
) {
  const share = new Array<number>(length);
  const above = new Array<number>(length);
  const valid = new Array<number>(length);
  for (let step = 0; step < length; step++) {
    let n = 0;
    let over = 0;
    for (const member of series) {
      const value = member[step];
      if (Number.isFinite(value)) {
        n++;
        over += value > threshold ? 1 : 0;
      }
    }
    valid[step] = n;
    above[step] = over;
    share[step] = n ? (100 * over) / n : Number.NaN;
  }
  return { share, above, valid };
}

/**
 * A starting threshold: the members' median, to two significant digits, by
 * selection over the members as they are, once per set of members.
 */
export function roundThreshold(values: number[] | number[][]) {
  const lists = (
    values.length && Array.isArray(values[0]) ? values : [values]
  ) as number[][];
  // Kept against the member arrays themselves: a member list made again around
  // the same arrays reuses it.
  const key = membersKey(lists);
  const kept = thresholds.get(key);
  if (kept !== undefined) {
    return kept;
  }
  let n = 0;
  for (const list of lists) {
    for (const v of list) {
      n += Number.isFinite(v) ? 1 : 0;
    }
  }
  // Finite values only, once: the selection works in place on them.
  const all = new Float64Array(n);
  let at = 0;
  for (const list of lists) {
    for (const v of list) {
      if (Number.isFinite(v)) {
        all[at++] = v;
      }
    }
  }
  const median = percentileOfValues(all, 0.5);
  const threshold = Number.isFinite(median) ? Number(median.toPrecision(2)) : 0;
  thresholds.set(key, threshold);
  return threshold;
}
const thresholds = new WeakMap<object, number>();

/** One object per set of member arrays, whatever list holds them. */
function membersKey(lists: number[][]): object {
  let node: { next: WeakMap<object, unknown> } = { next: keyRoot };
  for (const list of lists) {
    let child = node.next.get(list) as typeof node | undefined;
    if (!child) {
      child = { next: new WeakMap() };
      node.next.set(list, child);
    }
    node = child;
  }
  return node;
}
const keyRoot = new WeakMap<object, unknown>();
