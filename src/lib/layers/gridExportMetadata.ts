import { type TGeoBounds } from "./equirectLayer.ts";

export const GridTextureExportMode = {
  REGULAR_LAT_LON: "regular-lat-lon",
} as const;

export type TGridTextureExportMode =
  (typeof GridTextureExportMode)[keyof typeof GridTextureExportMode];

export const GridTextureExportUserDataKey = {
  METADATA: "gridTextureExport",
} as const;

export type TGridTextureExportUserDataKey =
  (typeof GridTextureExportUserDataKey)[keyof typeof GridTextureExportUserDataKey];

export const TextureExportVCoordinate = {
  BOTTOM: 0,
  TOP: 1,
} as const;

export type TTextureExportVCoordinate =
  (typeof TextureExportVCoordinate)[keyof typeof TextureExportVCoordinate];

export type TRegularLatLonTextureExportMetadata = {
  mode: typeof GridTextureExportMode.REGULAR_LAT_LON;
  bounds: TGeoBounds;
  topV: TTextureExportVCoordinate;
};

export type TGridTextureExportMetadata = TRegularLatLonTextureExportMetadata;

const DEFAULT_SINGLE_COORD_SPAN = 1;

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
    west: first - firstStep / 2,
    east: last + lastStep / 2,
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
