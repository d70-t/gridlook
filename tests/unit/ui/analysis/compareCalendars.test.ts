import { expect, it } from "vitest";

import { timeLabels } from "@/lib/analysis/calendar.ts";
import { keyDays, pairSeries } from "@/ui/analysis/compare.ts";
import { meanDurations, memberStats } from "@/ui/analysis/members.ts";

function monthly(calendar: string, edges: number[], incomplete = false) {
  const raw = edges.slice(1).map((high, i) => (high + edges[i]) / 2);
  const bounds = edges.slice(1).flatMap((high, i) => [edges[i], high]);
  if (incomplete) {
    bounds[bounds.length - 1] = Number.NaN;
  }
  const time = {
    raw,
    bounds,
    units: "days since 2001-01-01",
    calendar,
    dimension: "time",
    cellMethods: "time: mean",
    ...(incomplete ? { boundsUnread: "one bound is missing" } : {}),
  };
  return { dates: timeLabels(time), values: [1, 2, 3, 4], calendar, time };
}

it("keeps three known monthly pairs across calendars when only the fourth month has an unread bound", () => {
  const ordinary = monthly("standard", [0, 31, 59, 90, 120]);
  const model = [0, 30, 60, 90, 120];
  expect(pairSeries(ordinary, monthly("360_day", model)).keys).toHaveLength(4);
  expect(pairSeries(ordinary, monthly("360_day", model, true)).keys).toEqual([
    "2001-01",
    "2001-02",
    "2001-03",
  ]);
});

it("spaces compared dates by the elapsed days on the source's standard calendar", () => {
  const raw = [0, 1, 2];
  const dates = timeLabels({
    raw,
    units: "days since 1582-10-04",
    calendar: "standard",
  });
  const days = dates.map((date) => keyDays(date, "standard"));
  expect(dates.map((date) => date.slice(0, 10))).toEqual([
    "1582-10-04",
    "1582-10-15",
    "1582-10-16",
  ]);
  expect(days.map((d) => d - days[0])).toEqual(raw);
});

it("retains known member durations when only an unobserved cell has missing bounds", () => {
  const result = {
    time: {
      dimension: "time",
      raw: [0.5, 5.5, 12],
      bounds: [0, 1, 1, 10, Number.NaN, Number.NaN],
    },
    cellMethods: "time: mean",
  };
  const series = [[0, 20, Number.NaN]];
  const full = {
    ...result,
    time: { ...result.time, bounds: [0, 1, 1, 10, 10, 14] },
  };
  expect(memberStats(series, 3, meanDurations(full)).means).toEqual([18]);
  expect(memberStats(series, 3, meanDurations(result)).means).toEqual([18]);
});

it("review of interim41: Compare judges quantities by name, kind and statistic", async () => {
  const { quantityProblem } = await import("@/ui/analysis/compare.ts");
  // One CF quantity under its alias: compared.
  expect(
    quantityProblem(
      {
        variable: "cp",
        standardName: "convective_precipitation_rate",
        units: "mm day-1",
      },
      {
        variable: "cp",
        standardName: "lwe_convective_precipitation_rate",
        units: "mm day-1",
      }
    )
  ).toBeUndefined();
  // A current in mm/s beside a carbon flux without a standard name: no.
  expect(
    quantityProblem(
      { variable: "fgco2", units: "kg m-2 s-1" },
      {
        variable: "uo",
        standardName: "eastward_sea_water_velocity",
        units: "mm s-1",
      }
    )
  ).toMatch(/not both speeds/);
  // Monthly maxima against monthly means of air pressure: no scores.
  const side = (cellMethods: string) => ({
    variable: "psl",
    standardName: "air_pressure_at_mean_sea_level",
    units: "Pa",
    cellMethods,
    timeDimension: "time",
  });
  expect(quantityProblem(side("time: maximum"), side("time: mean"))).toMatch(
    /time: maximum values, psl time: mean ones/
  );
  expect(
    quantityProblem(side("time: mean"), side("time: mean"))
  ).toBeUndefined();
});

it("final review of interim41: model-calendar dates a microsecond apart stay apart", () => {
  const [a, b] = [
    keyDays("2001-02-30 00:00:00.000001", "360_day"),
    keyDays("2001-02-30 00:00:00.000002", "360_day"),
  ];
  expect(b).toBeGreaterThan(a);
});
