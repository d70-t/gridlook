import { expect, it } from "vitest";

import { timeLabels } from "@/lib/analysis/calendar.ts";
import {
  maximaYears,
  periodDates,
  reshapedSpec,
  type TSeriesContext,
} from "@/ui/analysis/seriesViews.ts";
import {
  annualCycle,
  diurnalCycle,
  runningMeanOverCells,
  TIME_VIEWS,
} from "@/ui/analysis/timeViews.ts";

type Cell = [start: number, end: number, value: number];

function context(
  cells: Cell[],
  method = "mean"
): TSeriesContext & {
  values: number[];
} {
  const timeUnits = "days since 2001-01-01";
  const calendar = "360_day";
  const raw = cells.map(([start, end]) => (start + end) / 2);
  return {
    raw,
    dates: timeLabels({ raw, units: timeUnits, calendar }),
    timeUnits,
    calendar,
    units: "K",
    cellMethods: `time: ${method}`,
    bounds: cells.flatMap(([start, end]) => [start, end]),
    values: cells.map(([, , value]) => value),
    window: 3,
    threshold: 0,
  };
}

function spec(ctx: TSeriesContext & { values: number[] }) {
  return {
    mode: "time" as const,
    x: ctx.raw,
    y: ctx.values,
    units: ctx.units,
    xTitle: "Date",
    yTitle: "Temperature",
    xLabel: String,
    readout: () => [],
  };
}

it("a running mean does not count subintervals twice alongside its known full-window mean", () => {
  // Daily means 300, 260 and 280 K would give exactly the published 280 K.
  // The supplied days fall inside the published three-day interval.
  const ctx = context([
    [0, 1, 300],
    [0, 3, 280],
    [2, 3, 280],
  ]);
  const result = reshapedSpec(TIME_VIEWS.RUNNING, spec(ctx), ctx)!;
  const middle = result.overlay!.values[1];
  expect(result.overlay!.label).toBe("3-day running mean");
  expect([280, Number.NaN]).toContain(middle);
});

it("a quarterly maximum cannot identify a month of the annual cycle", () => {
  const ctx = context(
    [
      [0, 90, 300],
      [90, 180, 310],
      [180, 270, 320],
      [270, 360, 305],
    ],
    "maximum"
  );
  const result = annualCycle(periodDates(ctx), ctx.values);
  expect(result.mean.filter(Number.isFinite)).toEqual([]);
});

it("monthly means on a 360-day calendar cannot split a longer-than-month observation into two monthly values", () => {
  const ctx = context([[0, 31, 300]]);
  const result = annualCycle(periodDates(ctx), ctx.values);
  expect(result.mean.filter(Number.isFinite)).toEqual([]);
});

it("a 28-day outlier is not a monthly maximum of 30-day means on a 360-day calendar", () => {
  const monthly = Array.from({ length: 6 * 12 }, (_, i): Cell => [
    i * 30,
    (i + 1) * 30,
    270 + (i % 12) + Math.floor(i / 12),
  ]);
  const plain = context(monthly);
  expect(maximaYears(plain).years.size).toBe(6);
  const mixed = context([...monthly, [720, 748, 999]]);
  const fitted = (ctx: typeof plain) =>
    reshapedSpec(TIME_VIEWS.RETURN, spec(ctx), ctx)!.y.at(-1);
  expect(fitted(mixed)).toBeCloseTo(fitted(plain)!);
});

it("a running window reuses disjoint hourly means instead of reading every covered value for every output", () => {
  const count = 2048;
  const hour = Array.from({ length: count }, (_, i) => i + 0.5);
  const bounds = hour.flatMap((t) => [t - 0.5, t + 0.5]);
  let reads = 0;
  const values = new Proxy(new Array<number>(count).fill(280), {
    get(list, key) {
      if (typeof key === "string" && /^\d+$/.test(key)) {
        reads++;
      }
      return Reflect.get(list, key);
    },
  });
  const result = runningMeanOverCells(values, hour, bounds, 720)!;
  expect(result[count / 2]).toBe(280);
  expect(reads).toBeLessThan(40 * count);
});

it("a maximum with a missing support interval cannot identify the hour of its event", () => {
  const ctx = context(
    [
      [0, 1 / 24, 280],
      [0.5, 0.5 + 1 / 24, 310],
    ],
    "maximum"
  );
  ctx.bounds!.splice(2, 2, Number.NaN, Number.NaN);
  const result = diurnalCycle(periodDates(ctx), ctx.values);
  expect(result.mean[0]).toBe(280);
  expect(result.mean[12]).toBeNaN();
});

it("a redundant annual mean leaves annual maxima of fully observed monthly means intact", () => {
  // All five years supply twelve complete monthly means. Their mean
  // in the first year adds no observations to the monthly support.
  const monthly = Array.from({ length: 60 }, (_, i): Cell => [
    i * 30,
    (i + 1) * 30,
    280 + (i % 12),
  ]);
  const plain = context(monthly);
  expect(maximaYears(plain).years.size).toBe(5);
  const redundant = context([...monthly, [0, 360, 285.5]]);
  expect([...maximaYears(redundant).years]).toEqual([
    ...maximaYears(plain).years,
  ]);
});
