import * as THREE from "three";
import type { FeatureCollection } from "geojson";

export function geojson2geometry(geojson: FeatureCollection, radius = 1) {
  const polylines: number[] = [];
  const splits: number[] = [];
  let count = 0;

  const pushLinestring = (coords: number[][]) => {
    for (const [lon, lat] of coords) {
      const x =
        radius *
        Math.cos((lon / 180) * Math.PI) *
        Math.cos((lat / 180) * Math.PI);
      const y =
        radius *
        Math.sin((lon / 180) * Math.PI) *
        Math.cos((lat / 180) * Math.PI);
      const z = radius * Math.sin((lat / 180) * Math.PI);

      polylines.push(x);
      polylines.push(y);
      polylines.push(z);
      count += 1;
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
      console.log("unknown geometry: " + f.geometry.type);
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
