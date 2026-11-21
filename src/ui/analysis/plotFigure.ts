import type { TDistributionMarks } from "./distribution.ts";
import { percentileOfValues } from "./members.ts";
import {
  axisMarks,
  edgesFromBounds,
  layerSpans,
  type TAxisMark,
} from "./pathMarks.ts";
import {
  axisQuantity,
  describeGeometry,
  displayedSummary,
  levelText,
  lonSpanText,
  nativeLevels,
  verticalTitle,
} from "./plotLayout.ts";

import { resultTable } from "@/lib/analysis/analysisExport.ts";
import { timeLabelAt, parseTimeAxis } from "@/lib/analysis/calendar.ts";
import { rowsUntil } from "@/lib/analysis/timeRows.ts";
import {
  ANALYSIS_KINDS,
  GEOMETRY_KINDS,
  FIXED_LEVEL_KINDS,
  SECTION_MODES,
  SPREAD_VIEWS,
  TIME_RANGE_KINDS,
  type TAnalysisQuery,
  type TAnalysisResult,
  type TSpreadView,
} from "@/lib/analysis/types.ts";
import { PLOT_KIND_NAMES, type TPlotWindow } from "@/store/analysisStore.ts";
import { formatValue } from "@/utils/formatValue.ts";

/**
 * What a chart draws. Time series and paths plot values against time or
 * distance; profiles plot values (x) against the vertical coordinate (y).
 */
export type TSeriesSpec = {
  mode: "time" | "profile" | "path" | "histogram" | "cycle";
  /**
   * Path mode against latitude: each sample's distance along the path
   * (m), the samples drawn in walking order and the map's cursor placed by
   * them, not by the axis' values.
   */
  along?: number[];
  /** Cycle mode: tick labels of the x values (months, hours). */
  xLabel?: (value: number) => string;
  /** A fitted line drawn dashed over the series (a trend). */
  fit?: { values: number[]; label: string };
  /** A line drawn solid over the series (a running mean). */
  overlay?: { values: number[]; label: string };
  /** Cycle mode: the tick step on x (default 1, or 3 past 12 values). */
  xStep?: number;
  /** A logarithmic x axis (periods, return periods). */
  xLog?: boolean;
  /** Cycle mode: ticks chosen freely on a value axis (a CDF). */
  xFree?: boolean;
  /** A fixed y range, such as 0–100 %. */
  yRange?: [number, number];
  /** Draw each value as a marker (counts per year). */
  markers?: boolean;
  /**
   *  How the series is drawn (Settings → Display): bars from zero or
   * points instead of a line.
   */
  style?: "bars" | "points";
  /** Cycle mode: a box per x value (quartiles, median, extremes). */
  boxes?: (
    | { low: number; q1: number; median: number; q3: number; high: number }
    | undefined
  )[];
  /** Extra points drawn as dots, not joined (observed yearly maxima). */
  points?: { x: number[]; y: number[]; label: string };
  /** Over a distribution's bars: curves, the middle 95 %, median, mean. */
  distribution?: TDistributionMarks;
  x: number[];
  y: number[];
  xTitle: string;
  yTitle: string;
  /** Source time coordinate, for calendar ticks (time mode). */
  time?: { units?: string; calendar?: string; dimension: string };
  /** Readout lines for an original sample index: heading first. */
  readout: (index: number) => string[];
  invertY?: boolean;
  /**
   * Valid-area fractions per time step (area means), with a threshold;
   * `sites`: the share of sites with a value (a site mean).
   */
  coverage?: { values: number[]; threshold?: number; sites?: boolean };
  /** Rows from this index on (file order) were not read (a partial series). */
  unreadFrom?: number;
  /** Per sample along a path: ok, missing or no stored cell. */
  status?: string[];
  /** Numbered path points on the distance axis (path mode, km). */
  marks?: TAxisMark[];
  /** Value units, for the value shown at the map's time. */
  units?: string;
  /** A shaded band around an area mean: ±1σ or the min–max range. */
  band?: { lower: number[]; upper: number[]; label: string };
  /**
   * Wind barbs per sample: eastward and northward components (in `units`),
   * in a strip above a time series or a column beside a profile.
   */
  wind?: {
    u: number[];
    v: number[];
    units?: string;
    flip: boolean;
    /** An ocean current: read out by where it goes. */
    current?: boolean;
  };
  /**
   * An ensemble series: every member (a plume), the median with its
   * 10–90 % range (a fan) or both, and each member's period mean.
   */
  members?: {
    series: number[][];
    view: "plume" | "fan" | "both" | "chance";
    /** The plotted member (drawn as the series itself). */
    chosen: number;
    name: string;
    p10: number[];
    p50: number[];
    p90: number[];
    means: number[];
    /** Values of unknown length left out of a member's period mean. */
    leftOut?: number;
    /** No period mean: cells overlap, or none has a length. */
    withheld?: boolean;
    /** Interval means of unknown lengths: means of samples, not periods. */
    sample?: boolean;
    /** Chance view: the threshold and the share (%) above it per step. */
    threshold?: number;
    chance?: { share: number[]; above: number[]; valid: number[] };
  };
};

/** A path's samples as walked (against latitude): sample k is point k. */
export function walkedPoints(spec: Pick<TSeriesSpec, "x" | "y">) {
  return spec.x.map((x, at) => ({
    x,
    y: Number.isNaN(spec.y[at]) || Number.isNaN(x) ? null : spec.y[at],
    i: at,
  }));
}

/** The sample whose distance along the path is nearest `distance` (−1). */
export function nearestSample(along: number[], distance: number) {
  let [best, at] = [Infinity, -1];
  along.forEach((d, k) => {
    const gap = Math.abs(d - distance);
    if (gap < best) {
      [best, at] = [gap, k];
    }
  });
  return at;
}

/** What a heatmap (time × axis) draws. */
export type THeatmapSpec = {
  values: number[];
  time: {
    raw: number[];
    units?: string;
    calendar?: string;
    dimension: string;
    standardName?: string;
    /** Declared cell bounds, [start, end] per step. */
    bounds?: number[];
  };
  axis: {
    values: number[];
    /** Bin edges, one more than the values (Hovmöller bins). */
    bounds?: number[];
    title: string;
    format?: (value: number) => string;
    /** Numbered path points along the axis (distance × time, km). */
    marks?: TAxisMark[];
    /** Larger values downwards (depth, pressure). */
    reverse?: boolean;
  };
  timeOn: "x" | "y";
  valueTitle: string;
  /** Units of the values, shown above the colour bar. */
  units?: string;
  /** Time index from which nothing was read. */
  unreadFrom?: number;
  description: string;
  /** Wind barbs per cell (time–height), indexed as `values`. */
  wind?: {
    u: number[];
    v: number[];
    units?: string;
    flip: boolean;
    /** An ocean current: read out by where it goes. */
    current?: boolean;
  };
};

function lonLabel(value: number) {
  const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
  return `${Math.round(Math.abs(wrapped) * 10) / 10}° ${wrapped < 0 ? "W" : wrapped > 0 ? "E" : ""}`.trim();
}

function latLabel(value: number) {
  return `${Math.round(Math.abs(value) * 10) / 10}° ${value < 0 ? "S" : value > 0 ? "N" : ""}`.trim();
}

/** The smaller side of a sampled cell, in degrees, when known. */
function cellSpacing(
  cell: { footprint?: { lat: number; lon: number } } | undefined
) {
  const f = cell?.footprint;
  return f ? Math.min(f.lat, f.lon) : undefined;
}

/**
 * The name of a time × vertical plot after the coordinate it shows:
 * Time–pressure, Time–depth, Time–height or Time–model level.
 */
export function timeVerticalName(
  vertical: { physical: boolean; label: string; units?: string } | undefined,
  first = "Time"
) {
  if (!vertical) {
    return `${first}–vertical coordinate`;
  }
  return `${first}–${verticalQuantity(vertical)}`;
}

/**
 * The quantity a vertical axis is in, by its own description: pressure, depth,
 * altitude, height, potential temperature… or model level.
 */
export function verticalQuantity(vertical: {
  physical: boolean;
  label: string;
  units?: string;
}) {
  if (!vertical.physical) {
    return "model level";
  }
  const text = `${vertical.label} ${vertical.units ?? ""}`.toLowerCase();
  if (/potential_temperature|potential temperature/.test(text)) {
    return "potential temperature";
  }
  if (/pressure|\b(pa|pascals?|hpa|kpa|mbar|bar|dbar)\b/.test(text)) {
    return "pressure";
  }
  if (/depth/.test(text)) {
    return "depth";
  }
  if (/altitude/.test(text)) {
    return "altitude";
  }
  if (/height/.test(text)) {
    return "height";
  }
  // Another declared quantity (potential density…): its own name.
  const named = /^([a-z_]+)\s*\(/.exec(vertical.label.trim())?.[1];
  return named && named.includes("_")
    ? named.replace(/^(sea_water|air|ocean)_/, "").replace(/_/g, " ")
    : "vertical coordinate";
}

/** Heatmap spec of a time–depth or Hovmöller result. */
// eslint-disable-next-line max-lines-per-function
export function heatmapSpec(result: TAnalysisResult): THeatmapSpec | undefined {
  // A latitude × vertical section has no time axis to draw (one date).
  if (
    !result.axis ||
    !result.time ||
    result.kind === ANALYSIS_KINDS.LAT_VERTICAL ||
    result.kind === ANALYSIS_KINDS.LON_VERTICAL
  ) {
    return undefined;
  }
  const name = result.query.variable.split("/").pop() ?? result.query.variable;
  const valueTitle = axisQuantity(name, result.longName, result.units);
  const axis = result.axis;
  const common = {
    values: result.values,
    time: {
      raw: result.time.raw,
      units: result.time.units,
      calendar: result.time.calendar,
      dimension: result.time.dimension,
      standardName: result.time.standardName,
      bounds: result.time.bounds,
    },
    valueTitle,
    units: result.units,
    unreadFrom: result.partial
      ? rowsUntil(result.query.time, result.partial.readUntil)
      : undefined,
  };
  switch (result.kind) {
    case ANALYSIS_KINDS.TIME_DEPTH: {
      // The axis title names the values drawn: physical levels, or model
      // level indices when there are none.
      const physical = Boolean(result.vertical?.physical);
      const native = nativeLevels(result.vertical);
      return {
        ...common,
        axis: {
          values: physical
            ? axis.values
            : (native ?? axis.values.map((_, k) => k)),
          // Published layer bounds are drawn as given: joined layers as
          // edges, independently bounded ones each on its own interval.
          bounds: physical
            ? (edgesFromBounds(result.vertical?.bounds, axis.values.length) ??
              (layerSpans(result.vertical?.bounds, axis.values.length)
                ? result.vertical!.bounds
                : undefined))
            : undefined,
          title: verticalTitle(result.vertical),
          reverse: physical && result.vertical?.positive === "down",
        },
        timeOn: "x",
        description: `${timeVerticalName(result.vertical)}: ${valueTitle} by time and ${verticalTitle(result.vertical)}`,
      };
    }
    case ANALYSIS_KINDS.HOVMOLLER_LAT:
      return {
        ...common,
        axis: {
          values: axis.values,
          bounds: axis.bounds,
          title: "Latitude",
          format: latLabel,
        },
        timeOn: "x",
        description: `${valueTitle}: ${axis.reduction}`,
      };
    case ANALYSIS_KINDS.HOVMOLLER_LON:
      return {
        ...common,
        axis: {
          values: axis.values,
          bounds: axis.bounds,
          title: "Longitude",
          format: lonLabel,
        },
        timeOn: "y",
        description: `${valueTitle}: ${axis.reduction}`,
      };
    default:
      return {
        ...common,
        axis: {
          values: axis.values.map((d) => d / 1000),
          // Sample cells end at the path's ends: nothing before 0 or past
          // its length (midpoints between samples inside).
          bounds: pathEdges(axis.values.map((d) => d / 1000)),
          title: "Distance along path (km)",
          marks: axisMarks(result.samples?.vertices, 1 / 1000),
        },
        timeOn: "y",
        description: `${valueTitle} along the path over time`,
      };
  }
}

/**
 * One date of a time × axis plot as a line: the path trace on that date
 * (distance × time), the profile (time–depth), or the band or sector mean
 * by longitude or latitude. The values are the plot's own row.
 */
export function sliceSpec(
  result: TAnalysisResult,
  row: number
): TSeriesSpec | undefined {
  const heat = heatmapSpec(result);
  if (!heat || !result.axis || row < 0 || row >= heat.time.raw.length) {
    return undefined;
  }
  const n = heat.axis.values.length;
  const y = result.values.slice(row * n, row * n + n);
  const units = result.units ? ` ${result.units}` : "";
  const profile = result.kind === ANALYSIS_KINDS.TIME_DEPTH;
  const samples = result.samples;
  // Profiles put values on x and levels on y, like the profile plot.
  return {
    mode: profile ? "profile" : "path",
    x: profile ? y : heat.axis.values,
    y: profile ? heat.axis.values : y,
    xTitle: profile ? heat.valueTitle : heat.axis.title,
    yTitle: profile ? heat.axis.title : heat.valueTitle,
    invertY: profile && heat.axis.reverse,
    marks: profile ? undefined : heat.axis.marks,
    status:
      result.kind === ANALYSIS_KINDS.HOVMOLLER_PATH
        ? samples?.status
        : undefined,
    readout: (at) => [
      heat.axis.format
        ? heat.axis.format(heat.axis.values[at])
        : `${formatValue(heat.axis.values[at])}${heat.axis.marks ? " km" : ""}`,
      Number.isNaN(y[at])
        ? samples?.status[at] && samples.status[at] !== "ok"
          ? samples.status[at]
          : "missing"
        : `${formatValue(y[at])}${units}`,
    ],
  };
}

function percent(value: number) {
  return Number.isNaN(value) ? "unknown" : `${Math.round(value * 100)} %`;
}

/** The time axis of a series, named with its calendar. */
/**
 * What the time axis holds: forecasts plotted along their reference times say
 * so.
 */
export function timeWord(time: { standardName?: string }) {
  return time.standardName === "forecast_reference_time"
    ? "Initialization time"
    : "Time";
}

function timeTitle(result: TAnalysisResult) {
  const time = result.time!;
  // Only a decodable reference earns a calendar title; otherwise the raw
  // values are drawn and the title says so, with the units as written.
  const decodable =
    time.units !== undefined &&
    !("unsupported" in parseTimeAxis(time.units, time.calendar));
  return decodable
    ? `${timeWord(time)} (${time.calendar ?? "standard"} calendar)`
    : `${time.dimension} (raw values${time.units ? `, ${time.units}` : ""})`;
}

function seriesReadout(result: TAnalysisResult, valueName: string) {
  const units = result.units ? ` ${result.units}` : "";
  const threshold = result.query.minCoverage;
  return (at: number) => {
    const value = result.values[at];
    const lines = [
      timeLabelAt(result.time, at),
      `${valueName}: ${Number.isNaN(value) ? "missing" : `${formatValue(value)}${units}`}`,
    ];
    const spread = result.region?.spread;
    if (spread && Number.isFinite(spread.std[at])) {
      lines.push(
        `σ ${formatValue(spread.std[at])}, min ${formatValue(spread.min[at])}, max ${formatValue(spread.max[at])}${units}`
      );
    }
    const coverage = result.region?.coverage[at];
    if (coverage !== undefined) {
      const hidden = threshold !== undefined && coverage < threshold;
      const unweighed = result.region?.unweighedCells;
      // A mean of sites covers sites, not an area.
      lines.push(
        `${result.region?.sites ? "Valid sites" : "Valid area"} ${percent(coverage)}${unweighed ? ` of the cells with an area (${unweighed.toLocaleString("en-US")} without one left out)` : ""}${hidden ? `, below ${percent(threshold)} threshold; mean hidden (kept in Data)` : ""}`
      );
    }
    return lines;
  };
}

/**
 * The band around an area mean: mean ± σ, or the cells' min–max. Times
 * whose mean is hidden (below the threshold) have no band either.
 */
function spreadBand(result: TAnalysisResult, view?: TSpreadView) {
  const spread = result.region?.spread;
  if (!spread || !view) {
    return undefined;
  }
  const threshold = result.query.minCoverage;
  const shown = (at: number) =>
    threshold === undefined || !(result.region!.coverage[at] < threshold);
  const pick = (f: (at: number) => number) =>
    result.values.map((_, at) => (shown(at) ? f(at) : Number.NaN));
  return view === SPREAD_VIEWS.STD
    ? {
        lower: pick((at) => result.values[at] - spread.std[at]),
        upper: pick((at) => result.values[at] + spread.std[at]),
        label: "Mean ± 1σ",
      }
    : {
        lower: pick((at) => spread.min[at]),
        upper: pick((at) => spread.max[at]),
        label: "Min–max",
      };
}

/** Chart spec for a series, profile or path result. */
/**
 * A series as shown: means below the plot's minimum coverage are hidden
 * (kept in Data), as are rows from `unreadFrom` on. Compare uses these.
 */
export function shownValues(result: TAnalysisResult, unreadFrom?: number) {
  const coverage = result.region?.coverage;
  const threshold = result.query.minCoverage;
  if (!coverage || threshold === undefined) {
    return result.values;
  }
  const values = result.values;
  return grownPrefix(
    [coverage, values, threshold],
    unreadFrom ?? values.length,
    (at) => (coverage[at] < threshold ? Number.NaN : values[at])
  );
}

/**
 * A derived column of the first `length` rows, kept per input and grown as rows
 * are read: the same array, only the new rows made. Made anew when an input or
 * the threshold changes, or the rows shrink.
 */
export function grownPrefix(
  inputs: [object, ...unknown[]],
  length: number,
  make: (at: number) => number
) {
  const [first, ...rest] = inputs;
  const entries = grown.get(first) ?? [];
  const kept = entries.find(
    (entry) =>
      entry.rest.length === rest.length &&
      entry.rest.every((part, k) => Object.is(part, rest[k]))
  );
  if (kept && kept.out.length <= length) {
    for (let at = kept.out.length; at < length; at++) {
      kept.out.push(make(at));
    }
    return kept.out;
  }
  const out = Array.from({ length }, (_, at) => make(at));
  // A few views of one input at once (the coverage strip above and below).
  grown.set(first, [
    { rest, out },
    ...entries.filter((entry) => entry !== kept).slice(0, 3),
  ]);
  return out;
}
const grown = new WeakMap<object, { rest: unknown[]; out: number[] }[]>();

/**
 * The Count view's first threshold: the 90th percentile, to two figures, of the
 * values as plotted.
 */
export function countThreshold(result: TAnalysisResult | undefined) {
  const values = result ? shownValues(result) : [];
  return Number((percentileOfValues(values, 0.9) || 0).toPrecision(2));
}

/**
 * Whether a path's samples change latitude, so they can be drawn against it.
 */
export function latitudeVaries(result: TAnalysisResult) {
  const lats = result.samples?.lats ?? [];
  return lats.some((lat) => Math.abs(lat - lats[0]) > 1e-9);
}

/** Whether a path's latitudes only rise or only fall (no turn). */
export function latitudeMonotonic(result: TAnalysisResult) {
  const lats = result.samples?.lats ?? [];
  const rising = lats.every((lat, k) => k === 0 || lat > lats[k - 1]);
  const falling = lats.every((lat, k) => k === 0 || lat < lats[k - 1]);
  return lats.length > 1 && (rising || falling);
}

// eslint-disable-next-line max-lines-per-function
export function chartSpec(
  result: TAnalysisResult,
  spreadView?: TSpreadView,
  /** A path drawn against latitude, in the order it was sampled. */
  pathAxis?: "latitude"
): TSeriesSpec | undefined {
  const name = result.query.variable.split("/").pop() ?? result.query.variable;
  const valueName = result.longName || name;
  const yTitle = axisQuantity(name, result.longName, result.units);
  const units = result.units ? ` ${result.units}` : "";
  if (
    result.time &&
    (result.kind === ANALYSIS_KINDS.POINT_SERIES ||
      result.kind === ANALYSIS_KINDS.REGION_SERIES)
  ) {
    const threshold = result.query.minCoverage;
    const unreadFrom = result.partial
      ? rowsUntil(result.query.time, result.partial.readUntil)
      : undefined;
    return {
      mode: "time",
      x: result.time.raw,
      y: shownValues(result, unreadFrom),
      xTitle: timeTitle(result),
      // Sites are averaged with equal weights: no area mean.
      yTitle: result.region
        ? `${result.region.sites ? "Site mean" : "Area mean"} ${yTitle}`
        : yTitle,
      units: result.units,
      time: {
        units: result.time.units,
        calendar: result.time.calendar,
        dimension: result.time.dimension,
      },
      readout: seriesReadout(result, valueName),
      coverage: result.region && {
        values: result.region.coverage,
        threshold,
        ...(result.region.sites ? { sites: true } : {}),
      },
      band: spreadBand(result, spreadView),
      // An index: rows from here on (in file order) were not read.
      unreadFrom,
    };
  }
  if (result.kind === ANALYSIS_KINDS.PROFILE && result.vertical) {
    const v = result.vertical;
    const levels = v.values.length ? v.values : result.values.map((_, k) => k);
    const native = nativeLevels(v);
    return {
      mode: "profile",
      x: result.values,
      y: v.physical ? levels : (native ?? result.values.map((_, k) => k)),
      xTitle: yTitle,
      yTitle: verticalTitle(v),
      invertY: v.positive === "down",
      readout: (k) => [
        v.physical
          ? `${verticalTitle(v).replace(/\s*\(.*\)$/, "")} ${formatValue(levels[k])}${v.units ? ` ${v.units}` : ""}`
          : native
            ? `Model level ${k} (${formatValue(native[k])})`
            : `Model level ${k}`,
        `${valueName}: ${Number.isNaN(result.values[k]) ? "missing" : `${formatValue(result.values[k])}${units}`}`,
      ],
    };
  }
  if (result.histogram) {
    // Each bar is drawn from its own two edges at its own height: points
    // (left, h) and (right, h) per bin, joined, so no bar takes a
    // neighbour's height whatever the line interpolation.
    const h = result.histogram;
    const n = result.values.length;
    return {
      mode: "histogram",
      x: Array.from(
        { length: 2 * n },
        (_, at) => h.edges[(at >> 1) + (at & 1)]
      ),
      y: Array.from({ length: 2 * n }, (_, at) => result.values[at >> 1] * 100),
      xTitle: yTitle,
      yTitle: "Share of valid area (%)",
      readout: (at) => {
        const bin = Math.min(at >> 1, n - 1);
        return h.constant !== undefined
          ? [
              `All valid values are ${formatValue(h.constant)}${units}`,
              "100 % of valid area",
            ]
          : [
              `${formatValue(h.edges[bin])} to ${formatValue(h.edges[bin + 1])}${units}`,
              `${formatValue(result.values[bin] * 100)} % of valid area`,
            ];
      },
    };
  }
  if (result.sectionMode === SECTION_MODES.PATH && result.samples) {
    const samples = result.samples;
    // Against latitude, the samples as read: a turning track is drawn as
    // walked, not folded into latitude order.
    const byLatitude = pathAxis === "latitude" && latitudeVaries(result);
    return {
      mode: "path",
      x: byLatitude
        ? [...samples.lats]
        : samples.distances.map((d) => d / 1000),
      y: result.values,
      status: samples.status,
      xTitle: byLatitude
        ? "Latitude (degrees_north)"
        : "Distance along path (km)",
      ...(byLatitude ? { along: [...samples.distances] } : {}),
      ...(byLatitude ? {} : { marks: axisMarks(samples.vertices, 1 / 1000) }),
      yTitle,
      readout: (s) => [
        `${formatValue(samples.distances[s] / 1000)} km — ${samples.lats[s].toFixed(3)}°, ${samples.lons[s].toFixed(3)}°`,
        `${valueName}: ${Number.isNaN(result.values[s]) ? samples.status[s] : `${formatValue(result.values[s])}${units}`}`,
        samples.cells[s] ? `Cell ${samples.cells[s]}` : "No stored cell",
      ],
    };
  }
  return undefined;
}

/** "Point time series — 48.30° N, 16.20° W — depth 5 m". */
export function selectionSubtitle(
  w: TPlotWindow,
  query: Omit<TAnalysisQuery, "source"> | undefined
) {
  const geometry = query?.geometry ?? w.draft.geometry;
  const shownSummary = displayedSummary(w);
  const place =
    geometry.kind === GEOMETRY_KINDS.BOX &&
    w.kind === ANALYSIS_KINDS.HOVMOLLER_LON
      ? `${latLabel(geometry.south)}–${latLabel(geometry.north)} band mean, ${lonSpanText(geometry.west, geometry.east, false)}`
      : geometry.kind === GEOMETRY_KINDS.BOX &&
          w.kind === ANALYSIS_KINDS.HOVMOLLER_LAT
        ? `${lonLabel(geometry.west)}–${lonLabel(geometry.east)} sector mean`
        : geometry.kind === GEOMETRY_KINDS.BOX &&
            w.kind === ANALYSIS_KINDS.LAT_VERTICAL
          ? `mean over ${lonLabel(geometry.west)}–${lonLabel(geometry.east)}, ${latLabel(geometry.south)}–${latLabel(geometry.north)}`
          : geometry.kind === GEOMETRY_KINDS.BOX &&
              w.kind === ANALYSIS_KINDS.LON_VERTICAL
            ? `mean over ${latLabel(geometry.south)}–${latLabel(geometry.north)}, ${lonSpanText(geometry.west, geometry.east, false)}`
            : describeGeometry(geometry, cellSpacing(w.result?.cell));
  // A time × vertical plot is named after the coordinate it shows.
  const name =
    w.kind === ANALYSIS_KINDS.TIME_DEPTH && w.result?.vertical
      ? timeVerticalName(w.result.vertical)
      : w.kind === ANALYSIS_KINDS.LAT_VERTICAL && w.result?.vertical
        ? timeVerticalName(w.result.vertical, "Latitude")
        : w.kind === ANALYSIS_KINDS.LON_VERTICAL && w.result?.vertical
          ? timeVerticalName(w.result.vertical, "Longitude")
          : PLOT_KIND_NAMES[w.kind];
  const parts = [name, place];
  const time = shownSummary?.time;
  const range = query?.time;
  const single = !TIME_RANGE_KINDS.includes(w.kind);
  // The displayed result's own date, when it is the one described.
  const own = w.result && w.result.query === query ? w.result.time : undefined;
  if (single && own?.raw.length) {
    parts.push(timeLabelAt(own, 0));
  } else if (time && range && single) {
    parts.push(timeLabelAt(time, range.start));
  }
  const level = levelText(shownSummary?.vertical, query?.level, formatValue);
  if (level && FIXED_LEVEL_KINDS.includes(w.kind)) {
    parts.push(level);
  }
  return parts.join(" — ");
}

/** Chunks of one date read so far. */
function chunkPartText(partial: NonNullable<TAnalysisResult["partial"]>) {
  return `${partial.done.toLocaleString("en-US")} of ${partial.total.toLocaleString("en-US")} chunks read`;
}

/** Progress on the requested time axis, including dates whose measured value is missing. */
export function readThroughText(result: TAnalysisResult | undefined) {
  if (result?.partial?.chunks) {
    return chunkPartText(result.partial);
  }
  if (!result?.partial || !result.time) {
    return "";
  }
  const total = result.time.raw.length;
  const read = Math.max(
    0,
    Math.min(total, rowsUntil(result.query.time, result.partial.readUntil))
  );
  const counts = `${read.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} time steps read`;
  return read
    ? `${counts} — through ${timeLabelAt(result.time, read - 1)}`
    : counts;
}

/** Status line of a partial result, for the window and exported figures. */
export function partialText(result: TAnalysisResult | undefined) {
  const partial = result?.partial;
  // One date part way through its chunks: counted by them, not as "0 of 1
  // dates".
  if (partial?.chunks) {
    return `Partial: ${chunkPartText(partial)}; cells not read yet are blank`;
  }
  if (!partial || !result?.time) {
    return "";
  }
  const at = rowsUntil(result.query.time, partial.readUntil);
  const raw = result.time.raw;
  if (at >= raw.length) {
    return "";
  }
  const label = (k: number) => timeLabelAt(result.time, k);
  const ascending = raw.length < 2 || raw[raw.length - 1] >= raw[0];
  // Dates of the time axis, not request parts (a part can hold many dates).
  const dates = `${Math.max(0, at).toLocaleString("en-US")} of ${raw.length.toLocaleString("en-US")} dates read`;
  return ascending
    ? `Partial: ${dates}; not read from ${label(at)}`
    : `Partial: ${dates}; not read: ${label(at)} back to ${label(raw.length - 1)}`;
}

const HEADER_NAMES: Record<string, string> = {
  time_index: "Index", // eslint-disable-line camelcase
  status: "Status",
  coverage: "Valid area (%)",
  site_coverage: "Valid sites (%)", // eslint-disable-line camelcase
  valid_sites: "Valid sites", // eslint-disable-line camelcase
  selected_sites: "Selected sites", // eslint-disable-line camelcase
  valid_cells: "Valid cells", // eslint-disable-line camelcase
  selected_cells: "Selected cells", // eslint-disable-line camelcase
  area_std: "Std. dev.", // eslint-disable-line camelcase
  area_min: "Min", // eslint-disable-line camelcase
  area_max: "Max", // eslint-disable-line camelcase
  site_std: "Std. dev. of sites", // eslint-disable-line camelcase
  site_min: "Min of sites", // eslint-disable-line camelcase
  site_max: "Max of sites", // eslint-disable-line camelcase
  sample: "Sample",
  distance_m: "Distance (km)", // eslint-disable-line camelcase
  lat: "Latitude (°)",
  lon: "Longitude (°)",
  cell: "Cell",
  level_index: "Level index", // eslint-disable-line camelcase
};

function readableHeader(header: string) {
  if (HEADER_NAMES[header]) {
    return HEADER_NAMES[header];
  }
  const time = /^time \((.*)\)$/.exec(header);
  if (time) {
    return `Time (${time[1]})`;
  }
  return header;
}

export const TABLE_ROWS = 500;

/**
 * The data view: readable headers with units, the first rows formatted,
 * missing values explicit and below-threshold means identified.
 */

// eslint-disable-next-line max-lines-per-function
export function dataView(
  result: TAnalysisResult,
  /**
   * What the chart draws when it is not the source values (an anomaly, a
   * running mean, a total): a column of its own beside them.
   */
  plotted?: { title: string; values: number[] }
) {
  const table = resultTable(result);
  const columns = table.header.map(readableHeader);
  const extra =
    plotted && plotted.values.length === table.rowCount ? plotted : undefined;
  if (extra) {
    columns.push(`Plotted: ${extra.title}`);
  }
  const statusAt = table.header.indexOf("status");
  const coverageAt = Math.max(
    table.header.indexOf("coverage"),
    table.header.indexOf("site_coverage")
  );
  const distanceAt = table.header.indexOf("distance_m");
  const threshold = result.query.minCoverage;
  const rows: string[][] = [];
  const count = Math.min(TABLE_ROWS, table.rowCount);
  for (let at = 0; at < count; at++) {
    const raw = table.row(at);
    const row = raw.map((cell, c) => {
      if (typeof cell !== "number") {
        return String(cell);
      }
      if (Number.isNaN(cell)) {
        return "—";
      }
      if (c === coverageAt) {
        return formatValue(cell * 100);
      }
      if (c === distanceAt) {
        return formatValue(cell / 1000);
      }
      return formatValue(cell);
    });
    const coverage = coverageAt >= 0 ? (raw[coverageAt] as number) : NaN;
    if (
      statusAt >= 0 &&
      threshold !== undefined &&
      coverage < threshold &&
      row[statusAt] === "ok"
    ) {
      row[statusAt] = "below threshold (hidden on chart)";
    }
    if (extra) {
      const v = extra.values[at];
      row.push(Number.isFinite(v) ? formatValue(v) : "—");
    }
    rows.push(row);
  }
  const numeric = table.header.map(
    (header) => !["status", "cell"].includes(header) && !/^time \(/.test(header)
  );
  if (extra) {
    numeric.push(true);
  }
  return { columns, rows, total: table.rowCount, numeric };
}

/** Cell edges between samples, clamped to the first and last sample. */
function pathEdges(values: number[]) {
  const n = values.length;
  if (n < 2) {
    return undefined;
  }
  const edges = [values[0]];
  for (let at = 1; at < n; at++) {
    edges.push((values[at - 1] + values[at]) / 2);
  }
  edges.push(values[n - 1]);
  return edges;
}

/** The finite values' span, with a little room when they are all one. */
export function finiteSpan(values: number[]) {
  let [min, max] = [Infinity, -Infinity];
  for (const v of values) {
    if (Number.isFinite(v)) {
      [min, max] = [Math.min(min, v), Math.max(max, v)];
    }
  }
  if (!(max >= min)) {
    return {};
  }
  return max > min ? { min, max } : { min: min - 1, max: max + 1 };
}
