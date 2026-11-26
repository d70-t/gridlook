import { expect, it } from "vitest";

import { timeLabels } from "@/lib/analysis/calendar.ts";
import { vectorMethodProblem } from "@/lib/analysis/cellMethods.ts";
import {
  levelStatisticsOverRows,
  verticalStatistics,
} from "@/lib/analysis/verticalStats.ts";
import {
  maximaYears,
  periodDates,
  reshapeViews,
  reshapedSpec,
} from "@/ui/analysis/seriesViews.ts";
import {
  diurnalCycle,
  runningMeanOverCells,
  spectrum,
  TIME_VIEWS,
} from "@/ui/analysis/timeViews.ts";

type TCell = [number, number, number];

function ctx(
  cells: TCell[],
  method = "mean",
  units = "days since 2001-01-01",
  calendar = "360_day"
) {
  const raw = cells.map(([a, b]) => (a + b) / 2);
  return {
    raw,
    dates: timeLabels({ raw, units, calendar }),
    values: cells.map((c) => c[2]),
    bounds: cells.flatMap((c) => c.slice(0, 2)),
    timeUnits: units,
    calendar,
    cellMethods: `time: ${method}`,
    units: "K",
    threshold: 0,
    window: 3,
  };
}

function spec(view: string, c: ReturnType<typeof ctx>) {
  const base = {
    mode: "time",
    x: c.raw,
    y: c.values,
    xTitle: "Date",
    yTitle: "T",
    xLabel: String,
    readout: () => [],
  };
  return reshapedSpec(view as never, base as never, c as never) as never as {
    x: number[];
    y: number[];
    overlay?: { values: number[] };
    readout: (at: number) => string[];
  };
}

/** The running mean of `n` cells at the cell centred on `centre`. */
function windowMean(cells: TCell[], centre: number, n: number) {
  const c = { ...ctx(cells), window: n };
  return spec(TIME_VIEWS.RUNNING, c).overlay!.values[c.raw.indexOf(centre)];
}

it("nested means: a known finer day stays, conflicts are withheld, every depth resolves", () => {
  const before: TCell[] = [
    [-3, -2, 20],
    [-2, -1, 20],
    [-1, 0, 20],
    [0, 1, 10],
    [2, 3, 30],
    [3, 4, 30],
    [4, 5, 30],
  ];
  // The first day observed, a two-day mean over it and the next.
  expect(windowMean(before, 0.5, 1)).toBe(10);
  expect(windowMean([...before, [0, 2, 20]], 0.5, 1)).toBe(10);
  const daily: TCell[] = [
    [0, 1, 10],
    [1, 2, 20],
    [2, 3, 30],
    [3, 4, 40],
    [4, 5, 50],
  ];
  expect(windowMean(daily, 1.5, 3)).toBe(20);
  // An exact repeat counts once; another value for the same day: unknown.
  expect(windowMean([...daily, [0, 1, 10]], 1.5, 3)).toBe(20);
  expect(windowMean([...daily, [0, 1, 50]], 1.5, 3)).toBeNaN();
  // Days, two-day and four-day means that agree: the days.
  expect(windowMean([...daily, [0, 2, 15], [0, 4, 25]], 1.5, 3)).toBe(20);
  // One that disagrees with its days: withheld.
  expect(windowMean([...daily, [0, 2, 99]], 1.5, 3)).toBeNaN();
});

it("one wide mean over 150,000 finer ones neither overflows nor changes them", () => {
  const n = 150_000;
  const raw = Array.from({ length: n }, (_, i) => i + 0.5);
  const bounds = raw.flatMap((v) => [v - 0.5, v + 0.5]);
  const values = raw.map(() => 10);
  const out = runningMeanOverCells(
    [...values, 10],
    [...raw, n / 2],
    [...bounds, 0, n],
    3
  );
  expect(out?.[100]).toBe(10);
});

it("the spectrum is of the observed cadence, in the calendar's months", () => {
  const raw = Array.from({ length: 128 }, (_, t) => t);
  const wave = raw.map((t) => 280 + Math.cos((2 * Math.PI * t) / 8));
  const gaps = spectrum(
    wave.map((v, t) => (t % 2 === 0 ? v : Number.NaN)),
    86400
  )!;
  // No period below twice the two-day spacing of the observations.
  expect(Math.min(...gaps.period)).toBeGreaterThanOrEqual(4 * 86400);
  expect(gaps.peak).toBe(8 * 86400);
  // Eight 30-day months of a 360-day calendar: eight months.
  const months = Array.from({ length: 128 }, (_, i) => i * 30);
  const c = {
    ...ctx(months.map((t) => [t, t, 0] as TCell)),
    raw: months,
    dates: timeLabels({
      raw: months,
      units: "days since 2001-01-01",
      calendar: "360_day",
    }),
    values: months.map((_, i) => 280 + Math.cos((2 * Math.PI * i) / 8)),
    bounds: undefined,
  };
  const s = spec(TIME_VIEWS.SPECTRUM, c as never);
  const at = s.y.indexOf(Math.max(...s.y));
  expect(s.x[at]).toBeCloseTo(8, 9);
});

it("sampling intervals go with their own axes, in comparable units", () => {
  const problem = (a: string, b: string) =>
    vectorMethodProblem({ cellMethods: a }, { cellMethods: b }) ?? "accepted";
  const latLon = "lat: lon: mean (interval: 1 degree interval: 2 degree)";
  const lonLat = "lon: lat: mean (interval: 2 degree interval: 1 degree)";
  const crossed = "lon: lat: mean (interval: 1 degree interval: 2 degree)";
  expect(problem(latLon, lonLat)).toBe("accepted");
  expect(problem(latLon, crossed)).not.toBe("accepted");
  expect(
    problem(
      "time: mean (interval: 1 hour)",
      "time: mean (interval: 60 minutes)"
    )
  ).toBe("accepted");
  expect(
    problem("time: mean (interval: 1 hour)", "time: mean (interval: 2 hours)")
  ).not.toBe("accepted");
  expect(
    problem("area: mean (interval: 1 mm)", "area: mean (interval: 1 Mm)")
  ).not.toBe("accepted");
});

it("Count above counts records of one support", () => {
  const daily: TCell[] = Array.from(
    { length: 7 },
    (_, d) => [d, d + 1, d < 2 ? 300 : 280] as TCell
  );
  const count = (cells: TCell[]) => {
    const s = spec(TIME_VIEWS.COUNT, { ...ctx(cells), threshold: 290 });
    return { plotted: s.y[0], label: s.readout(0) };
  };
  expect(count(daily).plotted).toBe(2);
  const both = count([...daily, [0, 2, 300]]);
  expect(both.plotted).toBe(2);
  expect(both.label[1]).toMatch(/2 of 7 days/);
  expect(both.label[2]).toMatch(/1 record over other intervals left out/);
});

it("28-day means are a fixed-length fit, not calendar months", () => {
  const years = (width: number) => {
    const per = Math.floor(365 / width);
    const list = Array.from({ length: 6 }, (_, y) =>
      Array.from(
        { length: per },
        (_, i) =>
          [
            y * 365 + i * width,
            y * 365 + (i + 1) * width,
            i === 0 ? 10 + y : 0,
          ] as TCell
      )
    ).flat();
    const c = ctx(list, "mean", "days since 2001-01-01", "365_day");
    return {
      years: maximaYears(c as never).years.size,
      menu: reshapeViews(c as never).includes(TIME_VIEWS.RETURN),
    };
  };
  expect(years(27)).toEqual({ years: 6, menu: true });
  expect(years(28)).toEqual({ years: 6, menu: true });
});

it("a maximum with no bounds at all is of no hour of the day", () => {
  const cells: TCell[] = [
    [0, 1, 270],
    [1, 2, 271],
    [0, 24, 300],
  ];
  const c = ctx(cells, "maximum", "hours since 2001-01-01", "standard");
  const noon = (b: unknown) =>
    diurnalCycle(periodDates({ ...c, bounds: b } as never), c.values).mean[12];
  expect(noon(c.bounds)).toBeNaN();
  expect(noon(undefined)).toBeNaN();
});

it("published annual maxima are counted among the years kept", () => {
  const monthly: TCell[] = Array.from(
    { length: 7 * 12 },
    (_, m) => [30 * m, 30 * (m + 1), 270 + (m % 12)] as TCell
  );
  const c = ctx([...monthly, [0, 360, 281], [40, 42, 999]], "maximum");
  c.bounds.splice(-2, 2, Number.NaN, Number.NaN);
  const fit = maximaYears(c as never);
  expect(fit.years.has("2001")).toBe(false);
  expect(fit.years.size).toBe(6);
  expect(fit.of).not.toMatch(/published/);
});

it("mass ratios in g/kg, and a burden of a mean mixing ratio said so", () => {
  const input = {
    z: [96250, 98750],
    bounds: [95000, 97500, 97500, 100000],
    zUnits: "Pa",
  };
  const amount = (
    r: number,
    units: string,
    standardName: string,
    cellMethods = "time: mean"
  ) =>
    verticalStatistics({
      ...input,
      values: [r, r],
      units,
      standardName,
      cellMethods,
    }).find((s) => s.id === "amount");
  const kg = amount(0.02, "kg kg-1", "specific_humidity")!;
  const g = amount(20, "g kg-1", "specific_humidity")!;
  expect(g.value).toBeCloseTo(kg.value, 12);
  const mixing = amount(0.02, "kg kg-1", "humidity_mixing_ratio")!;
  expect(mixing.method).toMatch(/burden of that mean state/);
  const instant = amount(
    0.02,
    "kg kg-1",
    "humidity_mixing_ratio",
    "time: point"
  )!;
  expect(instant.method).not.toMatch(/mean state/);
});

it("the isotherm menu sees every date, and stops once all its kind can have are found", () => {
  const z = {
    z: [0, 10, 100],
    zUnits: "m",
    positive: "down" as const,
    units: "degC",
    standardName: "sea_water_temperature",
  };
  const temperature = Array.from({ length: 2049 }, (_, i) =>
    i % 2 === 0 ? [30, 30, 25] : [21, 21, 19]
  ).flat();
  const offered = levelStatisticsOverRows(2049, 3, temperature, z).some(
    (s) => s.id === "z20"
  );
  expect(offered).toBe(true);
  // A tracer: its two level diagnostics found on the first date.
  let reads = 0;
  const values = new Proxy(
    new Array(512 * 96).fill(1).map((_, i) => i % 7),
    {
      get(target, key, receiver) {
        if (typeof key === "string" && /^\d+$/.test(key)) {
          reads++;
        }
        return Reflect.get(target, key, receiver);
      },
    }
  );
  const tracer = {
    z: Array.from({ length: 96 }, (_, k) => k * 10),
    zUnits: "m",
    positive: "down" as const,
    units: "mol m-3",
    standardName: "mole_concentration_of_nitrate_in_sea_water",
  };
  const ids = levelStatisticsOverRows(512, 96, values, tracer).map((s) => s.id);
  expect(ids.sort()).toEqual(["max-level", "min-level"]);
  expect(reads).toBeLessThanOrEqual(96);
});
