import * as THREE from "three";
import * as d3 from "d3-geo";
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
  let flatWidth: number | undefined = undefined;

  if (helper.isFlat) {
    const projection = helper.getD3Projection();
    if (projection) {
      const path = d3.geoPath(projection);
      const [[minX], [maxX]] = path.bounds({ type: "Sphere" });
      flatWidth = maxX - minX;
    }
  }

  const pushLinestring = (coords: number[][]) => {
    let previousProjectedX: number | undefined = undefined;
    for (const [lon, lat] of coords) {
      const normalizedLon = helper.normalizeLongitude(lon);
      const [x, y, z] = helper.project(lat, normalizedLon, radius);

      if (helper.isFlat && previousProjectedX !== undefined) {
        // Fallback to the full 360° span of a unit-radius globe (2π) when we
        // cannot derive the flat projected width from d3. This is only used
        // as a heuristic for detecting wraparound splits (dx > width / 2).
        const width = flatWidth ?? Math.PI * 2;
        const dx = Math.abs(x - previousProjectedX);
        if (dx > width / 2) {
          splits.push(count);
        }
      }

      polylines.push(x);
      polylines.push(y);
      polylines.push(z + zOffset);
      count += 1;
      previousProjectedX = x;
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
