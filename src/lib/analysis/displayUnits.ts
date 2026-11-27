/**
 * Showing a plot in other units than the file's (Settings → Display): a
 * temperature in °C, precipitation in mm/day, wind in km/h. Only what is
 * drawn and read out changes; nothing is read again, and the data exports
 * keep the file's units.
 */
import { parseCellMethods } from "./cellMethods.ts";
import { ANALYSIS_KINDS, type TAnalysisResult } from "./types.ts";
import { converter, sameUnits } from "./unitConvert.ts";

/** Units offered for each quantity, in the order shown. */
const TEMPERATURES = [
  { units: "K", label: "K" },
  { units: "degC", label: "°C" },
  { units: "degF", label: "°F" },
];
const WATER = [
  { units: "kg m-2 s-1", label: "kg m-2 s-1" },
  { units: "mm h-1", label: "mm/h" },
  { units: "mm day-1", label: "mm/day" },
];
const SPEEDS = [
  { units: "m s-1", label: "m/s" },
  { units: "km h-1", label: "km/h" },
  { units: "knots", label: "knots" },
  { units: "mph", label: "mph" },
];
const CHOICES: { units: string; label: string }[][] = [
  TEMPERATURES,
  // Speeds before water rates: mm/s alone is a velocity (rateKind).
  SPEEDS,
  WATER,
  [
    { units: "Pa", label: "Pa" },
    { units: "hPa", label: "hPa" },
    { units: "kPa", label: "kPa" },
  ],
  [
    { units: "m", label: "m" },
    { units: "cm", label: "cm" },
    { units: "mm", label: "mm" },
    { units: "km", label: "km" },
  ],
];

/**
 * The units a plot in `units` can be shown in: the file's own first, then
 * the others of its quantity. Empty when there is nothing to choose.
 */
export function unitChoices(
  units: string | undefined,
  metadata?: string,
  /** What the field is, when known (rateKind): decides mm/s. */
  kind?: TRateKind
) {
  if (!units) {
    return [];
  }
  const meta = { from: metadata, to: metadata };
  const fits = (list: { units: string }[]) =>
    list.some((choice) => converter(units, choice.units, meta));
  // A water-equivalent rate is a precipitation's (or evaporation's); a mass
  // flux of something else has no depth per time, a current no mm/day. A known
  // speed (a current in mm/day) is offered speeds only.
  const group =
    kind === "water" && fits(WATER)
      ? WATER
      : kind === "speed"
        ? fits(SPEEDS)
          ? SPEEDS
          : undefined
        : kind === "other" && fits(WATER) && !fits(SPEEDS)
          ? undefined
          : CHOICES.find(fits);
  if (!group) {
    return [];
  }
  const others = group.filter(
    (choice) =>
      converter(units, choice.units, meta) &&
      // The file's own unit under another spelling is not a choice; °C beside a
      // difference in K is, though the numbers stay.
      !sameUnits(units, choice.units)
  );
  // Nothing else it converts to (a temperature of unknown scale): no choice.
  return others.length
    ? [{ units, label: `${units} (as stored)` }, ...others]
    : [];
}

/**
 * How a series is drawn unless chosen: bars for precipitation (a flux of
 * mass, or a variable named as one), a line otherwise.
 */
export function defaultChartStyle(
  variable: string | undefined,
  units: string | undefined,
  standardName?: string
): "line" | "bars" {
  const kind = rateKind(variable, standardName);
  const flux =
    kind !== "speed" &&
    kind !== "other" &&
    Boolean(units && converter(units, "kg m-2 s-1")) &&
    // mm/s alone is a velocity unless the field says water.
    (kind === "water" || !(units && converter(units, "m s-1")));
  return flux || kind === "water" ? "bars" : "line";
}

export type TRateKind = "water" | "speed" | "other";

/**
 * What a rate in mm/s (or a mass flux) is: water (precipitation,
 * evaporation, runoff: mm/day is a depth of water), a speed (a velocity,
 * a current, a wind), or another quantity (a carbon flux); undefined when
 * neither name tells. The standard name decides when given.
 */
export function rateKind(
  variable: string | undefined,
  standardName?: string
): TRateKind | undefined {
  const name = standardName?.trim() ?? "";
  if (name) {
    if (/velocity|_wind\b|wind_speed|^wind|_speed$|current/.test(name)) {
      return "speed";
    }
    if (
      /precipitation|rainfall|snowfall|evaporation|runoff|water_flux|water_equivalent|lwe_/.test(
        name
      )
    ) {
      return "water";
    }
    return "other";
  }
  if (
    /^(pr|prc|prl|prsn|tp|cp|lsp|precip|precipitation|rain|snowfall)$/i.test(
      variable ?? ""
    )
  ) {
    return "water";
  }
  if (
    /^(u|v|w|uo|vo|wo|ua|va|uas|vas|u10|v10|sfcwind|wind)$/i.test(
      variable ?? ""
    )
  ) {
    return "speed";
  }
  return undefined;
}

/**
 * The result as shown in `to`: values, spreads, a distribution's edges and
 * curve converted (a σ or a bin width by the size of a unit only), the
 * units renamed. The same result when `to` is unset, its own, or cannot
 * be reached.
 */
/**
 * A value in `from` units as `to` units, as the plot's values convert;
 * undefined when they do not convert.
 */
/**
 * The temperature meaning to convert a result's values (and thresholds,
 * comparisons, statistics of them) with: `temperature: difference` when it is a
 * difference whatever its units say: declared so, an anomaly by any of its
 * names (standard name, long name, variable), or a spread over time (a standard
 * deviation, standard error or range: 1 K of it is 1 °C, never −272.15 °C);
 * else its own `units_metadata`. One answer for every place a temperature is
 * converted.
 */
/** Cell methods whose values are spreads: temperature differences. */
const SPREADS = new Set(["standard_deviation", "standard_error", "range"]);

export function temperatureMetadata(
  result: Pick<
    TAnalysisResult,
    "unitsMetadata" | "longName" | "cellMethods" | "query"
  >,
  standardName?: string
) {
  const declared = result.unitsMetadata;
  if (declared && /on[_ ]scale/.test(declared)) {
    return declared;
  }
  // A CF standard name says what the quantity is; without one, the long name
  // and the variable's own name.
  const leaf = result.query?.variable?.split("/").pop() ?? "";
  const names = standardName
    ? standardName
    : `${result.longName ?? ""} ${leaf}`;
  // The methods themselves, not their comments, each of a compound one
  // ("standard_deviation within days … mean over days"), and CF's
  // standard_error modifier of a standard name.
  const methods = (result.cellMethods ?? "").replace(/\([^)]*\)/g, " ");
  const spread =
    [...parseCellMethods(result.cellMethods).values()].some((method) =>
      SPREADS.has(method)
    ) ||
    /:\s*(standard_deviation|standard_error|range)\b/.test(methods) ||
    / standard_error$/.test(standardName ?? "");
  return /difference/.test(declared ?? "") || /anomal/i.test(names) || spread
    ? "temperature: difference"
    : declared;
}

export function convertValue(
  value: number,
  from: string | undefined,
  to: string | undefined,
  metadata?: string
) {
  if (!from || !to || from === to) {
    return value;
  }
  const convert = converter(from, to, { from: metadata, to: metadata });
  return convert ? convert(value) : undefined;
}

// eslint-disable-next-line max-lines-per-function
export function convertResult(
  result: TAnalysisResult,
  to: string | undefined,
  /** The variable's CF standard name, when known. */
  standardName?: string
): TAnalysisResult {
  if (!to || to === result.units) {
    return result;
  }
  // A temperature anomaly is a difference whatever its units say: 1 K of
  // anomaly is 1 °C, not −272.15 °C.
  const metadata = temperatureMetadata(result, standardName);
  const meta = { from: metadata, to: metadata };
  // Only to units Settings would offer for this quantity: a restored link or an
  // earlier version may carry others.
  const kind = rateKind(result.query?.variable?.split("/").pop(), standardName);
  if (
    !unitChoices(result.units, metadata, kind).some(
      (choice) => choice.units === to
    )
  ) {
    return result;
  }
  const convert = converter(result.units, to, meta);
  if (!convert) {
    return result;
  }
  const size = convert(1) - convert(0);
  const each = (list: number[]) => list.map(convert);
  const spread = result.region?.spread;
  const histogram = result.histogram;
  const summary = histogram?.summary;
  return {
    ...result,
    units: to,
    ...(metadata ? { unitsMetadata: metadata } : {}),
    // A distribution's values are shares of area, not of the quantity.
    values:
      result.kind === ANALYSIS_KINDS.DISTRIBUTION
        ? result.values
        : each(result.values),
    ...(result.field
      ? { field: { ...result.field, values: each(result.field.values) } }
      : {}),
    ...(result.region
      ? {
          region: {
            ...result.region,
            ...(spread
              ? {
                  spread: {
                    std: spread.std.map((v) => v * size),
                    min: each(spread.min),
                    max: each(spread.max),
                  },
                }
              : {}),
          },
        }
      : {}),
    ...(histogram
      ? {
          histogram: {
            ...histogram,
            edges: each(histogram.edges),
            mean: convert(histogram.mean),
            ...(histogram.constant !== undefined
              ? { constant: convert(histogram.constant) }
              : {}),
            ...(summary
              ? {
                  summary: {
                    ...summary,
                    std: summary.std * size,
                    percentiles: each(summary.percentiles),
                    ...(summary.density
                      ? {
                          density: {
                            x: each(summary.density.x),
                            // Area per unit of value: per the new unit.
                            y: summary.density.y.map((v) => v / size),
                            bandwidth: summary.density.bandwidth * size,
                          },
                        }
                      : {}),
                  },
                }
              : {}),
          },
        }
      : {}),
    notes: [
      ...result.notes,
      `Shown in ${to}, converted from the file's ${result.units}.`,
    ],
  };
}
