/* eslint-disable max-lines-per-function -- each case builds its own fixture. */
import { describe, expect, it } from "vitest";

import { timeLabels } from "@/lib/analysis/calendar.ts";
import { unitChoices } from "@/lib/analysis/displayUnits.ts";
import { converter } from "@/lib/analysis/unitConvert.ts";
import { verticalStatistics } from "@/lib/analysis/verticalStats.ts";
import { quantityProblem } from "@/ui/analysis/compare.ts";
import { axisCells } from "@/ui/analysis/heatmapRaster.ts";
import {
  periodDates,
  reshapedSpec,
  reshapeViews,
} from "@/ui/analysis/seriesViews.ts";
import {
  annualCycle,
  dateKey,
  diurnalCycle,
  monthOf,
  TIME_VIEWS,
} from "@/ui/analysis/timeViews.ts";

const side = (
  standardName: string,
  units: string,
  cellMethods?: string,
  variable = "v"
) => ({ variable, standardName, units, cellMethods, timeDimension: "time" });

describe("review of interim43: what Compare scores", () => {
  it("does not take snowfall thickness for its liquid water equivalent", () => {
    expect(
      quantityProblem(
        side("thickness_of_snowfall_amount", "m"),
        side("lwe_thickness_of_snowfall_amount", "m")
      )
    ).toMatch(/another quantity/);
  });

  it("keeps CF aliases one quantity", () => {
    expect(
      quantityProblem(
        side("lwe_convective_precipitation_rate", "mm/day"),
        side("convective_precipitation_rate", "mm/day")
      )
    ).toBeUndefined();
    expect(
      quantityProblem(
        side("thickness_of_stratiform_rainfall_amount", "m"),
        side("thickness_of_large_scale_rainfall_amount", "m")
      )
    ).toBeUndefined();
  });

  it("does not score means of daily maxima against means of daily means", () => {
    expect(
      quantityProblem(
        side(
          "air_temperature",
          "K",
          "time: maximum within days time: mean over days"
        ),
        side(
          "air_temperature",
          "K",
          "time: mean within days time: mean over days"
        )
      )
    ).toMatch(/maximum within days, then mean over days/);
  });

  it("does not score a land mean against a sea mean", () => {
    expect(
      quantityProblem(
        side("air_temperature", "K", "area: mean where land time: mean"),
        side("air_temperature", "K", "area: mean where sea time: mean")
      )
    ).toMatch(/where land.*where sea/);
    // Means alike, comments aside, are compared.
    expect(
      quantityProblem(
        side("air_temperature", "K", "time: mean (comment: range checked)"),
        side("air_temperature", "K", "time: mean")
      )
    ).toBeUndefined();
  });

  it("compares a current in mm/day with one in m/s", () => {
    for (const units of ["mm/day", "mm/s", "m/s"]) {
      expect(
        quantityProblem(
          side("eastward_sea_water_velocity", units, undefined, "uo"),
          side("eastward_sea_water_velocity", "m/s", undefined, "uo")
        ),
        units
      ).toBeUndefined();
    }
  });
});

/** Two 350 m layers of seawater, 0–700 m. */
const ocean = (values: number[], more: Record<string, string> = {}) =>
  verticalStatistics({
    z: [175, 525],
    values,
    zUnits: "m",
    positive: "down",
    bounds: [0, 350, 350, 700],
    units: "degC",
    standardName: "sea_water_temperature",
    ...more,
  });
const heat = (stats: ReturnType<typeof verticalStatistics>) =>
  stats.find((s) => s.id === "heat-700")?.value;

describe("review of interim43: heat content", () => {
  it("is withheld for means of layer maxima and for medians", () => {
    for (const cellMethods of [
      "time: maximum within days time: mean over days",
      "time: median",
      "time: minimum",
    ]) {
      expect(heat(ocean([1, 1], { cellMethods })), cellMethods).toBeUndefined();
    }
    // A linear mean keeps it.
    expect(heat(ocean([1, 1], { cellMethods: "time: mean" }))).toBeGreaterThan(
      0
    );
  });

  it("is kept with a comment or a long name that says nothing of the quantity", () => {
    expect(
      heat(
        ocean([1, 1], { cellMethods: "time: mean (comment: range checked)" })
      )
    ).toBeGreaterThan(0);
    expect(
      heat(ocean([1, 1], { name: "thetao Copernicus Marine Service" }))
    ).toBeGreaterThan(0);
  });

  it("does not take a whole-column point or maximum for the column mean", () => {
    // Rows over [0, 700] and [0, 350] m: the first stands for the column
    // only when it is its mean.
    const column = (cellMethods: string, values: number[]) =>
      verticalStatistics({
        z: [35, 175],
        values,
        zUnits: "m",
        positive: "down",
        bounds: [0, 700, 0, 350],
        units: "degC",
        cellMethods,
      }).find((s) => s.id === "mean")?.value;
    expect(column("depth: mean", [13, 16.5])).toBe(13);
    expect(column("depth: point", [19.3, 16.5])).toBeUndefined();
    expect(column("depth: maximum", [20, 20])).toBeUndefined();
  });
});

describe("review of interim43: time support of calendar views", () => {
  const units = "days since 2001-01-01";
  /** Cells [low, high, value] as a mean series, folded by month. */
  const months = (rows: number[][]) => {
    const raw = rows.map(([a, b]) => (a + b) / 2);
    const ctx = {
      raw,
      dates: timeLabels({ raw, calendar: "standard", units }),
      values: rows.map((r) => r[2]),
      calendar: "standard",
      timeUnits: units,
      cellMethods: "time: mean",
      bounds: rows.flatMap((r) => r.slice(0, 2)),
    };
    return annualCycle(periodDates(ctx as never), ctx.values).mean.slice(0, 2);
  };

  it("leaves a cell of no length out of its month", () => {
    // January: 0 over one day, 20 over nine; a [5, 5] cell of 100 holds no time.
    expect(
      months([
        [0, 1, 0],
        [1, 10, 20],
      ])[0]
    ).toBeCloseTo(18, 9);
    expect(
      months([
        [0, 1, 0],
        [1, 10, 20],
        [5, 5, 100],
      ])[0]
    ).toBeCloseTo(18, 9);
  });

  it("splits a cross-month cell whatever lies far off", () => {
    const rows = [
      [0, 30, 0],
      [30, 32, 20],
      [32, 59, 0],
    ];
    const near = months(rows);
    expect(near[0]).toBeCloseTo(20 / 31, 6);
    expect(near[1]).toBeCloseTo(20 / 28, 6);
    // A missing row 1,200 years before changes nothing.
    const far = months([[-450_000, -449_999, NaN], ...rows]);
    expect(far[0]).toBeCloseTo(near[0], 9);
    expect(far[1]).toBeCloseTo(near[1], 9);
  });

  it("gives a night's hours the same weights across a month's end or not", () => {
    // Hourly means, one 23:00–01:00 mean of 20, the other hours 0.
    const hourly = (day: number) => {
      const hours = Array.from({ length: 48 }, (_, h) => day + h / 24);
      const rows = hours.map((t) => [t, t + 1 / 24, 0]);
      rows.splice(23, 2, [day + 23 / 24, day + 25 / 24, 20]);
      const raw = rows.map(([a, b]) => (a + b) / 2);
      const ctx = {
        raw,
        dates: timeLabels({ raw, calendar: "standard", units }),
        values: rows.map((r) => r[2]),
        calendar: "standard",
        timeUnits: units,
        cellMethods: "time: mean",
        bounds: rows.flatMap((r) => r.slice(0, 2)),
      };
      const cycle = diurnalCycle(periodDates(ctx as never), ctx.values).mean;
      return [cycle[23], cycle[0]];
    };
    // Jan 29 → 31 and Jan 30 → Feb 1: the same hours, the same means.
    const [inside, across] = [hourly(28), hourly(29)];
    expect(across[0]).toBeCloseTo(inside[0], 9);
    expect(across[1]).toBeCloseTo(inside[1], 9);
    // Neither hour is given the two-hour mean: its hours are not known.
    expect(inside[0]).toBe(0);
    expect(inside[1]).toBe(0);
  });
});

it("a temperature of unknown scale keeps its stored units", () => {
  const unknown = { from: "temperature: unknown", to: "temperature: unknown" };
  expect(converter("K", "degC", unknown)).toBeUndefined();
  expect(unitChoices("K", "temperature: unknown")).toEqual([]);
  // Declared on the scale, or a difference: converted as before.
  expect(converter("K", "degC")!(2)).toBeCloseTo(-271.15);
  const on = "temperature: on_scale";
  expect(converter("K", "degC", { from: on, to: on })!(2)).toBeCloseTo(-271.15);
  const diff = "temperature: difference";
  expect(converter("K", "degC", { from: diff, to: diff })!(2)).toBe(2);
  expect(unitChoices("K", diff).map((c) => c.units)).toContain("degC");
});

it("heatmap levels stored out of order reach their neighbours by position", () => {
  // Depths [0, 2, 1] m: the 2 m value is drawn on 1.5–2.5 m, the axis
  // ends at 2.5 m (it was 1–1.5 m, ending at 1.5).
  const { lo, hi } = axisCells([0, 2, 1]);
  expect([...lo]).toEqual([-0.5, 1.5, 0.5]);
  expect([...hi]).toEqual([0.5, 2.5, 1.5]);
  // Ordered either way: as before.
  expect([...axisCells([3, 2, 1]).lo]).toEqual([2.5, 1.5, 0.5]);
});

it("period dates of the same axis in another calendar are its own", () => {
  // A mean over [45, 46] days: February 15 (+12 h) in the standard
  // calendar, February 16 in a 360-day one; the same arrays, reused.
  const raw = [45.5];
  const bounds = [45, 46];
  const ctx = (calendar: string) =>
    ({
      raw,
      bounds,
      calendar,
      timeUnits: "days since 2001-01-01",
      cellMethods: "time: mean",
      dates: timeLabels({ raw, calendar, units: "days since 2001-01-01" }),
    }) as never;
  const standard = periodDates(ctx("standard"))[0];
  const day360 = periodDates(ctx("360_day"))[0];
  expect(standard.slice(0, 10)).toBe("2001-02-15");
  expect(day360.slice(0, 10)).toBe("2001-02-16");
});

it("five-digit model years keep their months", () => {
  for (const origin of ["12001-01-01", "-12001-01-01"]) {
    const units = `days since ${origin}`;
    const raw = [0, 40, 360, 400];
    const dates = timeLabels({ raw, units, calendar: "360_day" });
    expect(dates.map((d) => monthOf(d))).toEqual(["01", "02", "01", "02"]);
    expect(dateKey(dates[1], 7)).toBe(origin.replace("-01-01", "-02"));
    const cycle = annualCycle(dates, [1, 2, 3, 4]).mean;
    expect(cycle.slice(0, 2)).toEqual([2, 3]);
  }
});

describe("review of interim43: the tropopause search on many levels", () => {
  const find = (z: number[], values: number[]) =>
    verticalStatistics({
      z,
      values,
      positive: "up",
      zUnits: "m",
      units: "K",
      standardName: "air_temperature",
    }).find((s) => s.id === "tropopause")?.value;
  /** Levels from 5 to 10 km: 1.5 K/km up to `turn`, then `above` K/km. */
  const profile = (n: number, turn: number, above: number) => {
    const z = Array.from({ length: n }, (_, k) => 5000 + (5000 * k) / (n - 1));
    const T = z.map((h) =>
      h <= turn
        ? 260 - 0.0015 * (h - 5000)
        : 260 - 0.0015 * (turn - 5000) - (above / 1000) * (h - turn)
    );
    return { z, T };
  };

  it("finds none at either resolution, in linear time", () => {
    for (const n of [32768, 65536]) {
      const { z, T } = profile(n, 6800, 12);
      const start = performance.now();
      expect(find(z, T), `${n} levels`).toBeUndefined();
      const ms = performance.now() - start;
      if (process.env.GRIDLOOK_TIMING === "1") {
        expect(ms, `${n} levels`).toBeLessThan(150);
      }
    }
  });

  it("finds the same level as the lapse rates one by one", () => {
    // Against the lapse rate from each candidate to every level within
    // 2 km, on profiles with noise, ties at the limit and a gap of 2 km.
    const exact = (z: number[], T: number[]) => {
      for (let at = 0; at + 1 < z.length; at++) {
        const lapse = (b: number) => (-(T[b] - T[at]) / (z[b] - z[at])) * 1000;
        if (z[at] < 5000 || lapse(at + 1) > 2) {
          continue;
        }
        let end = at + 1;
        while (end < z.length && z[end] - z[at] < 2000) {
          end++;
        }
        if (end >= z.length) {
          return undefined;
        }
        let holds = true;
        for (let up = at + 1; up < end; up++) {
          holds &&= lapse(up) <= 2;
        }
        const f = (z[at] + 2000 - z[end - 1]) / (z[end] - z[end - 1]);
        const tEnd = T[end - 1] + f * (T[end] - T[end - 1]);
        if (holds && (-(tEnd - T[at]) / 2000) * 1000 <= 2) {
          return z[at];
        }
      }
      return undefined;
    };
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    for (let trial = 0; trial < 200; trial++) {
      const z = [4000];
      while (z.length < 80) {
        z.push(
          z[z.length - 1] +
            (trial % 7 === 0 && z.length === 40 ? 2000 : 50 + 300 * random())
        );
      }
      const T = [280];
      for (let k = 1; k < z.length; k++) {
        const rate = trial % 5 === 0 ? 2 : 8 * random() - 1;
        T.push(T[k - 1] - (rate / 1000) * (z[k] - z[k - 1]));
      }
      expect(find(z, T), `trial ${trial}`).toBe(exact(z, T));
    }
  });
});

it("the first Return levels of 200,000 hourly means: the menu once, the fit from it", () => {
  const n = 200000;
  const units = "hours since 2001-01-01";
  const make = () => {
    const raw = Array.from({ length: n }, (_, k) => k + 0.5);
    const values = raw.map(
      (r) => 280 + 10 * Math.sin(r / 50) + (r % 977) / 100
    );
    return {
      raw,
      values,
      bounds: raw.flatMap((r) => [r - 0.5, r + 0.5]),
      dates: timeLabels({ raw, units, calendar: "standard" }),
      timeUnits: units,
      calendar: "standard",
      cellMethods: "time: mean",
      units: "K",
      window: 3,
      threshold: 0,
    };
  };
  const base = (ctx: { raw: number[]; values: number[] }) =>
    ({
      mode: "time",
      x: ctx.raw,
      y: ctx.values,
      xTitle: "Time",
      yTitle: "T",
      xLabel: String,
      readout: () => [],
    }) as never;
  const ctx = make();
  let start = performance.now();
  const views = reshapeViews(ctx as never);
  const menu = performance.now() - start;
  expect(views).toContain(TIME_VIEWS.RETURN);
  start = performance.now();
  const spec = reshapedSpec(TIME_VIEWS.RETURN, base(ctx), ctx as never)!;
  const fit = performance.now() - start;
  expect(spec.mode).toBe("cycle");
  // The same fit as from arrays seen for the first time.
  const fresh = make();
  const again = reshapedSpec(TIME_VIEWS.RETURN, base(fresh), fresh as never)!;
  expect(spec.y).toEqual(again.y);
  expect(spec.points?.x.length).toBe(22);
  if (process.env.GRIDLOOK_TIMING === "1") {
    expect(menu, "menu").toBeLessThan(250);
    expect(fit, "fit").toBeLessThan(150);
  }
});
