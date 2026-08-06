import {
  buildSerializedGeoSampleIndexData,
  shouldFlipCartesianTriangle,
} from "./gridWorkerCalculations.ts";
import type {
  TGridDataValueBatch,
  TGridPositionBatch,
  TSerializedGeoSampleIndexData,
} from "./gridWorkerTypes.ts";

import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";

type TCoordinateArray = Float32Array | Float64Array;

export type TTriangularGrid = {
  vertices: Float32Array;
  centroidLatitudes: Float64Array;
  centroidLongitudes: Float64Array;
};

function getVertex(
  index: number,
  vertexX: TCoordinateArray,
  vertexY: TCoordinateArray,
  vertexZ: TCoordinateArray
): [number, number, number] {
  if (index < 0 || index >= vertexX.length) {
    throw new Error(`Triangular grid vertex index ${index + 1} is invalid.`);
  }
  return [vertexX[index], vertexY[index], vertexZ[index]];
}

function writeVertex(
  vertices: Float32Array,
  triangleIndex: number,
  vertexIndex: number,
  vertex: [number, number, number]
) {
  const offset = triangleIndex * 9 + vertexIndex * 3;
  vertices[offset] = vertex[0];
  vertices[offset + 1] = vertex[1];
  vertices[offset + 2] = vertex[2];
}

function writeTriangle(
  vertices: Float32Array,
  triangleIndex: number,
  vertex0: [number, number, number],
  vertex1: [number, number, number],
  vertex2: [number, number, number]
) {
  if (
    shouldFlipCartesianTriangle(
      vertex0[0],
      vertex0[1],
      vertex0[2],
      vertex1[0],
      vertex1[1],
      vertex1[2],
      vertex2[0],
      vertex2[1],
      vertex2[2]
    )
  ) {
    [vertex1, vertex2] = [vertex2, vertex1];
  }
  writeVertex(vertices, triangleIndex, 0, vertex0);
  writeVertex(vertices, triangleIndex, 1, vertex1);
  writeVertex(vertices, triangleIndex, 2, vertex2);
}

function buildTriangleCentroids(vertices: Float32Array) {
  const triangleCount = vertices.length / 9;
  const centroidLatitudes = new Float64Array(triangleCount);
  const centroidLongitudes = new Float64Array(triangleCount);
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
    const offset = triangleIndex * 9;
    const centerX =
      vertices[offset] + vertices[offset + 3] + vertices[offset + 6];
    const centerY =
      vertices[offset + 1] + vertices[offset + 4] + vertices[offset + 7];
    const centerZ =
      vertices[offset + 2] + vertices[offset + 5] + vertices[offset + 8];
    const { lat, lon } = ProjectionHelper.cartesianToLatLon(
      centerX,
      centerY,
      centerZ
    );
    centroidLatitudes[triangleIndex] = lat;
    centroidLongitudes[triangleIndex] = lon;
  }
  return { centroidLatitudes, centroidLongitudes };
}

export function buildTriangularGrid(
  vertexOfCell: Int32Array,
  vertexX: TCoordinateArray,
  vertexY: TCoordinateArray,
  vertexZ: TCoordinateArray
): TTriangularGrid {
  if (vertexOfCell.length % 3 !== 0) {
    throw new Error("Triangular grid connectivity must contain three rows.");
  }
  if (vertexX.length !== vertexY.length || vertexX.length !== vertexZ.length) {
    throw new Error("Triangular grid vertex coordinate lengths do not match.");
  }
  const triangleCount = vertexOfCell.length / 3;
  const vertices = new Float32Array(triangleCount * 9);
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
    const vertex0 = getVertex(
      vertexOfCell[triangleIndex] - 1,
      vertexX,
      vertexY,
      vertexZ
    );
    const vertex1 = getVertex(
      vertexOfCell[triangleCount + triangleIndex] - 1,
      vertexX,
      vertexY,
      vertexZ
    );
    const vertex2 = getVertex(
      vertexOfCell[triangleCount * 2 + triangleIndex] - 1,
      vertexX,
      vertexY,
      vertexZ
    );
    writeTriangle(vertices, triangleIndex, vertex0, vertex1, vertex2);
  }
  return { vertices, ...buildTriangleCentroids(vertices) };
}

export function getTriangularBatchCount(
  triangleCount: number,
  batchSize: number
) {
  return Math.ceil(triangleCount / batchSize);
}

export function buildTriangularGeometryBatch(
  grid: TTriangularGrid,
  batchIndex: number,
  batchSize: number,
  projection: ProjectionHelper
): TGridPositionBatch {
  const triangleCount = grid.vertices.length / 9;
  const start = batchIndex * batchSize;
  const end = Math.min(start + batchSize, triangleCount);
  const sourceVertices = grid.vertices.subarray(start * 9, end * 9);
  const positionValues = new Float32Array(sourceVertices.length);
  const latLonValues = new Float32Array((sourceVertices.length / 3) * 2);
  for (
    let vertexIndex = 0;
    vertexIndex < sourceVertices.length / 3;
    vertexIndex++
  ) {
    const sourceOffset = vertexIndex * 3;
    const { lat, lon } = ProjectionHelper.cartesianToLatLon(
      sourceVertices[sourceOffset],
      sourceVertices[sourceOffset + 1],
      sourceVertices[sourceOffset + 2]
    );
    projection.projectLatLonToArrays(
      lat,
      lon,
      positionValues,
      sourceOffset,
      latLonValues,
      vertexIndex * 2
    );
  }
  return { batchIndex, positionValues, latLonValues };
}

export function buildTriangularDataBatch(
  data: Float32Array,
  batchIndex: number,
  batchSize: number
): TGridDataValueBatch {
  const start = batchIndex * batchSize;
  const end = Math.min(start + batchSize, data.length);
  const dataValues = new Float32Array((end - start) * 3);
  for (let cellIndex = start; cellIndex < end; cellIndex++) {
    const offset = (cellIndex - start) * 3;
    dataValues[offset] = data[cellIndex];
    dataValues[offset + 1] = data[cellIndex];
    dataValues[offset + 2] = data[cellIndex];
  }
  return { batchIndex, dataValues };
}

export function buildTriangularHoverIndexData(
  grid: TTriangularGrid,
  data: Float32Array
): TSerializedGeoSampleIndexData {
  if (data.length !== grid.centroidLatitudes.length) {
    throw new Error(
      `Triangular grid has ${grid.centroidLatitudes.length} cells but data has ${data.length} values.`
    );
  }
  return buildSerializedGeoSampleIndexData(
    grid.centroidLatitudes.slice(),
    grid.centroidLongitudes.slice(),
    data.slice()
  );
}
