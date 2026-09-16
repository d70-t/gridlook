import type * as zarr from "zarrita";

export type TVectorMagnitudeInfo = {
  standardName?: string;
  longName: string;
  units: string;
};

export type TVectorMagnitudeData = TVectorMagnitudeInfo & {
  data: Float32Array;
  min: number;
  max: number;
};

const EXPLICIT_MAGNITUDE_NAMES: Record<string, string> = {
  wind: "wind_speed",
  ["sea_water_velocity"]: "sea_water_speed",
  ["sea_water_velocity_at_sea_floor"]: "sea_water_speed_at_sea_floor",
  ["sea_water_velocity_due_to_tides"]: "sea_water_speed_due_to_tides",
  ["sea_ice_velocity"]: "sea_ice_speed",
};

function cfName(attrs: zarr.Attributes) {
  const value = attrs.standard_name;
  return typeof value === "string" && !value.includes(" ") ? value : undefined;
}

function matchingVectorBase(uName: string, vName: string) {
  const uParts = uName.split("_");
  const vParts = vName.split("_");
  if (uParts.length !== vParts.length) {
    return undefined;
  }
  const differences = uParts.flatMap((part, index) =>
    part === vParts[index] ? [] : [index]
  );
  if (differences.length !== 1) {
    return undefined;
  }
  const index = differences[0];
  const isDirectionalPair =
    (uParts[index] === "eastward" && vParts[index] === "northward") ||
    (uParts[index] === "x" && vParts[index] === "y");
  if (!isDirectionalPair) {
    return undefined;
  }
  uParts.splice(index, 1);
  const base = uParts.join("_");
  return base.startsWith("grid_") ? base.slice("grid_".length) : base;
}

function humanizeStandardName(standardName: string) {
  return standardName
    .split("_")
    .map((word, index) =>
      index === 0 ? `${word.charAt(0).toUpperCase()}${word.slice(1)}` : word
    )
    .join(" ");
}

function matchingUnits(uAttrs: zarr.Attributes, vAttrs: zarr.Attributes) {
  const uUnits = typeof uAttrs.units === "string" ? uAttrs.units.trim() : "";
  const vUnits = typeof vAttrs.units === "string" ? vAttrs.units.trim() : "";
  return uUnits && uUnits === vUnits ? uUnits : undefined;
}

/** Resolve a CF-valid scalar magnitude from two horizontal components. */
export function resolveCfVectorMagnitude(
  uAttrs: zarr.Attributes,
  vAttrs: zarr.Attributes
): TVectorMagnitudeInfo | undefined {
  const uName = cfName(uAttrs);
  const vName = cfName(vAttrs);
  const units = matchingUnits(uAttrs, vAttrs);
  if (!uName || !vName || !units) {
    return undefined;
  }
  const base = matchingVectorBase(uName, vName);
  const standardName = base ? EXPLICIT_MAGNITUDE_NAMES[base] : undefined;
  if (!standardName) {
    return undefined;
  }
  return {
    standardName,
    longName: humanizeStandardName(standardName),
    units,
  };
}

/** Resolve a specific CF magnitude or a generic magnitude for equal units. */
export function resolveVectorMagnitude(
  uAttrs: zarr.Attributes,
  vAttrs: zarr.Attributes
): TVectorMagnitudeInfo | undefined {
  const cfMagnitude = resolveCfVectorMagnitude(uAttrs, vAttrs);
  if (cfMagnitude) {
    return cfMagnitude;
  }
  const units = matchingUnits(uAttrs, vAttrs);
  return units ? { longName: "Vector magnitude", units } : undefined;
}

export function calculateVectorMagnitude(
  uData: Float32Array,
  vData: Float32Array,
  uScale = 1,
  vScale = 1
) {
  if (uData.length !== vData.length) {
    throw new Error("Derived vector components have different data lengths");
  }
  const magnitude = new Float32Array(uData.length);
  for (let index = 0; index < magnitude.length; index++) {
    magnitude[index] = Math.hypot(uData[index] * uScale, vData[index] * vScale);
  }
  return magnitude;
}

export function getVectorMagnitudeBounds(data: Float32Array) {
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  for (const value of data) {
    if (!Number.isFinite(value)) {
      continue;
    }
    min = Math.min(min, value);
    max = Math.max(max, value);
  }
  return {
    min: min === Number.POSITIVE_INFINITY ? NaN : min,
    max: max === Number.NEGATIVE_INFINITY ? NaN : max,
  };
}

export function createVectorMagnitudeData(
  uData: Float32Array,
  vData: Float32Array,
  info: TVectorMagnitudeInfo
): TVectorMagnitudeData {
  const data = calculateVectorMagnitude(uData, vData);
  const { min, max } = getVectorMagnitudeBounds(data);
  return { data, min, max, ...info };
}
