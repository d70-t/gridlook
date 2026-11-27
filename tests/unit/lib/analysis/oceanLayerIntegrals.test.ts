import { expect, it } from "vitest";

import { verticalStatistics } from "@/lib/analysis/verticalStats.ts";
import { reshapedSpec } from "@/ui/analysis/seriesViews.ts";
import {
  accumulate,
  runningMeanInTime,
  TIME_VIEWS,
} from "@/ui/analysis/timeViews.ts";

const ocean = {
  zUnits: "m",
  positive: "down" as const,
  units: "degC",
  standardName: "sea_water_potential_temperature",
};
const timeUnits = "days since 2001-01-01";

it("integrates adjacent published ocean layers over their actual thickness", () => {
  const stats = verticalStatistics({
    ...ocean,
    z: [100, 450],
    bounds: [0, 200, 200, 700],
    values: [12, 8],
  });
  const heat = stats.find((s) => s.id === "heat-700");
  expect(heat?.units).toBe("J m-2");
  expect(heat?.value).toBeCloseTo(1025 * 3991.87 * (200 * 12 + 500 * 8), 0);
});

it("withholds 0–700 m heat when the shallowest unbounded sample is at 400 m", () => {
  const stats = verticalStatistics({
    ...ocean,
    z: [400, 700],
    values: [10, 10],
  });
  expect(stats.find((s) => s.id === "heat-700")).toBeUndefined();
});

it("does not add rainfall amounts that share an accumulation start", () => {
  // The three-day cell includes both earlier cells, so the last total is 3 mm.
  const total = accumulate(
    [1, 2, 3],
    timeUnits,
    [1, 2, 3],
    "mm",
    [0, 1, 0, 2, 0, 3],
    undefined,
    "sum"
  );
  if (total.withheld) {
    expect(total.y.every((value) => !Number.isFinite(value))).toBe(true);
  } else {
    expect(total.y.at(-1)).toBe(3);
  }
});

it("withholds the 100-year return level when only one day per year has data", () => {
  const start = Date.UTC(2001, 0, 1);
  const msPerDay = 86_400_000;
  const days = (Date.UTC(2006, 0, 1) - start) / msPerDay;
  const raw = Array.from({ length: days }, (_, day) => day);
  const dates = raw.map((day) =>
    new Date(start + day * msPerDay).toISOString().slice(0, 10)
  );
  const values = dates.map((date) =>
    date.endsWith("-01-01") ? Number(date.slice(0, 4)) - 2000 : Number.NaN
  );
  const chart = reshapedSpec(
    TIME_VIEWS.RETURN,
    {
      mode: "time",
      x: raw,
      y: values,
      xTitle: "Date",
      yTitle: "Rainfall (mm)",
      readout: () => [],
    },
    {
      raw,
      dates,
      timeUnits,
      bounds: raw.flatMap((day) => [day, day + 1]),
      units: "mm",
      cellMethods: "time: maximum",
      threshold: 0,
      window: 3,
    }
  );
  // Without a fit the chart can retain the original daily time axis.
  const level =
    chart?.mode === "cycle" ? chart.y[chart.x.indexOf(100)] : undefined;
  expect(level).not.toSatisfy(Number.isFinite);
});

it("reviews of interim26: heat content needs 0–700 m observed, once", () => {
  const heat = (z: number[], values: number[], bounds?: number[]) =>
    verticalStatistics({ ...ocean, z, values, bounds }).find(
      (s) => s.id === "heat-700"
    );
  // Bounded layers, the middle one missing: 40 of 700 m observed.
  expect(
    heat([10, 350, 690], [10, Number.NaN, 10], [0, 20, 20, 680, 680, 700])
  ).toBeUndefined();
  // Overlapping layers [0, 400] and [300, 700].
  expect(heat([200, 500], [10, 10], [0, 400, 300, 700])).toBeUndefined();
  // The full column, bounded: integrated once.
  expect(heat([200, 500], [10, 10], [0, 400, 400, 700])?.value).toBeCloseTo(
    1025 * 3991.87 * 700 * 10,
    -3
  );
  // Model levels from 5 m: the stated surface extension.
  const levels = [5, 100, 300, 500, 700];
  expect(
    heat(
      levels,
      levels.map(() => 10)
    )?.value
  ).toBeCloseTo(1025 * 3991.87 * 700 * 10, -3);
});

it("reviews of interim26: a column amount only for a mass fraction", () => {
  const amount = (standardName: string, units: string) =>
    verticalStatistics({
      z: [1000, 800, 600],
      zUnits: "hPa",
      values: [0.5, 0.5, 0.5],
      units,
      standardName,
    }).find((s) => s.id === "amount");
  expect(amount("relative_humidity", "1")).toBeUndefined();
  expect(amount("mole_fraction_of_carbon_dioxide_in_air", "1")).toBeUndefined();
  expect(amount("specific_humidity", "1")?.units).toBe("kg m-2");
  expect(amount("specific_humidity", "kg kg-1")?.units).toBe("kg m-2");
});

it("reviews of interim26: a tropopause needs 2 km of profile above it", () => {
  const air = (z: number[], values: number[]) =>
    verticalStatistics({
      z,
      zUnits: "m",
      positive: "up",
      values,
      units: "K",
      standardName: "air_temperature",
    }).find((s) => s.id === "tropopause");
  expect(air([5000, 5100], [220, 220])).toBeUndefined();
  expect(air([5000, 6000, 7000, 8000], [220, 220, 220, 220])?.value).toBe(5000);
});

it("reviews of interim26: soil temperatures get no ocean diagnostics", () => {
  const stats = verticalStatistics({
    z: [0, 10, 20, 40],
    zUnits: "m",
    positive: "down",
    values: [25, 22, 18, 15],
    units: "degC",
    standardName: "soil_temperature",
  });
  expect(stats.map((s) => s.id)).not.toContain("mld");
  expect(stats.map((s) => s.id)).not.toContain("z20");
  expect(stats.map((s) => s.id)).toContain("mean");
});

it("reviews of interim26: totals and means in time, whatever the encoding", () => {
  // 1 W m-2 daily means on three contiguous days, the last missing:
  // 172,800 s covered, 86,400 s missing, the same in seconds or ms.
  for (const [units, scale] of [
    ["days since 2001-01-01", 1],
    ["seconds since 2001-01-01", 86400],
    ["milliseconds since 2001-01-01", 86400000],
  ] as const) {
    const total = accumulate(
      [0.5, 1.5, 2.5].map((d) => d * scale),
      units,
      [1, 1, Number.NaN],
      "W m-2",
      [0, 1, 1, 2, 2, 3].map((d) => d * scale),
      undefined,
      "mean"
    );
    expect(total.units).toBe("J m-2");
    expect(total.y.slice(0, 2)).toEqual([86400, 172800]);
    expect(total.covered).toBe(172800);
    expect(total.uncovered).toBe(86400);
  }
  // Interleaved dates: the window of day 3 is days 2, 3 and 4.
  expect(runningMeanInTime([0, 30, 10, 20, 40], [0, 3, 1, 2, 4], 3)[1]).toBe(
    30
  );
});
