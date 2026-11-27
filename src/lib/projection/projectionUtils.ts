import * as d3 from "d3-geo";
import {
  geoMollweide,
  geoRobinson,
  geoCylindricalEqualArea,
} from "d3-geo-projection";
import { MathUtils } from "three";

import { createAzimuthalHybridRaw } from "./azimuthalHybrid.ts";

export const PROJECTION_TYPES = {
  NEARSIDE_PERSPECTIVE: "nearside_perspective",
  MERCATOR: "mercator",
  ROBINSON: "robinson",
  MOLLWEIDE: "mollweide",
  CYLINDRICAL_EQUAL_AREA: "cylindrical_equal_area",
  EQUIRECTANGULAR: "equirectangular",
  AZIMUTHAL_EQUIDISTANT: "azimuthal_equidistant",
  AZIMUTHAL_HYBRID: "azimuthal_hybrid",
} as const;

export type TProjectionType =
  (typeof PROJECTION_TYPES)[keyof typeof PROJECTION_TYPES];

export type TProjectionCenter = {
  lat: number;
  lon: number;
};

export const MERCATOR_LAT_LIMIT = 85;

// Clip angle for azimuthal equidistant projection (matches coastline clipping)
export const AZIMUTHAL_CLIP_ANGLE = 173;

// Clamp helper for projection center; falls back to 0 for non-finite input
// because (lat: 0, lon: 0) is the neutral "reset" center used elsewhere.
export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(Number.isFinite(value) ? value : 0, min), max);
}

export function isAzimuthalProjectionType(type: TProjectionType) {
  return (
    type === PROJECTION_TYPES.AZIMUTHAL_EQUIDISTANT ||
    type === PROJECTION_TYPES.AZIMUTHAL_HYBRID
  );
}

/**
 * Whether an azimuthal map shows a place: within the angle it is clipped at
 * (the renderer's, AZIMUTHAL_CLIP_ANGLE). Its inverse answers beyond that too,
 * where nothing is drawn.
 */
export function withinAzimuthalClip(
  center: TProjectionCenter,
  lat: number,
  lon: number
) {
  const r = Math.PI / 180;
  const cos =
    Math.sin(center.lat * r) * Math.sin(lat * r) +
    Math.cos(center.lat * r) *
      Math.cos(lat * r) *
      Math.cos((lon - center.lon) * r);
  return Math.acos(Math.max(-1, Math.min(1, cos))) <= AZIMUTHAL_CLIP_ANGLE * r;
}

export class ProjectionHelper {
  readonly type: TProjectionType;
  readonly isFlat: boolean;
  readonly center: TProjectionCenter;

  private d3Projection:
    | d3.GeoProjection
    | ReturnType<typeof geoRobinson>
    | ReturnType<typeof geoMollweide>
    | null = null;

  constructor(type: TProjectionType, center: TProjectionCenter) {
    this.type = type;
    this.center = center;
    this.isFlat = type !== PROJECTION_TYPES.NEARSIDE_PERSPECTIVE;

    this.initializeD3Projection();
  }

  private initializeD3Projection(): void {
    // We still keep a d3 projection for CPU-side geometry work:
    // flat mask clipping, bounds, and initial vertex positions before shaders run.
    this.d3Projection = this.createD3ProjectionInstance();
    const angles = this.d3Projection?.rotate() ?? [0, 0, 0];
    this.mercatorRotation =
      this.type === PROJECTION_TYPES.MERCATOR &&
      ((angles[1] ?? 0) !== 0 || (angles[2] ?? 0) !== 0)
        ? d3.geoRotation(angles as [number, number, number])
        : undefined;
  }

  private createAzimuthalProjectionInstance(): d3.GeoProjection | null {
    switch (this.type) {
      case PROJECTION_TYPES.AZIMUTHAL_EQUIDISTANT:
        return d3.geoAzimuthalEquidistant().clipAngle(AZIMUTHAL_CLIP_ANGLE);
      case PROJECTION_TYPES.AZIMUTHAL_HYBRID:
        return d3
          .geoProjection(createAzimuthalHybridRaw())
          .clipAngle(AZIMUTHAL_CLIP_ANGLE);
      default:
        return null;
    }
  }

  createD3ProjectionInstance(): d3.GeoProjection | null {
    let d3Projection: d3.GeoProjection | null = null;
    switch (this.type) {
      case PROJECTION_TYPES.MERCATOR:
        d3Projection = d3.geoMercator();
        break;
      case PROJECTION_TYPES.ROBINSON:
        // Use precision for better adaptive resampling at curved edges
        d3Projection = geoRobinson();
        break;
      case PROJECTION_TYPES.MOLLWEIDE:
        d3Projection = geoMollweide();
        break;
      case PROJECTION_TYPES.CYLINDRICAL_EQUAL_AREA:
        d3Projection = geoCylindricalEqualArea();
        break;
      case PROJECTION_TYPES.EQUIRECTANGULAR:
        d3Projection = d3.geoEquirectangular();
        break;
      case PROJECTION_TYPES.AZIMUTHAL_EQUIDISTANT:
      case PROJECTION_TYPES.AZIMUTHAL_HYBRID:
        d3Projection = this.createAzimuthalProjectionInstance();
        break;
      default:
        d3Projection = null;
    }
    const centerLat = Math.max(-90, Math.min(90, this.center.lat));
    const centerLon = ProjectionHelper.normalizeLongitude(this.center.lon);

    d3Projection?.translate([0, 0]).scale(1).rotate([-centerLon, -centerLat]);
    return d3Projection;
  }

  static normalizeLongitude(lon: number): number {
    return (((lon % 360) + 540) % 360) - 180;
  }

  static cartesianToLatLon(x: number, y: number, z: number) {
    const r = Math.sqrt(x * x + y * y + z * z);
    const lat = MathUtils.radToDeg(Math.asin(z / r));
    const lon = MathUtils.radToDeg(Math.atan2(y, x));
    return { lat, lon };
  }

  getD3Projection(): d3.GeoProjection | null {
    return this.d3Projection;
  }

  project(lat: number, lon: number, radius = 1): [number, number, number] {
    if (this.type === PROJECTION_TYPES.NEARSIDE_PERSPECTIVE) {
      return this.projectGlobe(lat, lon, radius);
    }

    if (this.type === PROJECTION_TYPES.MERCATOR) {
      return this.projectMercator(lat, lon, radius);
    }

    return this.projectFlat(lat, lon, radius);
  }

  projectLatLonToArrays(
    lat: number,
    lon: number,
    positionOut: Float32Array | number[],
    positionOffset: number,
    latLonOut: Float32Array | number[],
    latLonOffset: number,
    radius = 1.0
  ): void {
    const normalizedLon = ProjectionHelper.normalizeLongitude(lon);
    latLonOut[latLonOffset] = lat;
    latLonOut[latLonOffset + 1] = normalizedLon;
    const [x, y, z] = this.project(lat, normalizedLon, radius);
    positionOut[positionOffset] = x;
    positionOut[positionOffset + 1] = y;
    positionOut[positionOffset + 2] = z;
  }

  private projectGlobe(
    lat: number,
    lon: number,
    radius: number
  ): [number, number, number] {
    const latRad = MathUtils.degToRad(lat);
    const lonRad = MathUtils.degToRad(lon);

    const x = radius * Math.cos(latRad) * Math.cos(lonRad);
    const y = radius * Math.cos(latRad) * Math.sin(lonRad);
    const z = radius * Math.sin(latRad);

    return [x, y, z];
  }

  /**
   * The map's rotation for Mercator clamping, built once with the projection
   * (its centre is fixed for this helper); none when it only turns longitudes
   * (latitudes are clamped as they are).
   */
  private mercatorRotation?: d3.GeoRotation;

  private projectMercator(
    lat: number,
    lon: number,
    radius: number
  ): [number, number, number] {
    // Clamped in the rotated frame, as the shader clamps. The rotation is built
    // once with the helper, and inverted only for a place that needs clamping.
    const point: [number, number] = [
      ProjectionHelper.normalizeLongitude(lon),
      lat,
    ];
    const clamp = (value: number) =>
      Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, value));
    const rotation = this.mercatorRotation;
    let safe = point;
    if (!rotation) {
      safe = [point[0], clamp(lat)];
    } else {
      const [rLon, rLat] = rotation(point);
      if (Math.abs(rLat) > MERCATOR_LAT_LIMIT) {
        safe = rotation.invert([rLon, clamp(rLat)]) as [number, number];
      }
    }
    const projected = this.d3Projection?.(safe);
    if (!projected) {
      return [0, 0, 0];
    }
    const [x, y] = projected;
    return [x * radius, -y * radius, 0];
  }

  private projectFlat(
    lat: number,
    lon: number,
    radius: number
  ): [number, number, number] {
    // CPU projection is still needed where geometry is built on the CPU
    // (e.g., flat masks and initial mesh positions). GPU projection only
    // applies when using shader materials with latLon attributes.
    const projected = this.d3Projection?.([
      ProjectionHelper.normalizeLongitude(lon),
      lat,
    ]);
    if (!projected) {
      return [0, 0, 0];
    }
    const [x, y] = projected;
    return [x * radius, -y * radius, 0];
  }
}
