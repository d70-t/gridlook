import { buildSerializedGeoSampleIndexData } from "./gridWorkerCalculations.ts";
import type {
  TGridGeometryBatch,
  TSerializedGeoSampleIndexData,
} from "./gridWorkerTypes.ts";

import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";

type TCoordinate = { lat: number; lon: number };
type TBoundaryFunction = (
  row: number,
  fromColumn: number,
  toColumn: number
) => TCoordinate;
type TMidpointFunction = (fromColumn: number, toColumn: number) => TCoordinate;

export type TCurvilinearGrid = {
  latitudes: Float32Array;
  longitudes: Float32Array;
  data: Float32Array;
  nj: number;
  ni: number;
  shouldFlipLongitude: boolean;
  isPeriodicI: boolean;
};

function isMissingCoordinate(
  value: number,
  missingValue: number,
  fillValue: number
) {
  return Number.isNaN(value) || value === missingValue || value === fillValue;
}

export function detectCurvilinearLongitudeFlip(
  longitudes: Float32Array,
  latitudes: Float32Array,
  missingValue: number,
  fillValue: number,
  nj: number,
  ni: number
) {
  for (let row = 0; row < nj - 1; row++) {
    const columnLimit = Math.min(ni - 1, 10);
    for (let column = 0; column < columnLimit; column++) {
      const topLeft = row * ni + column;
      const topRight = topLeft + 1;
      const bottomLeft = (row + 1) * ni + column;
      const bottomRight = bottomLeft + 1;
      if (
        isMissingCoordinate(longitudes[topLeft], missingValue, fillValue) ||
        isMissingCoordinate(longitudes[topRight], missingValue, fillValue) ||
        isMissingCoordinate(longitudes[bottomLeft], missingValue, fillValue) ||
        isMissingCoordinate(longitudes[bottomRight], missingValue, fillValue)
      ) {
        continue;
      }
      const longitudeI = longitudes[topRight] - longitudes[topLeft];
      const latitudeI = latitudes[topRight] - latitudes[topLeft];
      const longitudeJ = longitudes[bottomLeft] - longitudes[topLeft];
      const latitudeJ = latitudes[bottomLeft] - latitudes[topLeft];
      return longitudeI * latitudeJ - latitudeI * longitudeJ < 0;
    }
  }
  return false;
}

export function detectCurvilinearColumnPeriodicity(
  longitudes: Float32Array,
  nj: number,
  ni: number
) {
  if (ni < 3) {
    return false;
  }
  const sampleRow = Math.floor(nj / 2);
  const sampleCount = Math.min(ni - 1, 10);
  let spacingTotal = 0;
  let validSpacingCount = 0;
  for (let column = 0; column < sampleCount; column++) {
    const longitude = longitudes[sampleRow * ni + column];
    const nextLongitude = longitudes[sampleRow * ni + column + 1];
    const spacing = Math.abs(((nextLongitude - longitude + 540) % 360) - 180);
    if (spacing > 0) {
      spacingTotal += spacing;
      validSpacingCount++;
    }
  }
  if (validSpacingCount === 0) {
    return false;
  }
  const firstLongitude = longitudes[sampleRow * ni];
  const lastLongitude = longitudes[sampleRow * ni + ni - 1];
  const wrapGap = Math.abs(
    ((firstLongitude - lastLongitude + 540) % 360) - 180
  );
  return wrapGap < (spacingTotal / validSpacingCount) * 4;
}

function getNextColumn(column: number, ni: number, flipLongitude: boolean) {
  if (flipLongitude) {
    return column === 0 ? ni - 1 : column - 1;
  }
  return (column + 1) % ni;
}

function getPreviousColumn(column: number, ni: number, flipLongitude: boolean) {
  if (flipLongitude) {
    return (column + 1) % ni;
  }
  return column === 0 ? ni - 1 : column - 1;
}

function getCircularMeanLongitude(
  first: number,
  second: number,
  third: number,
  fourth: number
) {
  const radians = Math.PI / 180;
  const sine =
    Math.sin(first * radians) +
    Math.sin(second * radians) +
    Math.sin(third * radians) +
    Math.sin(fourth * radians);
  const cosine =
    Math.cos(first * radians) +
    Math.cos(second * radians) +
    Math.cos(third * radians) +
    Math.cos(fourth * radians);
  return Math.atan2(sine / 4, cosine / 4) / radians;
}

function getCellCenter(
  grid: TCurvilinearGrid,
  topLeft: number,
  topRight: number,
  bottomLeft: number,
  bottomRight: number
) {
  return {
    lat:
      (grid.latitudes[topLeft] +
        grid.latitudes[topRight] +
        grid.latitudes[bottomLeft] +
        grid.latitudes[bottomRight]) /
      4,
    lon: getCircularMeanLongitude(
      grid.longitudes[topLeft],
      grid.longitudes[topRight],
      grid.longitudes[bottomLeft],
      grid.longitudes[bottomRight]
    ),
  };
}

function getBoundaryPoint(
  grid: TCurvilinearGrid,
  row: number,
  fromColumn: number,
  toColumn: number
) {
  return getCellCenter(
    grid,
    row * grid.ni + fromColumn,
    row * grid.ni + toColumn,
    (row + 1) * grid.ni + fromColumn,
    (row + 1) * grid.ni + toColumn
  );
}

function getRowMidpoint(
  grid: TCurvilinearGrid,
  row: number,
  fromColumn: number,
  toColumn: number
) {
  return getCellCenter(
    grid,
    row * grid.ni + fromColumn,
    row * grid.ni + toColumn,
    row * grid.ni + fromColumn,
    row * grid.ni + toColumn
  );
}

function mirrorBoundaryPoint(center: TCoordinate, boundary: TCoordinate) {
  const longitudeOffset = ((boundary.lon - center.lon + 540) % 360) - 180;
  return {
    lat: 2 * center.lat - boundary.lat,
    lon: center.lon - longitudeOffset,
  };
}

function getPreviousBoundaryCorners(
  row: number,
  column: number,
  nextColumn: number,
  boundary: TBoundaryFunction,
  midpoint: TMidpointFunction
) {
  const forwardNext = boundary(row, column, nextColumn);
  const forwardPrevious = mirrorBoundaryPoint(
    midpoint(column, column),
    forwardNext
  );
  const backwardNext =
    row === 0
      ? mirrorBoundaryPoint(midpoint(column, nextColumn), forwardNext)
      : boundary(row - 1, column, nextColumn);
  return {
    forwardPrevious,
    forwardNext,
    backwardPrevious: mirrorBoundaryPoint(
      midpoint(column, column),
      backwardNext
    ),
    backwardNext,
  };
}

function getNextBoundaryCorners(
  row: number,
  column: number,
  previousColumn: number,
  boundary: TBoundaryFunction,
  midpoint: TMidpointFunction
) {
  const forwardPrevious = boundary(row, previousColumn, column);
  const forwardNext = mirrorBoundaryPoint(
    midpoint(column, column),
    forwardPrevious
  );
  const backwardPrevious =
    row === 0
      ? mirrorBoundaryPoint(midpoint(previousColumn, column), forwardPrevious)
      : boundary(row - 1, previousColumn, column);
  return {
    forwardPrevious,
    forwardNext,
    backwardPrevious,
    backwardNext: mirrorBoundaryPoint(
      midpoint(column, column),
      backwardPrevious
    ),
  };
}

function getPeriodicCorners(
  row: number,
  column: number,
  previousColumn: number,
  nextColumn: number,
  boundary: TBoundaryFunction,
  midpoint: TMidpointFunction
) {
  const forwardPrevious = boundary(row, previousColumn, column);
  const forwardNext = boundary(row, column, nextColumn);
  return {
    forwardPrevious,
    forwardNext,
    backwardPrevious:
      row === 0
        ? mirrorBoundaryPoint(midpoint(previousColumn, column), forwardPrevious)
        : boundary(row - 1, previousColumn, column),
    backwardNext:
      row === 0
        ? mirrorBoundaryPoint(midpoint(column, nextColumn), forwardNext)
        : boundary(row - 1, column, nextColumn),
  };
}

/* eslint-disable-next-line max-lines-per-function */
function getCenteredCellCorners(
  grid: TCurvilinearGrid,
  row: number,
  column: number
) {
  const previousColumn = getPreviousColumn(
    column,
    grid.ni,
    grid.shouldFlipLongitude
  );
  const nextColumn = getNextColumn(column, grid.ni, grid.shouldFlipLongitude);
  const boundary: TBoundaryFunction = (boundaryRow, fromColumn, toColumn) =>
    getBoundaryPoint(grid, boundaryRow, fromColumn, toColumn);
  const midpoint: TMidpointFunction = (fromColumn, toColumn) =>
    getRowMidpoint(grid, row, fromColumn, toColumn);
  const isFirst = grid.shouldFlipLongitude
    ? column === grid.ni - 1
    : column === 0;
  const isLast = grid.shouldFlipLongitude
    ? column === 0
    : column === grid.ni - 1;
  const corners =
    !grid.isPeriodicI && isFirst
      ? getPreviousBoundaryCorners(row, column, nextColumn, boundary, midpoint)
      : !grid.isPeriodicI && isLast
        ? getNextBoundaryCorners(
            row,
            column,
            previousColumn,
            boundary,
            midpoint
          )
        : getPeriodicCorners(
            row,
            column,
            previousColumn,
            nextColumn,
            boundary,
            midpoint
          );
  return {
    latitudes: [
      corners.backwardPrevious.lat,
      corners.backwardNext.lat,
      corners.forwardNext.lat,
      corners.forwardPrevious.lat,
    ],
    longitudes: [
      corners.backwardPrevious.lon,
      corners.backwardNext.lon,
      corners.forwardNext.lon,
      corners.forwardPrevious.lon,
    ],
  };
}

function fillCell(
  grid: TCurvilinearGrid,
  projection: ProjectionHelper,
  row: number,
  column: number,
  cellIndex: number,
  batch: TGridGeometryBatch
) {
  const corners = getCenteredCellCorners(grid, row, column);
  const invalid =
    corners.latitudes.some((value) => !Number.isFinite(value)) ||
    corners.longitudes.some((value) => !Number.isFinite(value));
  if (invalid) {
    batch.dataValues.fill(NaN, cellIndex * 4, cellIndex * 4 + 4);
  } else {
    for (let corner = 0; corner < 4; corner++) {
      projection.projectLatLonToArrays(
        corners.latitudes[corner],
        corners.longitudes[corner],
        batch.positionValues,
        cellIndex * 12 + corner * 3,
        batch.latLonValues,
        cellIndex * 8 + corner * 2
      );
    }
    const dataIndex = row * grid.ni + column;
    batch.dataValues.fill(
      grid.data[dataIndex],
      cellIndex * 4,
      cellIndex * 4 + 4
    );
  }
  const vertex = cellIndex * 4;
  batch.indices.set(
    [vertex, vertex + 1, vertex + 2, vertex, vertex + 2, vertex + 3],
    cellIndex * 6
  );
}

export function getCurvilinearBatchCount(
  grid: TCurvilinearGrid,
  batchSize: number
) {
  return Math.ceil((grid.nj - 1) / batchSize);
}

export function buildCurvilinearBatch(
  grid: TCurvilinearGrid,
  batchIndex: number,
  batchSize: number,
  projection: ProjectionHelper
): TGridGeometryBatch {
  const rowStart = batchIndex * batchSize;
  const rowEnd = Math.min(rowStart + batchSize, grid.nj - 1);
  const cellCount = (rowEnd - rowStart) * grid.ni;
  const batch: TGridGeometryBatch = {
    batchIndex,
    positionValues: new Float32Array(cellCount * 12),
    dataValues: new Float32Array(cellCount * 4),
    latLonValues: new Float32Array(cellCount * 8),
    indices: new Uint32Array(cellCount * 6),
  };
  let cellIndex = 0;
  for (let row = rowStart; row < rowEnd; row++) {
    for (let column = 0; column < grid.ni; column++) {
      fillCell(grid, projection, row, column, cellIndex, batch);
      cellIndex++;
    }
  }
  return batch;
}

export function buildCurvilinearHoverIndexData(
  grid: TCurvilinearGrid
): TSerializedGeoSampleIndexData {
  const sampleCount = (grid.nj - 1) * grid.ni;
  const latitudes = new Float64Array(sampleCount);
  const longitudes = new Float64Array(sampleCount);
  const values = new Float32Array(sampleCount);
  let sampleIndex = 0;
  for (let row = 0; row < grid.nj - 1; row++) {
    for (let column = 0; column < grid.ni; column++) {
      const dataIndex = row * grid.ni + column;
      latitudes[sampleIndex] = grid.latitudes[dataIndex];
      longitudes[sampleIndex] = grid.longitudes[dataIndex];
      values[sampleIndex] = grid.data[dataIndex];
      sampleIndex++;
    }
  }
  return buildSerializedGeoSampleIndexData(latitudes, longitudes, values);
}
