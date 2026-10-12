import type { TGeoBounds } from "./equirectLayer.ts";

export const GridTextureExportUserDataKey = {
  METADATA: "gridTextureExport",
} as const;

export const TextureExportVCoordinate = {
  BOTTOM: 0,
  TOP: 1,
} as const;

type TTextureExportVCoordinate =
  (typeof TextureExportVCoordinate)[keyof typeof TextureExportVCoordinate];

export type TRegularLatLonTextureExportMetadata = {
  bounds: TGeoBounds;
  topV: TTextureExportVCoordinate;
};

const DEFAULT_SINGLE_COORD_SPAN = 1;
// Coordinate arrays are commonly stored as Float32 (e.g. Zarr/NetCDF lat/lon
// variables), which only carries ~1e-5deg precision at longitude magnitude.
// Cell-edge bounds derived from them (first - step/2, last + step/2) can
// overshoot the true edge by that much, which is enough to fail downstream
// validation (e.g. a global grid landing a hair past +-180deg). Rounding to
// this precision removes that noise while staying far finer than any real
// grid resolution.
const COORDINATE_PRECISION_DEGREES = 1e-4;

function roundToCoordinatePrecision(value: number): number {
  return (
    Math.round(value / COORDINATE_PRECISION_DEGREES) *
    COORDINATE_PRECISION_DEGREES
  );
}

const UNIFORM_SPACING_RELATIVE_TOLERANCE = 0.01;

// The direct-texture GeoTIFF export maps texture rows/columns linearly onto
// the geographic bounds, which only reproduces the source grid correctly
// when coordinate spacing is actually uniform. Equal-area grids (e.g.
// EASE-Grid 2.0) space latitudes non-uniformly (denser near the equator),
// so they must fall back to the slower per-vertex export path instead.
export function isUniformlySpaced(values: Float32Array): boolean {
  if (values.length < 3) {
    return true;
  }
  const referenceStep = values[1] - values[0];
  if (referenceStep === 0) {
    return false;
  }
  const tolerance =
    Math.abs(referenceStep) * UNIFORM_SPACING_RELATIVE_TOLERANCE;
  for (let index = 2; index < values.length; index++) {
    const step = values[index] - values[index - 1];
    if (Math.abs(step - referenceStep) > tolerance) {
      return false;
    }
  }
  return true;
}

function getSingleCoordinateBounds(value: number) {
  const halfSpan = DEFAULT_SINGLE_COORD_SPAN / 2;
  return { min: value - halfSpan, max: value + halfSpan };
}

function getOrderedLongitudeBounds(
  longitudes: Float32Array
): Pick<TGeoBounds, "west" | "east"> | undefined {
  if (longitudes.length === 0) {
    return undefined;
  }
  if (longitudes.length === 1) {
    const bounds = getSingleCoordinateBounds(longitudes[0]);
    return { west: bounds.min, east: bounds.max };
  }

  const first = longitudes[0];
  const last = longitudes[longitudes.length - 1];
  const firstStep = longitudes[1] - first;
  const lastStep = last - longitudes[longitudes.length - 2];
  if (firstStep <= 0 || lastStep <= 0 || last <= first) {
    return undefined;
  }

  return {
    west: roundToCoordinatePrecision(first - firstStep / 2),
    east: roundToCoordinatePrecision(last + lastStep / 2),
  };
}

function getLatitudeBounds(
  latitudes: Float32Array
): Pick<TGeoBounds, "south" | "north"> | undefined {
  if (latitudes.length === 0) {
    return undefined;
  }
  if (latitudes.length === 1) {
    const bounds = getSingleCoordinateBounds(latitudes[0]);
    return {
      south: Math.max(-90, bounds.min),
      north: Math.min(90, bounds.max),
    };
  }

  const first = latitudes[0];
  const last = latitudes[latitudes.length - 1];
  const firstStep = latitudes[1] - first;
  const lastStep = last - latitudes[latitudes.length - 2];
  if (firstStep === 0 || lastStep === 0 || first === last) {
    return undefined;
  }

  if (first < last) {
    return {
      south: Math.max(-90, first - Math.abs(firstStep) / 2),
      north: Math.min(90, last + Math.abs(lastStep) / 2),
    };
  }

  return {
    south: Math.max(-90, last - Math.abs(lastStep) / 2),
    north: Math.min(90, first + Math.abs(firstStep) / 2),
  };
}

export function getRegularLatLonGridBounds(
  latitudes: Float32Array,
  longitudes: Float32Array
): TGeoBounds | undefined {
  const longitudeBounds = getOrderedLongitudeBounds(longitudes);
  const latitudeBounds = getLatitudeBounds(latitudes);
  if (!longitudeBounds || !latitudeBounds) {
    return undefined;
  }
  if (latitudeBounds.north <= latitudeBounds.south) {
    return undefined;
  }
  return {
    ...longitudeBounds,
    ...latitudeBounds,
  };
}
