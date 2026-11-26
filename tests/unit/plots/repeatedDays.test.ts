import { expect, it } from "vitest";

import { timeLabels } from "@/lib/analysis/calendar.ts";
import {
  maximaYears,
  periodDates,
  type TSeriesContext,
} from "@/ui/analysis/seriesViews.ts";
import {
  monthlyBoxes,
  returnLevels,
  runningMeanOverCells,
  spectrum,
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

it("interim49: a repeated day counts once, and a consistent wider mean beside its days keeps the mean", () => {
  const days = [0, 1, 2].map((d) => d + 0.5);
  const bounds = days.flatMap((t) => [t - 0.5, t + 0.5]);
  const plain = runningMeanOverCells([10, 20, 30], days, bounds, 3)!;
  expect(plain[1]).toBe(20);
  const repeated = runningMeanOverCells(
    [10, 10, 20, 30],
    [0.5, 0.5, 1.5, 2.5],
    [0, 1, 0, 1, 1, 2, 2, 3],
    3
  )!;
  expect(repeated[2]).toBe(20);
  // A two-day mean of 0 over days of 0 and 0, beside a 90: 30, not 18.
  const nested = runningMeanOverCells(
    [0, 0, 90, 0],
    // Stamped at a day's centre, so the step stays one day.
    [0.5, 1.5, 2.5, 2.5],
    [0, 1, 1, 2, 2, 3, 0, 2],
    3
  )!;
  expect(nested[1]).toBe(30);
  // A partly overlapping half day is ambiguous: withheld, not blended.
  const partial = runningMeanOverCells(
    [10, 20, 30, 40],
    [0.5, 1.5, 2.5, 1.25],
    [0, 1, 1, 2, 2, 3, 0.75, 1.25],
    3
  )!;
  expect(partial[1]).toBeNaN();
});

it("interim49: a missing value over the whole axis leaves the running work linear", () => {
  const n = 1000;
  const raw = Array.from({ length: n }, (_, i) => i + 0.5);
  const bounds = raw.flatMap((t) => [t - 0.5, t + 0.5]);
  bounds[0] = 0;
  bounds[1] = n;
  let reads = 0;
  const values = new Proxy(
    Array.from({ length: n }, (_, i) => (i === 0 ? Number.NaN : 1)),
    {
      get(list, key) {
        if (typeof key === "string" && /^\d+$/.test(key)) {
          reads++;
        }
        return Reflect.get(list, key);
      },
    }
  );
  const out = runningMeanOverCells(values, raw, bounds, 3)!;
  expect(out[n / 2]).toBe(1);
  expect(reads).toBeLessThan(4 * n);
});

it("interim49: a linear series with regular gaps has no spectral peak", () => {
  const line = Array.from({ length: 64 }, (_, i) =>
    i % 4 === 3 ? Number.NaN : 280 + 0.125 * i
  );
  expect(spectrum(line, 86400)).toBeUndefined();
  const wave = Array.from({ length: 64 }, (_, i) =>
    i % 4 === 3 ? Number.NaN : 280 + 0.125 * i + Math.sin((2 * Math.PI * i) / 8)
  );
  expect(spectrum(wave, 86400)?.peak).toBe(8 * 86400);
});

it("interim49: fits 150,000 annual values without overflowing the stack", () => {
  const n = 150_000;
  const dates = Array.from(
    { length: n },
    (_, i) => `${String(1000 + i).padStart(6, "0")}-07-01`
  );
  const values = dates.map((_, i) => 280 + (i % 8));
  expect(() => returnLevels(dates, values)).not.toThrow();
});

it("interim49: quarterly means are no samples of their midpoint months", () => {
  const ctx = context([
    [0, 90, 100],
    [90, 180, 2],
    [180, 270, 3],
    [270, 360, 4],
  ]);
  const boxes = monthlyBoxes(periodDates(ctx), ctx.values);
  expect(boxes.every((b) => !b || !Number.isFinite(b.median))).toBe(true);
});

it("interim49: a fit mixing published and computed annual maxima says so", () => {
  const months = Array.from({ length: 6 * 12 }, (_, i): Cell => [
    i * 30,
    (i + 1) * 30,
    270 + (i % 12),
  ]);
  const annual: Cell[] = [
    [0, 360, 281],
    [360, 720, 281],
  ];
  const ctx = context([...months, ...annual], "maximum");
  const { of } = maximaYears(ctx) as { of: string };
  expect(of).toMatch(/published for 2 of 6 years/);
});

it("interim49: column integrals read every SI prefix and the standard name first", async () => {
  const { verticalStatistics } =
    await import("@/lib/analysis/verticalStats.ts");
  const column = (units: string) => ({
    z: [250, 750],
    bounds: [0, 500, 500, 1000],
    zUnits: "m",
    values: [1, 1],
    units,
  });
  const amount = (extra: Record<string, unknown>) =>
    verticalStatistics({ ...column("1"), ...extra } as never).find(
      (x) => x.id === "amount"
    );
  const of = (units: string) =>
    verticalStatistics(column(units) as never).find((x) => x.id === "amount");
  expect(of("fm-3")).toMatchObject({ units: "m-2" });
  expect(of("fm-3")!.value).toBeCloseTo(1e48, -40);
  expect(of("Mm-3")!.value).toBeCloseTo(1e-15, 25);
  expect(of("kg m-3")).toMatchObject({ units: "kg m-2", value: 1000 });
  const pressure = {
    z: [96250, 98750],
    bounds: [95000, 97500, 97500, 100000],
    zUnits: "Pa",
    values: [1e-5, 1e-5],
    units: "1",
  };
  const mass = (extra: Record<string, unknown>) =>
    verticalStatistics({ ...pressure, ...extra } as never).find(
      (x) => x.id === "amount"
    );
  expect(mass({ name: "ozone_volume_mixing_ratio" })).toBeUndefined();
  const q = {
    standardName: "specific_humidity",
    units: "kg kg-1",
    values: [0.02, 0.02],
  };
  expect(mass({ ...q, name: "mr" })!.value).toBe(
    mass({ ...q, name: "q" })!.value
  );
  void amount;
});

it("interim49: an isotherm one date crosses is offered over time though the mean does not cross it", async () => {
  const { levelStatisticsOverRows } =
    await import("@/lib/analysis/verticalStats.ts");
  const column = {
    z: [0, 10, 100],
    zUnits: "m",
    positive: "down" as const,
    units: "degC",
    standardName: "sea_water_temperature",
  };
  const temps = [21, 21, 19, 30, 30, 25];
  const ids = levelStatisticsOverRows(2, 3, temps, column).map((s) => s.id);
  expect(ids).toContain("z20");
});
