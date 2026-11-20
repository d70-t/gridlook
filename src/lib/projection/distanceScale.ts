import { geoDistance } from "d3-geo";
import { Plane, Raycaster, Sphere, Vector2, Vector3, type Camera } from "three";

import {
  AZIMUTHAL_CLIP_ANGLE,
  isAzimuthalProjectionType,
  MERCATOR_LAT_LIMIT,
  PROJECTION_TYPES,
  type ProjectionHelper,
} from "./projectionUtils.ts";

export type TDistanceScale = { distanceMeters: number; widthPx: number };
export type TViewport = Pick<DOMRect, "left" | "top" | "width" | "height">;

function invertMapPoint(helper: ProjectionHelper, point: Vector3) {
  const projection = helper.getD3Projection();
  const geo = projection?.invert?.([point.x, -point.y]);
  if (!geo || !geo.every(Number.isFinite) || Math.abs(geo[1]) > 90) {
    return null;
  }
  const projected = projection!(geo);
  if (
    !projected ||
    Math.hypot(projected[0] - point.x, projected[1] + point.y) > 1e-6
  ) {
    return null;
  }
  if (
    isAzimuthalProjectionType(helper.type) &&
    geoDistance([helper.center.lon, helper.center.lat], geo) >
      (AZIMUTHAL_CLIP_ANGLE * Math.PI) / 180
  ) {
    return null;
  }
  if (
    helper.type === PROJECTION_TYPES.MERCATOR &&
    Math.abs(point.y) >
      Math.log(Math.tan(Math.PI / 4 + (MERCATOR_LAT_LIMIT * Math.PI) / 360))
  ) {
    return null;
  }
  return geo;
}

export function screenToGeo(
  camera: Camera,
  helper: ProjectionHelper,
  rect: TViewport,
  x: number,
  y: number
): [number, number] | null {
  if (
    rect.width <= 0 ||
    rect.height <= 0 ||
    x < rect.left ||
    x > rect.left + rect.width ||
    y < rect.top ||
    y > rect.top + rect.height
  ) {
    return null;
  }
  const raycaster = new Raycaster();
  raycaster.setFromCamera(
    new Vector2(
      ((x - rect.left) / rect.width) * 2 - 1,
      1 - ((y - rect.top) / rect.height) * 2
    ),
    camera
  );
  const point = new Vector3();
  if (helper.isFlat) {
    return raycaster.ray.intersectPlane(
      new Plane(new Vector3(0, 0, 1), 0),
      point
    )
      ? invertMapPoint(helper, point)
      : null;
  }
  if (!raycaster.ray.intersectSphere(new Sphere(new Vector3(), 1), point)) {
    return null;
  }
  return [
    (Math.atan2(point.y, point.x) * 180) / Math.PI,
    (Math.asin(point.z) * 180) / Math.PI,
  ];
}

/**
 * Ground metres one screen pixel covers at a screen point, in any projection,
 * along the screen's horizontal or its vertical. The two differ wherever a
 * projection stretches the map more one way than the other.
 */
export function metersPerPixelAt(
  camera: Camera,
  helper: ProjectionHelper,
  rect: TViewport,
  x: number,
  y: number,
  earthRadiusMeters: number,
  vertical = false
): number | null {
  if (!screenToGeo(camera, helper, rect, x, y)) {
    return null;
  }
  const dx = vertical ? 0 : 0.5;
  const dy = vertical ? 0.5 : 0;
  const left = screenToGeo(camera, helper, rect, x - dx, y - dy);
  const right = screenToGeo(camera, helper, rect, x + dx, y + dy);
  if (!left || !right) {
    return null;
  }
  // ponytail: one-pixel sampling estimates local horizontal scale, not distance
  // across the whole bar. A measuring tool would need to integrate along its path.
  const metersPerPixel = geoDistance(left, right) * earthRadiusMeters;
  return Number.isFinite(metersPerPixel) && metersPerPixel > 0
    ? metersPerPixel
    : null;
}

export function getDistanceScale(
  camera: Camera,
  helper: ProjectionHelper,
  rect: TViewport,
  x: number,
  y: number,
  earthRadiusMeters: number
): TDistanceScale | null {
  const metersPerPixel = metersPerPixelAt(
    camera,
    helper,
    rect,
    x,
    y,
    earthRadiusMeters
  );
  if (metersPerPixel === null) {
    return null;
  }
  const maxDistance = metersPerPixel * 150;
  const magnitude = 10 ** Math.floor(Math.log10(maxDistance));
  const normalized = maxDistance / magnitude;
  const distanceMeters =
    (normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1) * magnitude;
  return { distanceMeters, widthPx: distanceMeters / metersPerPixel };
}
