import { expect, it } from "vitest";

import { timeLabels } from "@/lib/analysis/calendar.ts";
import { verticalStatistics } from "@/lib/analysis/verticalStats.ts";
import {
  maximaYears,
  periodDates,
  reshapeViews,
  reshapedSpec,
} from "@/ui/analysis/seriesViews.ts";
import { annualCycle, TIME_VIEWS } from "@/ui/analysis/timeViews.ts";

const day = 86400000;
const origin = Date.UTC(2001, 0, 1);
const firstDay = (year: number) => (Date.UTC(year, 0, 1) - origin) / day;
const date = (t: number) =>
  new Date(origin + t * day).toISOString().slice(0, 10);
const page = (x: number[], y: number[]) => ({
  mode: "time" as const,
  x,
  y,
  xTitle: "Time",
  yTitle: "Value",
  xLabel: String,
  readout: () => [],
});
const context = (raw: number[], values: number[]) => ({
  dates: raw.map(date),
  raw,
  values,
  timeUnits: "days since 2001-01-01",
  units: "K",
  window: 3,
  threshold: 0,
});

it("withholds a return-level fit from 12 January points a year regardless of their nominal cells", () => {
  const raw: number[] = [],
    bounds: number[] = [],
    values: number[] = [];
  for (let year = 2001; year <= 2005; year++) {
    for (let d = 1; d <= 12; d++) {
      raw.push(firstDay(year) + d);
      // Each stamp falls within its nominal interval. Point values do not
      // measure other days in that interval.
      bounds.push(firstDay(year), firstDay(year + 1) - d);
      values.push(280 + d + year - 2001);
    }
  }
  const ctx = { ...context(raw, values), cellMethods: "time: point" };
  expect(maximaYears(ctx).years.size).toBe(0);
  expect(
    reshapedSpec(TIME_VIEWS.RETURN, page(raw, values), { ...ctx, bounds })?.mode
  ).not.toBe("cycle");
});

it("keeps the elapsed integral of instantaneous rates available if their nominal bounds are unreadable", () => {
  const raw = [0, 1, 2],
    values = [1, 2, 100];
  const ctx = {
    ...context(raw, values),
    units: "mm/day",
    cellMethods: "time: point",
  };
  const total = (boundsUnread?: string) =>
    reshapedSpec(TIME_VIEWS.CUMULATIVE, page(raw, values), {
      ...ctx,
      boundsUnread,
    })?.y;
  expect(total()).toEqual([0, 1, 3]);
  expect(total("Declared time bounds cannot be read")).toEqual([0, 1, 3]);
});

it("withholds a temporal spectrum when 32 stored rows repeatedly sample just two dates", () => {
  const raw = Array.from({ length: 32 }, (_, i) => i % 2);
  const values = raw.map((t) => (t ? 290 : 280));
  const ctx = context(raw, values);
  expect(reshapeViews(ctx)).not.toContain(TIME_VIEWS.SPECTRUM);
});

it("computes a long concentration column without exhausting the JavaScript argument stack", () => {
  const z = Array.from({ length: 100_000 }, (_, k) => k / 100);
  const column = { z, values: z.map(() => 1), zUnits: "m", units: "kg m-3" };
  const stats = verticalStatistics(column);
  expect(stats.find((stat) => stat.id === "amount")?.value).toBeCloseTo(999.99);
});

it("withholds a below-mixed-layer thermocline when all sampled water is in the mixed layer", () => {
  const stats = verticalStatistics({
    z: [0, 10, 30, 50, 100],
    values: [20, 20, 19.98, 19.95, 19.9],
    zUnits: "m",
    units: "degC",
    positive: "down",
    standardName: "sea_water_temperature",
  });
  // The entire profile stays within 0.2 °C of its 10 m reference.
  expect(stats.find((stat) => stat.id === "mld")).toBeUndefined();
  expect(stats.find((stat) => stat.id === "thermocline")).toBeUndefined();
});

it("keeps the 1 January point maximum in its observed year when bounds end at the stamp", () => {
  const raw = Array.from({ length: firstDay(2006) }, (_, t) => t);
  const values = raw.map((t) =>
    t === firstDay(2003) ? 350 : t === firstDay(2002) + 180 ? 340 : 270
  );
  const ctx = { ...context(raw, values), cellMethods: "time: point" };
  const maxima = (bounds?: number[]) =>
    reshapedSpec(TIME_VIEWS.RETURN, page(raw, values), { ...ctx, bounds })
      ?.points?.y;
  const expected = [350, 340, 270, 270, 270];
  expect(maxima()).toEqual(expected);
  expect(maxima(raw.flatMap((t) => [t - 1, t]))).toEqual(expected);
});

it("counts distinct observation times toward the 12-value annual maximum requirement", () => {
  const raw: number[] = [];
  for (let year = 2001; year <= 2005; year++) {
    for (const offset of [90, 273]) {
      raw.push(...Array(6).fill(firstDay(year) + offset));
    }
  }
  const values = raw.map((t) => 270 + t / 365);
  const ctx = { ...context(raw, values), cellMethods: "time: point" };
  expect(reshapedSpec(TIME_VIEWS.RETURN, page(raw, values), ctx)?.mode).toBe(
    "time"
  );
});

it("withholds a return fit when the declared support of interval means cannot be read", () => {
  const raw: number[] = [];
  for (let year = 2001; year <= 2005; year++) {
    for (let month = 0; month < 12; month++) {
      raw.push((Date.UTC(year, month, 15) - origin) / day);
    }
  }
  const values = raw.map((t) => 270 + t / 365);
  const ctx = { ...context(raw, values), cellMethods: "time: mean" };
  const oneHour = raw.flatMap((t) => [t - 1 / 48, t + 1 / 48]);
  expect(reshapeViews({ ...ctx, bounds: oneHour })).not.toContain(
    TIME_VIEWS.RETURN
  );
  expect(
    reshapeViews({
      ...ctx,
      boundsUnread: "Declared time bounds cannot be read",
    })
  ).not.toContain(TIME_VIEWS.RETURN);
});

it("keeps a monthly temperature mean invariant under splitting a constant CF time cell", () => {
  const january = (bounds: number[], values: number[]) => {
    const raw = values.map((_, i) => (bounds[2 * i] + bounds[2 * i + 1]) / 2);
    const ctx = { ...context(raw, values), bounds, cellMethods: "time: mean" };
    return annualCycle(periodDates(ctx), values).mean[0];
  };
  const oneDay = Array.from({ length: 31 }, (_, i) => [i, i + 1]).flat();
  const expected = (300 + 30 * 270) / 31;
  expect(
    january(
      [...oneDay, 31, 59, 59, 90],
      [300, ...Array(30).fill(270), 280, 280]
    )
  ).toBeCloseTo(expected);
  expect(
    january([0, 1, 1, 31, 31, 59, 59, 90], [300, 270, 280, 280])
  ).toBeCloseTo(expected);
});

it("interpolates a mixed-layer crossing in temperature when the signed departure reverses", () => {
  const stats = verticalStatistics({
    z: [0, 10, 20, 30],
    values: [20, 20, 20.1, 19.7],
    zUnits: "m",
    units: "degC",
    positive: "down",
    standardName: "sea_water_temperature",
  });
  // Between 20 and 30 m the interpolated temperature first reaches 19.8 at 27.5 m.
  expect(stats.find((stat) => stat.id === "mld")?.value).toBeCloseTo(27.5);
});

it("does not draw January readings into a labelled three-day November running mean", () => {
  const raw = [0, 1, 2, 327, 328, 329];
  const values = [300, 300, 300, 270, 270, 270];
  const ctx = context(raw, values);
  const overlay = reshapedSpec(
    TIME_VIEWS.RUNNING,
    page(raw, values),
    ctx
  )?.overlay;
  expect(overlay?.label).toContain("3-day");
  // The two observed days within the centred three-day window are both 270 K.
  expect(overlay?.values[3]).toBeCloseTo(270);
});

it("can open the chart view menu for a twenty-year bounded hourly series", () => {
  const raw = Array.from({ length: 175_200 }, (_, i) => (i + 0.5) / 24);
  const values = raw.map(() => 280);
  const ctx = {
    ...context(raw, values),
    bounds: raw.flatMap((_, i) => [i / 24, (i + 1) / 24]),
    cellMethods: "time: mean",
  };
  expect(() => reshapeViews(ctx)).not.toThrow();
});

it("keeps five measured annual maxima when a later two-year cell contains only fill", () => {
  const years = [2001, 2002, 2003, 2004, 2005];
  const raw = years.map((y) => firstDay(y) + 180);
  const values = [1, 2, 3, 4, 5];
  const bounds = years.flatMap((y) => [firstDay(y), firstDay(y + 1)]);
  const fit = (times: number[], v: number[], b: number[]) =>
    reshapedSpec(TIME_VIEWS.RETURN, page(times, v), {
      ...context(times, v),
      bounds: b,
      cellMethods: "time: maximum",
    })?.points?.y;
  expect(fit(raw, values, bounds)).toEqual([5, 4, 3, 2, 1]);
  expect(
    fit(
      [...raw, firstDay(2007)],
      [...values, NaN],
      [...bounds, firstDay(2006), firstDay(2008)]
    )
  ).toEqual([5, 4, 3, 2, 1]);
});

it("fits six published annual maxima before year zero in a proleptic calendar", () => {
  const timeUnits = "days since -0006-01-01";
  const calendar = "360_day";
  const raw = Array.from({ length: 6 }, (_, k) => 360 * k + 180);
  const bounds = raw.flatMap((t) => [t - 180, t + 180]);
  const values = [1, 2, 3, 4, 5, 6];
  const ctx = {
    ...context(raw, values),
    timeUnits,
    calendar,
    bounds,
    dates: timeLabels({ raw, units: timeUnits, calendar }),
    cellMethods: "time: maximum",
  };
  expect(reshapeViews(ctx)).toContain(TIME_VIEWS.RETURN);
  expect(
    reshapedSpec(TIME_VIEWS.RETURN, page(raw, values), ctx)?.points?.y
  ).toEqual([6, 5, 4, 3, 2, 1]);
});

it("keeps known January durations when one March interval is unavailable", () => {
  const raw = [0.5, 16, 45, 75];
  const values = [300, 270, 280, 280];
  const january = (bounds: number[]) =>
    annualCycle(
      periodDates({
        ...context(raw, values),
        bounds,
        cellMethods: "time: mean",
      }),
      values
    ).mean[0];
  const jan = (300 + 270 * 30) / 31;
  expect(january([0, 1, 1, 31, 31, 59, 59, 90])).toBeCloseTo(jan);
  expect(january([0, 1, 1, 31, 31, 59, NaN, NaN])).toBeCloseTo(jan);
});

it("preserves interval-weighted seasonal means on a decreasing CF time axis", () => {
  const january = (raw: number[], values: number[], bounds: number[]) =>
    annualCycle(
      periodDates({
        ...context(raw, values),
        bounds,
        cellMethods: "time: mean",
      }),
      values
    ).mean[0];
  const ascending = january(
    [0.5, 16, 45, 75],
    [300, 270, 280, 280],
    [0, 1, 1, 31, 31, 59, 59, 90]
  );
  const descending = january(
    [75, 45, 16, 0.5],
    [280, 280, 270, 300],
    [90, 59, 59, 31, 31, 1, 1, 0]
  );
  expect(ascending).toBeCloseTo((300 + 270 * 30) / 31);
  expect(descending).toBeCloseTo(ascending);
});

it("withholds ocean heat content computed from layer maxima attained on different dates", () => {
  const column = {
    z: [175, 525],
    bounds: [0, 350, 350, 700],
    positive: "down" as const,
    zUnits: "m",
    units: "degC",
    standardName: "sea_water_temperature",
  };
  const heat = (values: number[], cellMethods: string) =>
    verticalStatistics({
      ...column,
      values,
      cellMethods,
    }).find((s) => s.id === "heat-700")?.value;
  // Each observed profile contains the same amount of heat. The layerwise maxima
  // combine warm values that never coexisted; their sum would double it.
  const first = heat([20, 0], "time: point");
  expect(first).toBeGreaterThan(0);
  expect(heat([0, 20], "time: point")).toBe(first);
  expect(heat([20, 20], "time: maximum")).toBeUndefined();
});

it("keeps cumulative precipitation invariant under equivalent per-second and per-minute units", () => {
  const raw = [0.5, 1.5, 2.5];
  const total = (units: string, value: number) => {
    const values = raw.map(() => value);
    return reshapedSpec(TIME_VIEWS.CUMULATIVE, page(raw, values), {
      ...context(raw, values),
      timeUnits: "hours since 2001-01-01",
      units,
      cellMethods: "time: mean",
      bounds: [0, 1, 1, 2, 2, 3],
    })?.y;
  };
  expect(total("mm s-1", 1 / 60)).toEqual([60, 120, 180]);
  expect(total("mm min-1", 1)).toEqual([60, 120, 180]);
});

it("final review of interim41: heat content keeps its meaning whatever group holds the field", () => {
  // Two equal layers of 280 K sea water over 0–700 m.
  const column = {
    z: [175, 525],
    bounds: [0, 350, 350, 700],
    positive: "down" as const,
    zUnits: "m",
    units: "K",
    standardName: "sea_water_temperature",
    unitsMetadata: "temperature: on_scale",
    values: [280, 280],
  };
  const heat = (name: string) =>
    verticalStatistics({ ...column, name }).find((s) => s.id === "heat-700");
  const plain = heat("thetao");
  // 1025 × 3991.87 × 700 × 6.85 J/m², relative to 0 °C.
  expect(plain?.value).toBeCloseTo(1025 * 3991.87 * 700 * 6.85, -6);
  expect(plain?.label).toBe("Heat content 0–700 m");
  // A field named in an "anomaly" group is not an anomaly when its
  // metadata says what it is.
  expect(heat("thetao anomaly_analysis")?.value).toBeCloseTo(plain!.value, 6);
});

it("final review of interim41: a temperature's standard error and a compound spread are differences", async () => {
  const { temperatureMetadata } =
    await import("@/lib/analysis/displayUnits.ts");
  const query = { variable: "tas_err" } as never;
  expect(temperatureMetadata({ query }, "air_temperature standard_error")).toBe(
    "temperature: difference"
  );
  expect(
    temperatureMetadata(
      {
        query,
        cellMethods:
          "time: standard_deviation within days time: mean over days",
      },
      "air_temperature"
    )
  ).toBe("temperature: difference");
  // An ordinary daily mean stays on its scale.
  expect(
    temperatureMetadata({ query, cellMethods: "time: mean" }, "air_temperature")
  ).toBeUndefined();
});

it("final review of interim41: a three-month running mean keeps 28-, 30- and 31-day neighbours", async () => {
  const { runningMeanInTime } = await import("@/ui/analysis/timeViews.ts");
  // Mid-month days of 2001; 30 in August, 0 elsewhere.
  const starts = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334, 365];
  const raw = starts.slice(0, 12).map((s, k) => (s + starts[k + 1]) / 2);
  const values = raw.map((_, k) => (k === 7 ? 30 : 0));
  const mean = runningMeanInTime(values, raw, 3);
  // July, August and September each average three months.
  expect([mean[6], mean[7], mean[8]]).toEqual([10, 10, 10]);
  expect(mean[5]).toBe(0);
  // A gap of two months still breaks the window (30-day steps).
  const gap = runningMeanInTime([0, 0, 30, 0], [15, 45, 75, 165], 3);
  expect(gap[3]).toBeNaN();
});

it("final review of interim41: only an air temperature gets a tropopause", () => {
  const column = {
    z: [4000, 5000, 6000, 7000],
    positive: "up" as const,
    zUnits: "m",
    units: "K",
    values: [275, 266, 266, 266],
  };
  const tropopause = (standardName: string) =>
    verticalStatistics({ ...column, standardName }).find(
      (s) => s.id === "tropopause"
    )?.value;
  expect(tropopause("air_temperature")).toBe(5000);
  expect(tropopause("soil_temperature")).toBeUndefined();
  expect(tropopause("land_ice_temperature")).toBeUndefined();
});

it("independent review of interim41: one event in a rolling maximum is no annual maximum of two years", () => {
  // Daily 1 mm in 2001–2006, 100 mm on 1 January 2004; published as
  // 30-day maxima centred on every day.
  const days = firstDay(2007);
  const daily = Array.from({ length: days }, (_, t) =>
    t === firstDay(2004) ? 100 : 1
  );
  const raw = daily.map((_, t) => t + 0.5);
  const bounds = raw.flatMap((t) => [t - 15, t + 15]);
  const values = raw.map((t) =>
    Math.max(...daily.slice(Math.max(0, Math.floor(t - 15)), Math.ceil(t + 15)))
  );
  const ctx = {
    ...context(raw, values),
    units: "mm",
    bounds,
    cellMethods: "time: maximum",
  };
  const maxima = reshapedSpec(TIME_VIEWS.RETURN, page(raw, values), ctx)?.points
    ?.y;
  // 2003 could hold the event too: withheld, the event counted once.
  expect(maxima).toEqual([100, 1, 1, 1, 1]);
  // The windows are 30 days, not calendar months.
  expect(maximaYears(ctx).of).toMatch(/30-day maxima/);
});

it("independent review of interim41: overlapping layers give the column's mean only when one covers it", () => {
  const column = {
    z: [175, 350],
    positive: "down" as const,
    zUnits: "m",
    units: "degC",
    standardName: "sea_water_temperature",
    cellMethods: "depth: mean",
  };
  const mean = (values: number[], bounds: number[]) =>
    verticalStatistics({ ...column, values, bounds }).find(
      (s) => s.id === "mean"
    )?.value;
  // 0 °C over 0–350 m and 1 °C over all of 0–700 m: the column is 1 °C.
  expect(mean([0, 1], [0, 350, 0, 700])).toBe(1);
  // Two disjoint equal layers at 0 and 2 °C: 1 °C, as before.
  expect(mean([0, 2], [0, 350, 350, 700])).toBe(1);
  // Overlapping, none over the whole column: no mean.
  expect(mean([0, 2], [0, 400, 300, 700])).toBeUndefined();
});

it("final review of interim41: a regular series stored with two dates swapped keeps its spectrum", () => {
  const raw = Array.from({ length: 32 }, (_, k) => k);
  const values = raw.map((t) => Math.sin((2 * Math.PI * t) / 8));
  const swapped = [raw[1], raw[0], ...raw.slice(2)];
  const swappedValues = [values[1], values[0], ...values.slice(2)];
  const peak = (r: number[], v: number[]) => {
    const ctx = { ...context(r, v), units: "K" };
    expect(reshapeViews(ctx)).toContain(TIME_VIEWS.SPECTRUM);
    const spec = reshapedSpec(TIME_VIEWS.SPECTRUM, page(r, v), ctx)!;
    return spec.x[spec.y.indexOf(Math.max(...spec.y))];
  };
  expect(peak(swapped, swappedValues)).toBe(peak(raw, values));
  expect(peak(raw, values)).toBeCloseTo(8, 6);
});

it("independent review of interim41: a mean over a month's end gives each month its own share", () => {
  // Days of January and February 2001: 31 K on 31 Jan and 1 Feb, else 0.
  const cycle = (raw: number[], values: number[], bounds: number[]): number[] =>
    annualCycle(
      periodDates({
        ...context(raw, values),
        bounds,
        cellMethods: "time: mean",
      }),
      values
    ).mean.slice(0, 2);
  const daily = Array.from({ length: 59 }, (_, d) => d);
  const dailyValues = daily.map((d) => (d === 30 || d === 31 ? 31 : 0));
  const asDays = cycle(
    daily.map((d) => d + 0.5),
    dailyValues,
    daily.flatMap((d) => [d, d + 1])
  );
  // The same data with 31 Jan and 1 Feb stored as one two-day mean.
  const merged = daily.filter((d) => d !== 31);
  const asCell = cycle(
    merged.map((d) => (d === 30 ? 31 : d + 0.5)),
    merged.map((d) => (d === 30 ? 31 : 0)),
    merged.flatMap((d) => (d === 30 ? [30, 32] : [d, d + 1]))
  );
  expect(asDays[0]).toBeCloseTo(1, 9);
  expect(asDays[1]).toBeCloseTo(31 / 28, 9);
  expect(asCell[0]).toBeCloseTo(asDays[0], 9);
  expect(asCell[1]).toBeCloseTo(asDays[1], 9);
});
