import * as d3 from "d3-geo";
import type { FeatureCollection } from "geojson";
import * as THREE from "three";

import { ProjectionHelper } from "../projection/projectionUtils";

type TGeometryOptions = {
  radius?: number;
  zOffset?: number;
};

interface GpuLineSegmentBuilder {
  positions: number[];
  latLon: number[];
  segmentOtherLatLon: number[];
}

const MAX_GPU_LINE_SEGMENT_ANGLE = Math.PI / 90;

function initializeOptions(options?: TGeometryOptions) {
  return {
    radius: options?.radius ?? 1,
    zOffset: options?.zOffset ?? 0,
  };
}

function unwrapLongitude(targetLon: number, referenceLon: number): number {
  let unwrappedLon = targetLon;
  while (unwrappedLon - referenceLon > 180) {
    unwrappedLon -= 360;
  }
  while (unwrappedLon - referenceLon < -180) {
    unwrappedLon += 360;
  }
  return unwrappedLon;
}

function densifyGeographicPolyline(coords: number[][]): number[][] {
  if (coords.length < 2) {
    return coords;
  }

  const densified: number[][] = [
    [ProjectionHelper.normalizeLongitude(coords[0][0]), coords[0][1]],
  ];

  for (let i = 0; i < coords.length - 1; i++) {
    const startLon = ProjectionHelper.normalizeLongitude(coords[i][0]);
    const endLon = unwrapLongitude(
      ProjectionHelper.normalizeLongitude(coords[i + 1][0]),
      startLon
    );
    const start: [number, number] = [startLon, coords[i][1]];
    const end: [number, number] = [endLon, coords[i + 1][1]];

    if (
      !Number.isFinite(start[0]) ||
      !Number.isFinite(start[1]) ||
      !Number.isFinite(end[0]) ||
      !Number.isFinite(end[1])
    ) {
      continue;
    }

    const angularDistance = d3.geoDistance(start, end);
    const steps = Math.max(
      1,
      Math.ceil(angularDistance / MAX_GPU_LINE_SEGMENT_ANGLE)
    );

    if (steps === 1) {
      densified.push([ProjectionHelper.normalizeLongitude(end[0]), end[1]]);
      continue;
    }

    for (let step = 1; step <= steps; step++) {
      const t = step / steps;
      const lon = start[0] + (end[0] - start[0]) * t;
      const lat = start[1] + (end[1] - start[1]) * t;
      densified.push([ProjectionHelper.normalizeLongitude(lon), lat]);
    }
  }

  return densified;
}

function addGpuLineSegments(
  coords: number[][],
  helper: ProjectionHelper,
  builder: GpuLineSegmentBuilder,
  radius: number,
  zOffset: number
) {
  const densifiedCoords = densifyGeographicPolyline(coords);

  for (let i = 0; i < densifiedCoords.length - 1; i++) {
    const [normalizedLonA, latA] = densifiedCoords[i];
    const [normalizedLonB, latB] = densifiedCoords[i + 1];

    if (
      !Number.isFinite(latA) ||
      !Number.isFinite(normalizedLonA) ||
      !Number.isFinite(latB) ||
      !Number.isFinite(normalizedLonB)
    ) {
      continue;
    }

    const [xA, yA, zA] = helper.project(latA, normalizedLonA, radius);
    const [xB, yB, zB] = helper.project(latB, normalizedLonB, radius);
    const positionZA = helper.isFlat ? zA + zOffset : zA;
    const positionZB = helper.isFlat ? zB + zOffset : zB;

    builder.positions.push(xA, yA, positionZA, xB, yB, positionZB);
    builder.latLon.push(latA, normalizedLonA, latB, normalizedLonB);
    builder.segmentOtherLatLon.push(latB, normalizedLonB, latA, normalizedLonA);
  }
}

function geojson2gpuLineSegmentsGeometry(
  geojson: FeatureCollection,
  helper: ProjectionHelper,
  options?: TGeometryOptions
) {
  const { radius, zOffset } = initializeOptions(options);
  const builder: GpuLineSegmentBuilder = {
    positions: [],
    latLon: [],
    segmentOtherLatLon: [],
  };

  for (const feature of geojson.features) {
    if (feature.geometry.type === "LineString") {
      addGpuLineSegments(
        feature.geometry.coordinates as number[][],
        helper,
        builder,
        radius,
        zOffset
      );
    } else if (feature.geometry.type === "MultiLineString") {
      for (const coords of feature.geometry.coordinates as number[][][]) {
        addGpuLineSegments(coords, helper, builder, radius, zOffset);
      }
    } else {
      console.error("unknown geometry: " + feature.geometry.type);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(builder.positions, 3)
  );
  geometry.setAttribute(
    "latLon",
    new THREE.Float32BufferAttribute(builder.latLon, 2)
  );
  geometry.setAttribute(
    "segmentOtherLatLon",
    new THREE.Float32BufferAttribute(builder.segmentOtherLatLon, 2)
  );
  geometry.computeBoundingSphere();
  return geometry;
}

export { geojson2gpuLineSegmentsGeometry };
