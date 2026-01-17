import * as d3 from "d3-geo";
import type { FeatureCollection } from "geojson";
import * as THREE from "three";

import { ProjectionHelper } from "../projection/projectionUtils";

type TGeometryOptions = {
  radius?: number;
  zOffset?: number;
};

interface PolylineBuilder {
  polylines: number[];
  splits: number[];
  count: number;
}

// Calculate the width of flat projection
function calculateFlatWidth(projection: d3.GeoProjection): number | undefined {
  const path = d3.geoPath(projection);
  const [[minX], [maxX]] = path.bounds({ type: "Sphere" });
  return maxX - minX;
}

// Initialize options with defaults
function initializeOptions(options?: TGeometryOptions) {
  return {
    radius: options?.radius ?? 1,
    zOffset: options?.zOffset ?? 0,
  };
}

function shouldSplitForWraparound(
  x: number,
  previousX: number,
  flatWidth: number | undefined
): boolean {
  const width = flatWidth ?? Math.PI * 2;
  const dx = Math.abs(x - previousX);
  return dx > width / 2;
}

// Add a linestring to the polyline builder
function addLinestring(
  coords: number[][],
  helper: ProjectionHelper,
  builder: PolylineBuilder,
  radius: number,
  zOffset: number,
  flatWidth: number | undefined
) {
  let previousProjectedX: number | undefined = undefined;

  for (const [lon, lat] of coords) {
    const normalizedLon = helper.normalizeLongitude(lon);
    const [x, y, z] = helper.project(lat, normalizedLon, radius);

    if (helper.isFlat && previousProjectedX !== undefined) {
      if (shouldSplitForWraparound(x, previousProjectedX, flatWidth)) {
        builder.splits.push(builder.count);
      }
    }

    builder.polylines.push(x, y, z + zOffset);
    builder.count += 1;
    previousProjectedX = x;
  }

  builder.splits.push(builder.count);
}

// Create a d3 geo stream for flat projections
function createGeoStream(
  builder: PolylineBuilder,
  radius: number,
  zOffset: number
): d3.GeoStream {
  let currentLine: number[][] | null = null;

  return {
    point(x: number, y: number) {
      if (!currentLine) {
        return;
      }
      currentLine.push([x * radius, -y * radius, zOffset]);
    },
    lineStart() {
      currentLine = [];
    },
    lineEnd() {
      if (currentLine && currentLine.length) {
        for (const [px, py, pz] of currentLine) {
          builder.polylines.push(px, py, pz);
          builder.count += 1;
        }
        builder.splits.push(builder.count);
      }
      currentLine = null;
    },
    polygonStart() {
      currentLine = [];
    },
    polygonEnd() {
      currentLine = null;
    },
    sphere() {
      currentLine = null;
    },
  };
}

// Process features for flat projections using d3 geoStream
function processFlatProjection(
  geojson: FeatureCollection,
  projection: d3.GeoProjection,
  builder: PolylineBuilder,
  radius: number,
  zOffset: number
) {
  const collectStream = createGeoStream(builder, radius, zOffset);
  d3.geoStream(geojson, projection.stream(collectStream));
}

// Process features for non-flat projections
function processStandardProjection(
  geojson: FeatureCollection,
  helper: ProjectionHelper,
  builder: PolylineBuilder,
  radius: number,
  zOffset: number,
  flatWidth: number | undefined
) {
  for (const f of geojson.features) {
    if (f.geometry.type === "LineString") {
      addLinestring(
        f.geometry.coordinates as number[][],
        helper,
        builder,
        radius,
        zOffset,
        flatWidth
      );
    } else if (f.geometry.type === "MultiLineString") {
      for (const coords of f.geometry.coordinates as number[][][]) {
        addLinestring(coords, helper, builder, radius, zOffset, flatWidth);
      }
    } else {
      console.error("unknown geometry: " + f.geometry.type);
    }
  }
}

// Generate indices from splits
function generateIndices(polylineCount: number, splits: number[]): number[] {
  const indices: number[] = [];
  let splitIndex = 0;

  for (let i = 0; i < polylineCount - 1; i++) {
    if (i + 1 === splits[splitIndex]) {
      splitIndex += 1;
    } else {
      indices.push(i, i + 1);
    }
  }

  return indices;
}

// Create THREE.js geometry from polylines and indices
function createThreeGeometry(
  polylines: number[],
  indices: number[]
): THREE.BufferGeometry {
  const geometry = new THREE.BufferGeometry();
  geometry.setIndex(indices);
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(polylines, 3)
  );
  geometry.computeBoundingSphere();
  return geometry;
}

function geojson2geometry(
  geojson: FeatureCollection,
  helper: ProjectionHelper,
  options?: TGeometryOptions
): THREE.BufferGeometry {
  const { radius, zOffset } = initializeOptions(options);

  const builder: PolylineBuilder = {
    polylines: [],
    splits: [],
    count: 0,
  };

  let flatWidth: number | undefined = undefined;
  if (helper.isFlat) {
    const projection = helper.getD3Projection();
    if (projection) {
      flatWidth = calculateFlatWidth(projection);
    }
  }

  const projection = helper.getD3Projection();
  if (helper.isFlat && projection) {
    processFlatProjection(geojson, projection, builder, radius, zOffset);
  } else {
    processStandardProjection(
      geojson,
      helper,
      builder,
      radius,
      zOffset,
      flatWidth
    );
  }

  const indices = generateIndices(builder.polylines.length / 3, builder.splits);
  return createThreeGeometry(builder.polylines, indices);
}

export { geojson2geometry };
