import { describe, expect, it } from "vitest";

import { maximaYears, reshapeViews } from "@/ui/analysis/seriesViews.ts";
import { accumulate, TIME_VIEWS } from "@/ui/analysis/timeViews.ts";

describe("return levels need annual maxima", () => {
  const years = [2000, 2001, 2002, 2003, 2004];
  const base = {
    raw: years.map((_, k) => 365 * k + 182),
    timeUnits: "days since 2000-01-01",
    window: 3,
    threshold: 0,
  };

  it("does not fit annual means as maxima", () => {
    const ctx = {
      ...base,
      dates: years.map((y) => `${y}-07-01`),
      bounds: years.flatMap((_, k) => [365 * k, 365 * (k + 1)]),
      cellMethods: "time: mean",
    };
    expect(reshapeViews(ctx)).not.toContain(TIME_VIEWS.RETURN);
  });

  it("does not fit one one-day January maximum a year", () => {
    const ctx = {
      ...base,
      raw: years.map((_, k) => 365 * k),
      dates: years.map((y) => `${y}-01-01`),
      bounds: years.flatMap((_, k) => [365 * k, 365 * k + 1]),
      cellMethods: "time: maximum",
    };
    expect(reshapeViews(ctx)).not.toContain(TIME_VIEWS.RETURN);
  });

  it("names the maxima of daily means it fits", () => {
    const days = Array.from({ length: 5 * 365 }, (_, d) => d);
    const date = (d: number) => {
      const t = new Date(Date.UTC(2000, 0, 1) + d * 86400000);
      return t.toISOString().slice(0, 10);
    };
    const ctx = {
      ...base,
      raw: days,
      dates: days.map(date),
      bounds: days.flatMap((d) => [d, d + 1]),
      cellMethods: "time: mean",
    };
    const found = maximaYears(ctx);
    expect(found.years.size).toBe(5);
    expect(found.of).toBe("annual maxima of daily means");
  });
});

describe("totals say what they cover", () => {
  it("withholds a total of overlapping interval means", () => {
    const t = accumulate(
      [1, 2, 3],
      "days since 2000-01-01",
      [1, 1, 1],
      "W m-2",
      [0, 2, 1, 3, 2, 4]
    );
    expect(t.withheld).toMatch(/overlap/);
  });

  it("tells the covered time from the time between", () => {
    const t = accumulate(
      [0.5, 1.5, 365.5],
      "days since 2000-01-01",
      [1, 1, 1],
      "W m-2",
      [0, 1, 1, 2, 365, 366]
    );
    expect(t.y[2]).toBeCloseTo(259200, 6);
    expect(t.covered).toBe(3 * 86400);
    expect(t.uncovered).toBe(363 * 86400);
  });

  it("holds an instantaneous rate until the next sample: elapsed time only", () => {
    const t = accumulate(
      [0, 1, 365],
      "days since 2000-01-01",
      [1, 1, 1],
      "W m-2"
    );
    expect(t.y).toEqual([0, 86400, 365 * 86400]);
    expect(t.held).toBe(true);
  });
});

it("performance review of interim30: the annual-maxima test is kept per series", () => {
  const raw = Array.from({ length: 6 * 365 }, (_, at) => at + 0.5);
  const ctx = {
    dates: raw.map((t) => {
      const d = new Date(Date.UTC(2001, 0, 1) + t * 86400000);
      return d.toISOString().slice(0, 10);
    }),
    raw,
    bounds: raw.flatMap((t) => [t - 0.5, t + 0.5]),
    timeUnits: "days since 2001-01-01",
    calendar: "standard",
    values: raw.map(() => 1),
    window: 5,
    threshold: 1,
  };
  const first = maximaYears(ctx);
  // The same series in another context object: the same answer, kept.
  expect(maximaYears({ ...ctx, window: 9 })).toBe(first);
  // Other plotted values (a coverage cutoff): tested again.
  const masked = { ...ctx, values: ctx.values.map(() => Number.NaN) };
  expect(maximaYears(masked)).not.toBe(first);
  expect(maximaYears(masked).years.size).toBe(0);
});
