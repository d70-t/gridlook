import { describe, expect, it } from "vitest";

import { percentileOf, percentileOfValues } from "@/ui/analysis/members.ts";
import { axisRows } from "@/ui/analysis/seriesDates.ts";

describe("v24 review: series costs", () => {
  it("a descending million-date axis with three rows read gives three rows", () => {
    const n = 1_000_000;
    const dates = Array.from({ length: n }, (_, k) => n - k);
    expect(axisRows(dates, 3)).toEqual([2, 1, 0]);
    expect(axisRows([5, 4, 3, 2])).toEqual([3, 2, 1, 0]);
    // Ascending needs no order; an unordered axis still sorts its rows.
    expect(axisRows([1, 2, 3])).toBeUndefined();
    expect(axisRows([2, 1, 3], 3)).toEqual([1, 0, 2]);
  });

  it("the 90th percentile by selection equals the sorted one", () => {
    const values = Array.from(
      { length: 10_001 },
      (_, k) => ((k * 7919) % 10_007) / 7
    );
    values[5] = Number.NaN;
    const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
    for (const f of [0, 0.1, 0.5, 0.9, 0.95, 1]) {
      expect(percentileOfValues(values, f)).toBeCloseTo(
        percentileOf(sorted, f),
        9
      );
    }
    expect(percentileOfValues([], 0.9)).toBeNaN();
  });
});

describe("v24 review: Compare's marks within one budget per panel", () => {
  it("four series of 31,411 days draw a few thousand dots, not 80,000", async () => {
    const { budgetedScatter, dotsPath } =
      await import("@/ui/analysis/chartBudget.ts");
    const n = 31_411;
    const series = [0, 1, 2, 3].map((s) => ({
      xs: Float64Array.from(
        { length: n },
        (_, k) => Math.sin(k * 0.37 + s) * 10
      ),
      ys: Float64Array.from(
        { length: n },
        (_, k) => Math.cos(k * 0.11 + s) * 10
      ),
    }));
    // A 566 × 264 px panel.
    const toX = (x: number) => 58 + ((x + 10) / 20) * 566;
    const toY = (y: number) => 14 + ((10 - y) / 20) * 264;
    const { kept } = budgetedScatter(series, toX, toY);
    const total = kept.reduce((sum, k) => sum + k.length, 0);
    expect(total).toBeLessThanOrEqual(6000);
    // Every series keeps a share of the panel.
    expect(kept.every((k) => k.length > 500)).toBe(true);
    // One path per series: each dot a pair of arcs.
    const d = dotsPath(
      [
        { x: 10, y: 20 },
        { x: 30, y: 40 },
      ],
      2
    );
    expect(d.match(/M/g)).toHaveLength(2);
    expect(d.startsWith("M8.0,20.0a2,2 0 1,0 4,0a2,2 0 1,0 -4,0")).toBe(true);
  });
});

describe("v24 review: reduction by screen position, not index", () => {
  it("keeps two peaks of an irregular series that index buckets merged", async () => {
    const { reduceForDisplay } =
      await import("@/lib/analysis/analysisExport.ts");
    // 9,900 samples in the first unit of x, then one per unit to 100.
    const x = [
      ...Array.from({ length: 9900 }, (_, k) => k / 9900),
      ...Array.from({ length: 100 }, (_, k) => k + 1),
    ];
    const y = x.map((v) => (v === 40 || v === 60 ? 10 : 0));
    const reduced = reduceForDisplay(x, y, 100);
    const peaks = reduced.x.filter((_, at) => reduced.y[at] === 10);
    expect(peaks).toEqual([40, 60]);
    // Unordered x still reduces (by index), every gap kept.
    const shuffled = reduceForDisplay([3, 1, 2, ...x], [0, 0, 0, ...y], 100);
    expect(shuffled.x.length).toBeGreaterThan(0);
  });
});
