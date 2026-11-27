import * as d3 from "d3-geo";
import { expect, it, vi } from "vitest";

import {
  MERCATOR_LAT_LIMIT,
  PROJECTION_TYPES,
  ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";

it("projects 88°N on a map centred at 60°N without a geographic clamp", () => {
  const helper = new ProjectionHelper(PROJECTION_TYPES.MERCATOR, {
    lat: 60,
    lon: 0,
  });
  const projection = helper.getD3Projection()!;
  const [, rLat] = d3.geoRotation(projection.rotate())([10, 88]);
  expect(Math.abs(rLat)).toBeLessThan(80); // well inside the limit there
  const [x, y] = helper.project(88, 10);
  const [px, py] = projection([10, 88])!;
  const ratio = x / px;
  expect(-y / py).toBeCloseTo(ratio, 9);
  // And a place beyond the limit in the rotated frame is held at it.
  const far = d3.geoRotation(projection.rotate()).invert([10, 89.9])!;
  const [, fy] = helper.project(far[1], far[0]);
  const edge = d3.geoRotation(projection.rotate()).invert([10, 85.05112878])!;
  const [, ey] = helper.project(edge[1], edge[0]);
  expect(fy).toBeCloseTo(ey, 4);
});

// A per-vertex projection: a fresh rotation, rotate and invert each time
// (its round trip adds ~1e-8 rad of noise, hence 6 digits).
function perVertexProjection(projection: d3.GeoProjection) {
  return (lat: number, lon: number) => {
    const rotation = d3.geoRotation(projection.rotate());
    const [rLon, rLat] = rotation([lon, lat]);
    const safe = rotation.invert([
      rLon,
      Math.max(-MERCATOR_LAT_LIMIT, Math.min(MERCATOR_LAT_LIMIT, rLat)),
    ])!;
    const [x, y] = projection(safe)!;
    return [x, -y];
  };
}

it("review #35: the cached rotation projects as building it per vertex did, at every centre", () => {
  const points = Array.from({ length: 5000 }, (_, k) => [
    ((k * 37) % 180) - 90,
    ((k * 101) % 360) - 180,
  ]);
  for (const center of [
    { lat: 35, lon: 20 },
    { lat: -60, lon: 170 },
    { lat: 0, lon: -45 },
    { lat: 89, lon: 0 },
  ]) {
    const helper = new ProjectionHelper(PROJECTION_TYPES.MERCATOR, center);
    const perVertex = perVertexProjection(helper.getD3Projection()!);
    for (const [lat, lon] of points) {
      const [x, y] = helper.project(lat, lon, 1);
      const [ex, ey] = perVertex(lat, lon);
      expect(x).toBeCloseTo(ex, 6);
      expect(y).toBeCloseTo(ey, 6);
    }
  }
});

it("review of interim30 (N13): projecting reads no rotation angles per vertex", () => {
  const helper = new ProjectionHelper(PROJECTION_TYPES.MERCATOR, {
    lat: 35,
    lon: 20,
  });
  const projection = helper.getD3Projection()!;
  const rotate = vi.spyOn(projection, "rotate");
  for (let k = 0; k < 1000; k++) {
    helper.project(((k * 37) % 180) - 90, ((k * 101) % 360) - 180, 1);
  }
  expect(rotate).not.toHaveBeenCalled();
});
