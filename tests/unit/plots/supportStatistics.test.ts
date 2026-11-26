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
  reshapedSpec,
} from "@/ui/analysis/seriesViews.ts";
import {
  diurnalCycle,
  runningMeanOverCells,
  spectrum,
  TIME_VIEWS,
} from "@/ui/analysis/timeViews.ts";

type TCell = [number, number, number];

function context(
  cells: TCell[],
  units = "days since 2001-01-01",
  calendar = "365_day",
  method = "time: mean"
) {
  const raw = cells.map(([a, b]) => (a + b) / 2);
  return {
    raw,
    dates: timeLabels({ raw, units, calendar }),
    timeUnits: units,
    calendar,
    bounds: cells.flatMap((c) => c.slice(0, 2)),
    values: cells.map((c) => c[2]),
    cellMethods: method,
    units: "K",
    threshold: 290,
    window: 1,
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function plot(c: ReturnType<typeof context>, view: string): any {
  const base = {
    mode: "time",
    x: c.raw,
    y: c.values,
    xTitle: "date",
    yTitle: "temperature",
    xLabel: String,
    readout: () => [],
  };
  return reshapedSpec(view as never, base as never, c as never);
}

it("withholds a one-day mean the aggregate leaves underdetermined", () => {
  const daily: TCell[] = Array.from({ length: 7 }, (_, i) => [
    i,
    i + 1,
    i === 2 || i === 4 ? NaN : i === 3 ? 280 : 290,
  ]);
  const p = plot(context([...daily, [2, 5, 290]]), TIME_VIEWS.RUNNING);
  // Only the two missing days' sum is known: neither day is.
  expect(p.overlay.values[2]).toBeNaN();
  expect(p.overlay.values[3]).toBe(280);
  expect(p.overlay.values[4]).toBeNaN();
});

it("counts each calendar month and each day of support once", () => {
  const read = (cells: TCell[]) => {
    const p = plot(context(cells), TIME_VIEWS.COUNT);
    return { n: p.y[0], label: String(p.readout(0)) };
  };
  let end = 0;
  const months: TCell[] = [31, 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31].map(
    (span) => {
      const begin = end;
      end += span;
      return [begin, end, 300];
    }
  );
  const daily: TCell[] = Array.from({ length: 7 }, (_, i) => [
    i,
    i + 1,
    i < 2 ? 300 : 280,
  ]);
  expect(read(months).n).toBe(12);
  expect(read([...daily, daily[0]]).n).toBe(2);
  const empty = Array.from(
    { length: 8 },
    (_, i) => [i / 2, (i + 1) / 2, NaN] as TCell
  );
  expect(read([...daily, ...empty]).n).toBe(2);
});

it("keeps 31-day means out of a 28-day return-level fit", () => {
  const b: TCell[] = Array.from({ length: 6 }, (_, y) =>
    Array.from(
      { length: 13 },
      (_, i) =>
        [
          y * 365 + i * 28,
          y * 365 + (i + 1) * 28,
          i === 0 ? 281 + y : 280,
        ] as TCell
    )
  ).flat();
  const longer: TCell[] = Array.from({ length: 6 }, (_, y) => [
    y * 365,
    y * 365 + 31,
    290 + y,
  ]);
  const fit = (cells: TCell[]) => {
    const p = plot(context(cells), TIME_VIEWS.RETURN);
    return { fit: p.y.at(-1), of: maximaYears(context(cells)).of };
  };
  const control = fit(b);
  const mixed = fit([...b, ...longer]);
  expect(mixed.fit).toBeCloseTo(control.fit, 9);
});

it("does not let missing-only ends or one off-lattice value shape a spectrum", () => {
  const signal = Array.from(
    { length: 16 },
    (_, t) => 280 + Math.cos((2 * Math.PI * t) / 8)
  );
  const plain = spectrum(signal, 86400)!;
  const padded = spectrum([...signal, ...Array(112).fill(NaN)], 86400)!;
  expect(padded.peak).toBeCloseTo(plain.peak, 6);
  expect(padded.period[0]).toBe(plain.period[0]);
  const n = 128;
  const full = Array.from(
    { length: n },
    (_, i) => 280 + Math.cos((i * 2 * Math.PI) / 8)
  );
  const extra = spectrum(
    full.map((v, i) => (i % 2 === 0 || i === 3 ? v : NaN)),
    86400
  )!;
  const short = extra.share.reduce(
    (s, p, i) => s + (extra.period[i] < 4 * 86400 ? p : 0),
    0
  );
  expect(short).toBeLessThan(1);
});

it("runs nested since-origin means in bounded work, tolerant of float32 rounding", () => {
  const nested = (n: number) => {
    const raw = Array.from({ length: n }, (_, i) => i + 1);
    return runningMeanOverCells(
      raw.map(() => 280),
      raw,
      raw.flatMap((t) => [0, t]),
      3
    );
  };
  expect(nested(5500)!.at(-5)).toBe(280);
  const started = performance.now();
  nested(3000);
  expect(performance.now() - started).toBeLessThan(2000);
  const a = Math.fround(280.01);
  const b = Math.fround(280.02);
  const p = Math.fround((a + b) / 2);
  const cells: TCell[] = [
    [0, 1, a],
    [1, 2, b],
    [2, 3, 280],
    [3, 4, 280],
    [4, 5, 280],
    [0, 2, p],
  ];
  const c = { ...context(cells), window: 3 };
  expect(Number.isFinite(plot(c, TIME_VIEWS.RUNNING).overlay.values[1])).toBe(
    true
  );
});

it("classifies undated-support extremes by their own method on a shared label array", () => {
  const c = context(
    [
      [0, 1, 280],
      [1, 2, 281],
      [12, 13, 300],
    ],
    "hours since 2001-01-01",
    "standard",
    "time: point"
  );
  const noon = (methods: string[]) =>
    methods.map(
      (method) =>
        diurnalCycle(
          periodDates({
            ...c,
            bounds: undefined,
            cellMethods: method,
          } as never),
          c.values.slice()
        ).mean[12]
    );
  const [pointsFirst, extremesFirst] = [
    noon(["time: point", "time: maximum"]),
    noon(["time: maximum", "time: point"]),
  ];
  // Points at noon are hourly readings; undated maxima are not placed.
  expect(pointsFirst).toEqual([300, NaN]);
  expect(extremesFirst).toEqual([NaN, 300]);
});

it("finds a cold section's missing isotherm without diagnosing every profile", () => {
  const nk = 96;
  const z = Array.from({ length: nk }, (_, i) => i * 10 + 5);
  const c = {
    z,
    zUnits: "m",
    positive: "down" as const,
    units: "degC",
    standardName: "sea_water_temperature",
    bounds: z.flatMap((v) => [v - 5, v + 5]),
  };
  const vals = Float64Array.from(
    { length: 4096 * nk },
    (_, i) => 9 - 0.05 * (i % nk)
  );
  // Each profile has its other diagnostics at once; only the isotherm,
  // which none has, would make every profile be diagnosed.
  levelStatisticsOverRows(4096, nk, vals, c);
  const started = performance.now();
  const ids = levelStatisticsOverRows(4096, nk, vals, c).map((x) => x.id);
  expect(ids).not.toContain("z20");
  expect(performance.now() - started).toBeLessThan(40);
});

it("qualifies a mean state's burden on every reduction axis, not comment words", () => {
  const base = {
    z: [96250, 98750],
    bounds: [95000, 97500, 97500, 100000],
    zUnits: "Pa",
    units: "g kg-1",
    standardName: "humidity_mixing_ratio",
  };
  const of = (cellMethods: string) =>
    verticalStatistics({ ...base, values: [20, 20], cellMethods }).find(
      (x) => x.id === "amount"
    )!;
  for (const method of [
    "time: mean",
    "t: mean",
    "area: mean",
    "realization: mean",
  ]) {
    expect(of(method).method).toMatch(/burden of that mean state/);
  }
  const text = vectorMethodProblem(
    {
      cellMethods:
        "time: mean (interval: 1 hour comment: gap handling uses interval: 1 day only to flag gaps)",
    },
    { cellMethods: "time: mean (interval: 60 minutes)" }
  );
  expect(text).toBeUndefined();
});
