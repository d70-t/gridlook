import { buildSerializedGeoSampleIndexData } from "./gridWorkerCalculations.ts";
import type {
  TGridGeometryBatch,
  TSerializedGeoSampleIndexData,
} from "./gridWorkerTypes.ts";

import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";

type TGaussianReducedCell = {
  lon: number;
  value: number;
};

export type TGaussianReducedRows = {
  rows: Record<number, TGaussianReducedCell[]>;
  uniqueLatitudes: number[];
};

export function buildGaussianReducedRows(
  latitudes: Float64Array,
  longitudes: Float64Array,
  data: Float32Array
): TGaussianReducedRows {
  const rows: Record<number, TGaussianReducedCell[]> = {};
  for (let index = 0; index < latitudes.length; index++) {
    const latitude = latitudes[index];
    if (!rows[latitude]) {
      rows[latitude] = [];
    }
    rows[latitude].push({ lon: longitudes[index], value: data[index] });
  }

  const uniqueLatitudes = Object.keys(rows)
    .map(Number)
    .sort((first, second) => second - first);
  return { rows, uniqueLatitudes };
}

function getCellData(row: TGaussianReducedCell[], index: number) {
  const cell = row[index];
  const nextCell = row[(index + 1) % row.length];
  const longitudeWidth = (nextCell.lon - cell.lon + 360) % 360;
  return { cell, longitudeWidth };
}

function countCells(
  grid: TGaussianReducedRows,
  latitudeStart: number,
  latitudeEnd: number
) {
  let totalCells = 0;
  for (let index = latitudeStart; index < latitudeEnd; index++) {
    totalCells += grid.rows[grid.uniqueLatitudes[index]].length;
  }
  return totalCells;
}

export function getGaussianReducedBatchCount(
  grid: TGaussianReducedRows,
  batchSize: number
) {
  return Math.ceil((grid.uniqueLatitudes.length - 1) / batchSize);
}

function projectQuad(
  projection: ProjectionHelper,
  latitudeTop: number,
  longitudeLeft: number,
  latitudeBottom: number,
  longitudeWidth: number,
  epsilon: number,
  positionValues: Float32Array,
  latLonValues: Float32Array,
  positionOffset: number,
  latLonOffset: number
) {
  const longitudeRight = longitudeLeft - longitudeWidth;
  projection.projectLatLonToArrays(
    latitudeTop,
    longitudeLeft + epsilon,
    positionValues,
    positionOffset,
    latLonValues,
    latLonOffset
  );
  projection.projectLatLonToArrays(
    latitudeTop,
    longitudeRight - epsilon,
    positionValues,
    positionOffset + 3,
    latLonValues,
    latLonOffset + 2
  );
  projection.projectLatLonToArrays(
    latitudeBottom - epsilon,
    longitudeRight - epsilon,
    positionValues,
    positionOffset + 6,
    latLonValues,
    latLonOffset + 4
  );
  projection.projectLatLonToArrays(
    latitudeBottom - epsilon,
    longitudeLeft + epsilon,
    positionValues,
    positionOffset + 9,
    latLonValues,
    latLonOffset + 6
  );
}

/* eslint-disable-next-line max-lines-per-function */
export function buildGaussianReducedBatch(
  grid: TGaussianReducedRows,
  batchIndex: number,
  batchSize: number,
  epsilon: number,
  projection: ProjectionHelper
): TGridGeometryBatch {
  const latitudeStart = batchIndex * batchSize;
  const latitudeEnd = Math.min(
    latitudeStart + batchSize,
    grid.uniqueLatitudes.length - 1
  );
  const totalCells = countCells(grid, latitudeStart, latitudeEnd);
  const latLonValues = new Float32Array(totalCells * 8);
  const positionValues = new Float32Array(totalCells * 12);
  const dataValues = new Float32Array(totalCells * 4);
  const indices = new Uint32Array(totalCells * 6);
  let cellIndex = 0;

  for (
    let latitudeIndex = latitudeStart;
    latitudeIndex < latitudeEnd;
    latitudeIndex++
  ) {
    const latitudeTop = grid.uniqueLatitudes[latitudeIndex];
    const latitudeBottom = grid.uniqueLatitudes[latitudeIndex + 1];
    const row = grid.rows[latitudeTop];

    for (let index = 0; index < row.length; index++) {
      const { cell, longitudeWidth } = getCellData(row, index);
      projectQuad(
        projection,
        latitudeTop,
        cell.lon,
        latitudeBottom,
        longitudeWidth,
        epsilon,
        positionValues,
        latLonValues,
        cellIndex * 12,
        cellIndex * 8
      );
      dataValues.fill(cell.value, cellIndex * 4, cellIndex * 4 + 4);
      const vertex = cellIndex * 4;
      indices.set(
        [vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3],
        cellIndex * 6
      );
      cellIndex++;
    }
  }

  return { batchIndex, positionValues, dataValues, latLonValues, indices };
}

export function buildGaussianReducedHoverIndexData(
  grid: TGaussianReducedRows
): TSerializedGeoSampleIndexData {
  const rowCount = Math.max(0, grid.uniqueLatitudes.length - 1);
  const sampleCount = countCells(grid, 0, rowCount);
  const latitudes = new Float64Array(sampleCount);
  const longitudes = new Float64Array(sampleCount);
  const values = new Float32Array(sampleCount);
  let sampleIndex = 0;

  for (let latitudeIndex = 0; latitudeIndex < rowCount; latitudeIndex++) {
    const latitudeTop = grid.uniqueLatitudes[latitudeIndex];
    const latitudeBottom = grid.uniqueLatitudes[latitudeIndex + 1];
    const row = grid.rows[latitudeTop];
    for (let indexInRow = 0; indexInRow < row.length; indexInRow++) {
      const { cell, longitudeWidth } = getCellData(row, indexInRow);
      const latitude = (latitudeTop + latitudeBottom) / 2;
      const longitude = ProjectionHelper.normalizeLongitude(
        cell.lon - longitudeWidth / 2
      );
      latitudes[sampleIndex] = latitude;
      longitudes[sampleIndex] = longitude;
      values[sampleIndex] = cell.value;
      sampleIndex++;
    }
  }
  return buildSerializedGeoSampleIndexData(latitudes, longitudes, values);
}
