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
  dataIndices?: Uint32Array;
  latitudes: Float64Array;
  longitudes: Float64Array;
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
  const flipped = shouldFlipCartesianTriangle(
    vertex0[0],
    vertex0[1],
    vertex0[2],
    vertex1[0],
    vertex1[1],
    vertex1[2],
    vertex2[0],
    vertex2[1],
    vertex2[2]
  );
  if (flipped) {
    [vertex1, vertex2] = [vertex2, vertex1];
  }
  writeVertex(vertices, triangleIndex, 0, vertex0);
  writeVertex(vertices, triangleIndex, 1, vertex1);
  writeVertex(vertices, triangleIndex, 2, vertex2);
  return flipped;
}

function buildTriangleCentroids(vertices: Float32Array) {
  const triangleCount = vertices.length / 9;
  const latitudes = new Float64Array(triangleCount);
  const longitudes = new Float64Array(triangleCount);
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
    latitudes[triangleIndex] = lat;
    longitudes[triangleIndex] = lon;
  }
  return { latitudes, longitudes };
}

export function buildTriangularGrid(
  vertexOfCell: Int32Array,
  vertexX: TCoordinateArray,
  vertexY: TCoordinateArray,
  vertexZ: TCoordinateArray,
  nodeData = false
): TTriangularGrid {
  if (vertexOfCell.length % 3 !== 0) {
    throw new Error("Triangular grid connectivity must contain three rows.");
  }
  if (vertexX.length !== vertexY.length || vertexX.length !== vertexZ.length) {
    throw new Error("Triangular grid vertex coordinate lengths do not match.");
  }
  const triangleCount = vertexOfCell.length / 3;
  const vertices = new Float32Array(triangleCount * 9);
  const dataIndices = nodeData ? new Uint32Array(triangleCount * 3) : undefined;
  const vertex = (triangleIndex: number, corner: number) =>
    getVertex(
      vertexOfCell[corner * triangleCount + triangleIndex] - 1,
      vertexX,
      vertexY,
      vertexZ
    );
  for (let triangleIndex = 0; triangleIndex < triangleCount; triangleIndex++) {
    const flipped = writeTriangle(
      vertices,
      triangleIndex,
      vertex(triangleIndex, 0),
      vertex(triangleIndex, 1),
      vertex(triangleIndex, 2)
    );
    if (dataIndices) {
      for (let corner = 0; corner < 3; corner++) {
        const sourceCorner = flipped && corner > 0 ? 3 - corner : corner;
        dataIndices[triangleIndex * 3 + corner] =
          vertexOfCell[sourceCorner * triangleCount + triangleIndex] - 1;
      }
    }
  }
  return {
    vertices,
    dataIndices,
    ...(nodeData
      ? buildNodeCoordinates(vertexX, vertexY, vertexZ)
      : buildTriangleCentroids(vertices)),
  };
}

function buildNodeCoordinates(
  vertexX: TCoordinateArray,
  vertexY: TCoordinateArray,
  vertexZ: TCoordinateArray
) {
  const latitudes = new Float64Array(vertexX.length);
  const longitudes = new Float64Array(vertexX.length);
  for (let node = 0; node < vertexX.length; node++) {
    const { lat, lon } = ProjectionHelper.cartesianToLatLon(
      vertexX[node],
      vertexY[node],
      vertexZ[node]
    );
    latitudes[node] = lat;
    longitudes[node] = lon;
  }
  return { latitudes, longitudes };
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
  batchSize: number,
  dataIndices?: Uint32Array
): TGridDataValueBatch {
  const start = batchIndex * batchSize;
  const end = Math.min(
    start + batchSize,
    dataIndices ? dataIndices.length / 3 : data.length
  );
  const dataValues = new Float32Array((end - start) * 3);
  for (let cellIndex = start; cellIndex < end; cellIndex++) {
    const offset = (cellIndex - start) * 3;
    for (let corner = 0; corner < 3; corner++) {
      dataValues[offset + corner] =
        data[dataIndices ? dataIndices[cellIndex * 3 + corner] : cellIndex];
    }
  }
  return { batchIndex, dataValues };
}

export function buildTriangularHoverIndexData(
  grid: TTriangularGrid,
  data: Float32Array
): TSerializedGeoSampleIndexData {
  if (data.length !== grid.latitudes.length) {
    throw new Error(
      `Triangular grid has ${grid.latitudes.length} cells but data has ${data.length} values.`
    );
  }
  return buildSerializedGeoSampleIndexData(
    grid.latitudes.slice(),
    grid.longitudes.slice(),
    data.slice()
  );
}
