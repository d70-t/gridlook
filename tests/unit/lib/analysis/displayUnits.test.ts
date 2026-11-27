import { describe, expect, it } from "vitest";

import {
  convertResult,
  convertValue,
  defaultChartStyle,
  rateKind,
  temperatureMetadata,
  unitChoices,
} from "@/lib/analysis/displayUnits.ts";
import {
  ANALYSIS_KINDS,
  emptyCounters,
  type TAnalysisResult,
} from "@/lib/analysis/types.ts";

const result = (over: Partial<TAnalysisResult>) =>
  ({
    kind: ANALYSIS_KINDS.REGION_SERIES,
    query: {},
    units: "K",
    values: [273.15, 283.15],
    shape: [2],
    dims: ["time"],
    grid: { kind: "regular", conflicts: [] },
    decoding: "CF",
    notes: [],
    counters: emptyCounters(),
    ...over,
  }) as TAnalysisResult;

describe("display units", () => {
  it("offers the quantity's other units after the file's own", () => {
    expect(unitChoices("K").map((c) => c.units)).toEqual(["K", "degC", "degF"]);
    expect(unitChoices("kg m-2 s-1").map((c) => c.label)).toEqual([
      "kg m-2 s-1 (as stored)",
      "mm/h",
      "mm/day",
    ]);
    expect(unitChoices("1")).toEqual([]);
    expect(unitChoices(undefined)).toEqual([]);
  });

  it("converts the values and moves a σ by the size of a unit only", () => {
    const r = convertResult(
      result({
        region: {
          totalCells: "4",
          storedCells: 4,
          coverage: [1, 1],
          validCells: [4, 4],
          footprintCoverage: 1,
          weighting: "area",
          spread: { std: [2, 3], min: [270, 280], max: [275, 285] },
        },
      }),
      "degC"
    );
    expect(r.units).toBe("degC");
    expect(r.values.map((v) => Math.round(v * 100) / 100)).toEqual([0, 10]);
    expect(r.region!.spread!.std).toEqual([2, 3]);
    expect(r.region!.spread!.min[0]).toBeCloseTo(-3.15);
    expect(convertResult(result({}), "degF").values[0]).toBeCloseTo(32);
  });
});

describe("display units: other quantities", () => {
  it("turns a flux into mm/day, and leaves a distribution's shares alone", () => {
    const pr = result({ units: "kg m-2 s-1", values: [1 / 86400] });
    expect(convertResult(pr, "mm day-1").values[0]).toBeCloseTo(1);
    const d = convertResult(
      result({
        kind: ANALYSIS_KINDS.DISTRIBUTION,
        values: [0.25, 0.75],
        histogram: {
          edges: [273.15, 278.15, 283.15],
          validFraction: 1,
          validCells: 2,
          selectedCells: 2,
          mean: 278.15,
          weighting: "area",
        },
      }),
      "degC"
    );
    expect(d.values).toEqual([0.25, 0.75]);
    expect(d.histogram!.edges.map((v) => Math.round(v))).toEqual([0, 5, 10]);
  });

  it("keeps the result when the units are its own or out of reach", () => {
    const r = result({});
    expect(convertResult(r, undefined)).toBe(r);
    expect(convertResult(r, "K")).toBe(r);
    expect(convertResult(r, "m s-1")).toBe(r);
  });

  it("draws precipitation as bars by default, other series as a line", () => {
    expect(defaultChartStyle("pr", "kg m-2 s-1")).toBe("bars");
    expect(defaultChartStyle("tp", "m")).toBe("bars");
    expect(defaultChartStyle("tas", "K")).toBe("line");
  });
});

it("review of interim30 N9: a threshold converts as the values do", async () => {
  const { convertValue } = await import("@/lib/analysis/displayUnits.ts");
  expect(convertValue(273.15, "K", "degC")).toBeCloseTo(0, 12);
  expect(convertValue(0, "degC", "K")).toBeCloseTo(273.15, 12);
  // A temperature difference: no offset.
  expect(convertValue(1, "K", "degC", "temperature: difference")).toBeCloseTo(
    1,
    12
  );
  expect(convertValue(5, "m s-1", "m s-1")).toBe(5);
  expect(convertValue(5, "m s-1", "K")).toBeUndefined();
});

it("shows a reported temperature standard deviation as a spread when display units change", () => {
  const spread = result({
    units: "K",
    values: [1, 2, 3],
    cellMethods: "time: standard_deviation",
  });
  // A standard deviation may change its scale in Fahrenheit, but its
  // origin cannot move. In Celsius and kelvin the increments coincide.
  expect(convertResult(spread, "degC", "air_temperature").values).toEqual([
    1, 2, 3,
  ]);
});

describe("review of interim36: one meaning for a temperature, one quantity for a rate", () => {
  it("takes an anomaly named only by its variable as a difference", () => {
    const anomaly = result({
      values: [1, 2, 3],
      query: { variable: "thetao_anomaly" } as TAnalysisResult["query"],
    });
    expect(temperatureMetadata(anomaly)).toBe("temperature: difference");
    expect(convertResult(anomaly, "degC").values).toEqual([1, 2, 3]);
  });

  it("keeps an absolute temperature on its scale", () => {
    const absolute = result({ values: [273.15] });
    expect(temperatureMetadata(absolute)).toBeUndefined();
    expect(convertResult(absolute, "degC").values[0]).toBeCloseTo(0, 9);
  });

  it("offers speeds for a current in mm/s and mm/day for precipitation", () => {
    const current = rateKind("uo", "eastward_sea_water_velocity");
    expect(current).toBe("speed");
    const offered = unitChoices("mm s-1", undefined, current).map(
      (c) => c.units
    );
    expect(offered).toContain("m s-1");
    expect(offered).not.toContain("mm day-1");
    expect(
      defaultChartStyle("uo", "mm s-1", "eastward_sea_water_velocity")
    ).toBe("line");
    const rain = rateKind("pr", "precipitation_flux");
    expect(
      unitChoices("kg m-2 s-1", undefined, rain).map((c) => c.units)
    ).toContain("mm day-1");
  });

  it("offers no depth of water for a carbon flux", () => {
    const carbon = rateKind(
      "fgco2",
      "surface_downward_mass_flux_of_carbon_dioxide_expressed_as_carbon"
    );
    expect(carbon).toBe("other");
    expect(unitChoices("kg m-2 s-1", undefined, carbon)).toEqual([]);
  });
});

it("reads a range check in a cell-method comment as no spread (review of interim37)", () => {
  const result = (cellMethods: string) => ({
    query: { variable: "tas" } as never,
    cellMethods,
  });
  const absolute = temperatureMetadata(
    result("time: mean (interval: 1 hour comment: range checked)"),
    "air_temperature"
  );
  expect(convertValue(285, "K", "degF", absolute)).toBeCloseTo(53.33, 2);
  const spread = temperatureMetadata(
    result("time: standard_deviation"),
    "air_temperature"
  );
  expect(convertValue(2, "K", "degF", spread)).toBeCloseTo(3.6, 6);
});

it("shows a restored carbon flux in its own units, not mm/day (review of interim37)", () => {
  const result = {
    kind: ANALYSIS_KINDS.POINT_SERIES,
    query: { variable: "fgco2" },
    units: "kg m-2 s-1",
    values: [0.000001],
    notes: [],
  } as never;
  const carbon =
    "surface_downward_mass_flux_of_carbon_dioxide_expressed_as_carbon";
  expect(convertResult(result, "mm day-1", carbon).values).toEqual([0.000001]);
  // Precipitation still converts.
  expect(
    convertResult(result, "mm day-1", "precipitation_flux").values[0]
  ).toBeCloseTo(0.0864, 10);
});

it("offers °C for a temperature difference stored in K (review of interim37)", () => {
  const choices = unitChoices("K", "temperature: difference").map(
    (c) => c.units
  );
  expect(choices).toContain("degC");
});

it("final review of interim41: a current in mm/day is offered speeds, never a mass flux", async () => {
  const { unitChoices } = await import("@/lib/analysis/displayUnits.ts");
  const units = unitChoices("mm day-1", undefined, "speed").map((c) => c.units);
  expect(units).not.toContain("kg m-2 s-1");
  // In mm/s it converts to the speeds.
  expect(
    unitChoices("mm s-1", undefined, "speed").map((c) => c.units)
  ).toContain("m s-1");
});
