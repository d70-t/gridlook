import { describe, expect, it } from "vitest";

import {
  annualCycle,
  anomalies,
  diurnalCycle,
  linearTrend,
  trendRate,
  spansMonths,
  subDaily,
} from "@/ui/analysis/timeViews.ts";

/**
 * A wall-clock budget, checked only on a quiet benchmark run
 * (GRIDLOOK_TIMING=1): the suite asserts results and counts, and a busy host
 * does not fail correct code.
 */
const withinBudget = (ms: number, budget: number, what = "") =>
  process.env.GRIDLOOK_TIMING === "1" && expect(ms, what).toBeLessThan(budget);

/** Monthly dates over `years` years from 2020 (15th of each month). */
const monthly = (years: number) =>
  Array.from({ length: 12 * years }, (_, at) => {
    const year = 2020 + Math.floor(at / 12);
    const month = String((at % 12) + 1).padStart(2, "0");
    return `${year}-${month}-15 00:00:00`;
  });

describe("time views of a series", () => {
  it("folds months across years: mean and range of monthly means", () => {
    const dates = monthly(3);
    // A seasonal cycle (month number) that warms 1 per year.
    const values = dates.map(
      (date) => Number(date.slice(5, 7)) + Number(date.slice(0, 4)) - 2020
    );
    const cycle = annualCycle(dates, values);
    expect(cycle.mean[0]).toBe(2); // January: 1, 2, 3
    expect(cycle.low[11]).toBe(12);
    expect(cycle.high[11]).toBe(14);
    expect(cycle.count[5]).toBe(3);
  });

  it("subtracts each month's own mean for anomalies", () => {
    const dates = monthly(2);
    const values = dates.map(
      (date) =>
        Number(date.slice(5, 7)) * 10 + (date.startsWith("2021") ? 1 : -1)
    );
    const anomaly = anomalies(dates, values);
    expect(anomaly.slice(0, 3)).toEqual([-1, -1, -1]);
    expect(anomaly.slice(12, 15)).toEqual([1, 1, 1]);
  });

  it("folds hours across days for the diurnal cycle", () => {
    const dates = [
      "2020-01-01 00:00:00",
      "2020-01-01 12:00:00",
      "2020-01-02 00:00:00",
      "2020-01-02 12:00:00",
    ];
    const cycle = diurnalCycle(dates, [1, 5, 3, 7]);
    expect(cycle.mean[0]).toBe(2);
    expect(cycle.mean[12]).toBe(6);
    expect(cycle.mean[6]).toBeNaN();
    expect(subDaily(dates)).toBe(true);
    expect(subDaily(monthly(1))).toBe(false);
    expect(spansMonths(monthly(1))).toBe(true);
  });

  it("fits a least-squares trend, reported per decade", () => {
    const dates = monthly(10);
    // 0.05 per year: 0.5 per decade, plus a seasonal wiggle.
    const values = dates.map(
      (_, at) => 0.05 * (at / 12) + Math.sin((at % 12) * 0.5) * 0.01
    );
    const trend = linearTrend(dates, values);
    expect(trend.perDecade).toBeCloseTo(0.5, 2);
    expect(linearTrend(dates.slice(0, 2), [1, 2]).perDecade).toBeNaN();
  });
});

describe("the trend's unit", () => {
  it("reports the slope per day, year or decade by the series' length", () => {
    // Two weeks of hours rising 1 K a day: "+1 K per day", not per decade.
    const hours = Array.from({ length: 14 * 24 }, (_, h) => h);
    const short = linearTrend(
      hours.map(() => ""),
      hours.map((h) => h / 24),
      hours,
      "hours since 2024-06-01",
      "standard"
    );
    const day = trendRate(short);
    expect(day.per).toBe("day");
    expect(day.value).toBeCloseTo(1, 6);
    // A 360-day calendar's day is 1/360 of its year.
    const days360 = linearTrend(
      hours.map(() => ""),
      hours.map((h) => h / 24),
      hours,
      "hours since 2024-06-01",
      "360_day"
    );
    expect(trendRate(days360).value).toBeCloseTo(1, 6);
    // Five years of months: per year; thirty: per decade.
    const five = linearTrend(
      monthly(5),
      monthly(5).map((_, at) => at / 12)
    );
    expect(trendRate(five)).toMatchObject({ per: "year" });
    expect(trendRate(five).value).toBeCloseTo(1, 2);
    const thirty = linearTrend(
      monthly(30),
      monthly(30).map((_, at) => at / 12)
    );
    expect(trendRate(thirty)).toMatchObject({ per: "decade" });
  });
});

// eslint-disable-next-line max-lines-per-function
describe("more ways to see a series", () => {
  it("knows the step of a time coordinate and names it", async () => {
    const { secondsPerUnit, stepSeconds, stepName, defaultWindow } =
      await import("@/ui/analysis/timeViews.ts");
    expect(secondsPerUnit("days since 2000-01-01")).toBe(86400);
    expect(secondsPerUnit("hours since 1970-01-01 00:00")).toBe(3600);
    expect(secondsPerUnit("fortnights since 1")).toBeUndefined();
    expect(stepSeconds([0, 1, 2, 4], "days since 2000-01-01")).toBe(86400);
    expect(stepName(86400)).toBe("days");
    expect(stepName(30 * 86400)).toBe("months");
    expect(defaultWindow(30 * 86400)).toBe(12);
  });

  it("takes a centred running mean, blank where the window runs out", async () => {
    const { runningMean } = await import("@/ui/analysis/timeViews.ts");
    expect(runningMean([1, 2, 3, 4, 5], 3)).toEqual([NaN, 2, 3, 4, NaN]);
    // Fewer than half the window valid: blank.
    expect(runningMean([NaN, NaN, 3, NaN, 5], 3)[1]).toBeNaN();
    expect(runningMean([1, NaN, 3], 3)[1]).toBe(2);
  });

  it("slides the running mean in one pass: the direct sums, at 100,000 samples", async () => {
    const { runningMean } = await import("@/ui/analysis/timeViews.ts");
    const values = Array.from({ length: 100_000 }, (_, i) =>
      i % 97 === 0 ? NaN : Math.sin(i / 300) * 10 + (i % 7)
    );
    for (const window of [1, 4, 25, 730]) {
      const started = performance.now();
      const fast = runningMean(values, window);
      withinBudget(performance.now() - started, 200, `window ${window}`);
      for (const at of [0, 1, 12, 365, 4095, 4096, 8193, 50_000, 99_999]) {
        const before = Math.floor((window - 1) / 2);
        const from = at - before;
        const to = at + (window - 1 - before);
        if (from < 0 || to >= values.length) {
          expect(fast[at]).toBeNaN();
          continue;
        }
        const finite = values.slice(from, to + 1).filter(Number.isFinite);
        const direct =
          finite.length * 2 >= window
            ? finite.reduce((a, b) => a + b, 0) / finite.length
            : NaN;
        if (Number.isNaN(direct)) {
          expect(fast[at]).toBeNaN();
        } else {
          expect(fast[at]).toBeCloseTo(direct, 9);
        }
      }
    }
  });

  it("folds 100,000 hourly samples into a diurnal cycle in linear time", async () => {
    const { diurnalCycle } = await import("@/ui/analysis/timeViews.ts");
    const n = 100_000;
    const start = Date.UTC(2000, 0, 1);
    const dates = Array.from({ length: n }, (_, i) =>
      new Date(start + i * 3_600_000)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19)
    );
    const values = dates.map((_, i) => (i % 24) + Math.floor(i / 24) * 0.001);
    const started = performance.now();
    const cycle = diurnalCycle(dates, values);
    withinBudget(performance.now() - started, 250);
    expect(cycle.count[0]).toBe(Math.ceil(n / 24));
    expect(cycle.low[5]).toBeCloseTo(5);
    expect(cycle.high[5]).toBeCloseTo(5 + Math.floor((n - 1 - 5) / 24) * 0.001);
  });

  it("integrates bounded means over their declared intervals (v20 reviews)", async () => {
    const { accumulate } = await import("@/ui/analysis/timeViews.ts");
    // Jan–Mar 2000 monthly means of 1, 2 and 3 mm/day over 31, 29, 31 days.
    const monthly = accumulate(
      [15.5, 45, 75.5],
      "days since 2000-01-01",
      [1, 2, 3],
      "mm day-1",
      [0, 31, 31, 60, 60, 91]
    );
    expect(monthly.y).toEqual([31, 89, 182]);
    // Weekly observations, each a one-day mean of 1 mm/day: 3 mm, not 21.
    const weekly = accumulate(
      [0, 7, 14],
      "days since 2000-01-01",
      [1, 1, 1],
      "mm day-1",
      [0, 1, 7, 8, 14, 15]
    );
    expect(weekly.y).toEqual([1, 2, 3]);
    // Stored backwards: totalled by date, so the last date, stored first, holds
    // the whole total. Without bounds each value holds until the next sample
    // and a date's total is the time before it only: 0, 1, 2 by date.
    const backwards = accumulate(
      [2, 1, 0],
      "days since 2000-01-01",
      [1, 1, 1],
      "mm day-1"
    );
    expect(backwards.y).toEqual([2, 1, 0]);
    expect(backwards.held).toBe(true);
    expect(backwards.openEnd).toBe(true);
    expect(
      accumulate(
        [14, 7, 0],
        "days since 2000-01-01",
        [1, 1, 1],
        "mm day-1",
        [14, 15, 7, 8, 0, 1]
      ).y
    ).toEqual([3, 2, 1]);
  });

  it("integrates instants up to the last, and counts intervals with no value (review of interim10)", async () => {
    const { accumulate } = await import("@/ui/analysis/timeViews.ts");
    // Instantaneous 1 W m-2 at days 0, 1 and 365: 365 days, not 729.
    const instants = accumulate(
      [0, 1, 365],
      "days since 2000-01-01",
      [1, 1, 1],
      "W m-2"
    );
    expect(instants.y.at(-1)).toBe(365 * 86_400);
    const gap = accumulate(
      [0, 1, 2, 3],
      "days since 2000-01-01",
      [1, NaN, 1, 1],
      "W m-2"
    );
    expect(gap.gaps).toBe(1);
    // Spellings of one unit agree.
    const daily = (units: string, v: number) =>
      accumulate(
        [0.5, 1.5, 2.5],
        "days since 2000-01-01",
        [v, v, v],
        units,
        [0, 1, 1, 2, 2, 3]
      );
    expect(daily("watt m-2", 1).y.at(-1)).toBe(259_200);
    expect(daily("kW m-2", 0.001).y.at(-1)).toBeCloseTo(259_200, 6);
    expect(daily("kg m-2 s^-1", 1).y).toEqual(daily("kg m-2 s-1", 1).y);
    const reordered = daily("kg s-1 m-2", 1);
    expect(reordered.y.at(-1)).toBe(259_200);
    expect(reordered.units).toBe(daily("kg m-2 s-1", 1).units);
    expect(daily("degK", 273.15).withheld).toMatch(/temperature/);
  });

  it("integrates a power, and adds no temperatures (review of interim8)", async () => {
    const { accumulate } = await import("@/ui/analysis/timeViews.ts");
    // Three daily means of 1 W m-2 over declared days: 259,200 J m-2.
    const flux = accumulate(
      [0.5, 1.5, 2.5],
      "days since 2000-01-01",
      [1, 1, 1],
      "W m-2",
      [0, 1, 1, 2, 2, 3]
    );
    expect(flux.y).toEqual([86_400, 172_800, 259_200]);
    expect(flux.units).toBe("J m-2");
    expect(flux.rate).toBe(true);
    for (const units of ["K", "degC", "degrees_Celsius", "°C"]) {
      const t = accumulate(
        [0, 1, 2],
        "days since 2000",
        [273.15, 273.15, 273.15],
        units
      );
      expect(t.y.every(Number.isNaN)).toBe(true);
      expect(t.withheld).toMatch(/temperature/);
    }
  });

  it("withholds a rate's total when its declared bounds could not be read (v24 review)", async () => {
    const { accumulate } = await import("@/ui/analysis/timeViews.ts");
    const failed = accumulate(
      [0, 7, 14],
      "days since 2000-01-01",
      [1, 1, 1],
      "mm day-1",
      undefined,
      "its declared bounds time_bnds could not be read (503)"
    );
    expect(failed.y.every(Number.isNaN)).toBe(true);
    expect(failed.withheld).toMatch(/could not be read/);
    // Amounts too: without their cells, sums from one forecast origin may each
    // hold the ones before.
    const amounts = accumulate(
      [0, 7],
      "days since 2000",
      [1, 1],
      "mm",
      undefined,
      "x"
    );
    expect(amounts.y.every(Number.isNaN)).toBe(true);
    expect(amounts.withheld).toMatch(/retry/);
    // Undeclared bounds (none named) withhold nothing.
    expect(
      accumulate([0, 7], "days since 2000", [1, 1], "mm", undefined).y
    ).toEqual([1, 2]);
  });

  it("fits a trend on elapsed time, minutes and seconds included", async () => {
    const { linearTrend } = await import("@/ui/analysis/timeViews.ts");
    const dates = [
      "2000-01-01 00:00:00",
      "2000-01-01 00:15:00",
      "2000-01-01 00:30:00",
    ];
    const fromRaw = linearTrend(
      dates,
      [0, 1, 2],
      [0, 15, 30],
      "minutes since 2000-01-01"
    );
    // One unit per quarter-hour: 35,064 per year, per decade ten times that.
    expect(fromRaw.perDecade).toBeCloseTo(4 * 24 * 365.25 * 10, 3);
    expect(fromRaw.fitted).toEqual(
      [0, 1, 2].map((v) => expect.closeTo(v, 9)) as never
    );
    // From the dates alone, minutes still count.
    expect(Number.isFinite(linearTrend(dates, [0, 1, 2]).perDecade)).toBe(true);
  });

  it("accumulates a rate over each sample's duration, units without the rate", async () => {
    const { accumulate } = await import("@/ui/analysis/timeViews.ts");
    // 1 kg m-2 s-1 held for two days of daily samples: 86400 kg m-2 a day, each
    // date's total the days before it.
    const flux = accumulate(
      [0, 1, 2],
      "days since 2000",
      [1, 1, NaN],
      "kg m-2 s-1"
    );
    expect(flux.y).toEqual([0, 86400, 172800]);
    expect(flux.units).toBe("kg m-2");
    expect(accumulate([0, 1], "days since 2000", [2, 3], "mm/day").units).toBe(
      "mm"
    );
    // The last sample, without bounds, has no known end: it adds nothing.
    expect(accumulate([0, 1], "hours since 2000", [2, 3], "mm/day").y).toEqual([
      0,
      2 / 24,
    ]);
    // Not a rate: summed as it is.
    const plain = accumulate([0, 1], "days since 2000", [2, 3], "mm");
    expect(plain).toMatchObject({ y: [2, 5], units: "mm", rate: false });
  });

  it("counts the samples above a value in each calendar year", async () => {
    const { countAbove } = await import("@/ui/analysis/timeViews.ts");
    const dates = ["2000-01-01", "2000-06-01", "2001-01-01", "2001-02-01"];
    expect(countAbove(dates, [5, 1, 7, NaN], 3)).toEqual({
      x: [2000, 2001],
      above: [1, 1],
      valid: [2, 1],
    });
  });

  it("boxes every sample of each month across years", async () => {
    const { monthlyBoxes } = await import("@/ui/analysis/timeViews.ts");
    const boxes = monthlyBoxes(
      ["2000-01-01", "2000-01-15", "2001-01-01", "2000-02-01"],
      [1, 2, 3, 10]
    );
    expect(boxes[0]).toMatchObject({ low: 1, median: 2, high: 3, count: 3 });
    expect(boxes[1]).toMatchObject({ median: 10, count: 1 });
    expect(boxes[2]).toBeUndefined();
  });

  it("finds the period of a sine in the spectrum", async () => {
    const { spectrum } = await import("@/ui/analysis/timeViews.ts");
    // Monthly samples over 40 years with a 12-month cycle and a trend.
    const values = Array.from(
      { length: 480 },
      (_, k) => 10 * Math.sin((2 * Math.PI * k) / 12) + 0.01 * k
    );
    const month = 30 * 86400;
    const s = spectrum(values, month)!;
    expect(s.peak / month).toBeCloseTo(12, 0);
    expect(Math.max(...s.share)).toBeGreaterThan(40);
    expect(s.period[0]).toBeLessThanOrEqual(480 * month);
    expect(spectrum([1, 2, 3], month)).toBeUndefined();
  });

  it("fits return levels to yearly maxima (Gumbel, method of moments)", async () => {
    const { returnLevels } = await import("@/ui/analysis/timeViews.ts");
    // Yearly maxima drawn from a Gumbel(μ = 30, β = 4) at plotting positions.
    const years = 60;
    const maxima = Array.from({ length: years }, (_, k) => {
      const p = (k + 0.5) / years;
      return 30 - 4 * Math.log(-Math.log(p));
    });
    const dates: string[] = [];
    const values: number[] = [];
    maxima.forEach((max, k) => {
      dates.push(`${1950 + k}-03-01`, `${1950 + k}-08-01`);
      values.push(max - 10, max);
    });
    const r = returnLevels(dates, values)!;
    expect(r.years).toBe(60);
    expect(r.location).toBeCloseTo(30, 0);
    expect(r.scale).toBeCloseTo(4, 0);
    // The 100-year level of Gumbel(30, 4): 30 + 4 | 4.60 ≈ 48.4.
    expect(r.levels[r.periods.indexOf(100)]).toBeCloseTo(48.4, 0);
    expect(r.observed[0].value).toBe(Math.max(...maxima));
    expect(returnLevels(dates.slice(0, 8), values.slice(0, 8))).toBeUndefined();
  });
});

describe("v24 review: trends and spectra follow the calendar and the sampling", () => {
  it("one unit per 360-day year is ten per decade", async () => {
    const { linearTrend } = await import("@/ui/analysis/timeViews.ts");
    const raw = Array.from({ length: 40 }, (_, at) => at * 90);
    const values = raw.map((day) => day / 360);
    const fit = linearTrend(
      [],
      values,
      raw,
      "days since 2000-01-01",
      "360_day"
    );
    expect(fit.perDecade).toBeCloseTo(10, 9);
  });

  it("an irregularly sampled series offers no spectrum; a monthly one does", async () => {
    const { reshapeViews } = await import("@/ui/analysis/seriesViews.ts");
    const { TIME_VIEWS } = await import("@/ui/analysis/timeViews.ts");
    const ctx = (raw: number[]) => ({
      dates: raw.map(
        (_, at) => `2000-01-${String((at % 28) + 1).padStart(2, "0")}`
      ),
      raw,
      timeUnits: "hours since 2000-01-01",
      window: 3,
      threshold: 0,
    });
    // Hourly at first, then gaps of 1 to 5 hours.
    let t = 0;
    const irregular = Array.from(
      { length: 64 },
      (_, at) => (t += 1 + (at % 5))
    );
    expect(reshapeViews(ctx(irregular))).not.toContain(TIME_VIEWS.SPECTRUM);
    const hourly = Array.from({ length: 64 }, (_, at) => at);
    expect(reshapeViews(ctx(hourly))).toContain(TIME_VIEWS.SPECTRUM);
    // Months of 28 to 31 days are one step.
    const days = [0, 31, 60, 91, 121, 152, 182, 213, 244, 274, 305, 335];
    const months = [...days, ...days.map((d) => d + 366)].map((d) => d * 24);
    const { regularStep } = await import("@/ui/analysis/timeViews.ts");
    expect(regularStep(months, "hours since 2000-01-01")).toBeGreaterThan(0);
  });
});

describe("review of interim10: long series", () => {
  it("fits a trend to 250,000 hourly values without overflowing the stack", async () => {
    const { linearTrend } = await import("@/ui/analysis/timeViews.ts");
    const n = 250_000;
    const raw = Array.from({ length: n }, (_, at) => at);
    const values = raw.map((h) => h / 8766);
    const trend = linearTrend([], values, raw, "hours since 2000-01-01");
    expect(trend.perDecade).toBeCloseTo((10 * (365.25 * 24)) / 8766, 6);
    expect(trend.spanYears).toBeCloseTo((n - 1) / (365.25 * 24), 6);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("review of interim10: years only where the calendar says so", () => {
  const ctx = (dates: string[], extra = {}) => ({
    dates,
    raw: dates.map((_, at) => at),
    timeUnits: "days since 2000-01-01",
    window: 3,
    threshold: 0,
    ...extra,
  });

  it("offers no Count or Return for elapsed days without a calendar", async () => {
    const { reshapeViews } = await import("@/ui/analysis/seriesViews.ts");
    const { TIME_VIEWS } = await import("@/ui/analysis/timeViews.ts");
    const views = reshapeViews(
      ctx(Array.from({ length: 16 }, (_, at) => String(at)))
    );
    expect(views).not.toContain(TIME_VIEWS.COUNT);
    expect(views).not.toContain(TIME_VIEWS.RETURN);
    expect(views).not.toContain(TIME_VIEWS.BOXES);
  });

  it("needs a year's months, or annual cells, for return levels", async () => {
    const { reshapeViews } = await import("@/ui/analysis/seriesViews.ts");
    const { TIME_VIEWS } = await import("@/ui/analysis/timeViews.ts");
    const years = [2000, 2001, 2002, 2003, 2004];
    // Twelve hours of 1 January each year: no annual maximum.
    const january = years.flatMap((y) =>
      Array.from(
        { length: 12 },
        (_, h) => `${y}-01-01 ${String(h).padStart(2, "0")}:00:00`
      )
    );
    expect(reshapeViews(ctx(january))).not.toContain(TIME_VIEWS.RETURN);
    // Monthly values all year: offered.
    const monthly = years.flatMap((y) =>
      Array.from(
        { length: 12 },
        (_, m) => `${y}-${String(m + 1).padStart(2, "0")}-15`
      )
    );
    // (Their times a month apart: the values cover each year.)
    const monthDays = monthly.map((_, at) => at * 30.44);
    expect(reshapeViews(ctx(monthly, { raw: monthDays }))).toContain(
      TIME_VIEWS.RETURN
    );
    // One value a year over a year's cell: a maximum only when declared one.
    const annual = years.map((y) => `${y}-07-01`);
    // Calendar years exactly.
    const jan1 = [0, 366, 731, 1096, 1461, 1827];
    const bounds = years.flatMap((_, k) => [jan1[k], jan1[k + 1]]);
    expect(
      reshapeViews(ctx(annual, { bounds, cellMethods: "time: maximum" }))
    ).toContain(TIME_VIEWS.RETURN);
    expect(
      reshapeViews(ctx(annual, { bounds, cellMethods: "time: mean" }))
    ).not.toContain(TIME_VIEWS.RETURN);
    expect(reshapeViews(ctx(annual, { bounds }))).not.toContain(
      TIME_VIEWS.RETURN
    );
  });
});

// eslint-disable-next-line max-lines-per-function
describe("review of interim10: totals by cell methods", () => {
  it("adds no maxima, sums amounts, integrates means", async () => {
    const { accumulate, timeMethod } =
      await import("@/ui/analysis/timeViews.ts");
    expect(timeMethod("area: mean time: maximum")).toBe("maximum");
    const days = [0.5, 1.5, 2.5];
    const bounds = [0, 1, 1, 2, 2, 3];
    const max = accumulate(
      days,
      "days since 2000-01-01",
      [1, 1, 1],
      "mm day-1",
      bounds,
      undefined,
      "maximum"
    );
    expect(max.y.every(Number.isNaN)).toBe(true);
    expect(max.withheld).toMatch(/maximum/);
    const amounts = accumulate(
      days,
      "days since 2000-01-01",
      [2, 3, 4],
      "mm",
      bounds,
      undefined,
      "sum"
    );
    expect(amounts.y).toEqual([2, 5, 9]);
    expect(amounts.amounts).toBe(true);
    const means = accumulate(
      days,
      "days since 2000-01-01",
      [1, 1, 1],
      "mm day-1",
      bounds,
      undefined,
      "mean"
    );
    expect(means.y).toEqual([1, 2, 3]);
  });

  it("takes one published maximum a year for return levels", async () => {
    const { reshapeViews } = await import("@/ui/analysis/seriesViews.ts");
    const { TIME_VIEWS } = await import("@/ui/analysis/timeViews.ts");
    const dates = [2000, 2001, 2002, 2003, 2004].map((y) => `${y}-07-01`);
    const ctx = {
      dates,
      raw: [0, 1, 2, 3, 4],
      timeUnits: "days since 2000-01-01",
      window: 3,
      threshold: 0,
    };
    expect(reshapeViews(ctx)).not.toContain(TIME_VIEWS.RETURN);
    // A one-day maximum a year is no annual maximum; a maximum over a year's
    // declared cell is.
    expect(
      reshapeViews({ ...ctx, cellMethods: "time: maximum" })
    ).not.toContain(TIME_VIEWS.RETURN);
    const jan1 = [0, 366, 731, 1096, 1461, 1827];
    const bounds = [0, 1, 2, 3, 4].flatMap((k) => [jan1[k], jan1[k + 1]]);
    expect(
      reshapeViews({ ...ctx, bounds, cellMethods: "time: maximum" })
    ).toContain(TIME_VIEWS.RETURN);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("review of interim30: cumulative totals keep to what is known", () => {
  it("does not integrate point readings over cells, and adds nothing for an unknown cell", async () => {
    const { accumulate } = await import("@/ui/analysis/timeViews.ts");
    const bounds = [0, 30, 30, 60, 60, 90];
    const point = accumulate(
      [15, 45, 75],
      "days since 2000-01-01",
      [1, 1, 1],
      "W m-2",
      bounds,
      undefined,
      "point"
    );
    // Held until the next reading, not 90 days of cells.
    expect(point.held).toBe(true);
    expect(point.y[2]).toBe(60 * 86400);
    const mean = accumulate(
      [0.5, 1.5, 2.5],
      "days since 2000-01-01",
      [1, 1, 1],
      "W m-2",
      [0, 1, Number.NaN, Number.NaN, 2, 3],
      undefined,
      "mean"
    );
    // Two known days, the unknown one a gap.
    expect(mean.y[2]).toBe(2 * 86400);
    expect(mean.covered).toBe(2 * 86400);
    expect(mean.gaps).toBe(1);
  });

  it("adds nothing for a declared cell of no length (review of interim33)", async () => {
    const { accumulate } = await import("@/ui/analysis/timeViews.ts");
    const total = accumulate(
      [0, 0.5, 1.5],
      "days since 2000-01-01",
      [5, 0, 0],
      "mm day-1",
      [0, 0, 0, 1, 1, 2],
      undefined,
      "mean"
    );
    expect(total.y[2]).toBe(0);
  });

  it("finds the step of dates stored descending (review of interim33)", async () => {
    const { stepSeconds } = await import("@/ui/analysis/timeViews.ts");
    expect(stepSeconds([4, 3, 2, 1, 0], "days since 2000-01-01")).toBe(86400);
  });

  it("integrates a 360-day axis in microseconds as in seconds", async () => {
    const { accumulate } = await import("@/ui/analysis/timeViews.ts");
    const us = accumulate(
      [1e6, 3e6, 5e6],
      "microseconds since 2001-02-30",
      [5, 5, 5],
      "kg m-2 s-1",
      [0, 2e6, 2e6, 4e6, 4e6, 6e6],
      undefined,
      "mean"
    );
    expect(us.rate).toBe(true);
    expect(us.y).toEqual([10, 20, 30]);
  });
});

describe("review of interim30: return levels follow the cells, not the stamps", () => {
  it("gives the same curve for days stamped at noon or at the next midnight", async () => {
    const { reshapedSpec } = await import("@/ui/analysis/seriesViews.ts");
    const { TIME_VIEWS } = await import("@/ui/analysis/timeViews.ts");
    const jan1 = [0, 365, 730, 1095, 1461, 1826]; // 2001-01-01 onward
    const days = jan1[5];
    const lows = Array.from({ length: days }, (_, d) => d);
    const values = lows.map((d) => {
      const year = jan1.findIndex((j, k) => d >= j && d < jan1[k + 1]);
      return d === jan1[year + 1] - 1 ? 10 * (year + 1) : 0;
    });
    const dateOf = (day: number) =>
      new Date(Date.UTC(2001, 0, 1) + day * 86_400_000)
        .toISOString()
        .replace("T", " ")
        .slice(0, 19);
    const curve = (offset: number) => {
      const raw = lows.map((d) => d + offset);
      const spec = reshapedSpec(
        TIME_VIEWS.RETURN,
        {
          y: values,
          x: raw,
          yTitle: "Rain (mm)",
          readout: () => [],
        } as never,
        {
          dates: raw.map(dateOf),
          raw,
          bounds: lows.flatMap((d) => [d, d + 1]),
          timeUnits: "days since 2001-01-01",
          calendar: "standard",
          cellMethods: "time: sum",
          units: "mm",
          window: 3,
          threshold: 0,
          values,
        }
      ) as { y: number[]; points?: { y: number[] } };
      return spec;
    };
    const noon = curve(0.5);
    const midnight = curve(1);
    expect(noon.points?.y.slice().sort((a, b) => a - b)).toEqual([
      10, 20, 30, 40, 50,
    ]);
    expect(midnight.y).toEqual(noon.y);
    expect(midnight.points?.y).toEqual(noon.points?.y);
  });
});
