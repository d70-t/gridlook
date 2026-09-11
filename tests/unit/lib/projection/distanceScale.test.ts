import { PerspectiveCamera, Vector3 } from "three";
import { expect, it } from "vitest";

import { getDistanceScale } from "@/lib/projection/distanceScale.ts";
import {
  ProjectionHelper,
  PROJECTION_TYPES,
} from "@/lib/projection/projectionUtils.ts";

const radius = 6_371_008.8;
const rect = { left: 80, top: 30, width: 800, height: 600 };

function makeCamera(z = 5) {
  const camera = new PerspectiveCamera(
    60,
    rect.width / rect.height,
    0.001,
    100
  );
  camera.position.z = z;
  camera.updateMatrixWorld();
  return camera;
}

function sample(
  camera: PerspectiveCamera,
  helper: ProjectionHelper,
  lat: number,
  lon: number
) {
  const point = new Vector3(...helper.project(lat, lon)).project(camera);
  return getDistanceScale(
    camera,
    helper,
    rect,
    rect.left + ((point.x + 1) * rect.width) / 2,
    rect.top + ((1 - point.y) * rect.height) / 2,
    radius
  );
}

it.each(Object.values(PROJECTION_TYPES))(
  "provides a finite local scale for %s",
  (type) => {
    const helper = new ProjectionHelper(type, { lat: 25, lon: 150 });
    const scale =
      type === PROJECTION_TYPES.NEARSIDE_PERSPECTIVE
        ? sample(makeCamera(), helper, 80, 90)
        : sample(makeCamera(), helper, 30, 155);
    expect(scale).not.toBeNull();
    expect(scale!.distanceMeters).toBeGreaterThan(0);
    expect(scale!.widthPx).toBeGreaterThanOrEqual(48);
    expect(scale!.widthPx).toBeLessThanOrEqual(120);
  }
);

it("matches equatorial distance, latitude distortion, and zoom", () => {
  const helper = new ProjectionHelper(PROJECTION_TYPES.EQUIRECTANGULAR, {
    lat: 0,
    lon: 0,
  });
  const camera = makeCamera();
  const equator = sample(camera, helper, 0, 0)!;
  const highLatitude = sample(camera, helper, 60, 0)!;
  const zoomed = sample(makeCamera(2.5), helper, 0, 0)!;
  const expected = (radius * 2 * 5 * Math.tan(Math.PI / 6)) / rect.height;
  expect(equator.distanceMeters / equator.widthPx).toBeCloseTo(expected, 4);
  expect(
    highLatitude.distanceMeters / highLatitude.widthPx / expected
  ).toBeCloseTo(0.5, 5);
  expect(zoomed.distanceMeters / zoomed.widthPx).toBeCloseTo(expected / 2, 4);
});

it("accounts for perspective at the globe limb", () => {
  const helper = new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, {
    lat: 0,
    lon: 0,
  });
  const camera = makeCamera();
  const center = sample(camera, helper, 90, 0)!;
  const limb = sample(camera, helper, 40, 0)!;
  expect(limb.distanceMeters / limb.widthPx).toBeGreaterThan(
    center.distanceMeters / center.widthPx
  );
});

it.each(Object.values(PROJECTION_TYPES))(
  "hides outside the %s map or viewport",
  (type) => {
    const helper = new ProjectionHelper(type, { lat: 0, lon: 0 });
    const camera = makeCamera(10);
    expect(
      getDistanceScale(
        camera,
        helper,
        rect,
        rect.left + 1,
        rect.top + 1,
        radius
      )
    ).toBeNull();
    expect(
      getDistanceScale(
        camera,
        helper,
        rect,
        rect.left - 1,
        rect.top + 300,
        radius
      )
    ).toBeNull();
    expect(
      getDistanceScale(camera, helper, { ...rect, width: 0 }, 400, 300, radius)
    ).toBeNull();
  }
);

it("inverts the hybrid projection throughout its blend windows and near the antimeridian", () => {
  const helper = new ProjectionHelper(PROJECTION_TYPES.AZIMUTHAL_HYBRID, {
    lat: 0,
    lon: 170,
  });
  const projection = helper.getD3Projection()!;
  for (const lon of [170, -179, -130, -60, 0]) {
    const geo: [number, number] = [lon, 5];
    const inverted = projection.invert!(projection(geo)!)!;
    expect(inverted[0]).toBeCloseTo(lon, 6);
    expect(inverted[1]).toBeCloseTo(5, 6);
    expect(sample(makeCamera(), helper, 5, lon)).not.toBeNull();
  }
  expect(sample(makeCamera(), helper, 0, -15)).toBeNull();
});
