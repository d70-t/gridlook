/**
 * What a distribution draws over its bars and says beside them: the
 * smoothed curve (and a normal curve of the same mean and σ for
 * comparison), the middle 95 % of the valid area, the median and the mean.
 */
import { percentileAt } from "@/lib/analysis/distributionStats.ts";
import type { TAnalysisResult } from "@/lib/analysis/types.ts";
import { formatValue } from "@/utils/formatValue.ts";

export const CURVE_VIEWS = ["density", "both", "none", "cdf"] as const;
export type TCurveView = (typeof CURVE_VIEWS)[number];

export const CURVE_NAMES: Record<TCurveView, string> = {
  density: "Smoothed",
  both: "Smoothed and normal",
  none: "Bars only",
  cdf: "Cumulative (CDF)",
};

/**
 * Central ranges offered, in percent of the valid area, with the
 * percentiles that bound them. 95 % is the default; 90 % (5th–95th) is
 * IPCC's "very likely" range and P95 the usual extremes threshold.
 */
export const CENTRAL_RANGES = [50, 80, 90, 95, 99] as const;
export const DEFAULT_RANGE = 95;

/**
 * A central range with its bounding percentiles: 95 → "95 % (2.5th–97.5th)".
 * Every bound of CENTRAL_RANGES takes "th" (5th, 25th, 97.5th, …).
 */
export function rangeName(percent: number) {
  const tail = (100 - percent) / 2;
  return `${percent} % (${formatValue(tail)}th–${formatValue(100 - tail)}th)`;
}

export type TDistributionMarks = {
  /** Curves in the bars' units (% of valid area per bin). */
  curves: { label: string; x: number[]; y: number[]; dashed?: boolean }[];
  /** The central range: its share of the valid area and bounding values. */
  range: {
    percent: number;
    low: number;
    high: number;
    /** The area strictly below `low` and above `high`, in percent. */
    below: number;
    above: number;
  };
  median: number;
  mean: number;
  /** A value whose share of the area above it is shown, and that share. */
  above?: { value: number; share: number };
};

type THistogram = NonNullable<TAnalysisResult["histogram"]>;

/** The normal density of `mean` and `std` at `x`. */
function normal(x: number, mean: number, std: number) {
  const z = (x - mean) / std;
  return Math.exp(-0.5 * z * z) / (std * Math.sqrt(2 * Math.PI));
}

/** The marks for a histogram, or undefined without a summary. */
export function distributionMarks(
  h: THistogram,
  view: TCurveView,
  percent: number = DEFAULT_RANGE,
  aboveValue?: number
): TDistributionMarks | undefined {
  const s = h.summary;
  if (!s) {
    return undefined;
  }
  // A density (per unit of value) times the bin width is a share per bin;
  // in percent, the bars' own units.
  const bins = h.edges.length - 1;
  // Divided first: the range of a field at ±1e308 overflows.
  const perBin = (h.edges[bins] / bins - h.edges[0] / bins) * 100;
  const curves: TDistributionMarks["curves"] = [];
  const density = s.density;
  if (density && (view === "density" || view === "both")) {
    curves.push({
      label: "curve smoothed",
      x: density.x,
      y: density.y.map((value) => value * perBin),
    });
  }
  if (density && view === "both" && s.std > 0) {
    curves.push({
      label: "curve normal",
      x: density.x,
      y: density.x.map((x) => normal(x, h.mean, s.std) * perBin),
      dashed: true,
    });
  }
  return {
    curves,
    range: {
      percent,
      low: percentileAt(s.percentiles, (100 - percent) / 2),
      high: percentileAt(s.percentiles, (100 + percent) / 2),
      ...tailShares(s.percentiles, percent),
    },
    median: percentileAt(s.percentiles, 50),
    ...(aboveValue !== undefined && Number.isFinite(aboveValue)
      ? {
          above: {
            value: aboveValue,
            share: 1 - shareBelow(s.percentiles, aboveValue),
          },
        }
      : {}),
    mean: h.mean,
  };
}

/** Skewness in words: which side the long tail is on. */
export function skewWords(skewness: number) {
  if (!Number.isFinite(skewness) || Math.abs(skewness) < 0.5) {
    return "roughly symmetric";
  }
  return skewness > 0 ? "long tail to high values" : "long tail to low values";
}

/** The central range's bounds and the median. */
function bounds(s: NonNullable<THistogram["summary"]>, percent: number) {
  return [
    percentileAt(s.percentiles, (100 - percent) / 2),
    percentileAt(s.percentiles, 50),
    percentileAt(s.percentiles, (100 + percent) / 2),
  ];
}

/**
 * The area strictly outside the central range, each side, in percent (to
 * the half percent of the percentiles): tied values at the range's ends
 * belong to the range, so 99 % zeros and 1 % ones give 0 % below and 1 %
 * above their [0, 0], not the nominal 2.5 % each.
 */
function tailShares(percentiles: number[], percent: number) {
  const n = percentiles.length - 1;
  const low = percentileAt(percentiles, (100 - percent) / 2);
  const high = percentileAt(percentiles, (100 + percent) / 2);
  let below = 0;
  let above = 0;
  for (const value of percentiles) {
    below += value < low ? 1 : 0;
    above += value > high ? 1 : 0;
  }
  return { below: (100 * below) / n, above: (100 * above) / n };
}

/** Short, for the window: mean, median, σ and the central range. */
export function summaryChip(
  h: THistogram,
  units?: string,
  percent: number = DEFAULT_RANGE
) {
  const s = h.summary;
  if (!s) {
    return "";
  }
  const [low, median, high] = bounds(s, percent);
  return `Mean ${formatValue(h.mean)}, median ${formatValue(median)}, σ ${formatValue(s.std)}, ${percent} %: ${formatValue(low)}–${formatValue(high)}${units ? ` ${units}` : ""}`;
}

/** One line: mean, median, σ, the central range, its tails and the skew. */
export function summaryText(
  h: THistogram,
  units?: string,
  percent: number = DEFAULT_RANGE
) {
  const s = h.summary;
  if (!s) {
    return "";
  }
  const u = units ? ` ${units}` : "";
  const [low, median, high] = bounds(s, percent);
  const tails = tailShares(s.percentiles, percent);
  // Values tied at its ends can put clearly more than the nominal share
  // inside the range (a cell's own share, a few tenths, is not that).
  const inside = 100 - tails.below - tails.above;
  const range =
    inside > percent + 1
      ? `${percent} % range (${formatValue((100 - percent) / 2)}th to ${formatValue((100 + percent) / 2)}th percentile) ${formatValue(low)} to ${formatValue(high)}${u}; values tied at its ends put ${formatValue(inside)} % of the area in it`
      : `${percent} % of the area between ${formatValue(low)} and ${formatValue(high)}${u}`;
  return [
    `Mean ${formatValue(h.mean)}${u}`,
    `median ${formatValue(median)}${u}`,
    `σ ${formatValue(s.std)}${u}`,
    `${range} (${formatValue(tails.below)} % below, ${formatValue(tails.above)} % above)`,
    `skewness ${formatValue(s.skewness)} (${skewWords(s.skewness)})`,
  ].join("; ");
}

/**
 * The share of the valid area below `value` (0–1), interpolated between
 * the percentiles (every 0.5 %): within half a percent of the exact share.
 */
export function shareBelow(percentiles: number[], value: number) {
  const n = percentiles.length - 1;
  if (!(n > 0) || !Number.isFinite(value)) {
    return Number.NaN;
  }
  if (value < percentiles[0]) {
    return 0;
  }
  if (value >= percentiles[n]) {
    return 1;
  }
  let k = 0;
  while (k < n && percentiles[k + 1] <= value) {
    k++;
  }
  const span = percentiles[k + 1] - percentiles[k];
  const within = span > 0 ? (value - percentiles[k]) / span : 0;
  return (k + within) / n;
}

/** "Above 10 m s-1: ≈ 23 % of the area", for the window and caption. */
export function shareAboveText(h: THistogram, value: number, units?: string) {
  const s = h.summary;
  if (!s || !Number.isFinite(value)) {
    return "";
  }
  const above = 1 - shareBelow(s.percentiles, value);
  return `Above ${formatValue(value)}${units ? ` ${units}` : ""}: ≈ ${formatValue(Math.round(above * 1000) / 10)} % of the area`;
}

/**
 * The cumulative distribution: the share of the valid area below each
 * value (from the percentiles), 0 to 100 %.
 */
export function cdfPoints(h: THistogram) {
  const s = h.summary;
  if (!s) {
    return undefined;
  }
  const n = s.percentiles.length - 1;
  return {
    x: s.percentiles,
    y: s.percentiles.map((_, k) => (100 * k) / n),
  };
}

/** A labelled value line over a distribution: its tag and its look. */
export type TValueTag = {
  value: number;
  label: string;
  /** "median" solid dark, "mean" dashed amber, "both" solid with a dash. */
  style: "median" | "mean" | "both";
  left: boolean;
};

/**
 * The median and mean tags. When they coincide (equal as written, or under
 * 3 px apart on the chart) one tag names both, so two labels never stack
 * on one line; otherwise the lower is tagged to the left of its line.
 */
export function valueTags(
  marks: { median: number; mean: number },
  pixel: (value: number) => number
): TValueTag[] {
  const median = formatValue(marks.median);
  const mean = formatValue(marks.mean);
  if (
    median === mean ||
    Math.abs(pixel(marks.median) - pixel(marks.mean)) < 3
  ) {
    return [
      {
        value: marks.median,
        label:
          median === mean
            ? `mean = median ${median}`
            : `median ${median}, mean ${mean}`,
        style: "both",
        left: false,
      },
    ];
  }
  const medianFirst = marks.median <= marks.mean;
  return [
    {
      value: marks.median,
      label: `median ${median}`,
      style: "median",
      left: medianFirst,
    },
    {
      value: marks.mean,
      label: `mean ${mean}`,
      style: "mean",
      left: !medianFirst,
    },
  ];
}
