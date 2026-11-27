import { expect, it } from "vitest";

import { timeLabels } from "@/lib/analysis/calendar.ts";
import {
  maximaYears,
  periodDates,
  type TSeriesContext,
} from "@/ui/analysis/seriesViews.ts";
import { diurnalCycle } from "@/ui/analysis/timeViews.ts";

type Cell = [start: number, end: number, value: number];

function context(
  cells: Cell[],
  method: string,
  units = "days since 2001-01-01",
  calendar = "360_day"
) {
  const raw = cells.map(([a, b]) => (a + b) / 2);
  return {
    raw,
    dates: timeLabels({ raw, units, calendar }),
    bounds: cells.flatMap(([a, b]) => [a, b]),
    values: cells.map((c) => c[2]),
    timeUnits: units,
    calendar,
    cellMethods: `time: ${method}`,
    units: "mm/day",
    window: 3,
    threshold: 0,
  } satisfies TSeriesContext;
}

it("interim48: a 21-hour mean is no daily mean in an annual-maximum fit", () => {
  const days: Cell[] = Array.from({ length: 7 * 360 }, (_, d) => [d, d + 1, 5]);
  const short: Cell = [2 * 360 + 100, 2 * 360 + 100 + 21 / 24, 999];
  const { rowYear } = maximaYears(context([...days, short], "mean"));
  // Its row belongs to no year's daily maxima.
  expect(rowYear[days.length]).toBeUndefined();
  expect(rowYear[0]).toBe("2001");
});

it("interim48: a year's published maximum stands beside smaller maxima inside it", () => {
  const annual: Cell[] = Array.from({ length: 6 }, (_, y) => [
    360 * y,
    360 * (y + 1),
    10 + y,
  ]);
  const daily: Cell[] = Array.from({ length: 6 }, (_, y) => [
    360 * y + 10,
    360 * y + 11,
    4,
  ]);
  const both = maximaYears(context([...annual, ...daily], "maximum"));
  expect([...both.years].sort()).toEqual([
    "2001",
    "2002",
    "2003",
    "2004",
    "2005",
    "2006",
  ]);
  // A part larger than its year's published maximum contradicts it.
  const contradicted = maximaYears(
    context([...annual, [15, 16, 99]], "maximum")
  );
  expect(contradicted.years.has("2001")).toBe(false);
});

it("interim48: a daily mean beside its hours leaves the hourly bins, and is counted", () => {
  const units = "hours since 2001-01-01";
  const cells: Cell[] = [
    [0, 1, 10],
    [1, 2, 20],
    [0, 24, 15],
  ];
  const ctx = context(cells, "mean", units, "standard");
  const cycle = diurnalCycle(periodDates(ctx), ctx.values);
  expect([cycle.mean[0], cycle.mean[1]]).toEqual([10, 20]);
  expect(cycle.leftOut).toBe(1);
});

it("interim48: rolling 24-hour maxima locate no hour; a half-hour shifted mean is said to be split", () => {
  const units = "hours since 2001-01-01";
  const rolling: Cell[] = Array.from({ length: 8 }, (_, k) => [
    12 * k,
    12 * k + 24,
    40,
  ]);
  const maxima = context(rolling, "maximum", units, "standard");
  const cycle = diurnalCycle(periodDates(maxima), maxima.values);
  expect(cycle.mean.filter(Number.isFinite)).toEqual([]);
  expect(cycle.leftOut).toBe(8);
  const shifted = context([[0.5, 1.5, 10]], "mean", units, "standard");
  const split = diurnalCycle(periodDates(shifted), shifted.values);
  expect([split.mean[0], split.mean[1], split.spread]).toEqual([10, 10, 1]);
});
