import * as d3 from "d3-geo";
import { geoMollweide, geoRobinson } from "d3-geo-projection";

export const PROJECTION_TYPES = {
  GLOBE: "globe",
  MERCATOR: "mercator",
  ROBINSON: "robinson",
  MOLLWEIDE: "mollweide",
} as const;

export type TProjectionType =
  (typeof PROJECTION_TYPES)[keyof typeof PROJECTION_TYPES];

export type TProjectionCenter = {
  lat: number;
  lon: number;
};

export type TProjectionHelper = {
  type: TProjectionType;
  isFlat: boolean;
  center: TProjectionCenter;
  project: (
    lat: number,
    lon: number,
    radius?: number
  ) => [number, number, number];
  invert?: (
    x: number,
    y: number,
    radius?: number
  ) => { lat: number; lon: number } | undefined;
  normalizeLongitude: (lon: number) => number;
};

const MERCATOR_LAT_LIMIT = 85;
type TProjectionOptions = {
  center?: TProjectionCenter;
  longitudeDomain?: { min: number; max: number };
};

export function clampLatitude(lat: number) {
  return Math.max(-90, Math.min(90, lat));
}

export function wrapLongitude(lon: number) {
  let normalized = lon;
  while (normalized < -180) {
    normalized += 360;
  }
  while (normalized > 180) {
    normalized -= 360;
  }
  return normalized;
}

export function isFlatProjection(type: TProjectionType) {
  return type !== PROJECTION_TYPES.GLOBE;
}

export function createProjectionHelper(
  type: TProjectionType,
  center: TProjectionCenter,
  _options?: TProjectionOptions
): TProjectionHelper {
  // longitudeDomain is currently unused but kept in signature for future
  // extensions; normalization remains global.
  void _options;
  // We keep normalizeLongitude stable regardless of domain to avoid flicker
  // when switching between global and partial longitude coverage.
  const normalizeLongitude = (lon: number) => {
    return (((lon % 360) + 540) % 360) - 180;
  };

  if (type === PROJECTION_TYPES.MERCATOR) {
    const d3Projection = d3
      .geoMercator()
      .translate([0, 0])
      .scale(1)
      .rotate([-center.lon, -center.lat]);

    const project = (
      lat: number,
      lon: number,
      radius = 1
    ): [number, number, number] => {
      const safeLat = clampLatitude(
        Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, lat))
      );
      const projected = d3Projection([normalizeLongitude(lon), safeLat]);
      if (!projected) {
        return [0, 0, 0];
      }
      const [x, y] = projected;
      return [x * radius, -y * radius, 0];
    };

    return {
      type,
      isFlat: true,
      center,
      project,
      normalizeLongitude,
    };
  }

  if (type === PROJECTION_TYPES.ROBINSON) {
    const d3Projection = geoRobinson()
      .translate([0, 0])
      .scale(1)
      .rotate([-center.lon, -center.lat]);

    const project = (
      lat: number,
      lon: number,
      radius = 1
    ): [number, number, number] => {
      const projected = d3Projection([normalizeLongitude(lon), lat]);
      if (!projected) {
        return [0, 0, 0];
      }
      const [x, y] = projected;
      return [x * radius, -y * radius, 0];
    };

    return {
      type,
      isFlat: true,
      center,
      project,
      normalizeLongitude,
    };
  }

  if (type === PROJECTION_TYPES.MOLLWEIDE) {
    const d3Projection = geoMollweide()
      .translate([0, 0])
      .scale(1)
      .rotate([-center.lon, -center.lat]);

    const project = (
      lat: number,
      lon: number,
      radius = 1
    ): [number, number, number] => {
      const projected = d3Projection([normalizeLongitude(lon), lat]);
      if (!projected) {
        return [0, 0, 0];
      }
      const [x, y] = projected;
      return [x * radius, -y * radius, 0];
    };

    return {
      type,
      isFlat: true,
      center,
      project,
      normalizeLongitude,
    };
  }

  const project = (
    lat: number,
    lon: number,
    radius = 1
  ): [number, number, number] => {
    const latRad = (lat * Math.PI) / 180;
    const lonRad = (lon * Math.PI) / 180;

    const x = radius * Math.cos(latRad) * Math.cos(lonRad);
    const y = radius * Math.cos(latRad) * Math.sin(lonRad);
    const z = radius * Math.sin(latRad);

    return [x, y, z];
  };

  return {
    type,
    isFlat: false,
    center,
    project,
    normalizeLongitude,
  };
}
