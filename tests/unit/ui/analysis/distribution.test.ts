import { describe, expect, it } from "vitest";

import { distributionSummary } from "@/lib/analysis/distributionStats.ts";
import {
  cdfPoints,
  distributionMarks,
  shareAboveText,
  shareBelow,
  rangeName,
  skewWords,
  summaryChip,
  summaryText,
  valueTags,
} from "@/ui/analysis/distribution.ts";

/** A histogram of evenly spread values 0…10 in 10 bins, with its summary. */
function histogram() {
  const n = 1000;
  const values = Float64Array.from({ length: n }, (_, k) => (10 * k) / (n - 1));
  const weights = new Float64Array(n).fill(1);
  return {
    edges: Array.from({ length: 11 }, (_, k) => k),
    validFraction: 1,
    validCells: n,
    selectedCells: n,
    mean: 5,
    weighting: "equal",
    summary: distributionSummary(values, weights, n, 0, 10),
  };
}

// eslint-disable-next-line max-lines-per-function
describe("distribution marks", () => {
  it("draws the curve in the bars' units: % of the area per bin", () => {
    const marks = distributionMarks(histogram(), "density")!;
    expect(marks.curves).toHaveLength(1);
    // Uniform over 0–10: 10 % per bin of width 1, also at the edges
    // (the curve is reflected there).
    const y = marks.curves[0].y;
    expect(y[Math.floor(y.length / 2)]).toBeCloseTo(10, 0);
    expect(y[0]).toBeGreaterThan(8);
    expect(marks.median).toBeCloseTo(5, 1);
    expect(marks.range).toMatchObject({ percent: 95 });
    expect(marks.range.low).toBeCloseTo(0.25, 1);
    expect(marks.range.high).toBeCloseTo(9.75, 1);
  });

  it("adds a dashed normal curve on request, and none for bars only", () => {
    const h = histogram();
    const both = distributionMarks(h, "both")!;
    expect(both.curves.map((c) => c.label)).toEqual([
      "curve smoothed",
      "curve normal",
    ]);
    expect(both.curves[1].dashed).toBe(true);
    // The bracket and lines stay with the bars alone.
    const none = distributionMarks(h, "none")!;
    expect(none.curves).toHaveLength(0);
    expect(none.range).toEqual(both.range);
  });

  it("brackets any usual central range: 90 % is the 5th to 95th percentile", () => {
    const h = histogram();
    const ninety = distributionMarks(h, "density", 90)!.range;
    expect(ninety.low).toBeCloseTo(0.5, 1);
    expect(ninety.high).toBeCloseTo(9.5, 1);
    const half = distributionMarks(h, "density", 50)!.range;
    expect(half.low).toBeCloseTo(2.5, 1);
    expect(half.high).toBeCloseTo(7.5, 1);
    expect(rangeName(95)).toBe("95 % (2.5th–97.5th)");
    expect(rangeName(90)).toBe("90 % (5th–95th)");
    expect(rangeName(50)).toBe("50 % (25th–75th)");
    expect(summaryText(h, "mm", 90)).toMatch(
      /90 % of the area between 0\.4\d* and 9\.5\d* mm \(5 % below, 5 % above\)/
    );
    expect(summaryChip(h, "mm", 80)).toMatch(
      /, 80 %: 0\.99\d*–(8\.99\d*|9) mm$/
    );
  });

  it("says where the tail is, and sums it up in one line", () => {
    expect(skewWords(0.2)).toBe("roughly symmetric");
    expect(skewWords(1.4)).toBe("long tail to high values");
    expect(skewWords(-0.9)).toBe("long tail to low values");
    const text = summaryText(histogram(), "mm");
    expect(text).toMatch(/^Mean 5 mm; median (4\.99|5) mm; σ 2\.89 mm/);
    expect(text).toMatch(
      /95 % of the area between 0\.2\d* and 9\.7\d* mm \(2\.5 % below, 2\.5 % above\)/
    );
    expect(text).toMatch(/roughly symmetric/);
    // Short for the window: the units once, at the end.
    expect(summaryChip(histogram(), "mm")).toMatch(
      /^Mean 5, median (4\.99|5), σ 2\.89, 95 %: 0\.2\d*–9\.7\d* mm$/
    );
  });

  it("has nothing to add without a summary (a constant field)", () => {
    const h = { ...histogram(), summary: undefined };
    expect(distributionMarks(h, "density")).toBeUndefined();
    expect(summaryText(h)).toBe("");
    expect(summaryChip(h)).toBe("");
  });
});

describe("cumulative share and share above", () => {
  it("interpolates the share below a value between percentiles", () => {
    const percentiles = Array.from({ length: 201 }, (_, k) => k / 20);
    expect(shareBelow(percentiles, 5)).toBeCloseTo(0.5, 5);
    expect(shareBelow(percentiles, 2.525)).toBeCloseTo(0.2525, 5);
    expect(shareBelow(percentiles, -1)).toBe(0);
    expect(shareBelow(percentiles, 11)).toBe(1);
  });

  it("says how much of the area lies above a value, and marks it", () => {
    const h = histogram();
    expect(shareAboveText(h, 9, "m s-1")).toBe(
      "Above 9 m s-1: ≈ 10 % of the area"
    );
    const marks = distributionMarks(h, "density", 95, 9)!;
    expect(marks.above!.value).toBe(9);
    expect(marks.above!.share).toBeCloseTo(0.1, 2);
    expect(distributionMarks(h, "density", 95)!.above).toBeUndefined();
  });

  it("draws the cumulative share from 0 to 100 %, curves left out", () => {
    const h = histogram();
    const points = cdfPoints(h)!;
    expect(points.y[0]).toBe(0);
    expect(points.y[200]).toBe(100);
    expect(points.x[100]).toBeCloseTo(5, 1);
    expect(distributionMarks(h, "cdf")!.curves).toEqual([]);
  });
});

describe("tails of tied data (v20 review)", () => {
  it("99 % zeros and 1 % ones: 0 % below and 1 % above [0, 0]", () => {
    const n = 1000;
    const values = Float64Array.from({ length: n }, (_, i) =>
      i < 990 ? 0 : 1
    );
    const weights = new Float64Array(n).fill(1);
    const summary = distributionSummary(values, weights, n, 0, 1)!;
    const h = {
      edges: [0, 0.5, 1],
      validFraction: 1,
      validCells: n,
      selectedCells: n,
      mean: 0.01,
      weighting: "",
      summary,
    } as never;
    const marks = distributionMarks(h, "density", 95)!;
    expect([marks.range.low, marks.range.high]).toEqual([0, 0]);
    expect(marks.range.below).toBe(0);
    expect(marks.range.above).toBeCloseTo(1, 5);
    const text = summaryText(h, "mm", 95);
    expect(text).toMatch(/\(0 % below, 1 % above\)/);
    expect(text).toMatch(/values tied at its ends put 99 % of the area in it/);
  });
});

describe("median and mean tags", () => {
  const pixel = (value: number) => value * 100;
  it("combine into one tag when the two coincide", () => {
    const one = valueTags({ median: 9.23, mean: 9.2300001 }, pixel);
    expect(one).toHaveLength(1);
    expect(one[0]).toMatchObject({
      style: "both",
      label: "mean = median 9.23",
    });
    // Apart in value, but under 3 px apart on the chart: one tag naming both.
    const close = valueTags({ median: 9.2, mean: 9.21 }, pixel);
    expect(close).toHaveLength(1);
    expect(close[0].label).toBe("median 9.2, mean 9.21");
  });
  it("stay apart, the lower to the left, when they differ", () => {
    const two = valueTags({ median: 9.23, mean: 9.28 }, pixel);
    expect(two.map((t) => [t.style, t.left])).toEqual([
      ["median", true],
      ["mean", false],
    ]);
  });
});
