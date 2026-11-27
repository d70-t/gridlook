/**
 * Vertical coordinates for profiles and sections: a direct physical axis, a
 * CF parametric formula evaluated from its terms, or model levels that are
 * labelled as such and never given an invented physical unit.
 */

import { verticalCoordinateScore } from "@/lib/data/dimensionData.ts";

type TAttrs = Record<string, unknown>;

export const VERTICAL_KINDS = {
  PHYSICAL: "physical",
  FORMULA: "formula",
  MODEL: "model",
} as const;

type TVerticalKind = (typeof VERTICAL_KINDS)[keyof typeof VERTICAL_KINDS];

export const FORMULA_FAMILIES = {
  OCEAN_SIGMA: "ocean_sigma_coordinate",
  OCEAN_S_G1: "ocean_s_coordinate_g1",
  OCEAN_S_G2: "ocean_s_coordinate_g2",
  HYBRID_PRESSURE: "atmosphere_hybrid_sigma_pressure_coordinate",
  /**
   * Not a CF formula: a physical position published as an auxiliary
   * coordinate over the level and horizontal dimensions (pressure(layer,
   * lat, lon)), read per column like a formula term `z`.
   */
  AUXILIARY: "gridlook_auxiliary_vertical_coordinate",
} as const;

export type TFormulaFamily =
  (typeof FORMULA_FAMILIES)[keyof typeof FORMULA_FAMILIES];

const FAMILY_TERMS: Record<TFormulaFamily, string[][]> = {
  [FORMULA_FAMILIES.OCEAN_SIGMA]: [["sigma", "eta", "depth"]],
  [FORMULA_FAMILIES.OCEAN_S_G1]: [["s", "C", "eta", "depth", "depth_c"]],
  [FORMULA_FAMILIES.OCEAN_S_G2]: [["s", "C", "eta", "depth", "depth_c"]],
  [FORMULA_FAMILIES.HYBRID_PRESSURE]: [
    ["a", "b", "ps", "p0"],
    ["ap", "b", "ps"],
  ],
  [FORMULA_FAMILIES.AUXILIARY]: [["z"]],
};

const PHYSICAL_UNITS =
  /^(m|meters?|metres?|km|cm|dbar|decibar|pa|pascals?|hpa|kpa|mbar|millibar|bar|atm)$/i;

/**
 * Vertical coordinates in a quantity other than length or pressure (CF
 * allows them): potential temperature (isentropic levels), in kelvin.
 */
const ISENTROPIC = /potential_temperature$/;

const PHYSICAL_STANDARD_NAMES =
  /^(depth|height|altitude|air_pressure|sea_water_pressure|geopotential_height|height_above_.*|depth_below_.*|.*potential_temperature)$/;

export type TVerticalAxis = {
  kind: TVerticalKind;
  /** Index of the vertical dimension among the variable's dimensions. */
  axis: number;
  dimension: string;
  units?: string;
  positive?: "up" | "down";
  label: string;
  family?: TFormulaFamily;
  /** Formula term name to variable name. */
  terms?: Record<string, string>;
  /**
   *  Key of the coordinate that names the terms: they are read from its
   * store (a grid or vertical sidecar), not a same-named data array.
   */
  termsOwner?: string;
  /** Why only a model-level view is possible, naming the dependency. */
  note?: string;
  /**
   * CF standard name of the physical positions: the coordinate's own for a
   * physical axis; for a formula, its published computed_standard_name, or
   * air_pressure for hybrid pressure. Absent when it cannot be known (a
   * height formula's datum depends on its terms).
   */
  positionStandardName?: string;
};

export function parseFormulaTerms(text: unknown): Record<string, string> {
  const terms: Record<string, string> = {};
  if (typeof text !== "string") {
    return terms;
  }
  const pattern = /([A-Za-z0-9_]+)\s*:\s*([^\s:]+)(?=\s|$)/g;
  for (const match of text.matchAll(pattern)) {
    terms[match[1]] = match[2];
  }
  return terms;
}

export const PRESSURE_UNITS =
  /^(pa|pascals?|hpa|kpa|mbar|millibar|bar|dbar|decibar|atm)$/i;

/**
 * Direction of increasing values: declared, or as CF implies it when absent
 * (pressure units and depths grow downwards; heights upwards).
 */
const VERTICAL_NAMES =
  /pressure|depth|height|altitude|model_level|sigma|hybrid|geopotential/i;

/**
 * Whether a coordinate describes a vertical position: pressure units, a
 * vertical standard name, `positive` or `axis: Z`. Used before choosing
 * horizontal axes, so a level dimension is never taken for one.
 */
export function looksVertical(attrs: TAttrs) {
  const units = String(attrs.units ?? "").trim();
  return (
    PRESSURE_UNITS.test(units) ||
    VERTICAL_NAMES.test(String(attrs.standard_name ?? "")) ||
    /^(up|down)$/i.test(String(attrs.positive ?? "").trim()) ||
    String(attrs.axis ?? "").toUpperCase() === "Z"
  );
}

/** Whether a coordinate named like a level has nothing saying it is not one. */
function verticalByMetadata(attrs: TAttrs) {
  const units = String(attrs.units ?? "").trim();
  const words = `${attrs.long_name ?? ""} ${attrs.standard_name ?? ""}`;
  if (
    /energy|frequency|wavelength|wavenumber|angle|pitch|channel|band/i.test(
      words
    )
  ) {
    return false;
  }
  return (
    !units ||
    /^(1|level|levels|index|count)$/i.test(units) ||
    PHYSICAL_UNITS.test(units) ||
    looksVertical(attrs)
  );
}

/**
 * A dimensional vertical coordinate declared as one: `axis: Z` or `positive`,
 * units that are a quantity's (not 1, level or index), and no parametric
 * (`…_coordinate`) standard name, which needs its formula.
 */
function declaredDimensional(
  attrs: TAttrs,
  standardName: string,
  units: string | undefined
) {
  const declared =
    String(attrs.axis ?? "").toUpperCase() === "Z" ||
    /^(up|down)$/i.test(String(attrs.positive ?? "").trim());
  const dimensional =
    units !== undefined &&
    units.trim() !== "" &&
    !/^(1|level|levels|layer|layers|index|count|sigma)$/i.test(units.trim());
  return declared && dimensional && !/_coordinate$/.test(standardName);
}

/** An ensemble (realization) dimension: never horizontal, never vertical. */
export function looksEnsemble(name: string, attrs: TAttrs) {
  return (
    attrs.standard_name === "realization" ||
    String(attrs.axis ?? "").toUpperCase() === "E" ||
    /^(member|members|ensemble|realization|realisation|ens)$/i.test(name)
  );
}

/** CF `positive` in any case ("DOWN"), else what units or name imply. */
export function positiveOf(attrs: TAttrs): "up" | "down" | undefined {
  const positive = String(attrs.positive ?? "")
    .trim()
    .toLowerCase();
  if (positive === "up" || positive === "down") {
    return positive;
  }
  const units = String(attrs.units ?? "").trim();
  const standardName = String(attrs.standard_name ?? "");
  if (PRESSURE_UNITS.test(units) || /pressure|^depth/.test(standardName)) {
    return "down";
  }
  if (/^(height|altitude|geopotential_height)/.test(standardName)) {
    return "up";
  }
  return undefined;
}

/**
 * Terms CF lets a formula omit (taken as zero): the ocean free surface
 * `eta`. Omitted is fine; named but unavailable is a missing dependency.
 */
const OPTIONAL_TERMS = new Set(["eta"]);

function matchTermSet(
  family: TFormulaFamily,
  terms: Record<string, string>,
  available: (variable: string) => boolean
) {
  let best: { missing: string[]; set: string[] } | undefined;
  for (const set of FAMILY_TERMS[family]) {
    const missing = set.filter((term) =>
      OPTIONAL_TERMS.has(term) && !terms[term]
        ? false
        : !terms[term] || !available(terms[term])
    );
    if (!best || missing.length < best.missing.length) {
      best = { missing, set };
    }
  }
  return best!;
}

/**
 * Classify the vertical dimension of a variable. `attrsOf` gives the
 * attributes of a coordinate variable; `available` says whether a variable
 * exists in the dataset.
 */
// eslint-disable-next-line max-lines-per-function
export function resolveVerticalAxis(
  axis: number,
  dimension: string,
  coordinateAttrs: TAttrs | undefined,
  available: (variable: string) => boolean
): TVerticalAxis {
  const attrs = coordinateAttrs ?? {};
  const standardName = String(attrs.standard_name ?? "");
  const units = typeof attrs.units === "string" ? attrs.units : undefined;
  const positive = positiveOf(attrs);
  const familyName = Object.values(FORMULA_FAMILIES).find(
    (family) => family === standardName
  );
  if (familyName) {
    const terms = parseFormulaTerms(attrs.formula_terms);
    const { missing } = matchTermSet(familyName, terms, available);
    if (missing.length === 0) {
      return {
        kind: VERTICAL_KINDS.FORMULA,
        axis,
        dimension,
        family: familyName,
        terms,
        units: familyName === FORMULA_FAMILIES.HYBRID_PRESSURE ? "Pa" : "m",
        positive:
          familyName === FORMULA_FAMILIES.HYBRID_PRESSURE ? "down" : "up",
        ...(typeof attrs.computed_standard_name === "string"
          ? { positionStandardName: attrs.computed_standard_name }
          : familyName === FORMULA_FAMILIES.HYBRID_PRESSURE
            ? { positionStandardName: "air_pressure" }
            : {}),
        label:
          familyName === FORMULA_FAMILIES.HYBRID_PRESSURE
            ? "air pressure (Pa)"
            : "height above datum (m, from formula_terms)",
      };
    }
    return {
      kind: VERTICAL_KINDS.MODEL,
      axis,
      dimension,
      label: `model level ${dimension}`,
      note: `${standardName} needs formula term${missing.length > 1 ? "s" : ""} ${missing.join(", ")}, which ${missing.length > 1 ? "are" : "is"} not available.`,
    };
  }
  const physical =
    (units !== undefined && PHYSICAL_UNITS.test(units.trim())) ||
    PHYSICAL_STANDARD_NAMES.test(standardName) ||
    // Isentropic levels: potential temperature in K.
    (ISENTROPIC.test(standardName) && /^(k|kelvin)$/i.test(units ?? "")) ||
    declaredDimensional(attrs, standardName, units);
  if (physical && units !== undefined && !attrs.formula_terms) {
    return {
      kind: VERTICAL_KINDS.PHYSICAL,
      axis,
      dimension,
      units,
      positive,
      label: `${standardName || dimension} (${units}${positive ? `, positive ${positive}` : ""})`,
      ...(standardName ? { positionStandardName: standardName } : {}),
    };
  }
  return {
    kind: VERTICAL_KINDS.MODEL,
    axis,
    dimension,
    label: `model level ${dimension}`,
    note: standardName
      ? `${standardName} is not a supported vertical formula.`
      : `${dimension} has no standard_name, formula_terms or physical units.`,
  };
}

export type TFormulaInputs = {
  /** Terms varying only along the vertical dimension. */
  perLevel: Record<string, Float64Array>;
  /** Scalar terms, and terms read at this column and time. */
  scalar: Record<string, number>;
};

function term(inputs: TFormulaInputs, name: string, k: number) {
  const level = inputs.perLevel[name];
  if (level) {
    return level[k];
  }
  const value = inputs.scalar[name];
  if (value === undefined) {
    if (OPTIONAL_TERMS.has(name)) {
      return 0; // omitted by convention
    }
    throw new Error(`Formula term ${name} is missing.`);
  }
  return value;
}

const UNIT_FACTORS: Record<string, number> = {
  pa: 1,
  hpa: 100,
  mbar: 100,
  millibar: 100,
  kpa: 1000,
  bar: 100000,
  dbar: 10000,
  decibar: 10000,
  m: 1,
  meter: 1,
  meters: 1,
  metre: 1,
  metres: 1,
  cm: 0.01,
  mm: 0.001,
  km: 1000,
  atm: 101325,
  "%": 0.01,
  percent: 0.01,
};

/**
 * The factor from `from` to `to` when both are pressures or both lengths
 * plots know (hPa → Pa is 100), else undefined.
 */
export function unitFactor(from: string, to: string) {
  const [a, b] = [from.trim().toLowerCase(), to.trim().toLowerCase()];
  const kind = (key: string) =>
    PRESSURE_UNITS.test(key) || key === "millibar" || key === "decibar"
      ? "pressure"
      : key in UNIT_FACTORS && key !== "%" && key !== "percent"
        ? "length"
        : undefined;
  if (!kind(a) || kind(a) !== kind(b)) {
    return undefined;
  }
  return UNIT_FACTORS[a] / UNIT_FACTORS[b];
}

// Units of dimensionless formula terms (coefficients, sigma, s).
const DIMENSIONLESS = /^(1|-|dimensionless|fraction|)$/i;

/**
 * Why a formula term's units cannot be converted, or undefined. A unit that
 * is neither known nor dimensionless would otherwise be read as SI.
 */
export function formulaUnitProblem(term: string, unit: string) {
  const key = unit.trim().toLowerCase();
  if (!(key in UNIT_FACTORS || DIMENSIONLESS.test(key))) {
    return `Formula term ${term} has units "${unit}", which plots cannot convert to Pa or m.`;
  }
  // The term's own physical quantity: pressure, length or a coefficient.
  const quantity = TERM_QUANTITY[term];
  const found =
    DIMENSIONLESS.test(key) || key === "%" || key === "percent"
      ? "dimensionless"
      : PRESSURE_UNITS.test(key) || key === "millibar" || key === "decibar"
        ? "pressure"
        : "length";
  // An empty unit on a dimensional term is read as SI, as before.
  if (
    quantity &&
    found !== quantity &&
    !(key === "" && quantity !== "dimensionless")
  ) {
    return `Formula term ${term} should be a ${quantity === "dimensionless" ? "dimensionless coefficient" : quantity}, but its units are "${unit}".`;
  }
  return undefined;
}

const TERM_QUANTITY: Record<string, "pressure" | "length" | "dimensionless"> = {
  ap: "pressure",
  ps: "pressure",
  p0: "pressure",
  a: "dimensionless",
  b: "dimensionless",
  sigma: "dimensionless",
  s: "dimensionless",
  C: "dimensionless",
  eta: "length",
  depth: "length",
  depth_c: "length", // eslint-disable-line camelcase
};

/**
 * Factors that bring each formula term to SI (Pa or m); dimensionless and
 * unknown units keep 1.
 */
export function normalizeFormulaTerms(units: Record<string, string>) {
  const factors: Record<string, number> = {};
  for (const [name, unit] of Object.entries(units)) {
    factors[name] = UNIT_FACTORS[unit.trim().toLowerCase()] ?? 1;
  }
  return factors;
}

/** Evaluate a CF parametric vertical coordinate for one column, in Pa or m. */
export function evaluateFormula(
  family: TFormulaFamily,
  inputs: TFormulaInputs,
  levels: number,
  factors: Record<string, number> = {}
): Float64Array {
  const z = new Float64Array(levels);
  for (let k = 0; k < levels; k++) {
    const t = (name: string) => term(inputs, name, k) * (factors[name] ?? 1);
    switch (family) {
      case FORMULA_FAMILIES.OCEAN_SIGMA:
        z[k] = t("eta") + t("sigma") * (t("depth") + t("eta"));
        break;
      case FORMULA_FAMILIES.OCEAN_S_G1: {
        const s = t("depth_c") * t("s") + (t("depth") - t("depth_c")) * t("C");
        z[k] = s + t("eta") * (1 + s / t("depth"));
        break;
      }
      case FORMULA_FAMILIES.OCEAN_S_G2: {
        const s =
          (t("depth_c") * t("s") + t("depth") * t("C")) /
          (t("depth_c") + t("depth"));
        z[k] = t("eta") + (t("eta") + t("depth")) * s;
        break;
      }
      case FORMULA_FAMILIES.AUXILIARY:
        z[k] = t("z");
        break;
      case FORMULA_FAMILIES.HYBRID_PRESSURE:
        z[k] =
          inputs.perLevel.ap !== undefined
            ? t("ap") + t("b") * t("ps")
            : t("a") * t("p0") + t("b") * t("ps");
        break;
    }
  }
  return z;
}

// The map's scorer misses parametric (terrain-following) axes such as ROMS/CROCO
// `s_rho`; analysis also recognises those, below the map's own scores.
export function verticalScore(dimension: string, attrs: TAttrs) {
  const score = verticalCoordinateScore(dimension, attrs as never);
  // A name alone (energy_level, …) is no vertical axis when the coordinate says
  // it is something else: units of another quantity, or a spectral long name.
  if (score === 70 && !verticalByMetadata(attrs)) {
    return 0;
  }
  if (score > 0) {
    return score;
  }
  // E.g. p(p) = [850, 500] with units hPa and nothing else.
  if (looksVertical(attrs) && !looksEnsemble(dimension, attrs)) {
    return 55;
  }
  if (
    /(ocean_s_coordinate|ocean_sigma|ocean_double_sigma|atmosphere_.*coordinate)/.test(
      String(attrs.standard_name ?? "")
    )
  ) {
    return 65;
  }
  return /^(s_rho|s_w|sc_r|sc_w|olevel|alevel|z_t|zt|nz|nlev)$/i.test(dimension)
    ? 60
    : 0;
}
