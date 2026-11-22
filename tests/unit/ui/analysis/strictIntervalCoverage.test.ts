import { expect, it, vi } from "vitest";

import {
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  emptyCounters,
  type TAnalysisResult,
} from "@/lib/analysis/types.ts";
import { maximaYears, reshapedSpec } from "@/ui/analysis/seriesViews.ts";
import { accumulate, TIME_VIEWS } from "@/ui/analysis/timeViews.ts";

vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
vi.stubGlobal("location", { hash: "", pathname: "/", search: "" });
const { chartSpec } = await import("@/ui/analysis/plotFigure.ts");

const timeUnits = "days since 2001-01-01";
const msPerDay = 86_400_000;
const start = Date.UTC(2001, 0, 1);
const dayOf = (year: number) => (Date.UTC(year, 0, 1) - start) / msPerDay;
const dateAt = (day: number) =>
  new Date(start + day * msPerDay).toISOString().slice(0, 10);

function countrySeries(raw: number[], dates: string[]): TAnalysisResult {
  const kind = ANALYSIS_KINDS.REGION_SERIES;
  const coverage = dates.map((date) => (date.endsWith("-01-01") ? 1 : 0.1));
  return {
    kind,
    query: {
      kind,
      version: ALGORITHM_VERSION,
      source: { ref: "memory", versionStatus: "session" },
      variable: "rain",
      geometry: { kind: "country", id: "276", resolution: "50m" },
      minCoverage: 0.9,
      fixed: {},
    },
    values: dates.map((date) => Number(date.slice(0, 4)) - 2000),
    region: {
      coverage,
      totalCells: "10",
      storedCells: 10,
      validCells: coverage.map((share) => share * 10),
      footprintCoverage: 1,
      weighting: "area",
    },
    shape: [raw.length],
    dims: ["time"],
    time: { raw, units: timeUnits, dimension: "time" },
    units: "mm",
    cellMethods: "time: maximum",
    grid: { kind: "regular", conflicts: [] },
    decoding: "",
    notes: [],
    counters: emptyCounters(),
  };
}

it("counts only country means meeting the area cutoff toward annual maxima", () => {
  const raw = Array.from({ length: dayOf(2006) }, (_, day) => day);
  const dates = raw.map(dateAt);
  const result = countrySeries(raw, dates);
  const base = chartSpec(result)!;
  expect(base.y.filter(Number.isFinite)).toHaveLength(5);
  // PlotWindow supplies result.values in its context and chartSpec supplies
  // the masked series. Only the five dates visible on the chart qualify.
  const chart = reshapedSpec(TIME_VIEWS.RETURN, base, {
    dates,
    raw,
    values: result.values,
    bounds: raw.flatMap((day) => [day, day + 1]),
    timeUnits,
    cellMethods: result.cellMethods,
    units: result.units,
    window: 3,
    threshold: 0,
  });
  const level =
    chart?.mode === "cycle" ? chart.y[chart.x.indexOf(100)] : undefined;
  expect(level).not.toSatisfy(Number.isFinite);
});

it("does not classify overlapping two-year maxima as published annual maxima", () => {
  const years = [2001, 2002, 2003, 2004, 2005];
  const raw = years.map((year) => dayOf(year) + 181);
  const context = {
    dates: raw.map(dateAt),
    raw,
    timeUnits,
    cellMethods: "time: maximum",
    values: [1, 2, 3, 4, 5],
    threshold: 0,
    window: 3,
  };
  const bounds = (yearsPerCell: number) =>
    years.flatMap((year) => [dayOf(year), dayOf(year + yearsPerCell)]);
  expect(maximaYears({ ...context, bounds: bounds(1) }).years.size).toBe(5);
  expect(maximaYears({ ...context, bounds: bounds(2) }).years.size).toBe(0);
});

it("withholds a precipitation total if its declared accumulation cells are unreadable", () => {
  const total = accumulate(
    [1, 2, 3],
    timeUnits,
    [1, 2, 3],
    "mm",
    undefined,
    "its declared bounds time_bnds have missing values",
    "sum"
  );
  // The amounts can be overlapping forecasts since day zero. Their sum
  // cannot be described as a three-day rainfall total until the cells are known.
  expect(total.y.at(-1)).not.toSatisfy(Number.isFinite);
});
