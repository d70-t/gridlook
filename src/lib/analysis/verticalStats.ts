/**
 * Statistics of a vertical column (a profile, or one date of a
 * time–vertical section), computed from the values already read:
 *
 * - column (thickness-weighted) mean, and the levels of the maximum and
 *   minimum;
 * - column amount: ∫ q dp / g on pressure levels for a mass fraction
 *   (kg kg-1: precipitable water for specific humidity), ∫ c dz on height
 *   or depth for a concentration per volume;
 * - ocean temperature: mixed-layer depth (the depth where temperature
 *   differs by 0.2 °C from its value at 10 m: de Boyer Montégut et al.,
 *   2004, JGR 109, C12003), depth of the 20 °C isotherm (the usual proxy
 *   of the tropical thermocline, Z20), thermocline depth as the depth of
 *   the steepest cooling below the mixed layer, and the heat content of
 *   the upper 700 m, ρ₀ c_p ∫ θ dz above 0 °C (Levitus et al.);
 * - air temperature: the lapse-rate tropopause (WMO 1957: the lowest level
 *   where the lapse rate falls to 2 K/km or less, provided the mean lapse
 *   rate between it and every level within 2 km above does not exceed
 *   2 K/km), searched above 500 hPa (or 5 km) so a surface inversion is
 *   not taken for it.
 *
 * Levels are linearly interpolated between the two that bracket a
 * crossing. Missing values are skipped; a statistic whose column does not
 * reach (the 10 m reference, 700 m, a 20 °C crossing) is not given.
 */
import { cellMethodSteps, nonlinearStep } from "./cellMethods.ts";
import { converter } from "./unitConvert.ts";

export type TColumn = {
  /** Vertical positions (source units) and the values there. */
  z: number[];
  values: number[];
  zUnits?: string;
  positive?: "up" | "down";
  /** Published layer bounds, [low, high] per level, flat. */
  bounds?: number[];
  /** Units of the values. */
  units?: string;
  unitsMetadata?: string;
  standardName?: string;
  /** The variable's name and long name, for what it measures. */
  name?: string;
  /** CF cell_methods: a spread over time is no signed anomaly. */
  cellMethods?: string;
};

export type TVerticalStat = {
  id:
    | "mean"
    | "max-level"
    | "min-level"
    | "amount"
    | "mld"
    | "z20"
    | "thermocline"
    | "heat-700"
    | "tropopause"
    | "unknown-layers";
  label: string;
  /** A level (in the column's own units) or a value. */
  kind: "level" | "value";
  value: number;
  units?: string;
  /** How it was computed, with its reference: the tooltip and Method. */
  method: string;
};

const G = 9.80665;
const R_DRY = 287.05;
/** Reference density and heat capacity of sea water (TEOS-10 c_p0). */
const RHO0 = 1025;
const CP0 = 3991.87;

/** A level with a value: SI position, source position, value, its row. */
type TLevel = { s: number; z: number; v: number; k: number };

/** The kind of vertical axis, and the factor to metres or pascals. */
function axisOf(column: TColumn) {
  const pa = converter(column.zUnits, "Pa");
  if (pa) {
    return { kind: "pressure" as const, toSi: pa(1) - pa(0) };
  }
  const m = converter(column.zUnits, "m");
  if (m) {
    return {
      kind:
        column.positive === "down" ? ("depth" as const) : ("height" as const),
      toSi: m(1) - m(0),
    };
  }
  return undefined;
}

/**
 * Valid levels from the surface down (depth) or up (height, pressure):
 * `s` the position in SI (m, or Pa), `z` in the source units.
 */
function levels(
  column: TColumn,
  kind: "pressure" | "depth" | "height",
  toSi: number
) {
  const list: TLevel[] = [];
  column.z.forEach((z, k) => {
    const v = column.values[k];
    if (Number.isFinite(z) && Number.isFinite(v)) {
      list.push({ s: z * toSi, z, v, k });
    }
  });
  // From the surface: pressure falls, depth and height grow.
  return list.sort((a, b) => (kind === "pressure" ? b.s - a.s : a.s - b.s));
}

/**
 * Each row's layer, top and bottom (SI): its published bounds, else half the
 * gaps to its neighbouring rows, whether or not they hold a value (a missing
 * level is not absorbed by its neighbours); the outermost rows' layers end at
 * the rows themselves.
 */
function rowLayers(column: TColumn, toSi: number) {
  const { bounds, z } = column;
  const declared = bounds && bounds.length === 2 * z.length;
  const order = z
    .map((value, k) => ({ s: value * toSi, k }))
    .filter(({ s }) => Number.isFinite(s))
    .sort((a, b) => a.s - b.s);
  const layers: ([number, number] | undefined)[] = new Array(z.length);
  order.forEach(({ s, k }, at) => {
    if (declared) {
      const [a, b] = [bounds[2 * k] * toSi, bounds[2 * k + 1] * toSi];
      // A declared zero width is kept: such a level contributes nothing.
      if (Number.isFinite(a) && Number.isFinite(b)) {
        layers[k] = [Math.min(a, b), Math.max(a, b)];
        return;
      }
      // Declared, and missing for this row: its layer is not known, and is not
      // made up from the centres.
      return;
    }
    const before = order[at - 1]?.s;
    const after = order[at + 1]?.s;
    const low = before !== undefined ? (before + s) / 2 : s;
    const high = after !== undefined ? (s + after) / 2 : s;
    layers[k] = [low, high];
  });
  return layers;
}

/** Each valid level's thickness (SI), from its row's layer. */
function thicknesses(layers: ReturnType<typeof rowLayers>, list: TLevel[]) {
  return list.map((level) => {
    const layer = layers[level.k];
    const span = layer ? layer[1] - layer[0] : 0;
    return span > 0 ? span : list.length === 1 ? 1 : 0;
  });
}

/**
 * How the valid layers cover [from, to] (SI): the length they cover
 * (their union), and whether any two overlap there.
 */
function coverage(
  layers: ReturnType<typeof rowLayers>,
  list: TLevel[],
  from: number,
  to: number
) {
  const parts = list
    .map((level) => layers[level.k])
    .filter((layer): layer is [number, number] => Boolean(layer))
    .map(([a, b]) => [Math.max(a, from), Math.min(b, to)] as const)
    .filter(([a, b]) => b > a)
    .sort((x, y) => x[0] - y[0]);
  let covered = 0;
  let overlap = false;
  let reach = from;
  for (const [a, b] of parts) {
    if (a < reach - 1e-9 * Math.max(1, to)) {
      overlap = true;
    }
    covered += Math.max(0, b - Math.max(a, reach));
    reach = Math.max(reach, b);
  }
  return { covered, overlap };
}

/**
 * Where `f` (per level) first reaches `target`, interpolated (SI); with
 * `falling`, only where it falls through it from above.
 */
function firstCrossing(
  list: TLevel[],
  f: (level: TLevel) => number,
  target: number,
  falling = false
) {
  for (let at = 1; at < list.length; at++) {
    const [a, b] = [f(list[at - 1]), f(list[at])];
    const crosses = falling
      ? a >= target && b < target
      : (a - target) * (b - target) <= 0 && a !== b;
    if (crosses) {
      const t = (target - a) / (b - a);
      return list[at - 1].s + t * (list[at].s - list[at - 1].s);
    }
  }
  return undefined;
}

/**
 * Where `f` first departs from `reference` by `delta` either way, the signed
 * value interpolated towards the threshold it crosses.
 */
function thresholdCrossing(
  list: TLevel[],
  f: (level: TLevel) => number,
  reference: number,
  delta: number
) {
  for (let at = 1; at < list.length; at++) {
    const [a, b] = [f(list[at - 1]), f(list[at])];
    if (Math.abs(a - reference) < delta && Math.abs(b - reference) >= delta) {
      const target = reference + Math.sign(b - reference) * delta;
      const t = (target - a) / (b - a);
      return list[at - 1].s + t * (list[at].s - list[at - 1].s);
    }
  }
  return undefined;
}

/** The value at position `s` (SI), interpolated, or undefined outside. */
function valueAt(list: TLevel[], s: number) {
  for (let at = 1; at < list.length; at++) {
    const [a, b] = [list[at - 1], list[at]];
    if ((a.s - s) * (b.s - s) <= 0) {
      return a.s === b.s ? a.v : a.v + ((s - a.s) / (b.s - a.s)) * (b.v - a.v);
    }
  }
  return list.length === 1 && list[0].s === s ? list[0].v : undefined;
}

/** Heights (m) of pressure levels from the hypsometric equation. */
function hypsometric(list: TLevel[], kelvin: (v: number) => number) {
  const heights = [0];
  for (let at = 1; at < list.length; at++) {
    const mean = (kelvin(list[at - 1].v) + kelvin(list[at].v)) / 2;
    heights.push(
      heights[at - 1] +
        ((R_DRY * mean) / G) * Math.log(list[at - 1].s / list[at].s)
    );
  }
  return heights;
}

/** The WMO lapse-rate tropopause: its position (SI), or undefined. */
// eslint-disable-next-line max-lines-per-function
function tropopause(
  list: TLevel[],
  kind: "pressure" | "height",
  kelvin: (v: number) => number
) {
  const z =
    kind === "pressure" ? hypsometric(list, kelvin) : list.map((l) => l.s);
  const T = list.map((l) => kelvin(l.v));
  const lapse = (a: number, b: number) =>
    (-(T[b] - T[a]) / (z[b] - z[a])) * 1000;
  // Every level within 2 km above `at` holds a lapse rate of at most 2 K/km
  // from it exactly when T + 2 K/km × z there is at least `at`'s: the least of
  // that over the window, kept as the window moves up, decides.
  const adjusted = T.map((t, k) => t + 0.002 * z[k]);
  const window: number[] = [];
  let [head, pushed] = [0, 0];
  let end = 0;
  for (let at = 0; at + 1 < list.length; at++) {
    const high = kind === "pressure" ? list[at].s <= 50000 : z[at] >= 5000;
    if (!high || lapse(at, at + 1) > 2) {
      continue;
    }
    // No level with a value within the 2 km above: the criterion cannot be
    // tested there, and no higher level is the lowest that meets it.
    if (z[at + 1] - z[at] >= 2000) {
      return undefined;
    }
    // Every level within 2 km above, and the point 2 km above itself
    // (interpolated): the mean lapse rate stays ≤ 2 K/km. A profile that does
    // not reach 2 km above cannot confirm it. The end moves up with the
    // candidate, and the check stops at the first failure.
    end = Math.max(end, at + 1);
    while (end < z.length && z[end] - z[at] < 2000) {
      end++;
    }
    if (end >= z.length) {
      return undefined;
    }
    for (; pushed < end; pushed++) {
      while (
        window.length > head &&
        adjusted[window[window.length - 1]] >= adjusted[pushed]
      ) {
        window.pop();
      }
      window.push(pushed);
    }
    while (head < window.length && window[head] <= at) {
      head++;
    }
    // No level between it and 2 km above: nothing to break the rate.
    const least =
      head < window.length ? adjusted[window[head]] - adjusted[at] : 0;
    let holds = least >= 0;
    // Within rounding of the limit: the lapse rates themselves.
    if (Math.abs(least) < 1e-9 * (1 + Math.abs(adjusted[at]))) {
      holds = true;
      for (let up = at + 1; holds && up < end; up++) {
        holds = lapse(at, up) <= 2;
      }
    }
    const f = (z[at] + 2000 - z[end - 1]) / (z[end] - z[end - 1]);
    const tEnd = T[end - 1] + f * (T[end] - T[end - 1]);
    holds &&= (-(tEnd - T[at]) / 2000) * 1000 <= 2;
    if (holds) {
      return list[at].s;
    }
  }
  return undefined;
}

/** Whether the values are a temperature (any spelling of its units). */
const isTemperature = (column: TColumn) =>
  Boolean(
    converter(column.units, "K", {
      from: column.unitsMetadata,
      to: column.unitsMetadata,
    })
  ) && !/difference/.test(column.unitsMetadata ?? "");

/**
 * A temperature difference (an anomaly from a climatology, or declared a
 * difference): kelvin and degrees Celsius differ by no offset there.
 */
function temperatureDifference(column: TColumn) {
  const difference = {
    from: "temperature: difference",
    to: "temperature: difference",
  };
  // A standard name says what it is; declared on scale, it is no difference.
  if (/on[_ ]scale/.test(column.unitsMetadata ?? "")) {
    return undefined;
  }
  const words = (column.standardName ?? column.name ?? "").toLowerCase();
  return (/anomaly/.test(words) ||
    /difference/.test(column.unitsMetadata ?? "")) &&
    converter(column.units, "K", difference)
    ? converter(column.units, "degC", difference)
    : undefined;
}

/** What the column holds, for which statistics apply. */
function quantity(column: TColumn) {
  const words =
    `${column.standardName ?? ""} ${column.name ?? ""}`.toLowerCase();
  const named = column.standardName?.toLowerCase() || words;
  // A spread over time (standard deviation, variance, standard error) is
  // neither a temperature nor a signed anomaly: no heat content, isotherm or
  // mixed layer of it. A range too (maximum less minimum): never negative, so
  // layers cannot cancel as a signed departure does. Unsigned layer statistics
  // too (mean absolute value, root mean square): +1 and −1 K layers give +1 and
  // +1 K, never the column's zero. Comments say how, not what.
  const methods = (column.cellMethods ?? "").replace(/\([^)]*\)/g, " ");
  const dispersion =
    /standard_deviation|variance|standard_error|\brange\b|\b(std|var)\b|absolute_value|root_mean_square/.test(
      methods
    ) ||
    /standard_deviation|variance|standard_error|_range\b|absolute_value|root_mean_square/.test(
      words
    );
  // A temperature scale declared unknown: no position on the scale (no heat
  // content, isotherm or tropopause needs one), and a difference only where the
  // quantity's name says anomaly.
  const unknownScale = /temperature:\s*unknown/i.test(
    column.unitsMetadata ?? ""
  );
  const difference =
    dispersion ||
    (unknownScale && !/anomal/.test(column.standardName?.toLowerCase() ?? ""))
      ? undefined
      : temperatureDifference(column);
  // A temperature that is not the medium's own (its dew or frost point, its
  // freezing or boiling point, a brightness temperature): none of its
  // diagnostics, whatever its units.
  const other =
    /dew_point|frost_point|wet_bulb|freezing|melting|boiling|brightness|equivalent/.test(
      named
    );
  return {
    // An anomaly is no temperature: no isotherm, mixed layer or tropopause of
    // it.
    temperature:
      isTemperature(column) &&
      !difference &&
      !dispersion &&
      !unknownScale &&
      !other,
    difference,
    // The standard name decides when there is one: a long name's words are no
    // quantity.
    ocean: /sea_water|ocean|thetao|\bto\b|\btos\b/.test(named),
    // Soil, ice, snow or lake temperatures on depths are not the ocean.
    land: column.standardName
      ? /soil|ground|snow|ice|lake|permafrost/.test(column.standardName)
      : /\b(soil|ground|snow|ice|lake|permafrost|tsl)\b/.test(words),
    air: /air_temperature|^ta\b|\bta\b|atmosph/.test(named),
    // A potential temperature is no actual one: a dry adiabat is constant in
    // it, with no lapse rate to find a tropopause by.
    potential: /potential|\btheta\b|virtual/.test(words),
  };
}

/** A cell_methods axis that is a vertical one (by its usual names). */
const isVerticalName = (name: string) =>
  /^(depth|height|altitude|z|lev|level|olevel|plev|pressure|air_pressure|sigma|layer|deptht|depthu|depthv|depthw|st_ocean|sw_ocean)$/i.test(
    name
  ) || /depth|height|altitude|pressure/i.test(name);

/** SI prefixes and their factors (micro also as u and μ). */
const SI_PREFIXES: Record<string, number> = {
  y: 1e-24,
  z: 1e-21,
  a: 1e-18,
  f: 1e-15,
  p: 1e-12,
  n: 1e-9,
  u: 1e-6,
  µ: 1e-6,
  μ: 1e-6,
  m: 1e-3,
  c: 1e-2,
  d: 1e-1,
  da: 1e1,
  h: 1e2,
  k: 1e3,
  M: 1e6,
  G: 1e9,
  T: 1e12,
  P: 1e15,
  E: 1e18,
  Z: 1e21,
  Y: 1e24,
};

/** What a column is of: its standard name, else its variable's name. */
function describedBy(column: TColumn) {
  return (column.standardName || column.name || "").toLowerCase();
}

/** Units of ∫ v dz or ∫ v dp / g, for amounts that add up in a column. */
function amountUnits(
  column: TColumn,
  kind: "pressure" | "depth" | "height"
): { units: string; scale: number; ratio?: number } | undefined {
  const units = (column.units ?? "").replace(/\s+/g, " ").trim();
  // ∫ q dp / g is a mass only for a mass fraction: units that say so, or a bare
  // 1 whose name says so. The standard name decides when given, the variable's
  // name only without one; a volume or mole ratio is no mass ratio.
  const words = describedBy(column);
  const massFraction =
    /^(kg kg-1|kg\/kg|kg kg\^-1)$/.test(units) ||
    (units === "1" &&
      /mass_fraction|specific_humidity|mixing_ratio|\b(hus|q|qv)\b/.test(
        words
      ) &&
      !/relative|mole|volume/.test(words));
  if (kind === "pressure" && massFraction) {
    return { units: "kg m-2", scale: 1, ratio: 1 };
  }
  // Grams per kilogram: the same mass ratio, a thousandth.
  if (
    kind === "pressure" &&
    /^(g kg-1|g\/kg|g kg\^-1)$/.test(units) &&
    !/relative|mole|volume/.test(words)
  ) {
    return { units: "kg m-2", scale: 1, ratio: 1e-3 };
  }
  // Per volume, in any prefixed metre (cm-3, /cm3, km^-3): to per cubic metre
  // first, then along metres. Micro- and nanometres too; a prefix left on its
  // own before the metre is no unit, and no integral is given. Every SI prefix,
  // case-sensitive: fm is a femtometre, Mm a megametre; a prefix left on its
  // own before the metre is no unit, and no integral is given.
  const prefixes = `(${Object.keys(SI_PREFIXES)
    .sort((x, y) => y.length - x.length)
    .join("|")})?`;
  const volume = new RegExp(
    `^(.*?)\\s*(?:\\/\\s*${prefixes}m3|${prefixes}m\\^?-3)$`
  ).exec(units);
  if (kind !== "pressure" && volume) {
    const prefix = volume[2] ?? volume[3] ?? "";
    const metres = SI_PREFIXES[prefix] ?? 1;
    const rest = volume[1].trim();
    if (rest in SI_PREFIXES) {
      return undefined;
    }
    return {
      units: rest && rest !== "1" ? `${rest} m-2` : "m-2",
      scale: metres ** -3,
    };
  }
  return undefined;
}

/**
 * The statistics that apply to this column, in reading order. Levels are
 * in the column's own units (as its axis shows them).
 */
// eslint-disable-next-line max-lines-per-function
export function verticalStatistics(column: TColumn): TVerticalStat[] {
  const axis = axisOf(column);
  if (!axis) {
    return [];
  }
  const { kind, toSi } = axis;
  const list = levels(column, kind, toSi);
  if (list.length < 2) {
    return [];
  }
  const native = (s: number) => s / toSi;
  const stats: TVerticalStat[] = [];
  const layers = rowLayers(column, toSi);
  const dz = thicknesses(layers, list);
  // Levels with a value whose layer is unknown: no thickness to weigh
  // them by, so no thickness-weighted mean, integral or heat content.
  const unknownLayers = list.filter((l) => !layers[l.k]).length;
  const weight = dz.reduce((a, b) => a + b, 0);
  // The column's extent in a loop: 100,000 levels' 200,000 ends are too many
  // arguments for Math.min.
  let [low, high] = [Infinity, -Infinity];
  for (const level of list) {
    for (const edge of layers[level.k] ?? []) {
      low = Math.min(low, edge);
      high = Math.max(high, edge);
    }
  }
  const overlapping = low <= high && coverage(layers, list, low, high).overlap;
  // Overlapping layers count water twice: the column's mean is then the one
  // layer published over all of it, or none.
  const whole = overlapping
    ? list.filter((l) => {
        const [a, b] = layers[l.k] ?? [Number.NaN, Number.NaN];
        return Math.min(a, b) <= low && Math.max(a, b) >= high;
      })
    : [];
  // The row over the whole column is its mean only when it says so: a point or
  // a maximum there is none.
  const verticalMean = cellMethodSteps(column.cellMethods).some(
    (step) => step.names.some(isVerticalName) && step.method === "mean"
  );
  const mean = !overlapping
    ? list.reduce((sum, l, at) => sum + l.v * dz[at], 0) / weight
    : whole.length === 1 && verticalMean
      ? whole[0].v
      : undefined;
  if (mean !== undefined && !unknownLayers) {
    stats.push({
      id: "mean",
      label: "Column mean",
      kind: "value",
      value: mean,
      units: column.units,
      method: overlapping
        ? "The value published over the whole column (its other layers overlap it)."
        : "Thickness-weighted mean over the levels with values (each level's published bounds, else half the gaps to its neighbours).",
    });
  }
  if (unknownLayers) {
    stats.push({
      id: "unknown-layers",
      label: "Levels of unknown layer",
      kind: "value",
      value: unknownLayers,
      units: "levels",
      method:
        "Levels with a value whose declared layer bounds are missing: the column mean, integrals and heat content need every layer, so none is given.",
    });
  }
  const top = list.reduce((a, b) => (b.v > a.v ? b : a));
  const bottom = list.reduce((a, b) => (b.v < a.v ? b : a));
  stats.push(
    {
      id: "max-level",
      label: "Level of the maximum",
      kind: "level",
      value: top.z,
      units: column.zUnits,
      method: "The level where the value is largest.",
    },
    {
      id: "min-level",
      label: "Level of the minimum",
      kind: "level",
      value: bottom.z,
      units: column.zUnits,
      method: "The level where the value is smallest.",
    }
  );
  // Layerwise extremes, medians or other nonlinear statistics are no one state
  // of the column: nothing derived as if they were. Heat content too, below.
  const extremes = nonlinearStep(column.cellMethods);
  const amount =
    extremes || unknownLayers ? undefined : amountUnits(column, kind);
  // A mixing ratio (per kilogram of dry air) is specific humidity r / (1 + r)
  // before it is a mass of the column; overlapping layers count some air twice.
  // By the standard name when given.
  const described = describedBy(column);
  const mixing =
    /mixing_ratio|\bmr\b/.test(described) && !/mole|volume/.test(described);
  if (amount && !overlapping) {
    const ratio = amount.ratio ?? 1;
    const sum = list.reduce((s, l, at) => {
      const r = l.v * ratio;
      return s + (mixing ? r / (1 + r) : r) * dz[at];
    }, 0);
    // From a time mean of a mixing ratio, r / (1 + r) is taken of the mean
    // state: its burden, not the mean of the burdens. A mean over any axis,
    // however named.
    const meanStep = mixing
      ? cellMethodSteps(column.cellMethods).find(
          (step) => step.method === "mean"
        )
      : undefined;
    const meanOfRatio = Boolean(meanStep);
    stats.push({
      id: "amount",
      label: kind === "pressure" ? "Column amount" : "Column integral",
      kind: "value",
      value: (kind === "pressure" ? sum / G : sum) * amount.scale,
      units: amount.units,
      method:
        kind === "pressure"
          ? `∫ q dp / g over the levels with values (precipitable water for specific humidity)${mixing ? "; the mixing ratio r taken as q = r / (1 + r)" : ""}${ratio !== 1 ? "; g/kg read as kg/kg" : ""}.${meanOfRatio ? ` The mixing ratio is a mean (${meanStep!.names.join(", ")}): this is the burden of that mean state, not the mean of the burdens (q = r / (1 + r) is not linear).` : ""}`
          : "∫ c dz over the levels with values.",
    });
  }
  const what = quantity(column);
  // (`extremes`, above.) Layerwise extremes of an anomaly are not one state: no
  // heat content of them; nor are medians, nor means of extremes, at any step
  // of their reduction in time. Nor layer extremes or medians along the
  // vertical itself: no layer's representative value to integrate.
  if (
    what.difference &&
    !extremes &&
    kind === "depth" &&
    what.ocean &&
    !what.land
  ) {
    const heat = unknownLayers
      ? undefined
      : heatContent(layers, list, what.difference);
    if (heat !== undefined) {
      stats.push({
        id: "heat-700",
        label: "Heat content anomaly 0–700 m",
        kind: "value",
        value: RHO0 * CP0 * heat,
        units: "J m-2",
        method:
          "ρ₀ c_p ∫ ΔT dz over 0–700 m of a temperature anomaly (a difference: kelvin and °C alike), every metre covered by a level with a value, as for the heat content; ρ₀ = 1025 kg m-3, c_p = 3991.87 J kg-1 K-1.",
      });
    }
  }
  if (what.temperature && !extremes) {
    const celsius = converter(column.units, "degC")!;
    const kelvin = converter(column.units, "K")!;
    // Marine diagnostics need positive evidence of sea water.
    if (kind === "depth" && what.ocean && !what.land) {
      const ref = valueAt(list, 10);
      if (ref !== undefined) {
        const from = list.findIndex((l) => l.s > 10);
        const target = celsius(ref);
        const mld = thresholdCrossing(
          [{ s: 10, z: native(10), v: ref, k: -1 }, ...list.slice(from)],
          (l) => celsius(l.v),
          target,
          0.2
        );
        if (mld !== undefined) {
          stats.push({
            id: "mld",
            label: "Mixed-layer depth",
            kind: "level",
            value: native(mld),
            units: column.zUnits,
            method:
              "Depth where temperature differs by 0.2 °C from its value at 10 m (de Boyer Montégut et al., 2004), interpolated between levels.",
          });
        }
        // The steepest cooling below the mixed layer: the thermocline. No
        // crossing: the mixed layer reaches the deepest sample, and no sampled
        // water lies below it.
        let steepest: { s: number; rate: number } | undefined;
        for (
          let at = mld === undefined ? list.length : 1;
          at < list.length;
          at++
        ) {
          const [a, b] = [list[at - 1], list[at]];
          // The layer's middle below the mixed layer (not one that
          // straddles its base).
          if ((a.s + b.s) / 2 <= (mld ?? 10)) {
            continue;
          }
          const rate = (celsius(a.v) - celsius(b.v)) / (b.s - a.s);
          if (rate > 0 && (!steepest || rate > steepest.rate)) {
            steepest = { s: (a.s + b.s) / 2, rate };
          }
        }
        if (steepest) {
          stats.push({
            id: "thermocline",
            label: "Thermocline (steepest cooling)",
            kind: "level",
            value: native(steepest.s),
            units: column.zUnits,
            method: `Depth of the largest −dT/dz below the mixed layer (${(steepest.rate * 100).toFixed(2)} °C per 100 m), mid-way between the two levels.`,
          });
        }
      }
      const z20 = firstCrossing(list, (l) => celsius(l.v), 20, true);
      if (z20 !== undefined) {
        stats.push({
          id: "z20",
          label: "20 °C isotherm depth",
          kind: "level",
          value: native(z20),
          units: column.zUnits,
          method:
            "Depth where temperature first falls through 20 °C from the surface, interpolated (Z20, the usual proxy of the tropical thermocline).",
        });
      }
      // Only a column with values over all of 0–700 m, its layers not
      // overlapping. One stated extrapolation: a shallowest level within 10 m
      // stands for the water above it (model levels at 5 m have no layer
      // above). Layerwise extremes are no state of the column either.
      const heat = unknownLayers
        ? undefined
        : heatContent(layers, list, celsius);
      if (heat !== undefined) {
        stats.push({
          id: "heat-700",
          label: "Heat content 0–700 m",
          kind: "value",
          value: RHO0 * CP0 * heat,
          units: "J m-2",
          method:
            "ρ₀ c_p ∫ θ dz over 0–700 m, every metre of it covered by a level with a value (each level over its published layer, else to the midpoints between levels; a shallowest level within 10 m also stands for the water above it; given only when the column is observed over all of 0–700 m without overlapping layers), relative to 0 °C, with ρ₀ = 1025 kg m-3 and c_p = 3991.87 J kg-1 K-1 (as in ocean heat content estimates, Levitus et al.); compare its changes, not its size.",
        });
      }
    }
    if (
      (kind === "pressure" || kind === "height") &&
      // Positive evidence of the atmosphere: an air temperature, or levels of
      // pressure, never soil or ice.
      (what.air || (kind === "pressure" && !what.ocean)) &&
      !what.land &&
      !what.potential
    ) {
      const at = tropopause(list, kind, kelvin);
      if (at !== undefined) {
        stats.push({
          id: "tropopause",
          label: "Tropopause (lapse rate)",
          kind: "level",
          value: native(at),
          units: column.zUnits,
          method:
            "WMO (1957): the lowest level where the lapse rate falls to 2 K/km or less, the mean lapse rate to every level within 2 km above staying ≤ 2 K/km; searched above 500 hPa (5 km). Heights on pressure levels from the hypsometric equation.",
        });
      }
    }
  }
  return stats;
}

/**
 * ∫ θ dz over 0–700 m (θ in °C, or a difference), when every metre is
 * covered by a level with a value and no layers overlap; a shallowest
 * level within 10 m also stands for the water above it.
 */
function heatContent(
  layers: ReturnType<typeof rowLayers>,
  list: TLevel[],
  celsius: (v: number) => number
) {
  const top = list.reduce(
    (best, level) => Math.min(best, layers[level.k]?.[0] ?? Infinity),
    Infinity
  );
  const surface = top > 0 && top <= 10 ? top : 0;
  const shallowest = list.find((level) => layers[level.k]?.[0] === top);
  const { covered, overlap } = coverage(layers, list, surface, 700);
  if (overlap || covered + surface < 700 * (1 - 1e-9)) {
    return undefined;
  }
  let heat = surface && shallowest ? celsius(shallowest.v) * surface : 0;
  for (const level of list) {
    const [upper, lower] = layers[level.k]!;
    const span = Math.max(0, Math.min(lower, 700) - Math.max(upper, 0));
    heat += celsius(level.v) * span;
  }
  return heat;
}

/**
 * The level of the maximum or minimum of each date: one scan per date,
 * not every statistic of every column.
 */
function extremeLevels(
  rows: number,
  levelsPerRow: number,
  values: ArrayLike<number>,
  column: Omit<TColumn, "values">,
  id: "max-level" | "min-level"
) {
  const out: number[] = [];
  // The level of the maximum or minimum: one scan per date, not every statistic
  // of every column.
  const sign = id === "max-level" ? 1 : -1;
  // Ties go to the level nearest the surface, as in the profile, in whatever
  // order the levels are stored.
  const ax = axisOf({ ...column, values: [] });
  const surfaceFirst = (k: number, than: number) =>
    ax?.kind === "pressure"
      ? column.z[k] * ax.toSi > column.z[than] * ax.toSi
      : column.z[k] * (ax?.toSi ?? 1) < column.z[than] * (ax?.toSi ?? 1);
  for (let t = 0; t < rows; t++) {
    let best = Number.NaN;
    let at = -1;
    let valid = 0;
    for (let k = 0; k < levelsPerRow; k++) {
      const v = values[t * levelsPerRow + k];
      if (!Number.isFinite(v) || !Number.isFinite(column.z[k])) {
        continue;
      }
      valid++;
      if (
        at < 0 ||
        sign * (v - best) > 0 ||
        (v === best && surfaceFirst(k, at))
      ) {
        [best, at] = [v, k];
      }
    }
    out.push(
      valid >= 2 && axisOf({ ...column, values: [] }) ? column.z[at] : NaN
    );
  }
  return out;
}

/** One statistic over time: per row of a time × level result. */
export function statisticOverTime(
  rows: number,
  levelsPerRow: number,
  values: ArrayLike<number>,
  column: Omit<TColumn, "values">,
  id: TVerticalStat["id"]
) {
  const out: number[] = [];
  if (id === "max-level" || id === "min-level") {
    return extremeLevels(rows, levelsPerRow, values, column, id);
  }
  for (let t = 0; t < rows; t++) {
    const row = Array.from(
      { length: levelsPerRow },
      (_, k) => values[t * levelsPerRow + k]
    );
    const stat = verticalStatistics({ ...column, values: row }).find(
      (s) => s.id === id
    );
    out.push(stat ? stat.value : NaN);
  }
  return out;
}

/**
 * The level diagnostics a column of this kind can have at all, from its
 * metadata: the levels of its extremes, and an ocean temperature's mixed
 * layer, thermocline and 20 °C isotherm or an air temperature's tropopause.
 */
function possibleLevelIds(column: Omit<TColumn, "values">) {
  const ids = new Set(["max-level", "min-level"]);
  const axis = axisOf({ ...column, values: [] });
  if (!axis) {
    return ids;
  }
  const what = quantity({ ...column, values: [] });
  if (!what.temperature || nonlinearStep(column.cellMethods)) {
    return ids;
  }
  if (axis.kind === "depth" && what.ocean && !what.land) {
    ["mld", "thermocline", "z20"].forEach((id) => ids.add(id));
  }
  if (
    (axis.kind === "pressure" || axis.kind === "height") &&
    (what.air || (axis.kind === "pressure" && !what.ocean)) &&
    !what.land &&
    !what.potential
  ) {
    ids.add("tropopause");
  }
  return ids;
}

/**
 * The level diagnostics any date's profile has (an isotherm, a mixed-layer
 * depth): offered over time when some dates have them, not only when the mean
 * profile does. Every date is looked at, until each diagnostic its kind can
 * have is found.
 */
export function levelStatisticsOverRows(
  rows: number,
  nk: number,
  values: ArrayLike<number>,
  column: Omit<TColumn, "values">
) {
  const possible = possibleLevelIds(column);
  // The 20 °C isotherm needs a value of 20 °C or more somewhere: one tight pass
  // says whether any has, before profiles are diagnosed one by one.
  if (possible.has("z20")) {
    const celsius = converter(column.units, "degC");
    let warm = !celsius;
    for (let at = 0; !warm && at < rows * nk; at++) {
      warm = celsius!(values[at]) >= 20;
    }
    if (!warm) {
      possible.delete("z20");
    }
  }
  const found = new Map<string, TVerticalStat>();
  const profile = new Array<number>(nk);
  for (let t = 0; t < rows && found.size < possible.size; t++) {
    let any = false;
    for (let k = 0; k < nk; k++) {
      profile[k] = values[t * nk + k];
      any ||= Number.isFinite(profile[k]);
    }
    if (!any) {
      continue;
    }
    for (const stat of verticalStatistics({ ...column, values: profile })) {
      if (stat.kind === "level" && !found.has(stat.id)) {
        found.set(stat.id, stat);
      }
    }
  }
  return [...found.values()];
}
