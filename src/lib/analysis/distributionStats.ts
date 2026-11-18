/**
 * Area-weighted summary of a field's values in a region: percentiles,
 * spread, skewness and a smoothed density curve. Every figure weights each
 * cell by its area, as the histogram's bars do. Computed from the values
 * the distribution has already read: nothing more is downloaded.
 */
import { yieldIfBusy } from "./chunkVisitor.ts";

/**
 * Percentiles reported: every half percent, 0 to 100 (201 values), so any
 * usual central range (quartiles, 10–90, 5–95, 2.5–97.5, 0.5–99.5) is read
 * off without reading the data again.
 */
const PERCENTILE_COUNT = 201;
const PERCENTILE_FRACTIONS = Array.from(
  { length: PERCENTILE_COUNT },
  (_, k) => k / (PERCENTILE_COUNT - 1)
);

/** The value at `percent` (0–100, a multiple of 0.5) of the valid area. */
export function percentileAt(percentiles: number[], percent: number) {
  return percentiles[Math.round((percent / 100) * (percentiles.length - 1))];
}

export type TDistributionSummary = {
  /** Area-weighted standard deviation (population form). */
  std: number;
  /** Area-weighted skewness: m3 / m2^1.5 (0 for a symmetric field). */
  skewness: number;
  /** Values at 0, 0.5, 1, …, 100 % of the valid area (201 values). */
  percentiles: number[];
  /**
   * A smoothed density (fraction of valid area per unit of value) at `x`,
   * over the histogram's range; reflected at both ends so a bounded field
   * (precipitation at 0) is not pulled down at its edge.
   */
  /** Undefined when no finite, normalised curve could be made. */
  density?: { x: number[]; y: number[]; bandwidth: number };
};

/** Bins for smoothing the curve. */
const CURVE_BINS = 512;
const CURVE_POINTS = 160;
/** Sub-bins per refinement round, and the cells sorted outright. */
const REFINE_BINS = 1024;
const SORT_AT_MOST = 4096;

/** Bin width over [low, high] that never overflows (e.g. ±1e308). */
const widthOf = (low: number, high: number, bins: number) =>
  high / bins - low / bins;

/** low → high at t (0–1), without overflow between far ends. */
const lerp = (low: number, high: number, t: number) => low * (1 - t) + high * t;

function binOf(value: number, low: number, width: number, bins: number) {
  const b = Math.floor((value - low) / width);
  return b >= bins ? bins - 1 : b > 0 ? b : 0;
}

/** A value range still holding requested percentiles, refined each round. */
type TSpan = {
  low: number;
  high: number;
  /** The area of all cells below `low`. */
  below: number;
  /** The requested fractions (indices) that fall in it. */
  wanted: number[];
};

/**
 * Weighted percentiles, exact, in bounded memory and a few passes over the
 * cells whatever the data (ties, a single far outlier, ±1e308). Each round
 * re-bins only the spans that hold a requested percentile, over the span's
 * own lowest to highest value; a sub-bin of one distinct value answers at
 * once, and one of few cells is sorted. Every round splits a span's lowest
 * value from its highest, so it ends. A percentile is the smallest value
 * whose cumulative area reaches the fraction.
 */
export function weightedPercentiles(
  values: Float64Array,
  weights: Float64Array,
  n: number,
  low: number,
  high: number,
  fractions: readonly number[],
  total: number
) {
  return drive(
    percentileSteps(values, weights, n, low, high, fractions, total)
  );
}

/** Cells between pauses of a long pass (a yield, a cancel check). */
const BATCH = 1 << 18;

/** Run a stepwise computation to its end at once. */
function drive<T>(steps: Generator<void, T>) {
  for (;;) {
    const step = steps.next();
    if (step.done) {
      return step.value;
    }
  }
}

/** Run a stepwise computation, yielding to the event loop between steps. */
async function driveAsync<T>(steps: Generator<void, T>, signal?: AbortSignal) {
  for (;;) {
    const step = steps.next();
    if (step.done) {
      return step.value;
    }
    await yieldIfBusy(signal);
  }
}

// eslint-disable-next-line max-lines-per-function
function* percentileSteps(
  values: Float64Array,
  weights: Float64Array,
  n: number,
  low: number,
  high: number,
  fractions: readonly number[],
  total: number
): Generator<void, number[]> {
  if (n === 0) {
    return fractions.map(() => Number.NaN);
  }
  if (!(high > low)) {
    return fractions.map(() => low);
  }
  const out = fractions.map(() => Number.NaN);
  const targets = fractions.map((fraction) => fraction * total);
  let spans: TSpan[] = [
    { low, high, below: 0, wanted: fractions.map((_, k) => k) },
  ];
  const sorted: TSpan[] = [];
  while (spans.length) {
    const B = REFINE_BINS;
    const mass = spans.map(() => new Float64Array(B));
    const count = spans.map(() => new Uint32Array(B));
    const lo = spans.map(() => new Float64Array(B).fill(Infinity));
    const hi = spans.map(() => new Float64Array(B).fill(-Infinity));
    const widths = spans.map((span) => widthOf(span.low, span.high, B));
    for (let at = 0; at < n; at++) {
      if (at % BATCH === BATCH - 1) {
        yield;
      }
      const v = values[at];
      const k = spanAt(spans, v);
      if (k < 0) {
        continue;
      }
      const b = binOf(v, spans[k].low, widths[k], B);
      mass[k][b] += weights[at];
      count[k][b]++;
      lo[k][b] = v < lo[k][b] ? v : lo[k][b];
      hi[k][b] = v > hi[k][b] ? v : hi[k][b];
    }
    const next = new Map<string, TSpan>();
    spans.forEach((span, k) => {
      for (const f of span.wanted) {
        let sum = span.below;
        let b = 0;
        while (b < B - 1 && sum + mass[k][b] < targets[f]) {
          sum += mass[k][b];
          b++;
        }
        // An empty last bin (rounding of the target): the highest value.
        while (b > 0 && !count[k][b]) {
          b--;
          sum -= mass[k][b];
        }
        if (lo[k][b] === hi[k][b] || !(widths[k] > 0)) {
          out[f] = lo[k][b];
          continue;
        }
        const key = `${k}/${b}`;
        const sub = next.get(key) ?? {
          low: lo[k][b],
          high: hi[k][b],
          below: sum,
          wanted: [],
        };
        sub.wanted.push(f);
        next.set(key, sub);
        if (count[k][b] <= SORT_AT_MOST && !sorted.includes(sub)) {
          sorted.push(sub);
        }
      }
    });
    spans = [...next.values()]
      .filter((span) => !sorted.includes(span))
      .sort((a, b) => a.low - b.low);
  }
  // The small spans: their cells gathered in one pass (they are disjoint),
  // sorted, the fractions read off in order.
  sorted.sort((a, b) => a.low - b.low);
  const gathered = sorted.map(() => [] as number[]);
  for (let at = 0; at < n; at++) {
    if (at % BATCH === BATCH - 1) {
      yield;
    }
    const k = spanAt(sorted, values[at]);
    if (k >= 0) {
      gathered[k].push(at);
    }
  }
  for (const [k, span] of sorted.entries()) {
    const cells = gathered[k];
    cells.sort((a, b) => values[a] - values[b]);
    for (const f of span.wanted) {
      let sum = span.below;
      out[f] = values[cells[cells.length - 1]];
      for (const at of cells) {
        sum += weights[at];
        if (sum >= targets[f]) {
          out[f] = values[at];
          break;
        }
      }
    }
  }
  return out;
}

/** The span (sorted, disjoint) holding `v`, or −1. */
function spanAt(spans: TSpan[], v: number) {
  let a = 0;
  let b = spans.length - 1;
  while (a <= b) {
    const m = (a + b) >> 1;
    if (v < spans[m].low) {
      b = m - 1;
    } else if (v > spans[m].high) {
      a = m + 1;
    } else {
      return m;
    }
  }
  return -1;
}

/**
 * A Gaussian kernel density on a fine histogram (binned KDE), with
 * Silverman's bandwidth from σ, the interquartile range and the effective
 * number of cells (Σw)² / Σw². Reflected at the range's ends. Computed on
 * values divided by their magnitude, so a field reaching ±1e308 does not
 * overflow; undefined unless the curve is finite, non-negative and
 * integrates to one.
 */
// eslint-disable-next-line max-lines-per-function
function densityCurve(
  values: Float64Array,
  weights: Float64Array,
  n: number,
  range: { low: number; high: number },
  spread: {
    std: number;
    q1: number;
    q3: number;
    total: number;
    squares: number;
  }
) {
  const magnitude = Math.max(Math.abs(range.low), Math.abs(range.high)) || 1;
  const low = range.low / magnitude;
  const high = range.high / magnitude;
  const std = spread.std / magnitude;
  const iqr = spread.q3 / magnitude - spread.q1 / magnitude;
  const width = widthOf(low, high, CURVE_BINS);
  const mass = new Float64Array(CURVE_BINS);
  for (let at = 0; at < n; at++) {
    mass[binOf(values[at] / magnitude, low, width, CURVE_BINS)] += weights[at];
  }
  const effective = (spread.total * spread.total) / spread.squares;
  const scale = Math.min(std, iqr / 1.34) || std;
  const bandwidth = Math.max(
    width,
    0.9 * scale * Math.pow(Math.max(effective, 1), -0.2)
  );
  const x: number[] = [];
  const y: number[] = [];
  const norm = 1 / (spread.total * bandwidth * Math.sqrt(2 * Math.PI));
  const reach = 4 * bandwidth;
  for (let k = 0; k < CURVE_POINTS; k++) {
    const at = lerp(low, high, k / (CURVE_POINTS - 1));
    let sum = 0;
    for (let b = 0; b < CURVE_BINS; b++) {
      if (!mass[b]) {
        continue;
      }
      const centre = lerp(low, high, (b + 0.5) / CURVE_BINS);
      // The kernel, plus its mirror images about both ends of the range.
      for (const c of [centre, 2 * low - centre, 2 * high - centre]) {
        const d = at - c;
        if (Math.abs(d) < reach) {
          sum += mass[b] * Math.exp(-0.5 * (d / bandwidth) ** 2);
        }
      }
    }
    x.push(at);
    y.push(sum * norm);
  }
  // The trapezoid integral over the range: one, give or take the binning.
  const step = (high - low) / (CURVE_POINTS - 1);
  const area = y.reduce(
    (sum, v, k) => sum + (k && k < y.length - 1 ? v : v / 2) * step,
    0
  );
  if (
    !y.every((v) => Number.isFinite(v) && v >= 0) ||
    Math.abs(area - 1) > 0.05
  ) {
    return undefined;
  }
  return {
    // In the values' units, exactly at the range's ends.
    x: x.map((_, k) => lerp(range.low, range.high, k / (CURVE_POINTS - 1))),
    y: y.map((v) => v / magnitude),
    bandwidth: bandwidth * magnitude,
  };
}

/** The summary of `n` values with their areas (both arrays from index 0). */
// eslint-disable-next-line max-lines-per-function
function* summarySteps(
  values: Float64Array,
  weights: Float64Array,
  n: number,
  low: number,
  high: number
): Generator<void, TDistributionSummary | undefined> {
  if (n < 2 || !(high > low)) {
    return undefined;
  }
  // Moments of the values scaled by their magnitude, so a field reaching
  // ±1e308 keeps a finite σ; skewness does not depend on the scale.
  const scale = Math.max(Math.abs(low), Math.abs(high)) || 1;
  let total = 0;
  let squares = 0;
  let sum = 0;
  for (let at = 0; at < n; at++) {
    if (at % BATCH === BATCH - 1) {
      yield;
    }
    total += weights[at];
    squares += weights[at] * weights[at];
    sum += weights[at] * (values[at] / scale);
  }
  const mean = sum / total;
  let m2 = 0;
  let m3 = 0;
  for (let at = 0; at < n; at++) {
    if (at % BATCH === BATCH - 1) {
      yield;
    }
    const d = values[at] / scale - mean;
    m2 += weights[at] * d * d;
    m3 += weights[at] * d * d * d;
  }
  m2 /= total;
  m3 /= total;
  const std = Math.sqrt(m2) * scale;
  const percentiles = yield* percentileSteps(
    values,
    weights,
    n,
    low,
    high,
    PERCENTILE_FRACTIONS,
    total
  );
  return {
    std,
    skewness: m2 > 0 ? m3 / Math.pow(m2, 1.5) : 0,
    percentiles,
    density: densityCurve(
      values,
      weights,
      n,
      { low, high },
      {
        std,
        q1: percentileAt(percentiles, 25),
        q3: percentileAt(percentiles, 75),
        total,
        squares,
      }
    ),
  };
}

/** The summary of `n` values with their areas, at once (tests, small sets). */
export function distributionSummary(
  values: Float64Array,
  weights: Float64Array,
  n: number,
  low: number,
  high: number
) {
  return drive(summarySteps(values, weights, n, low, high));
}

/**
 * The same, yielding to the worker's event loop between batches of cells,
 * so a cancel is honoured within one batch (four million values no longer
 * hold the worker for seconds).
 */
export function distributionSummaryAsync(
  values: Float64Array,
  weights: Float64Array,
  n: number,
  low: number,
  high: number,
  signal?: AbortSignal
) {
  return driveAsync(summarySteps(values, weights, n, low, high), signal);
}
