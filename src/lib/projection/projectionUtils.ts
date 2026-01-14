import * as d3 from "d3-geo";
import {
  geoMollweide,
  geoRobinson,
  geoCylindricalEqualArea,
} from "d3-geo-projection";
import { MathUtils } from "three";

export const PROJECTION_TYPES = {
  NEARSIDE_PERSPECTIVE: "nearside_perspective",
  MERCATOR: "mercator",
  ROBINSON: "robinson",
  MOLLWEIDE: "mollweide",
  CYLINDRICAL_EQUAL_AREA: "cylindrical_equal_area",
  EQUIRECTANGULAR: "equirectangular",
  AZIMUTHAL_EQUIDISTANT: "azimuthal_equidistant",
} as const;

export type TProjectionType =
  (typeof PROJECTION_TYPES)[keyof typeof PROJECTION_TYPES];

export type TProjectionCenter = {
  lat: number;
  lon: number;
};

export type TProjectionOptions = {
  center?: TProjectionCenter;
};

export const MERCATOR_LAT_LIMIT = 85;

// Clip angle for azimuthal equidistant projection (matches coastline clipping)
export const AZIMUTHAL_CLIP_ANGLE = 173;

// Clamp helper for projection center; falls back to 0 for non-finite input
// because (lat: 0, lon: 0) is the neutral "reset" center used elsewhere.
export function clamp(value: number, min: number, max: number) {
  return Math.min(Math.max(Number.isFinite(value) ? value : 0, min), max);
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

  constructor(
    type: TProjectionType,
    center: TProjectionCenter,
    _options?: TProjectionOptions
  ) {
    void _options;

    this.type = type;
    this.center = center;
    this.isFlat = type !== PROJECTION_TYPES.NEARSIDE_PERSPECTIVE;

    this.initializeD3Projection();
  }

  private initializeD3Projection(): void {
    // We still keep a d3 projection for CPU-side geometry work:
    // flat mask clipping, bounds, and initial vertex positions before shaders run.
    this.d3Projection = this.createD3ProjectionInstance();
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
        // The azimuthal equidistant projection needs to be clipped to avoid
        // extreme distortion near the edges.
        d3Projection = d3
          .geoAzimuthalEquidistant()
          .clipAngle(AZIMUTHAL_CLIP_ANGLE);
        break;
      default:
        d3Projection = null;
    }
    const centerLat = Math.max(-90, Math.min(90, this.center.lat));
    const centerLon = this.normalizeLongitude(this.center.lon);

    d3Projection?.translate([0, 0]).scale(1).rotate([-centerLon, -centerLat]);
    return d3Projection;
  }

  normalizeLongitude(lon: number): number {
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
    const normalizedLon = this.normalizeLongitude(lon);
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

  private projectMercator(
    lat: number,
    lon: number,
    radius: number
  ): [number, number, number] {
    const safeLat = Math.max(
      -MERCATOR_LAT_LIMIT,
      Math.min(MERCATOR_LAT_LIMIT, lat)
    );
    const projected = this.d3Projection?.([
      this.normalizeLongitude(lon),
      safeLat,
    ]);
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
    const projected = this.d3Projection?.([this.normalizeLongitude(lon), lat]);
    if (!projected) {
      return [0, 0, 0];
    }
    const [x, y] = projected;
    return [x * radius, -y * radius, 0];
  }
}
