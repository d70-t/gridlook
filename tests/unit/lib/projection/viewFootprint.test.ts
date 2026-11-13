import { PerspectiveCamera, Vector3 } from "three";
import { expect, it } from "vitest";

import {
  ProjectionHelper,
  PROJECTION_TYPES,
} from "@/lib/projection/projectionUtils.ts";
import { viewFootprint } from "@/lib/projection/viewFootprint.ts";

const rect = { left: 80, top: 30, width: 800, height: 600 };
const globe = new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, {
  lat: 0,
  lon: 0,
});

/** A camera `distance` globe radii from the centre, above (lat, lon). */
function globeCamera(lat: number, lon: number, distance: number, fov = 7.5) {
  const camera = new PerspectiveCamera(
    fov,
    rect.width / rect.height,
    0.001,
    100
  );
  const phi = (lat * Math.PI) / 180;
  const lambda = (lon * Math.PI) / 180;
  camera.up.set(0, 0, 1);
  camera.position
    .set(
      Math.cos(phi) * Math.cos(lambda),
      Math.cos(phi) * Math.sin(lambda),
      Math.sin(phi)
    )
    .multiplyScalar(distance);
  camera.lookAt(new Vector3());
  camera.updateMatrixWorld();
  return camera;
}

it("boxes a close view of the globe around the point below the camera", () => {
  const box = viewFootprint(globeCamera(40, -100, 1.05), globe, rect)!;
  expect(box.latMin).toBeLessThan(40);
  expect(box.latMax).toBeGreaterThan(40);
  expect(box.latMax - box.latMin).toBeCloseTo(0.375, 1);
  expect(box.lonStart).toBeLessThan(-100);
  expect(box.lonStart + box.lonSpan).toBeGreaterThan(-100);
  expect(box.lonSpan).toBeLessThan(1);
});

it("returns the visible cap when the horizon is in view", () => {
  const box = viewFootprint(globeCamera(0, 20, 16), globe, rect)!;
  const radius = (Math.acos(1 / 16) * 180) / Math.PI;
  expect(box.latMin).toBeCloseTo(-radius, 5);
  expect(box.latMax).toBeCloseTo(radius, 5);
  expect(box.lonStart).toBeCloseTo(20 - radius, 5);
  expect(box.lonSpan).toBeCloseTo(2 * radius, 5);
});

it("covers every longitude when a pole is in view", () => {
  const far = viewFootprint(globeCamera(80, 0, 16), globe, rect)!;
  expect(far).toMatchObject({ latMax: 90, lonStart: -180, lonSpan: 360 });
  const close = viewFootprint(globeCamera(-89.95, 0, 1.05), globe, rect)!;
  expect(close).toMatchObject({ latMin: -90, lonStart: -180, lonSpan: 360 });
  expect(close.latMax).toBeLessThan(-89);
});

it("keeps a view across the antimeridian as one short arc", () => {
  const box = viewFootprint(globeCamera(0, 180, 1.05), globe, rect)!;
  expect(box.lonSpan).toBeLessThan(1);
  expect(box.lonStart).toBeGreaterThan(179);
  expect(box.lonStart + box.lonSpan).toBeGreaterThan(180);
});

it("boxes flat projections and reports nothing off the map", () => {
  const flat = new ProjectionHelper(PROJECTION_TYPES.EQUIRECTANGULAR, {
    lat: 0,
    lon: 0,
  });
  const camera = new PerspectiveCamera(
    60,
    rect.width / rect.height,
    0.001,
    100
  );
  camera.position.set(0.5, 0.25, 0.2);
  camera.updateMatrixWorld();
  const box = viewFootprint(camera, flat, rect)!;
  expect(box.lonSpan).toBeLessThan(40);
  expect(box.latMin).toBeGreaterThan(0);

  camera.position.set(0, 0, 5);
  camera.updateMatrixWorld();
  expect(viewFootprint(camera, flat, rect)).toMatchObject({ lonSpan: 360 });

  camera.position.set(50, 0, 0.2);
  camera.updateMatrixWorld();
  expect(viewFootprint(camera, flat, rect)).toBeNull();
});

it("finds the edge of a flat map that does not fill the screen", () => {
  const flat = new ProjectionHelper(PROJECTION_TYPES.EQUIRECTANGULAR, {
    lat: 0,
    lon: 0,
  });
  const camera = new PerspectiveCamera(
    7.5,
    rect.width / rect.height,
    0.001,
    1000
  );
  // far enough that the whole map is a small part of the screen
  camera.position.set(0, 0, 150);
  camera.updateMatrixWorld();
  const small = viewFootprint(camera, flat, rect)!;
  expect(small.lonSpan).toBe(360);
  expect(small.latMin).toBeLessThan(-89);
  expect(small.latMax).toBeGreaterThan(89);

  // only the map's eastern edge is on screen, at its left
  camera.position.set(Math.PI + 0.05, 0, 1);
  camera.updateMatrixWorld();
  const edge = viewFootprint(camera, flat, rect)!;
  expect(edge.lonStart + edge.lonSpan).toBeGreaterThan(179.9);
  expect(edge.lonSpan).toBeGreaterThan(0.5);
  expect(edge.lonSpan).toBeLessThan(10);
});

it("reports the point below the camera as the centre of the view", () => {
  const box = viewFootprint(globeCamera(88.5, 120, 1.5), globe, rect)!;
  expect(box.lonSpan).toBe(360);
  expect(box.centreLat).toBeCloseTo(88.5, 5);
  expect(box.centreLon).toBeCloseTo(120, 5);
});
