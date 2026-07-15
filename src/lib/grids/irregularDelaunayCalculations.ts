import { Delaunay } from "d3-delaunay";

import { buildSerializedGeoSampleIndexData } from "./gridWorkerCalculations.ts";
import type {
  TGridDataValueBatch,
  TGridPointBatch,
  TSerializedGeoSampleIndexData,
} from "./gridWorkerTypes.ts";

import { reconcileCoordinateArrays } from "@/lib/data/irregularGridHelpers.ts";
import {
  PROJECTION_TYPES,
  ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";

type TExtendedPointSet = {
  points: [number, number][];
  indexMap: number[];
};

export type TIrregularDelaunayGrid = {
  triangleIndices: Uint32Array;
  positions: Float32Array;
  latLonValues: Float32Array;
  latitudes: Float32Array;
  longitudes: Float32Array;
};

function createExtendedPointSet(
  latitudes: Float32Array,
  longitudes: Float32Array,
  wrapThreshold: number
): TExtendedPointSet {
  const points: [number, number][] = [];
  const indexMap: number[] = [];
  for (let index = 0; index < latitudes.length; index++) {
    const longitude = longitudes[index];
    const latitude = latitudes[index];
    points.push([longitude, latitude]);
    indexMap.push(index);
    if (longitude < -wrapThreshold) {
      points.push([longitude + 360, latitude]);
      indexMap.push(index);
    }
    if (longitude > wrapThreshold) {
      points.push([longitude - 360, latitude]);
      indexMap.push(index);
    }
  }
  return { points, indexMap };
}

function isValidTriangle(
  points: [number, number][],
  pointIndices: [number, number, number],
  maxEdgeLength: number
) {
  const [point0, point1, point2] = pointIndices.map(
    (pointIndex) => points[pointIndex]
  );
  if (
    (point0[0] < -180 || point0[0] > 180) &&
    (point1[0] < -180 || point1[0] > 180) &&
    (point2[0] < -180 || point2[0] > 180)
  ) {
    return false;
  }
  const edges = [
    [point0, point1],
    [point1, point2],
    [point2, point0],
  ] as const;
  for (const [[longitude0, latitude0], [longitude1, latitude1]] of edges) {
    const longitudeDelta = longitude1 - longitude0;
    const latitudeDelta = latitude1 - latitude0;
    if (
      Math.sqrt(
        longitudeDelta * longitudeDelta + latitudeDelta * latitudeDelta
      ) > maxEdgeLength
    ) {
      return false;
    }
  }
  return true;
}

export function computeDelaunayTriangulation(
  latitudes: Float32Array,
  longitudes: Float32Array
): Uint32Array {
  const { points, indexMap } = createExtendedPointSet(
    latitudes,
    longitudes,
    150
  );
  const triangles = Delaunay.from(points).triangles;
  const validTriangles: number[] = [];
  for (
    let triangleOffset = 0;
    triangleOffset < triangles.length;
    triangleOffset += 3
  ) {
    const pointIndices: [number, number, number] = [
      triangles[triangleOffset],
      triangles[triangleOffset + 1],
      triangles[triangleOffset + 2],
    ];
    if (isValidTriangle(points, pointIndices, 30)) {
      validTriangles.push(
        indexMap[pointIndices[0]],
        indexMap[pointIndices[1]],
        indexMap[pointIndices[2]]
      );
    }
  }
  return new Uint32Array(validTriangles);
}

export function computeTriangleAverage(
  value0: number,
  value1: number,
  value2: number
) {
  const valid0 = Number.isFinite(value0);
  const valid1 = Number.isFinite(value1);
  const valid2 = Number.isFinite(value2);
  if (!valid0 && !valid1 && !valid2) {
    return NaN;
  }
  let sum = 0;
  let count = 0;
  if (valid0) {
    sum += value0;
    count++;
  }
  if (valid1) {
    sum += value1;
    count++;
  }
  if (valid2) {
    sum += value2;
    count++;
  }
  return sum / count;
}

function shouldFlipTriangle(
  positions: Float32Array,
  index0: number,
  index1: number,
  index2: number
) {
  const offset0 = index0 * 3;
  const offset1 = index1 * 3;
  const offset2 = index2 * 3;
  const x0 = positions[offset0];
  const y0 = positions[offset0 + 1];
  const z0 = positions[offset0 + 2];
  const edgeAx = positions[offset1] - x0;
  const edgeAy = positions[offset1 + 1] - y0;
  const edgeAz = positions[offset1 + 2] - z0;
  const edgeBx = positions[offset2] - x0;
  const edgeBy = positions[offset2 + 1] - y0;
  const edgeBz = positions[offset2 + 2] - z0;
  const normalX = edgeAy * edgeBz - edgeAz * edgeBy;
  const normalY = edgeAz * edgeBx - edgeAx * edgeBz;
  const normalZ = edgeAx * edgeBy - edgeAy * edgeBx;
  const centerX = (x0 + positions[offset1] + positions[offset2]) / 3;
  const centerY = (y0 + positions[offset1 + 1] + positions[offset2 + 1]) / 3;
  const centerZ = (z0 + positions[offset1 + 2] + positions[offset2 + 2]) / 3;
  return normalX * centerX + normalY * centerY + normalZ * centerZ < 0;
}

export function buildIrregularDelaunayGrid(
  latitudes: Float32Array,
  longitudes: Float32Array,
  latitudeShape: number[],
  longitudeShape: number[],
  dataLength: number
): TIrregularDelaunayGrid {
  const coordinates = reconcileCoordinateArrays(
    latitudes,
    longitudes,
    latitudeShape,
    longitudeShape,
    dataLength
  );
  const positions = new Float32Array(dataLength * 3);
  const latLonValues = new Float32Array(dataLength * 2);
  const projection = new ProjectionHelper(
    PROJECTION_TYPES.NEARSIDE_PERSPECTIVE,
    { lat: 0, lon: 0 }
  );
  for (let index = 0; index < dataLength; index++) {
    projection.projectLatLonToArrays(
      coordinates.latitudes[index],
      coordinates.longitudes[index],
      positions,
      index * 3,
      latLonValues,
      index * 2
    );
  }
  return {
    ...coordinates,
    positions,
    latLonValues,
    triangleIndices: computeDelaunayTriangulation(
      coordinates.latitudes,
      coordinates.longitudes
    ),
  };
}

export function getIrregularDelaunayBatchCount(
  grid: TIrregularDelaunayGrid,
  batchSize: number
) {
  return Math.ceil(grid.triangleIndices.length / 3 / batchSize);
}

function getTriangleAverage(
  grid: TIrregularDelaunayGrid,
  data: Float32Array,
  triangleIndex: number
) {
  const offset = triangleIndex * 3;
  const index0 = grid.triangleIndices[offset];
  const index1 = grid.triangleIndices[offset + 1];
  const index2 = grid.triangleIndices[offset + 2];
  return computeTriangleAverage(data[index0], data[index1], data[index2]);
}

export function buildIrregularDelaunayGeometryBatch(
  grid: TIrregularDelaunayGrid,
  data: Float32Array,
  batchIndex: number,
  batchSize: number
): TGridPointBatch {
  const start = batchIndex * batchSize;
  const end = Math.min(start + batchSize, grid.triangleIndices.length / 3);
  const vertexCount = (end - start) * 3;
  const positionValues = new Float32Array(vertexCount * 3);
  const latLonValues = new Float32Array(vertexCount * 2);
  const dataValues = new Float32Array(vertexCount);
  for (let triangleIndex = start; triangleIndex < end; triangleIndex++) {
    const triangleOffset = triangleIndex * 3;
    const index0 = grid.triangleIndices[triangleOffset];
    let index1 = grid.triangleIndices[triangleOffset + 1];
    let index2 = grid.triangleIndices[triangleOffset + 2];
    const average = computeTriangleAverage(
      data[index0],
      data[index1],
      data[index2]
    );
    if (shouldFlipTriangle(grid.positions, index0, index1, index2)) {
      [index1, index2] = [index2, index1];
    }
    const batchTriangleIndex = triangleIndex - start;
    for (let vertexIndex = 0; vertexIndex < 3; vertexIndex++) {
      const sourceIndex =
        vertexIndex === 0 ? index0 : vertexIndex === 1 ? index1 : index2;
      const destinationIndex = batchTriangleIndex * 3 + vertexIndex;
      const sourcePositionOffset = sourceIndex * 3;
      const destinationPositionOffset = destinationIndex * 3;
      positionValues[destinationPositionOffset] =
        grid.positions[sourcePositionOffset];
      positionValues[destinationPositionOffset + 1] =
        grid.positions[sourcePositionOffset + 1];
      positionValues[destinationPositionOffset + 2] =
        grid.positions[sourcePositionOffset + 2];
      const sourceLatLonOffset = sourceIndex * 2;
      const destinationLatLonOffset = destinationIndex * 2;
      latLonValues[destinationLatLonOffset] =
        grid.latLonValues[sourceLatLonOffset];
      latLonValues[destinationLatLonOffset + 1] =
        grid.latLonValues[sourceLatLonOffset + 1];
      dataValues[destinationIndex] = average;
    }
  }
  return { batchIndex, positionValues, latLonValues, dataValues };
}

export function buildIrregularDelaunayDataBatch(
  grid: TIrregularDelaunayGrid,
  data: Float32Array,
  batchIndex: number,
  batchSize: number
): TGridDataValueBatch {
  const start = batchIndex * batchSize;
  const end = Math.min(start + batchSize, grid.triangleIndices.length / 3);
  const dataValues = new Float32Array((end - start) * 3);
  for (let triangleIndex = start; triangleIndex < end; triangleIndex++) {
    const average = getTriangleAverage(grid, data, triangleIndex);
    const batchOffset = (triangleIndex - start) * 3;
    dataValues[batchOffset] = average;
    dataValues[batchOffset + 1] = average;
    dataValues[batchOffset + 2] = average;
  }
  return { batchIndex, dataValues };
}

export function buildIrregularDelaunayHoverIndexData(
  grid: TIrregularDelaunayGrid,
  data: Float32Array
): TSerializedGeoSampleIndexData {
  return buildSerializedGeoSampleIndexData(
    Float64Array.from(grid.latitudes),
    Float64Array.from(grid.longitudes),
    data.slice()
  );
}
