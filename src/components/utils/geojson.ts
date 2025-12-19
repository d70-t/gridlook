import * as THREE from "three";
import type { FeatureCollection } from "geojson";
import { ProjectionHelper } from "./projectionUtils";

type TGeometryOptions = {
  radius?: number;
  zOffset?: number;
};

export function geojson2geometry(
  geojson: FeatureCollection,
  helper: ProjectionHelper,
  options?: TGeometryOptions
) {
  const polylines: number[] = [];
  const splits: number[] = [];
  let count = 0;
  const radius = options?.radius ?? 1;
  const zOffset = options?.zOffset ?? 0;

  const pushLinestring = (coords: number[][]) => {
    let previousLon: number | undefined = undefined;
    for (const [lon, lat] of coords) {
      const normalizedLon = helper.normalizeLongitude(lon);
      if (
        helper.isFlat &&
        previousLon !== undefined &&
        Math.abs(normalizedLon - previousLon) > 180
      ) {
        splits.push(count);
      }
      const [x, y, z] = helper.project(lat, normalizedLon, radius);

      polylines.push(x);
      polylines.push(y);
      polylines.push(z + zOffset);
      count += 1;
      previousLon = normalizedLon;
    }
    splits.push(count);
  };

  for (const f of geojson.features) {
    if (f.geometry.type === "LineString") {
      pushLinestring(f.geometry.coordinates);
    } else if (f.geometry.type === "MultiLineString") {
      for (const coords of f.geometry.coordinates) {
        pushLinestring(coords);
      }
    } else {
      console.error("unknown geometry: " + f.geometry.type);
    }
  }

  const indices: number[] = [];
  let is = 0;
  for (let i = 0; i < polylines.length / 3 - 1; ++i) {
    if (i + 1 === splits[is]) {
      is += 1;
    } else {
      indices.push(i);
      indices.push(i + 1);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(polylines, 3)
  );
  geometry.computeBoundingSphere();
  return geometry;
}
