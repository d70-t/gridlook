import { expect, it } from "vitest";

import { timeLabels } from "@/lib/analysis/calendar.ts";
import { meanDurations, memberStats } from "@/ui/analysis/members.ts";
import {
  maximaYears,
  periodDates,
  reshapedSpec,
  type TSeriesContext,
} from "@/ui/analysis/seriesViews.ts";
import {
  annualCycle,
  spansMonths,
  TIME_VIEWS,
} from "@/ui/analysis/timeViews.ts";

type Cell = [start: number, end: number, value: number];
const timeUnits = "days since 2001-01-01";
const calendar = "360_day";

function context(cells: Cell[], method = "mean", stamps?: number[]) {
  const raw = stamps ?? cells.map(([a, b]) => (a + b) / 2);
  return {
    raw,
    dates: timeLabels({ raw, units: timeUnits, calendar }),
    bounds: cells.flatMap(([a, b]) => [a, b]),
    values: cells.map((c) => c[2]),
    timeUnits,
    calendar,
    cellMethods: `time: ${method}`,
    units: "K",
    window: 3,
    threshold: 0,
  } satisfies TSeriesContext;
}

function monthly(years: number): Cell[] {
  return Array.from({ length: years * 12 }, (_, m) => [
    m * 30,
    (m + 1) * 30,
    270 + (m % 12) + Math.floor(m / 12),
  ]);
}

it("does not turn four quarterly temperature means into twelve observed monthly means", () => {
  const cells: Cell[] = [280, 290, 300, 285].map((v, i) => [
    i * 90,
    (i + 1) * 90,
    v,
  ]);
  const ctx = context(cells);
  expect(spansMonths(ctx.dates)).toBe(true);
  // January temperatures of 270 K and 290 K are equally compatible with
  // the first quarterly mean. No January mean is identified by these data.
  const cycle = annualCycle(periodDates(ctx), ctx.values);
  expect(cycle.mean.filter(Number.isFinite)).toEqual([]);
});

it("keeps five complete years of observed monthly means when daily fill rows are appended", () => {
  const observed = monthly(5);
  const missing: Cell[] = Array.from({ length: 90 }, (_, d) => [
    1800 + d,
    1801 + d,
    Number.NaN,
  ]);
  const original = maximaYears(context(observed));
  expect(original.years.size).toBe(5);
  expect([...maximaYears(context([...observed, ...missing])).years]).toEqual([
    ...original.years,
  ]);
});

it("a multi-year maximum ending at midnight on January 1 cannot invalidate the following year", () => {
  // Each year's missing 30 days keeps coverage above 90%. The two-year
  // maximum could have occurred in one of the missing months in 2002–03.
  const observed = monthly(7).filter((_, m) => m % 12 !== 0);
  const all = [...maximaYears(context(observed, "maximum")).years];
  expect(all).toContain("2004");
  const twoYears: Cell = [360, 1080, 320]; // [2002-01-01, 2004-01-01).
  const years = [
    ...maximaYears(context([...observed, twoYears], "maximum")).years,
  ];
  expect(years).toEqual(all.filter((y) => y !== "2002" && y !== "2003"));
});

it("averages each member over its own valid intervals when observations have complementary gaps", () => {
  const ctx = context([
    [0, 2, 280],
    [1, 3, 290],
  ]);
  const lengths = meanDurations({
    cellMethods: ctx.cellMethods,
    time: { dimension: "time", raw: ctx.raw, bounds: ctx.bounds },
  });
  const a = [280, Number.NaN];
  const b = [Number.NaN, 290];
  expect(memberStats([a], 2, lengths).means).toEqual([280]);
  expect(memberStats([b], 2, lengths).means).toEqual([290]);
  expect(memberStats([a, b], 2, lengths).means).toEqual([280, 290]);
});

it("weights the three-day running temperature mean by the declared support", () => {
  const ctx = context(
    [
      [0, 0.5, 270],
      [0.5, 2, 290],
      [2, 3, 270],
    ],
    "mean",
    [0.5, 1.5, 2.5]
  );
  const base = {
    mode: "time" as const,
    x: ctx.raw,
    y: ctx.values,
    units: ctx.units,
    xTitle: "Date",
    yTitle: "Temperature",
    xLabel: String,
    readout: () => [],
  };
  const chart = reshapedSpec(TIME_VIEWS.RUNNING, base, ctx)!;
  expect(chart.overlay?.label).toBe("3-day running mean");
  // The middle window covers exactly [0, 3] days.
  expect(chart.overlay?.values[1]).toBeCloseTo(
    (270 * 0.5 + 290 * 1.5 + 270) / 3
  );
});
