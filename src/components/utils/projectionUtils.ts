import * as d3 from "d3-geo";
import {
  geoMollweide,
  geoRobinson,
  geoCylindricalEqualArea,
} from "d3-geo-projection";

export const PROJECTION_TYPES = {
  NEARSIDE_PERSPECTIVE: "nearside_perspective",
  MERCATOR: "mercator",
  ROBINSON: "robinson",
  MOLLWEIDE: "mollweide",
  CYLINDRICAL_EQUAL_AREA: "cylindrical_equal_area",
  EQUIRECTANGULAR: "equirectangular",
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

const MERCATOR_LAT_LIMIT = 85;

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
    this.d3Projection = this.createD3ProjectionInstance();
  }

  createD3ProjectionInstance(): d3.GeoProjection | null {
    let d3Projection: d3.GeoProjection | null = null;
    switch (this.type) {
      case PROJECTION_TYPES.MERCATOR:
        d3Projection = d3.geoMercator();
        break;
      case PROJECTION_TYPES.ROBINSON:
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
      default:
        d3Projection = null;
    }
    d3Projection
      ?.translate([0, 0])
      .scale(1)
      .rotate([-this.center.lon, -this.center.lat]);
    return d3Projection;
  }

  normalizeLongitude(lon: number): number {
    return (((lon % 360) + 540) % 360) - 180;
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

  private projectGlobe(
    lat: number,
    lon: number,
    radius: number
  ): [number, number, number] {
    const latRad = (lat * Math.PI) / 180;
    const lonRad = (lon * Math.PI) / 180;

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
    const projected = this.d3Projection?.([this.normalizeLongitude(lon), lat]);
    if (!projected) {
      return [0, 0, 0];
    }
    const [x, y] = projected;
    return [x * radius, -y * radius, 0];
  }
}
