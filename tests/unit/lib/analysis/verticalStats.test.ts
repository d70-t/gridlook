import { describe, expect, it } from "vitest";

import { convertResult } from "@/lib/analysis/displayUnits.ts";
import type { TAnalysisResult } from "@/lib/analysis/types.ts";
import {
  statisticOverTime,
  verticalStatistics,
} from "@/lib/analysis/verticalStats.ts";

const stat = (list: ReturnType<typeof verticalStatistics>, id: string) =>
  list.find((s) => s.id === id);

// An idealised tropical ocean: a 50 m mixed layer at 28 °C, then cooling
// fastest between 100 and 150 m, through 20 °C at 140 m, to 5 °C at depth.
const depth = [0, 10, 20, 40, 50, 60, 100, 150, 200, 400, 700, 1000];
const temp = [28, 28, 28, 28, 27.9, 27.5, 26, 16, 12, 8, 6, 5];
const ocean = {
  z: depth,
  values: temp,
  zUnits: "m",
  positive: "down" as const,
  units: "degC",
  standardName: "sea_water_potential_temperature",
};

describe("vertical statistics of an ocean temperature profile", () => {
  const stats = verticalStatistics(ocean);

  it("finds the mixed layer 0.2 °C below its 10 m value", () => {
    // 28 → 27.5 between 50 and 60 m: 27.8 is reached at 52.5 m.
    expect(stat(stats, "mld")?.value).toBeCloseTo(52.5, 6);
    expect(stat(stats, "mld")?.method).toMatch(/de Boyer Montégut/);
  });

  it("finds the 20 °C isotherm and the thermocline below the mixed layer", () => {
    // 26 °C at 100 m, 16 °C at 150 m: 20 °C at 130 m.
    expect(stat(stats, "z20")?.value).toBeCloseTo(130, 6);
    expect(stat(stats, "thermocline")?.value).toBe(125);
  });

  it("gives the 0–700 m heat content and a thickness-weighted mean", () => {
    expect(stat(stats, "heat-700")?.units).toBe("J m-2");
    expect(stat(stats, "heat-700")!.value).toBeGreaterThan(
      1025 * 3991.87 * 700 * 5
    );
    expect(stat(stats, "mean")!.value).toBeGreaterThan(5);
    expect(stat(stats, "mean")!.value).toBeLessThan(28);
    expect(stat(stats, "max-level")?.value).toBe(0);
  });

  it("works in kelvin and skips what the column does not reach", () => {
    const kelvin = verticalStatistics({
      ...ocean,
      values: temp.map((t) => t + 273.15),
      units: "K",
    });
    expect(stat(kelvin, "mld")?.value).toBeCloseTo(52.5, 6);
    const shallow = verticalStatistics({
      ...ocean,
      z: depth.slice(0, 7),
      values: temp.slice(0, 7),
    });
    expect(stat(shallow, "z20")).toBeUndefined();
    expect(stat(shallow, "heat-700")).toBeUndefined();
  });
});

describe("vertical statistics of the atmosphere", () => {
  // A standard-like atmosphere on pressure levels: 6.5 K/km up to the
  // tropopause near 200 hPa, isothermal above.
  const p = [1000, 850, 700, 500, 400, 300, 250, 200, 150, 100, 70, 50];
  const T = [
    288, 278, 268, 252, 241, 229, 221, 216.7, 216.7, 216.7, 216.7, 217,
  ];

  it("finds the WMO lapse-rate tropopause", () => {
    const stats = verticalStatistics({
      z: p,
      values: T,
      zUnits: "hPa",
      positive: "down",
      units: "K",
      standardName: "air_temperature",
    });
    const tp = stat(stats, "tropopause");
    expect(tp?.value).toBe(200);
    expect(tp?.units).toBe("hPa");
    expect(stat(stats, "mld")).toBeUndefined();
  });

  it("totals specific humidity into precipitable water (kg m-2)", () => {
    const stats = verticalStatistics({
      z: [1000, 900, 800],
      values: [0.01, 0.01, 0.01],
      zUnits: "hPa",
      units: "kg kg-1",
      standardName: "specific_humidity",
    });
    // 0.01 × 200 hPa (100 + 100 hPa, half gaps at the ends) / g.
    expect(stat(stats, "amount")?.value).toBeCloseTo(
      (0.01 * 20000) / 9.80665,
      6
    );
    expect(stat(stats, "amount")?.units).toBe("kg m-2");
  });

  it("has nothing for model levels without positions", () => {
    expect(
      verticalStatistics({ z: [1, 2, 3], values: [1, 2, 3], zUnits: "1" })
    ).toEqual([]);
  });
});

describe("the thermocline lies below the mixed layer", () => {
  it("skips a layer that straddles the mixed layer's base", () => {
    // Levels 5, 15, 25 m: the mixed layer ends near 11.8 m; the layer
    // 5–15 m (middle 10 m) cools fastest but is not below it.
    const stats = verticalStatistics({
      z: [5, 15, 25, 50],
      values: [28, 25.2, 24.8, 22],
      zUnits: "m",
      positive: "down",
      units: "degC",
      standardName: "sea_water_potential_temperature",
    });
    const mld = stats.find((s) => s.id === "mld")!.value;
    const thermocline = stats.find((s) => s.id === "thermocline")!.value;
    expect(thermocline).toBeGreaterThan(mld);
  });
});

describe("a statistic over time", () => {
  it("gives the mixed-layer depth of each date of a time–depth section", () => {
    const deeper = temp.map((t, k) => (k === 4 ? 28 : t));
    const series = statisticOverTime(
      2,
      depth.length,
      [...temp, ...deeper],
      ocean,
      "mld"
    );
    expect(series[0]).toBeCloseTo(52.5, 6);
    expect(series[1]).toBeGreaterThan(52.5);
  });
});

describe("second interim22 review: vertical diagnostics", () => {
  const base = {
    zUnits: "m",
    positive: "down" as const,
    units: "degC",
    standardName: "sea_water_potential_temperature",
  };

  it("finds where temperature falls through 20 °C, not where it rises", () => {
    // Warming through 20 °C at 25 m, cooling through it at 150 m.
    const stats = verticalStatistics({
      ...base,
      z: [0, 10, 40, 100, 200],
      values: [18, 19, 21, 22, 18],
    });
    expect(stats.find((s) => s.id === "z20")?.value).toBeCloseTo(150, 6);
  });

  it("integrates heat over the published layers", () => {
    const stats = verticalStatistics({
      ...base,
      z: [5, 360],
      bounds: [0, 10, 10, 710],
      values: [10, 10],
    });
    expect(stats.find((s) => s.id === "heat-700")?.value).toBeCloseTo(
      1025 * 3991.87 * 10 * 700,
      0
    );
  });
});

// eslint-disable-next-line max-lines-per-function
describe("review of interim30: vertical diagnostics of differences, humidity and ties", () => {
  const depths = Array.from({ length: 71 }, (_, k) => 5 + 10 * k); // 5…705 m
  const layerBounds = depths.flatMap((z) => [z - 5, z + 5]);
  const anomaly = (units: string) =>
    verticalStatistics({
      z: depths,
      values: depths.map(() => 1),
      zUnits: "m",
      positive: "down",
      bounds: layerBounds,
      units,
      standardName: "sea_water_temperature_anomaly",
      name: "thetao_anomaly",
    }).find((s) => s.id === "heat-700");

  it("gives the same positive heat content anomaly in K and °C", () => {
    const k = anomaly("K");
    const c = anomaly("degC");
    expect(k?.label).toMatch(/anomaly/);
    expect(k?.value).toBeCloseTo(1025 * 3991.87 * 700, 0);
    expect(c?.value).toBeCloseTo(k!.value, 6);
  });

  it("takes degree_Celsius for °C, and offers no heat content of a range (review of interim35)", () => {
    expect(anomaly("degree_Celsius")?.value).toBeCloseTo(
      anomaly("K")!.value,
      6
    );
    const range = verticalStatistics({
      z: depths,
      values: depths.map(() => 1),
      zUnits: "m",
      positive: "down",
      bounds: layerBounds,
      units: "K",
      unitsMetadata: "temperature: difference",
      standardName: "sea_water_temperature",
      cellMethods: "time: range",
    }).find((s) => s.id === "heat-700");
    expect(range).toBeUndefined();
  });

  it("converts a mixing ratio before integrating, and withholds overlapping layers", () => {
    const pressures = [1000, 800, 600];
    const amount = (
      column: Partial<Parameters<typeof verticalStatistics>[0]>
    ) =>
      verticalStatistics({
        z: pressures,
        values: [0.02, 0.02, 0.02],
        zUnits: "hPa",
        units: "kg kg-1",
        ...column,
      }).find((s) => s.id === "amount");
    const q = amount({ standardName: "specific_humidity" })!;
    const r = amount({ standardName: "humidity_mixing_ratio" })!;
    expect(r.value).toBeCloseTo((q.value * (0.02 / 1.02)) / 0.02, 9);
    expect(
      amount({
        standardName: "specific_humidity",
        bounds: [1000, 750, 900, 700, 750, 600],
      })
    ).toBeUndefined();
  });

  it("puts a tied extremum at the same level in the profile and over time", () => {
    for (const z of [
      [500, 1000],
      [1000, 500],
    ]) {
      const column = { z, zUnits: "hPa", units: "K" };
      const profile = verticalStatistics({ ...column, values: [42, 42] }).find(
        (s) => s.id === "max-level"
      )!.value;
      expect(statisticOverTime(1, 2, [42, 42], column, "max-level")).toEqual([
        profile,
      ]);
      expect(profile).toBe(1000);
    }
  });
});

describe("review of interim33: heat content of a difference, as displayed", () => {
  // Two layers, 0–200 and 200–700 m, each +1 K of anomaly.
  const column = {
    z: [100, 450],
    zUnits: "m",
    positive: "down" as const,
    bounds: [0, 200, 200, 700],
    standardName: "sea_water_temperature_anomaly",
    name: "thetao_anomaly",
  };
  const heat = (values: number[], units: string, extra = {}) =>
    verticalStatistics({ ...column, values, units, ...extra }).find(
      (s) => s.id === "heat-700"
    );

  it("an anomaly shown in °C keeps its heat content", () => {
    const read = {
      kind: "profile",
      values: [1, 1],
      units: "K",
      query: { variable: "thetao_anomaly" },
      notes: [],
      counters: {},
    } as unknown as TAnalysisResult;
    const shown = convertResult(read, "degC", column.standardName);
    expect(shown.values).toEqual([1, 1]);
    expect(shown.unitsMetadata).toBe("temperature: difference");
    const inK = heat([1, 1], "K")!.value;
    const inC = heat(shown.values, "degC", {
      unitsMetadata: shown.unitsMetadata,
    })!.value;
    expect(inK).toBeCloseTo(1025 * 3991.87 * 700, 0);
    expect(inC).toBeCloseTo(inK, 6);
  });

  it("a standard deviation over time gives no heat content", () => {
    expect(
      heat([1, 1], "K", {
        standardName: "sea_water_temperature",
        unitsMetadata: "temperature: difference",
        cellMethods: "time: standard_deviation",
      })
    ).toBeUndefined();
  });
});

describe("review of interim37: column diagnostics of what was measured", () => {
  const anomaly = {
    z: [175, 525],
    zUnits: "m",
    positive: "down" as const,
    bounds: [0, 350, 350, 700],
    standardName: "sea_water_temperature_anomaly",
    name: "thetao_anomaly",
    units: "K",
  };
  const heat = (cellMethods: string) =>
    verticalStatistics({ ...anomaly, values: [1, 1], cellMethods }).find(
      (s) => s.id === "heat-700"
    );

  it("gives no heat content of unsigned or extreme layer statistics", () => {
    expect(heat("time: mean")).toBeDefined();
    for (const method of [
      "time: mean_absolute_value",
      "time: root_mean_square",
      "time: maximum",
    ]) {
      expect(heat(method)).toBeUndefined();
    }
  });

  it("finds no tropopause in a dry adiabat of potential temperature", () => {
    const p = [800, 600, 500, 400, 300, 200, 100];
    const tropopause = (standardName: string, values: number[]) =>
      verticalStatistics({
        z: p,
        zUnits: "hPa",
        positive: "down",
        units: "K",
        standardName,
        values,
      }).find((s) => s.id === "tropopause");
    expect(
      tropopause(
        "air_potential_temperature",
        p.map(() => 300)
      )
    ).toBeUndefined();
    expect(
      tropopause(
        "air_temperature",
        p.map((hPa) => 300 * (hPa / 1000) ** (2 / 7))
      )
    ).toBeUndefined();
  });
});

describe("vertical statistics of the quantity measured", () => {
  const pressure = [1000, 925, 850, 700, 500, 400, 300, 250, 200, 150, 100, 50];
  it("finds no tropopause in a dew point", () => {
    const dew = [268, 255, 243, 230, 219, 210, 201, 176, 176, 176, 176, 176];
    const stats = verticalStatistics({
      z: pressure,
      values: dew,
      zUnits: "hPa",
      positive: "down",
      units: "K",
      standardName: "dew_point_temperature",
    });
    expect(stat(stats, "tropopause")).toBeUndefined();
  });

  it("gives no marine diagnostics of the freezing point of sea water", () => {
    const z = [0, 10, 100, 300, 500, 700];
    const stats = verticalStatistics({
      z,
      values: z.map((d) => -1.9 - 0.00075 * d),
      zUnits: "m",
      positive: "down",
      units: "degC",
      standardName: "freezing_temperature_of_sea_water",
    });
    for (const id of ["mld", "thermocline", "heat-700"]) {
      expect(stat(stats, id), id).toBeUndefined();
    }
  });

  it("finds no tropopause where no level samples the 2 km above it", () => {
    const z = [0, 5000, 6000, 7000, 8000, 9000, 10000, 11000, 12000];
    const T = [288, 255.5, 247.5, 249.5, 251, 251, 251, 251, 251];
    const column = (values: number[]) =>
      verticalStatistics({
        z,
        values,
        zUnits: "m",
        positive: "up",
        units: "K",
        standardName: "air_temperature",
      });
    expect(stat(column(T), "tropopause")?.value).toBe(6000);
    // 6 and 7 km missing: 5 km's own 2 km cannot be tested.
    const gap = T.map((t, k) => (k === 2 || k === 3 ? NaN : t));
    expect(stat(column(gap), "tropopause")).toBeUndefined();
  });
});
