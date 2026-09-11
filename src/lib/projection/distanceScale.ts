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
type TViewport = Pick<DOMRect, "left" | "top" | "width" | "height">;

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

function screenToGeo(
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

export function getDistanceScale(
  camera: Camera,
  helper: ProjectionHelper,
  rect: TViewport,
  x: number,
  y: number,
  earthRadiusMeters: number
): TDistanceScale | null {
  if (!screenToGeo(camera, helper, rect, x, y)) {
    return null;
  }
  const left = screenToGeo(camera, helper, rect, x - 0.5, y);
  const right = screenToGeo(camera, helper, rect, x + 0.5, y);
  if (!left || !right) {
    return null;
  }
  // ponytail: one-pixel sampling estimates local horizontal scale, not distance
  // across the whole bar. A measuring tool would need to integrate along its path.
  const metersPerPixel = geoDistance(left, right) * earthRadiusMeters;
  if (!Number.isFinite(metersPerPixel) || metersPerPixel <= 0) {
    return null;
  }
  const maxDistance = metersPerPixel * 120;
  const magnitude = 10 ** Math.floor(Math.log10(maxDistance));
  const normalized = maxDistance / magnitude;
  const distanceMeters =
    (normalized >= 5 ? 5 : normalized >= 2 ? 2 : 1) * magnitude;
  return { distanceMeters, widthPx: distanceMeters / metersPerPixel };
}
