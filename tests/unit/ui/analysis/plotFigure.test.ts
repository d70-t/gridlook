/* eslint-disable max-lines-per-function -- one describe block of figure checks. */
import { describe, expect, it, vi } from "vitest";

vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
vi.stubGlobal("location", { hash: "", pathname: "/", search: "" });

const {
  chartSpec,
  countThreshold,
  heatmapSpec,
  selectionSubtitle,
  sliceSpec,
  dataView,
  readThroughText,
  partialText,
} = await import("@/ui/analysis/plotFigure.ts");
const { ALGORITHM_VERSION, ANALYSIS_KINDS } =
  await import("@/lib/analysis/types.ts");
type TResult = import("@/lib/analysis/types.ts").TAnalysisResult;
type TKind = import("@/lib/analysis/types.ts").TAnalysisKind;
type TWindow = import("@/store/analysisStore.ts").TPlotWindow;

const TIME = {
  dimension: "time",
  raw: [0, 1, 2],
  units: "days since 2000-01-01",
  calendar: "standard",
};

function result(kind: TKind, axis: number[], extra: Partial<TResult> = {}) {
  return {
    kind,
    query: {
      version: ALGORITHM_VERSION,
      kind,
      source: { ref: "memory", versionStatus: "session" },
      variable: "thetao",
      geometry: { kind: "box", west: 170, east: -170, south: -5, north: 5 },
      fixed: {},
      time: { start: 0, stop: 3 },
    },
    units: "degC",
    values: TIME.raw.flatMap((t) => axis.map((_, k) => 10 * t + k)),
    shape: [3, axis.length],
    dims: ["time", "x"],
    time: TIME,
    axis: {
      dimension: "x",
      label: "x",
      values: axis,
      reduction: "mean over 5.0° S–5.0° N at each longitude",
    },
    ...extra,
  } as TResult;
}

describe("time × space figures", () => {
  it("orients each family: time up for longitude and distance, across for depth and latitude", () => {
    const lon = heatmapSpec(result(ANALYSIS_KINDS.HOVMOLLER_LON, [175, 185]));
    expect(lon?.timeOn).toBe("y");
    expect(lon?.axis.format?.(185)).toBe("175° W");
    expect(lon?.description).toContain("5.0° S–5.0° N");
    const lat = heatmapSpec(result(ANALYSIS_KINDS.HOVMOLLER_LAT, [-5, 5]));
    expect(lat?.timeOn).toBe("x");
    expect(lat?.axis.format?.(-5)).toBe("5° S");
    const path = heatmapSpec(
      result(ANALYSIS_KINDS.HOVMOLLER_PATH, [0, 250000])
    );
    expect(path?.axis.values).toEqual([0, 250]);
    expect(path?.axis.title).toContain("km");
    const depth = heatmapSpec(
      result(ANALYSIS_KINDS.TIME_DEPTH, [5, 15], {
        vertical: {
          dimension: "depth",
          label: "depth",
          values: [5, 15],
          units: "m",
          positive: "down",
          physical: true,
        } as never,
      })
    );
    expect(depth?.timeOn).toBe("x");
    expect(depth?.axis.reverse).toBe(true);
  });

  it("a picked date gives that date's row: the path trace or the profile", () => {
    const hov = result(ANALYSIS_KINDS.HOVMOLLER_PATH, [0, 1000, 2000]);
    const trace = sliceSpec(hov, 2)!;
    expect(trace.mode).toBe("path");
    expect(trace.y).toEqual([20, 21, 22]);
    expect(trace.x).toEqual([0, 1, 2]);
    const depth = result(ANALYSIS_KINDS.TIME_DEPTH, [5, 15], {
      vertical: {
        dimension: "depth",
        label: "depth",
        values: [5, 15],
        positive: "down",
        physical: true,
      } as never,
    });
    const profile = sliceSpec(depth, 1)!;
    expect(profile.mode).toBe("profile");
    expect(profile.x).toEqual([10, 11]);
    expect(profile.y).toEqual([5, 15]);
    expect(profile.invertY).toBe(true);
    expect(sliceSpec(depth, 3)).toBeUndefined();
  });

  it("a partial result marks the rows not yet read", () => {
    const partial = result(ANALYSIS_KINDS.HOVMOLLER_LON, [0, 10], {
      partial: { readUntil: 2 } as never,
    });
    expect(heatmapSpec(partial)?.unreadFrom).toBe(2);
  });

  it("a distribution draws shares of valid area in percent on the bins' true edges", () => {
    const spec = chartSpec({
      ...result(ANALYSIS_KINDS.DISTRIBUTION, []),
      axis: undefined,
      time: undefined,
      values: [0.25, 0.75],
      shape: [2],
      histogram: {
        edges: [0, 10, 20],
        validFraction: 1,
        validCells: 4,
        selectedCells: 4,
        mean: 12.5,
        weighting: "area",
      },
    } as TResult)!;
    expect(spec.mode).toBe("histogram");
    // Bars on their true edges: [0, 10] at 25 %, [10, 20] at 75 %.
    expect(spec.x).toEqual([0, 10, 10, 20]);
    expect(spec.y).toEqual([25, 25, 75, 75]);
    expect(spec.readout(1)[0]).toMatch(/^0 to 10/);
    expect(spec.readout(2)[0]).toMatch(/^10 to 20/);
    expect(spec.yTitle).toBe("Share of valid area (%)");
  });

  it("a constant field fills one visible bar at 100 %", () => {
    const spec = chartSpec({
      ...result(ANALYSIS_KINDS.DISTRIBUTION, []),
      axis: undefined,
      time: undefined,
      values: [1],
      shape: [1],
      histogram: {
        edges: [4.5, 5.5],
        constant: 5,
        validFraction: 0.5,
        validCells: 2,
        selectedCells: 4,
        mean: 5,
        weighting: "area",
      },
    } as TResult)!;
    expect(spec.y).toEqual([100, 100]);
    expect(spec.x).toEqual([4.5, 5.5]);
    expect(spec.x[1]).toBeGreaterThan(spec.x[0]);
    expect(spec.readout(0)[0]).toContain("All valid values are 5");
  });

  it("keeps 500 hPa above 1000 hPa whatever the order of levels in the file", () => {
    for (const levels of [
      [1000, 850, 500],
      [500, 850, 1000],
    ]) {
      const vertical = {
        kind: "coordinate",
        dimension: "plev",
        label: "air pressure (hPa)",
        units: "hPa",
        physical: true,
        positive: "down",
        values: levels,
      };
      const section = heatmapSpec({
        ...result(ANALYSIS_KINDS.TIME_DEPTH, levels),
        vertical,
      } as unknown as TResult);
      // Larger pressure drawn lower: the axis runs downwards by value.
      expect(section?.axis.reverse).toBe(true);
      expect(section?.axis.values).toEqual(levels);
      const profile = chartSpec({
        ...result(ANALYSIS_KINDS.PROFILE, levels),
        time: undefined,
        values: levels.map((p) => p / 100),
        shape: [levels.length],
        vertical,
      } as unknown as TResult)!;
      expect(profile.invertY).toBe(true);
    }
  });

  it("draws published depth layers [0, 2, 18], not midpoints", () => {
    const spec = heatmapSpec({
      ...result(ANALYSIS_KINDS.TIME_DEPTH, [1, 10]),
      vertical: {
        dimension: "depth",
        label: "depth",
        units: "m",
        physical: true,
        positive: "down",
        values: [1, 10],
        bounds: [0, 2, 2, 18],
      },
    } as unknown as TResult)!;
    expect(spec.axis.bounds).toEqual([0, 2, 18]);
  });

  it("a hybrid formula with time-varying pressure shows model levels, not Pa", () => {
    const spec = heatmapSpec({
      ...result(ANALYSIS_KINDS.TIME_DEPTH, [0, 1]),
      vertical: {
        kind: "formula",
        dimension: "lev",
        label: "lev (model coordinate)",
        physical: false,
        values: [0.9, 0.5],
      },
    } as unknown as TResult)!;
    // Its own coefficients as published, not the index, and still no pressure.
    expect(spec.axis.values).toEqual([0.9, 0.5]);
    expect(spec.axis.title).toMatch(/native values/);
    expect(spec.axis.title).not.toContain("Pa");
    expect(spec.axis.reverse).toBe(false);
    expect(spec.description).toMatch(/^Time–model level/);
  });

  it("names the band of a longitude × time plot across 180°", () => {
    const hov = result(ANALYSIS_KINDS.HOVMOLLER_LON, [175, 185]);
    const text = selectionSubtitle(
      {
        kind: ANALYSIS_KINDS.HOVMOLLER_LON,
        draft: { geometry: hov.query.geometry },
        summary: { time: TIME },
      } as unknown as TWindow,
      hov.query
    );
    expect(text).toContain("5° S–5° N band mean, 170° E to 170° W");
  });

  it("puts the averaged sector and the date in a latitude–pressure subtitle", () => {
    const section = result(ANALYSIS_KINDS.LAT_VERTICAL, [-5, 5]);
    const text = selectionSubtitle(
      {
        kind: ANALYSIS_KINDS.LAT_VERTICAL,
        draft: { geometry: section.query.geometry },
        summary: { time: TIME },
        result: {
          vertical: { physical: true, label: "air pressure", units: "hPa" },
        },
      } as unknown as TWindow,
      { ...section.query, time: { start: 1, stop: 2 } }
    );
    expect(text).toMatch(
      /^Latitude–pressure — mean over 170° E–170° W, 5° S–5° N — 2000-01-02/
    );
    expect(heatmapSpec(section)).toBeUndefined();
  });
});

it("draws and labels the same read prefix as the Data preview and keeps gaps distinct from unread dates", async () => {
  const { reduceForDisplay } = await import("@/lib/analysis/analysisExport.ts");
  const raw = Array.from({ length: 31411 }, (_, i) => i);
  const values = Array<number>(raw.length).fill(NaN);
  values[0] = 7;
  const series = result(ANALYSIS_KINDS.POINT_SERIES, [], {
    time: { ...TIME, raw },
    axis: undefined,
    values,
    partial: { done: 1, total: 400, readUntil: 12 },
  });
  series.query.time = { start: 10, stop: 31421 };
  const spec = chartSpec(series)!;
  expect(spec.y).toBe(values);
  expect(reduceForDisplay(spec.x, spec.y, 10, spec.unreadFrom)).toEqual({
    x: [0, 1],
    y: [7, NaN],
    index: [0, 1],
  });
  const table = dataView(series);
  expect(table.rows).toHaveLength(500);
  expect(table.total).toBe(31411);
  expect(
    table.rows.slice(0, 3).map((row) => row[table.columns.indexOf("Status")])
  ).toEqual(["ok", "missing", "not read"]);
  expect(readThroughText(series)).toBe(
    "2 of 31,411 time steps read — through 2000-01-02 00:00:00"
  );
  // One part held two dates: the stopped note counts dates, not parts.
  expect(partialText(series)).toBe(
    "Partial: 2 of 31,411 dates read; not read from 2000-01-03 00:00:00"
  );
});

describe("review of interim10: plots named after their vertical quantity", () => {
  it("says altitude, potential temperature, pressure or model level", async () => {
    const { timeVerticalName } = await import("@/ui/analysis/plotFigure.ts");
    const { figuresOf } = await import("@/ui/analysis/orbitDial.ts");
    const v = (label: string, units?: string, physical = true) => ({
      label,
      units,
      physical,
    });
    expect(timeVerticalName(v("altitude (m, positive up)", "m"))).toBe(
      "Time–altitude"
    );
    expect(
      timeVerticalName(v("air_potential_temperature (K)", "K"), "Latitude")
    ).toBe("Latitude–potential temperature");
    expect(timeVerticalName(v("plev (pascals)", "pascals"))).toBe(
      "Time–pressure"
    );
    expect(timeVerticalName(v("model level lev", undefined, false))).toBe(
      "Time–model level"
    );
    expect(timeVerticalName(undefined)).toBe("Time–vertical coordinate");
    const titles = figuresOf("box", v("depth (m)", "m")).map((f) => f.title);
    expect(titles).toContain("Latitude–depth section");
    expect(titles).toContain("Longitude–depth section");
  });
});

describe("review of interim10: Data shows what the chart draws too", () => {
  it("adds the plotted values (an anomaly) beside the values as read", () => {
    const series = result(ANALYSIS_KINDS.POINT_SERIES, [], {
      axis: undefined,
      values: [123, 124, 125],
      shape: [3],
      dims: ["time"],
    });
    const table = dataView(series, {
      title: "Anomaly of thetao (degC)",
      values: [0, 0.5, NaN],
    });
    const at = table.columns.indexOf("Plotted: Anomaly of thetao (degC)");
    expect(at).toBeGreaterThan(0);
    expect(table.rows.map((row) => row[at])).toEqual(["0", "0.5", "—"]);
    expect(table.rows[0]).toContain("123");
  });
});

it("starts Count above at the 90th percentile of the means shown", () => {
  // Five means over enough area (2), 1,821 below the cutoff (1000).
  const n = 1826;
  const result = {
    kind: ANALYSIS_KINDS.REGION_SERIES,
    query: { minCoverage: 0.5 },
    values: Array.from({ length: n }, (_, at) => (at < 5 ? 2 : 1000)),
    region: {
      coverage: Array.from({ length: n }, (_, at) => (at < 5 ? 1 : 0.1)),
    },
  } as unknown as TResult;
  expect(countThreshold(result)).toBe(2);
});
