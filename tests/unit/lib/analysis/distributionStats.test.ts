import { describe, expect, it } from "vitest";

import {
  distributionSummary,
  percentileAt,
  weightedPercentiles,
} from "@/lib/analysis/distributionStats.ts";

const arrays = (values: number[], weights = values.map(() => 1)) => ({
  values: Float64Array.from(values),
  weights: Float64Array.from(weights),
});

// Deterministic normal quantiles (inverse CDF by bisection on erf).
const erf = (x: number) => {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) *
      t +
      0.254829592) *
      t *
      Math.exp(-x * x);
  return x >= 0 ? y : -y;
};
const cdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
const quantile = (p: number) => {
  let lo = -10;
  let hi = 10;
  for (let k = 0; k < 60; k++) {
    const mid = (lo + hi) / 2;
    if (cdf(mid) < p) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
};

// eslint-disable-next-line max-lines-per-function
describe("distribution summary", () => {
  it("finds weighted percentiles exactly: the smallest value reaching the share", () => {
    const { values, weights } = arrays([1, 2, 3, 4], [1, 1, 1, 1]);
    const [p25, p50, p75] = weightedPercentiles(
      values,
      weights,
      4,
      1,
      4,
      [0.25, 0.5, 0.75],
      4
    );
    expect([p25, p50, p75]).toEqual([1, 2, 3]);
    // A large cell carries its value further: 4 holds 70 % of the area.
    const big = arrays([1, 2, 3, 4], [0.1, 0.1, 0.1, 0.7]);
    expect(
      weightedPercentiles(big.values, big.weights, 4, 1, 4, [0.5], 1)
    ).toEqual([4]);
  });

  it("matches a normal field: mean ± 1.96 σ holds 95 %, skewness near 0", () => {
    const n = 20_000;
    const sample = Array.from({ length: n }, (_, k) => quantile((k + 0.5) / n));
    const { values, weights } = arrays(sample);
    const s = distributionSummary(
      values,
      weights,
      n,
      sample[0],
      sample[n - 1]
    )!;
    expect(s.std).toBeCloseTo(1, 2);
    expect(Math.abs(s.skewness)).toBeLessThan(0.01);
    // Every half percent: 201 values, the extremes at 0 and 100 %.
    expect(s.percentiles).toHaveLength(201);
    expect(s.percentiles[0]).toBe(sample[0]);
    expect(s.percentiles[200]).toBe(sample[n - 1]);
    expect(percentileAt(s.percentiles, 2.5)).toBeCloseTo(-1.96, 2);
    expect(percentileAt(s.percentiles, 50)).toBeCloseTo(0, 2);
    expect(percentileAt(s.percentiles, 97.5)).toBeCloseTo(1.96, 2);
    expect(percentileAt(s.percentiles, 5)).toBeCloseTo(-1.645, 2);
    expect(percentileAt(s.percentiles, 95)).toBeCloseTo(1.645, 2);
    // The curve is a density: it integrates to about 1 and peaks near 0.4.
    const { x, y } = s.density!;
    let area = 0;
    for (let k = 1; k < x.length; k++) {
      area += ((y[k] + y[k - 1]) / 2) * (x[k] - x[k - 1]);
    }
    expect(area).toBeCloseTo(1, 1);
    expect(Math.max(...y)).toBeGreaterThan(0.36);
    expect(Math.max(...y)).toBeLessThan(0.42);
  });

  it("keeps a bounded field's curve up at its edge and reports its skew", () => {
    // Exponential-like: many small values, a long right tail (rain).
    const n = 5_000;
    const sample = Array.from(
      { length: n },
      (_, k) => -Math.log(1 - (k + 0.5) / n)
    );
    const { values, weights } = arrays(sample);
    const s = distributionSummary(values, weights, n, 0, sample[n - 1])!;
    expect(s.skewness).toBeGreaterThan(1.5);
    // Reflection: the density at 0 stays near its true value (1), not half.
    expect(s.density!.y[0]).toBeGreaterThan(0.75);
  });

  it("has no summary for a constant field or a single cell", () => {
    const one = arrays([5]);
    expect(distributionSummary(one.values, one.weights, 1, 5, 5)).toBe(
      undefined
    );
    const flat = arrays([2, 2, 2]);
    expect(distributionSummary(flat.values, flat.weights, 3, 2, 2)).toBe(
      undefined
    );
  });
});

// eslint-disable-next-line max-lines-per-function
describe("percentiles in bounded work", () => {
  /** The definition, by brute force: sort, accumulate, first to reach. */
  function direct(values: number[], weights: number[], fractions: number[]) {
    const order = values
      .map((_, at) => at)
      .sort((a, b) => values[a] - values[b]);
    const total = weights.reduce((a, b) => a + b, 0);
    return fractions.map((fraction) => {
      let sum = 0;
      for (const at of order) {
        sum += weights[at];
        if (sum >= fraction * total) {
          return values[at];
        }
      }
      return values[order[order.length - 1]];
    });
  }
  const fractions = Array.from({ length: 201 }, (_, k) => k / 200);
  let seed = 7;
  const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;

  it("matches the definition on uniform, zero-heavy, tied, outlier and mixed data", () => {
    const n = 20_000;
    const cases: Record<string, number[]> = {
      uniform: Array.from({ length: n }, () => random() * 100),
      zeroHeavy: Array.from({ length: n }, (_, i) => (i % 100 === 0 ? 1 : 0)),
      ties: Array.from({ length: n }, (_, i) => i % 300),
      outlier: Array.from({ length: n }, (_, i) => (i === 17 ? 1e8 : i % 300)),
      wide: Array.from(
        { length: n },
        (_, i) => (i % 2 ? 1 : -1) * 10 ** (random() * 300)
      ),
    };
    for (const [name, values] of Object.entries(cases)) {
      const weights = values.map(() => 0.5 + random());
      const { values: v, weights: w } = arrays(values, weights);
      let [low, high] = [Infinity, -Infinity];
      for (const x of values) {
        low = Math.min(low, x);
        high = Math.max(high, x);
      }
      const total = weights.reduce((a, b) => a + b, 0);
      expect(
        weightedPercentiles(v, w, n, low, high, fractions, total),
        name
      ).toEqual(direct(values, weights, fractions));
    }
  });

  it("summarises a million cells with one far outlier quickly, median exact", () => {
    const n = 1_000_000;
    const values = new Float64Array(n);
    const weights = new Float64Array(n).fill(1);
    for (let at = 0; at < n; at++) {
      values[at] = at % 300;
    }
    values[n - 1] = 1e8;
    const started = performance.now();
    const s = distributionSummary(values, weights, n, 0, 1e8)!;
    const took = performance.now() - started;
    expect(percentileAt(s.percentiles, 50)).toBe(149);
    expect(percentileAt(s.percentiles, 100)).toBe(1e8);
    expect(took).toBeLessThan(2500);
  });

  it("keeps σ finite for values at ±1e308", () => {
    const { values, weights } = arrays([-1e308, 0, 1e308]);
    const s = distributionSummary(values, weights, 3, -1e308, 1e308)!;
    expect(s.std).toBeCloseTo(Math.sqrt(2 / 3) * 1e308, -300);
    expect(Number.isFinite(s.std)).toBe(true);
    expect(s.skewness).toBeCloseTo(0);
    expect(s.density!.x.every(Number.isFinite)).toBe(true);
    expect(s.percentiles[100]).toBe(0);
  });

  it("gives a finite, non-negative, normalised curve at ±1e308 (v24 review)", () => {
    const sample = Array.from(
      { length: 160 },
      (_, k) => (k / 79.5 - 1) * 1e308
    );
    const { values, weights } = arrays(sample);
    const s = distributionSummary(values, weights, 160, -1e308, 1e308)!;
    const { x, y } = s.density!;
    expect(y.every((v) => Number.isFinite(v) && v >= 0)).toBe(true);
    expect(y.some((v) => v > 0)).toBe(true);
    // Integrated in steps of x / 1e308, the density times 1e308.
    let area = 0;
    for (let k = 1; k < x.length; k++) {
      area +=
        ((y[k] + y[k - 1]) / 2) * 1e308 * (x[k] / 1e308 - x[k - 1] / 1e308);
    }
    expect(area).toBeCloseTo(1, 1);
  });
});

describe("v24 review: large distributions", () => {
  const uniform = (n: number) => {
    const values = new Float64Array(n);
    const weights = new Float64Array(n).fill(1);
    for (let at = 0; at < n; at++) {
      values[at] = (at * 7919) % n;
    }
    return { values, weights };
  };

  it("four million uniform values: one gathering pass, not one per percentile", async () => {
    const { distributionSummary, distributionSummaryAsync } =
      await import("@/lib/analysis/distributionStats.ts");
    const n = 4_000_000;
    const { values, weights } = uniform(n);
    const started = performance.now();
    const s = distributionSummary(values, weights, n, 0, n - 1)!;
    const took = performance.now() - started;
    expect(percentileAt(s.percentiles, 50)).toBeCloseTo(n / 2, -1);
    expect(percentileAt(s.percentiles, 0.5)).toBe(19_999);
    // Recorded, not gated (machines differ).
    console.info(`4M uniform summary: ${took.toFixed(0)} ms`);
    const again = await distributionSummaryAsync(values, weights, n, 0, n - 1);
    expect(again!.percentiles).toEqual(s.percentiles);
  });

  it("is cancelled between batches", async () => {
    const { distributionSummaryAsync } =
      await import("@/lib/analysis/distributionStats.ts");
    const n = 2_000_000;
    const { values, weights } = uniform(n);
    const controller = new AbortController();
    const pending = distributionSummaryAsync(
      values,
      weights,
      n,
      0,
      n - 1,
      controller.signal
    );
    controller.abort();
    await expect(pending).rejects.toThrow();
  });
});
