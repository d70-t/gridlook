import { expect, it } from "vitest";

import { timeLabels } from "@/lib/analysis/calendar.ts";
import { verticalStatistics } from "@/lib/analysis/verticalStats.ts";
import { periodDates } from "@/ui/analysis/seriesViews.ts";
import { annualCycle, anomalies } from "@/ui/analysis/timeViews.ts";

function intervalDates(bounds: number[], units: string) {
  const raw = [];
  for (let at = 0; at < bounds.length; at += 2) {
    raw.push((bounds[at] + bounds[at + 1]) / 2);
  }
  const calendar = "standard";
  return periodDates({
    dates: timeLabels({ raw, units, calendar }),
    raw,
    bounds,
    timeUnits: units,
    calendar,
    cellMethods: "time: mean",
  });
}

it("withholds the same overlapping mean when only the reference epoch changes", () => {
  const bounds = [0, 3, 2, 4];
  const unix = 1_700_000_000;
  const shifted = bounds.map((offset) => unix + offset);
  const local = intervalDates(bounds, "seconds since 2023-11-14 22:13:20");
  const epoch = intervalDates(shifted, "seconds since 1970-01-01");
  expect(epoch).toEqual(local);
  const cycle = (dates: string[]) => annualCycle(dates, [10, 40]).mean[10];
  expect(cycle(local)).toBeNaN();
  expect(cycle(epoch)).toBeNaN();
});

it("preserves a monthly mean when the only additional time cell contains a fill value", () => {
  const units = "days since 2001-01-01";
  const clean = intervalDates([0, 1, 1, 2], units);
  const padded = intervalDates([0, 1, 1, 2, 0, 2], units);
  expect(annualCycle(clean, [10, 30]).mean[0]).toBe(20);
  expect(annualCycle(padded, [10, 30, NaN]).mean[0]).toBe(20);
});

it("gives the same mean anomaly when a constant cell is split at a month boundary", () => {
  const units = "days since 2001-01-01";
  // Jan 30 at 0, Jan 31 and Feb 1 at 20, Feb 2 at 40.
  const whole = intervalDates([29, 30, 30, 32, 32, 33], units);
  const split = intervalDates([29, 30, 30, 31, 31, 32, 32, 33], units);
  const combined = [0, 20, 40];
  const daily = [0, 20, 20, 40];
  expect(annualCycle(whole, combined).mean.slice(0, 2)).toEqual([10, 30]);
  const byDay = anomalies(split, daily);
  expect(byDay.slice(1, 3)).toEqual([10, -10]);
  expect(anomalies(whole, combined)[1]).toBe((byDay[1] + byDay[2]) / 2);
});

it("withholds precipitable water from layer humidity maxima attained on different days", () => {
  const amount = (values: number[], cellMethods: string) =>
    verticalStatistics({
      z: [950, 850],
      zUnits: "hPa",
      bounds: [1000, 900, 900, 800],
      values,
      standardName: "specific_humidity",
      units: "kg kg-1",
      cellMethods,
    }).find((stat) => stat.id === "amount")?.value;
  const first = amount([0.01, 0], "time: point");
  const second = amount([0, 0.01], "time: point");
  expect(first).toBeCloseTo(100 / 9.80665);
  expect(second).toBe(first);
  expect(amount([0.01, 0.01], "time: maximum")).toBeUndefined();
});

it("independent review of interim45: a missing declared layer is no observed heat", () => {
  const stats = (bounds: number[]) =>
    verticalStatistics({
      z: [100, 300, 500, 650],
      zUnits: "m",
      positive: "down",
      bounds,
      values: [10, 10, 10, 10],
      standardName: "sea_water_potential_temperature",
      units: "degC",
    });
  const full = stats([0, 200, 200, 400, 400, 600, 600, 700]);
  expect(full.find((s) => s.id === "heat-700")?.value).toBeCloseTo(
    28.642e9,
    -7
  );
  const missing = stats([0, 200, NaN, NaN, 400, 600, 600, 700]);
  expect(missing.find((s) => s.id === "heat-700")).toBeUndefined();
  expect(missing.find((s) => s.id === "unknown-layers")?.value).toBe(1);
});

it("independent review of interim45: layer maxima give no isotherm or mixed layer", () => {
  const ids = (cellMethods: string) =>
    verticalStatistics({
      z: [10, 100],
      zUnits: "m",
      positive: "down",
      values: [30, 19],
      standardName: "sea_water_temperature",
      units: "degC",
      cellMethods,
    }).map((s) => s.id);
  expect(ids("time: mean")).toContain("z20");
  expect(ids("time: maximum")).not.toContain("z20");
  expect(ids("time: maximum")).not.toContain("mld");
});

it("review of interim45: a column of 1 cm-3 over 1,000 m holds 10^9 per m²", () => {
  const amount = (units: string, value: number) =>
    verticalStatistics({
      z: [250, 750],
      zUnits: "m",
      bounds: [0, 500, 500, 1000],
      values: [value, value],
      standardName: "number_concentration_of_ambient_aerosol_particles_in_air",
      units,
    }).find((s) => s.id === "amount");
  for (const [units, value] of [
    ["cm-3", 1],
    ["m-3", 1e6],
    ["/cm3", 1],
  ] as const) {
    expect(amount(units, value)?.value, units).toBeCloseTo(1e9, -3);
    expect(amount(units, value)?.units, units).toBe("m-2");
  }
});

it("interim48: per cubic micrometre and nanometre convert, a bare prefix gives none", () => {
  const amount = (units: string) =>
    verticalStatistics({
      z: [250, 750],
      zUnits: "m",
      bounds: [0, 500, 500, 1000],
      values: [1, 1],
      standardName: "number_concentration_of_ambient_aerosol_particles_in_air",
      units,
    }).find((s) => s.id === "amount");
  for (const units of ["µm-3", "μm-3", "um-3", "/µm3"]) {
    expect(amount(units)?.value, units).toBeCloseTo(1e21, -15);
    expect(amount(units)?.units, units).toBe("m-2");
  }
  expect(amount("nm-3")?.value).toBeCloseTo(1e30, -24);
  expect(amount("µ m-3")).toBeUndefined();
});
