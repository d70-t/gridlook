/* eslint-disable max-lines-per-function -- each case builds its own fixture. */
import { describe, expect, it } from "vitest";

import { timeLabels } from "@/lib/analysis/calendar.ts";
import { verticalStatistics } from "@/lib/analysis/verticalStats.ts";
import { quantityProblem } from "@/ui/analysis/compare.ts";
import { meanDurations, memberStats } from "@/ui/analysis/members.ts";
import { periodDates } from "@/ui/analysis/seriesViews.ts";
import { annualCycle, diurnalCycle } from "@/ui/analysis/timeViews.ts";

/** Two 350 m layers of sea water, 0–700 m. */
const column = {
  z: [175, 525],
  bounds: [0, 350, 350, 700],
  positive: "down" as const,
  zUnits: "m",
  units: "K",
  standardName: "sea_water_temperature",
  values: [280, 280],
};
const heat = (more: Record<string, unknown>) =>
  verticalStatistics({ ...column, ...more } as never).find(
    (s) => s.id === "heat-700"
  )?.value;

describe("heat content", () => {
  it("is withheld for a temperature of unknown scale", () => {
    // 2 K marked unknown gave −776.6 GJ/m².
    expect(
      heat({
        standardName: undefined,
        name: "thetao Sea water temperatures",
        unitsMetadata: "temperature: unknown",
        values: [2, 2],
      })
    ).toBeUndefined();
    // On the scale: as before.
    expect(heat({ unitsMetadata: "temperature: on_scale" })).toBeCloseTo(
      19619542066.25,
      0
    );
  });

  it("is withheld for layer extremes or medians along the vertical", () => {
    const anomaly = (cellMethods: string) =>
      heat({
        standardName: "sea_water_temperature_anomaly",
        values: [1, 1],
        cellMethods,
      });
    for (const method of [
      "depth: maximum",
      "depth: time: maximum",
      "z: maximum",
      "depth: median",
    ]) {
      expect(anomaly(method), method).toBeUndefined();
    }
    expect(anomaly("depth: mean")).toBeCloseTo(2864166725, 0);
  });
});

describe("what Compare scores", () => {
  const side = (cellMethods?: string, extra: Record<string, string> = {}) => ({
    variable: "v",
    standardName: "air_temperature",
    units: "K",
    cellMethods,
    ...extra,
  });
  it("refuses statistics in another order, over an axis one side leaves, or of other samplings", () => {
    expect(
      quantityProblem(
        side("area: mean time: maximum"),
        side("time: maximum area: mean")
      )
    ).toMatch(/other orders or groupings/);
    expect(
      quantityProblem(side("time: mean"), side("area: maximum time: mean"))
    ).toMatch(/maximum over area/);
    expect(
      quantityProblem(
        side("time: maximum (interval: 1 hour)"),
        side("time: maximum (interval: 1 day)")
      )
    ).toMatch(/every 1 hour/);
    expect(
      quantityProblem(
        side("depth: time: maximum"),
        side("depth: maximum time: maximum")
      )
    ).toMatch(/other orders or groupings/);
  });

  it("keeps what may be compared", () => {
    // The same chain; an area mean beside none.
    expect(
      quantityProblem(
        side("area: mean time: maximum"),
        side("area: mean time: maximum (interval: 1 hour)")
      )
    ).toBeUndefined();
    // Means in another order are not.
    expect(
      quantityProblem(
        side("area: mean time: mean"),
        side("time: mean area: mean")
      )
    ).toMatch(/other orders/);
    expect(
      quantityProblem(side("time: mean"), side("area: mean time: mean"))
    ).toBeUndefined();
  });

  it("refuses a temperature of unknown scale against one on its scale", () => {
    const unknown = { unitsMetadata: "temperature: unknown" };
    const on = { unitsMetadata: "temperature: on_scale" };
    expect(
      quantityProblem(side(undefined, unknown), side(undefined, on))
    ).toMatch(/unknown scale/);
    expect(
      quantityProblem(side(undefined, unknown), side(undefined, unknown))
    ).toBeUndefined();
  });

  it("takes CF aliases as one quantity", () => {
    expect(
      quantityProblem(
        {
          variable: "psl",
          standardName: "air_pressure_at_sea_level",
          units: "Pa",
        },
        {
          variable: "msl",
          standardName: "air_pressure_at_mean_sea_level",
          units: "Pa",
        }
      )
    ).toBeUndefined();
  });
});

describe("time support of means", () => {
  const units = "days since 2001-01-01";
  const series = (bounds: number[], values: number[]) => ({
    cellMethods: "time: mean",
    time: { raw: values.map((_, at) => at), bounds },
  });
  const cycle = (bounds: number[], values: number[]) => {
    const raw = values.map((_, at) => {
      const [a, b] = [bounds[2 * at], bounds[2 * at + 1]];
      return Number.isFinite(a) ? (a + b) / 2 : at;
    });
    const ctx = {
      raw,
      values,
      bounds,
      calendar: "standard",
      timeUnits: units,
      cellMethods: "time: mean",
      dates: timeLabels({ raw, units, calendar: "standard" }),
    };
    return annualCycle(periodDates(ctx as never), values).mean[0];
  };

  it("gives no mean of cells inside others", () => {
    // [0, 10] says 20; [2, 6] inside it says 100: 42.857 before.
    const b = [0, 10, 2, 6];
    const stats = memberStats(
      [[20, 100]],
      2,
      meanDurations(series(b, [20, 100]))
    );
    expect(stats.means[0]).toBeNaN();
    expect(stats.withheld).toBe(true);
    expect(cycle(b, [20, 100])).toBeNaN();
  });

  it("gives no mean of cells of no length", () => {
    for (const b of [
      [2, 2, 5, 5],
      [2, 2, Number.NaN, Number.NaN],
    ]) {
      const stats = memberStats(
        [[100, 200]],
        2,
        meanDurations(series(b, [100, 200]))
      );
      expect(stats.means[0], String(b)).toBeNaN();
    }
    expect(cycle([2, 2, 5, 5], [100, 200])).toBeNaN();
    // Known lengths: weighted, as before (18).
    expect(
      memberStats([[0, 20]], 2, meanDurations(series([0, 1, 1, 10], [0, 20])))
        .means[0]
    ).toBe(18);
  });

  it("leaves a day-long mean out of the diurnal cycle wherever it starts", () => {
    for (const start of [0, 0.5]) {
      const hours = "hours since 2001-01-01";
      const lower = 48 + start;
      const edges = [
        [0, 1],
        [1, 2],
        [2, 3],
        [3, 4],
        [lower, lower + 24],
      ];
      const raw = edges.map(([a, b]) => (a + b) / 2);
      const values = [Number.NaN, Number.NaN, Number.NaN, Number.NaN, 7];
      const ctx = {
        raw,
        values,
        bounds: edges.flat(),
        calendar: "standard",
        timeUnits: hours,
        cellMethods: "time: mean",
        dates: timeLabels({ raw, units: hours, calendar: "standard" }),
      };
      const out = diurnalCycle(periodDates(ctx as never), values);
      expect(out.mean.filter(Number.isFinite), String(start)).toEqual([]);
    }
  });
});
