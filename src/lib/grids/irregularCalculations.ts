import { buildSerializedGeoSampleIndexData } from "./gridWorkerCalculations.ts";
import type {
  TGridPointBatch,
  TSerializedGeoSampleIndexData,
} from "./gridWorkerTypes.ts";

import { reconcileCoordinateArrays } from "@/lib/data/irregularGridHelpers.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";

export type TIrregularGridData = {
  positions: Float32Array;
  latLonValues: Float32Array;
  data: Float32Array;
  latitudes: Float32Array;
  longitudes: Float32Array;
  estimatedSpacing: number;
};

export function estimateIrregularAverageSpacing(
  positions: Float32Array,
  sampleSize = 5000
) {
  const pointCount = positions.length / 3;
  const stride = Math.max(1, Math.floor(pointCount / sampleSize));
  let totalDistance = 0;
  let totalWeight = 0;

  for (let pointIndex = 0; pointIndex < pointCount; pointIndex += stride) {
    const offset = pointIndex * 3;
    const x = positions[offset];
    const y = positions[offset + 1];
    const z = positions[offset + 2];
    const weight = Math.cos(Math.asin(z));
    if (weight < 0.1) {
      continue;
    }
    let nearestDistance = Number.POSITIVE_INFINITY;
    const start = Math.max(0, pointIndex - 50);
    const end = Math.min(pointCount, pointIndex + 50);
    for (let neighborIndex = start; neighborIndex < end; neighborIndex++) {
      if (pointIndex === neighborIndex) {
        continue;
      }
      const neighborOffset = neighborIndex * 3;
      const deltaX = positions[neighborOffset] - x;
      const deltaY = positions[neighborOffset + 1] - y;
      const deltaZ = positions[neighborOffset + 2] - z;
      const distance = Math.sqrt(
        deltaX * deltaX + deltaY * deltaY + deltaZ * deltaZ
      );
      if (distance > 0 && distance < nearestDistance) {
        nearestDistance = distance;
      }
    }
    if (nearestDistance !== Number.POSITIVE_INFINITY) {
      totalDistance += nearestDistance * weight;
      totalWeight += weight;
    }
  }
  return totalWeight > 0 ? totalDistance / totalWeight : 0.01;
}

export function buildIrregularGridData(
  latitudes: Float32Array,
  longitudes: Float32Array,
  latitudeShape: number[],
  longitudeShape: number[],
  data: Float32Array,
  projection: ProjectionHelper
): TIrregularGridData {
  const coordinates = reconcileCoordinateArrays(
    latitudes,
    longitudes,
    latitudeShape,
    longitudeShape,
    data.length
  );
  const positions = new Float32Array(data.length * 3);
  const latLonValues = new Float32Array(data.length * 2);
  for (let index = 0; index < data.length; index++) {
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
    positions,
    latLonValues,
    data,
    ...coordinates,
    estimatedSpacing: estimateIrregularAverageSpacing(positions),
  };
}

export function getIrregularBatchCount(
  grid: TIrregularGridData,
  batchSize: number
) {
  return Math.ceil(grid.data.length / batchSize);
}

export function buildIrregularBatch(
  grid: TIrregularGridData,
  batchIndex: number,
  batchSize: number
): TGridPointBatch {
  const start = batchIndex * batchSize;
  const end = Math.min(start + batchSize, grid.data.length);
  return {
    batchIndex,
    positionValues: grid.positions.slice(start * 3, end * 3),
    latLonValues: grid.latLonValues.slice(start * 2, end * 2),
    dataValues: grid.data.slice(start, end),
  };
}

export function buildIrregularHoverIndexData(
  grid: TIrregularGridData
): TSerializedGeoSampleIndexData {
  return buildSerializedGeoSampleIndexData(
    Float64Array.from(grid.latitudes),
    Float64Array.from(grid.longitudes),
    grid.data.slice()
  );
}
