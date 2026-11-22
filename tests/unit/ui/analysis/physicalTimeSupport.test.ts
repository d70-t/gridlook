import { expect, it } from "vitest";

import { maximaYears, reshapedSpec } from "@/ui/analysis/seriesViews.ts";
import { TIME_VIEWS } from "@/ui/analysis/timeViews.ts";

const epoch = Date.UTC(2001, 0, 1);
const day = 86_400_000;
const offset = (year: number, month = 0) =>
  (Date.UTC(year, month, 1) - epoch) / day;
const date = (value: number) =>
  new Date(epoch + value * day).toISOString().slice(0, 10);

const series = (raw: number[], values: number[]) => ({
  mode: "time" as const,
  x: raw,
  y: values,
  xTitle: "Date",
  xLabel: String,
  yTitle: "Rain (mm)",
  readout: () => [],
});

const context = (raw: number[], bounds: number[], values: number[]) => ({
  dates: raw.map(date),
  raw,
  bounds,
  timeUnits: "days since 2001-01-01",
  units: "mm",
  cellMethods: "time: maximum",
  window: 3,
  threshold: 0,
  values,
});

it("keeps a fully observed year of monthly maxima in a fit alongside daily maxima", () => {
  const raw: number[] = [];
  const bounds: number[] = [];
  const values: number[] = [];
  const add = (low: number, high: number, max: number) => {
    raw.push((low + high) / 2);
    bounds.push(low, high);
    values.push(max);
  };
  for (let year = 2001; year < 2006; year++) {
    for (let d = offset(year); d < offset(year + 1); d++) {
      add(d, d + 1, year - 2000);
    }
  }
  for (let month = 0; month < 12; month++) {
    add(offset(2006, month), offset(2006, month + 1), 100);
  }
  const ctx = context(raw, bounds, values);
  expect(maximaYears(ctx).years.size).toBe(6);
  const chart = reshapedSpec(TIME_VIEWS.RETURN, series(raw, values), ctx);
  expect(chart?.points?.y).toEqual([100, 5, 4, 3, 2, 1]);
});

it("does not fit annual averages of daily maxima as published annual maxima", () => {
  const starts = Array.from({ length: 5 }, (_, k) => offset(2001 + k));
  const ends = Array.from({ length: 5 }, (_, k) => offset(2002 + k));
  const raw = starts.map((start, k) => (start + ends[k]) / 2);
  const values = [1, 2, 3, 4, 5];
  const ctx = context(
    raw,
    starts.flatMap((start, k) => [start, ends[k]]),
    values
  );
  expect(maximaYears(ctx).years.size).toBe(5);
  const chart = reshapedSpec(TIME_VIEWS.RETURN, series(raw, values), {
    ...ctx,
    cellMethods: "time: maximum within days time: mean over days",
  });
  expect(chart?.mode).not.toBe("cycle");
});

it("puts end-stamped monthly means in the box for the month actually measured", () => {
  const starts = [0, 1, 2].map((month) => offset(2001, month));
  const ends = [1, 2, 3].map((month) => offset(2001, month));
  const values = [10, 20, 30];
  const bounds = starts.flatMap((start, k) => [start, ends[k]]);
  const medians = (raw: number[]) => {
    const chart = reshapedSpec(TIME_VIEWS.BOXES, series(raw, values), {
      ...context(raw, bounds, values),
      cellMethods: "time: mean",
    });
    return chart?.boxes?.slice(0, 3).map((box) => box?.median);
  };
  expect(medians(starts)).toEqual(values);
  expect(medians(ends)).toEqual(values);
});

it("holds a 360_day year to nine-tenths of 360 days, not of 365", () => {
  const label = (d: number) => {
    const year = 2001 + Math.floor(d / 360);
    const rest = d % 360;
    const two = (n: number) => String(n).padStart(2, "0");
    return `${year}-${two(Math.floor(rest / 30) + 1)}-${two((rest % 30) + 1)}`;
  };
  const years = (days: number) => {
    const raw: number[] = [];
    const bounds: number[] = [];
    for (let year = 0; year < 5; year++) {
      for (let d = 0; d < days; d++) {
        raw.push(year * 360 + d + 0.5);
        bounds.push(year * 360 + d, year * 360 + d + 1);
      }
    }
    return maximaYears({
      ...context(
        raw,
        bounds,
        raw.map(() => 1)
      ),
      dates: raw.map((t) => label(Math.floor(t))),
      calendar: "360_day",
    }).years.size;
  };
  // 324 of 360 days is nine-tenths; 323 is not.
  expect(years(324)).toBe(5);
  expect(years(323)).toBe(0);
});

it("fits the return levels of a series once, however often the view is chosen (review of interim33)", () => {
  const raw: number[] = [];
  const bounds: number[] = [];
  const values: number[] = [];
  for (let d = offset(2001); d < offset(2007); d++) {
    raw.push(d + 0.5);
    bounds.push(d, d + 1);
    values.push(d % 97);
  }
  const ctx = context(raw, bounds, values);
  const base = series(raw, values);
  const first = reshapedSpec(TIME_VIEWS.RETURN, base, ctx);
  const again = reshapedSpec(TIME_VIEWS.RETURN, base, ctx);
  expect(first?.y.length).toBeGreaterThan(0);
  // The same fit, not a second one.
  expect(again?.y).toBe(first?.y);
});

it("keeps an intensive reading with no time method in its sample month", () => {
  const raw = [31, 59, 90];
  const values = [280, 285, 290];
  const fields = context(raw, [0, 31, 31, 59, 59, 90], values);
  const boxesOf = (cellMethods?: string) =>
    reshapedSpec(TIME_VIEWS.BOXES, series(raw, values), {
      ...fields,
      units: "K",
      cellMethods,
    })
      ?.boxes?.slice(0, 4)
      .map((box) => box?.median);
  const expected = [undefined, ...values];
  expect(boxesOf("time: point")).toEqual(expected);
  expect(boxesOf()).toEqual(expected);
});

it("counts only support inside each calendar year when qualifying annual maxima", () => {
  const raw: number[] = [];
  const bounds: number[] = [];
  const values: number[] = [];
  for (const year of [2001, 2003, 2005, 2007, 2009]) {
    for (let d = offset(year); d <= offset(year, 10); d++) {
      raw.push(d);
      bounds.push(d - 15, d + 15);
      values.push(year - 2000);
    }
  }
  // Each year's 30-day rolling maxima cover 319 days within that year and
  // 15 days of the preceding December. 319 / 365 falls below 90 percent.
  const ctx = context(raw, bounds, values);
  const chart = reshapedSpec(TIME_VIEWS.RETURN, series(raw, values), ctx);
  expect(chart?.mode).not.toBe("cycle");
});

it("gives an intensive rate the same elapsed total with an implicit or explicit point method", () => {
  const raw = [0, 1, 2];
  const values = [1, 2, 100];
  const ctx = context(raw, [0, 1, 1, 2, 2, 3], values);
  const totals = (cellMethods?: string) =>
    reshapedSpec(TIME_VIEWS.CUMULATIVE, series(raw, values), {
      ...ctx,
      units: "mm/day",
      cellMethods,
    })?.y;
  expect(totals("time: point")).toEqual([0, 1, 3]);
  expect(totals()).toEqual([0, 1, 3]);
});
