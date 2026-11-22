/**
 * The colour scale of a heatmap or section is the map's: the same palette,
 * limits, inversion, steps (posterize) and hidden ends, so one value has one
 * colour on the map, in the chart, in its legend and in its exports. The
 * arithmetic mirrors the map's shaders (`getColormapScaleOffset`,
 * `posterize.glsl`, `scalarColormap.frag.glsl`).
 *
 * A plot of another variable than the map shows (or a snapshot) keeps the
 * same palette but its own range, and says so: the map's limits would be in
 * other units.
 */

export type TColourScale = {
  colormap: string;
  low: number;
  high: number;
  invert: boolean;
  /** Discrete steps (the map's "Discrete colors"); 0 or 1: continuous. */
  levels: number;
  /** Values at or below `low` (above `high`) are not drawn on the map. */
  hideLow: boolean;
  hideHigh: boolean;
  /** Whose limits: the map's, or this plot's own range (and why). */
  from: "map" | "own";
  note?: string;
};

/** What the map's colour controls hold (the globe store's fields). */
export type TMapColours = {
  colormap: string;
  invertColormap: boolean;
  posterizeLevels: number;
  hideLowerBound: boolean;
  hideUpperBound: boolean;
  selection: { low?: number; high?: number };
  /** The variable the map shows. */
  varnameDisplay: string;
  /** Limits the user set on the map (both), not fitted to its slice. */
  fixedLimits?: boolean;
};

/** The finite range of some values (empty: low > high). */
export function valueRange(values: ArrayLike<number>) {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (let at = 0; at < values.length; at++) {
    const value = values[at];
    if (Number.isFinite(value)) {
      low = value < low ? value : low;
      high = value > high ? value : high;
    }
  }
  return { low, high, empty: low > high };
}

/**
 * The scale a plot of `variable` uses: the map's applied limits when the map
 * shows that variable of the same source, else its own range.
 */
// eslint-disable-next-line max-lines-per-function
export function plotScale(
  map: TMapColours,
  plot: {
    variable: string;
    sameSource: boolean;
    values: ArrayLike<number>;
    /**
     * What it holds against the map's one slice: `map`, the level and date
     * the map shows; `levels`, every level (a cross-section, a profile);
     * `dates`, many dates (a Hovmöller); `level`, another level. The map's
     * automatic limits are fitted to its one slice, so they are borrowed
     * only for that slice, or when the user fixed them (a cross-section
     * and a Hovmöller were recoloured, and cells hidden, whenever the map
     * changed level or date).
     */
    slice?: "map" | "levels" | "dates" | "level" | "date";
  }
): TColourScale {
  const base = {
    colormap: map.colormap,
    invert: map.invertColormap,
    levels: map.posterizeLevels,
  };
  const { low, high } = map.selection;
  const slice = plot.slice ?? "map";
  const mapped =
    (slice === "map" || map.fixedLimits === true) &&
    plot.sameSource &&
    map.varnameDisplay === plot.variable &&
    Number.isFinite(low) &&
    Number.isFinite(high) &&
    // The store's placeholder before a map has loaded.
    !(low === 0 && high === 0);
  if (mapped) {
    return {
      ...base,
      low: Math.min(low!, high!),
      high: Math.max(low!, high!),
      hideLow: map.hideLowerBound,
      hideHigh: map.hideUpperBound,
      from: "map",
    };
  }
  const own = valueRange(plot.values);
  return {
    ...base,
    low: own.empty ? 0 : own.low,
    high: own.empty ? 1 : own.high,
    hideLow: false,
    hideHigh: false,
    from: "own",
    note: !plot.sameSource
      ? "Own range: the map shows another dataset"
      : map.varnameDisplay !== plot.variable
        ? `Own range: the map shows ${map.varnameDisplay}`
        : slice === "levels"
          ? "Own range: the plot holds every level, the map's limits fit the one it shows"
          : slice === "dates"
            ? "Own range: the plot holds many dates, the map's limits fit the one it shows"
            : slice === "date"
              ? "Own range: the map shows another date"
              : "Own range: the map shows another level",
  };
}

/**
 * A value's position on the palette, 0–1, as the map's shader computes it
 * (inverted, then stepped); undefined where the map does not draw it.
 */
export function shadeOf(scale: TColourScale, value: number) {
  if (!Number.isFinite(value)) {
    return undefined;
  }
  if (
    (scale.hideLow && value <= scale.low) ||
    (scale.hideHigh && value >= scale.high)
  ) {
    return undefined;
  }
  let t: number;
  if (scale.high === scale.low) {
    t = 0.5;
  } else {
    const factor = (scale.invert ? -1 : 1) / (scale.high - scale.low);
    const offset = scale.invert ? -scale.high * factor : -scale.low * factor;
    t = Math.min(1, Math.max(0, offset + factor * value));
  }
  if (scale.levels > 1) {
    const step = Math.min(Math.floor(t * scale.levels), scale.levels - 1);
    t = step / (scale.levels - 1);
  }
  return t;
}

/** The palette index (0–255) of a value, or -3 where the map hides it. */
export function paletteIndex(scale: TColourScale, value: number) {
  const t = shadeOf(scale, value);
  return t === undefined ? HIDDEN : Math.round(t * 255);
}

/** A cell the map would not draw (hidden below or above the limits). */
export const HIDDEN = -3;

/**
 * Whether values reach past the limits (drawn in the end colours): the
 * legend marks such an end with a triangle, as matplotlib's `extend`.
 */
export function extendsPast(scale: TColourScale, values: ArrayLike<number>) {
  const range = valueRange(values);
  return {
    below: !range.empty && range.low < scale.low && !scale.hideLow,
    above: !range.empty && range.high > scale.high && !scale.hideHigh,
  };
}

/**
 * The legend's bar as palette positions from top (high) to bottom (low):
 * `rows` samples, each the shade of the value at its height, so steps and
 * inversion read as they do on the map.
 */
export function legendShades(scale: TColourScale, rows: number) {
  return Array.from({ length: rows }, (_, row) => {
    const value = scale.high - ((row + 0.5) / rows) * (scale.high - scale.low);
    const t = shadeOf({ ...scale, hideLow: false, hideHigh: false }, value);
    return t ?? 0.5;
  });
}

/**
 * Whether the map's Custom range is the one in use: Custom chosen and the
 * limits applied are the saved custom ones. Saved values alone stay after the
 * radio goes back to Data.
 */
export function customLimitsInUse(
  customChosen: boolean,
  userLow: number | undefined,
  userHigh: number | undefined,
  applied: { low?: number; high?: number } | undefined
) {
  const [low, high] = [Number(userLow), Number(userHigh)];
  if (
    !customChosen ||
    userLow === undefined ||
    userHigh === undefined ||
    !Number.isFinite(low) ||
    !Number.isFinite(high) ||
    applied?.low === undefined ||
    applied.high === undefined
  ) {
    return false;
  }
  return (
    applied.low === Math.min(low, high) && applied.high === Math.max(low, high)
  );
}
