import { Grid } from "healpix-geo";
import * as THREE from "three";
import { expect, it } from "vitest";

import { getRegionalCameraPosition } from "@/lib/camera/regionalCamera.ts";
import {
  buildHealpixRegionCoordinates,
  getHealpixFaceDataRect,
} from "@/lib/grids/healpixCalculations.ts";
import {
  ProjectionHelper,
  PROJECTION_TYPES,
} from "@/lib/projection/projectionUtils.ts";

function geometry(coordinates: number[]) {
  return new THREE.BufferGeometry().setAttribute(
    "latLon",
    new THREE.Float32BufferAttribute(coordinates, 2)
  );
}

it.each([
  { lat: 50, lon: 10, aspect: 2 },
  { lat: -35, lon: 179, aspect: 0.5 },
  { lat: 88, lon: -40, aspect: 1 },
])(
  "fits every regional vertex ($lat, $lon, $aspect)",
  ({ lat, lon, aspect }) => {
    const coordinates = [
      lat - 1,
      lon - 2,
      lat - 1,
      lon + 2,
      lat + 1,
      lon - 2,
      lat + 1,
      lon + 2,
    ];
    const camera = new THREE.PerspectiveCamera(7.5, aspect, 0.0001, 1000);
    const position = getRegionalCameraPosition(
      [geometry(coordinates)],
      camera
    )!;
    expect(position.length()).toBeLessThan(3);
    expect(position.length()).toBeGreaterThan(1);
    camera.up.set(0, 0, 1);
    camera.position.copy(position);
    camera.lookAt(0, 0, 0);
    camera.updateMatrixWorld();
    const helper = new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, {
      lat: 0,
      lon: 0,
    });
    for (let i = 0; i < coordinates.length; i += 2) {
      const point = new THREE.Vector3(
        ...helper.project(coordinates[i], coordinates[i + 1])
      );
      expect(point.dot(position)).toBeGreaterThan(1);
      const projected = point.project(camera);
      expect(Math.abs(projected.x)).toBeLessThan(1);
      expect(Math.abs(projected.y)).toBeLessThan(1);
      expect(Math.abs(projected.z)).toBeLessThan(1);
    }
  }
);

it("keeps the default view for global, empty, or invalid coordinates", () => {
  const camera = new THREE.PerspectiveCamera(7.5, 1);
  for (const coordinates of [
    [],
    [NaN, 0, 0, Infinity],
    [0, 0, 0, 90, 0, 180, 0, 270, 90, 0, -90, 0],
  ]) {
    expect(
      getRegionalCameraPosition([geometry(coordinates)], camera)
    ).toBeNull();
  }
});

it("fits all batches together and ignores invalid coordinates", () => {
  const camera = new THREE.PerspectiveCamera(7.5, 1);
  const batches = [geometry([40, 10, NaN, 0]), geometry([50, 20])];
  expect(getRegionalCameraPosition(batches, camera)).toEqual(
    getRegionalCameraPosition([geometry([40, 10, 50, 20])], camera)
  );
});

it("frames a tiny HEALPix cutout from cell IDs before loading data or meshes", () => {
  using grid = new Grid({ scheme: "nested", level: 17 });
  const cells = [
    Number(grid.bitCombine(grid.nside / 2, grid.nside / 2)),
    Number(grid.bitCombine(grid.nside / 2 + 15, grid.nside / 2 + 7)),
  ];
  const rect = getHealpixFaceDataRect(0, grid.nside, cells)!;
  const coordinates = buildHealpixRegionCoordinates(grid, 0, rect);
  const region = new THREE.BufferGeometry().setAttribute(
    "latLon",
    new THREE.BufferAttribute(coordinates, 2)
  );
  const camera = new THREE.PerspectiveCamera(7.5, 0.5, 0.0001, 1000);
  const position = getRegionalCameraPosition([region], camera)!;
  expect(position.length()).toBeLessThan(1.01);
  using face = grid.replace({ level: 0, scheme: "nested" });
  using center = face.vertex(
    0n,
    rect.u + rect.width / 2,
    rect.v + rect.height / 2
  );
  const actualCenter = ProjectionHelper.cartesianToLatLon(
    position.x,
    position.y,
    position.z
  );
  expect(actualCenter.lat).toBeCloseTo(center.lat, 3);
  expect(actualCenter.lon).toBeCloseTo(center.lon, 3);
  camera.up.set(0, 0, 1);
  camera.position.copy(position);
  camera.lookAt(0, 0, 0);
  camera.updateMatrixWorld();
  const helper = new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, {
    lat: 0,
    lon: 0,
  });
  for (let i = 0; i < coordinates.length; i += 2) {
    const point = new THREE.Vector3(
      ...helper.project(coordinates[i], coordinates[i + 1])
    );
    const projected = point.project(camera);
    expect(Math.abs(projected.x)).toBeLessThan(1);
    expect(Math.abs(projected.y)).toBeLessThan(1);
  }
});
