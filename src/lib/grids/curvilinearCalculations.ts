import { buildSerializedGeoSampleIndexData } from "./gridWorkerCalculations.ts";
import type { TSerializedGeoSampleIndexData } from "./gridWorkerTypes.ts";

import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";

export type TCurvilinearGrid = {
  latitudes: Float32Array;
  longitudes: Float32Array;
  nj: number;
  ni: number;
  shouldFlipLongitude: boolean;
  isPeriodicI: boolean;
};

export type TCurvilinearMesh = {
  positionValues: Float32Array;
  latLonValues: Float32Array;
  uvValues: Float32Array;
  indices: Uint32Array;
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

function subsampleIndices(count: number, maxCount: number) {
  if (count <= maxCount) {
    return Array.from({ length: count }, (_, index) => index);
  }
  return Array.from({ length: maxCount }, (_, k) =>
    Math.round((k * (count - 1)) / (maxCount - 1))
  );
}

// Fractional index -0.5 / count-0.5 is half a cell beyond the edge point and is
// extrapolated from the two outermost points.
function getAxisWeights(index: number, count: number): [number, number][] {
  if (count < 2 || (index >= 0 && index <= count - 1)) {
    return [[index < 0 ? 0 : index > count - 1 ? count - 1 : index, 1]];
  }
  return index < 0
    ? [
        [0, 1.5],
        [1, -0.5],
      ]
    : [
        [count - 1, 1.5],
        [count - 2, -0.5],
      ];
}

function wrapLongitudeDifference(difference: number) {
  return ((((difference + 180) % 360) + 360) % 360) - 180;
}

function sampleCoordinate(
  grid: TCurvilinearGrid,
  row: number,
  column: number
): { lat: number; lon: number } | null {
  const rowWeights = getAxisWeights(row, grid.nj);
  const columnWeights = getAxisWeights(
    column === grid.ni ? 0 : column,
    grid.ni
  );
  const referenceLon =
    grid.longitudes[rowWeights[0][0] * grid.ni + columnWeights[0][0]];
  let lat = 0;
  let lon = referenceLon;
  for (const [j, rowWeight] of rowWeights) {
    for (const [i, columnWeight] of columnWeights) {
      const pointLat = grid.latitudes[j * grid.ni + i];
      const pointLon = grid.longitudes[j * grid.ni + i];
      if (!Number.isFinite(pointLon) || !(Math.abs(pointLat) <= 90)) {
        return null;
      }
      lat += rowWeight * columnWeight * pointLat;
      lon +=
        rowWeight *
        columnWeight *
        wrapLongitudeDifference(pointLon - referenceLon);
    }
  }
  return { lat: lat < -90 ? -90 : lat > 90 ? 90 : lat, lon };
}

function getMeshAxes(grid: TCurvilinearGrid, maxResolution: number) {
  const rows = [
    -0.5,
    ...subsampleIndices(grid.nj, maxResolution),
    grid.nj - 0.5,
  ];
  const sampledColumns = subsampleIndices(grid.ni, maxResolution);
  const columns = grid.isPeriodicI
    ? [...sampledColumns, grid.ni]
    : [-0.5, ...sampledColumns, grid.ni - 0.5];
  return { rows, columns };
}

function buildMeshIndices(
  valid: Uint8Array,
  rowCount: number,
  columnCount: number,
  shouldFlip: boolean
) {
  const indices = new Uint32Array((rowCount - 1) * (columnCount - 1) * 6);
  let offset = 0;
  for (let r = 0; r < rowCount - 1; r++) {
    for (let c = 0; c < columnCount - 1; c++) {
      const lowLeft = r * columnCount + c;
      const lowRight = lowLeft + 1;
      const topLeft = lowLeft + columnCount;
      const topRight = topLeft + 1;
      if (
        !valid[lowLeft] ||
        !valid[lowRight] ||
        !valid[topLeft] ||
        !valid[topRight]
      ) {
        continue;
      }
      // Same winding as regular grids when i runs east and j north.
      indices.set(
        shouldFlip
          ? [lowLeft, topLeft, topRight, lowLeft, topRight, lowRight]
          : [lowLeft, topRight, topLeft, lowLeft, lowRight, topRight],
        offset
      );
      offset += 6;
    }
  }
  return indices.slice(0, offset);
}

/**
 * Builds a mesh whose vertices are a subsample of the grid points (plus a
 * half-cell border); the cells themselves come from a data texture sampled at
 * texel centres, so the mesh never has to be rebuilt for new data.
 *
 * ponytail: cells between sampled points are placed by linear interpolation
 * (error < 0.25 px for 99.9% of the 2688x2304 Meteosat disk at 512). Upgrade
 * path: sample more densely where the grid bends strongly.
 */
export function buildCurvilinearMesh(
  grid: TCurvilinearGrid,
  maxResolution: number,
  projection: ProjectionHelper
): TCurvilinearMesh {
  const { rows, columns } = getMeshAxes(grid, maxResolution);
  const vertexCount = rows.length * columns.length;
  const positionValues = new Float32Array(vertexCount * 3);
  const latLonValues = new Float32Array(vertexCount * 2);
  const uvValues = new Float32Array(vertexCount * 2);
  const valid = new Uint8Array(vertexCount);
  for (let r = 0; r < rows.length; r++) {
    for (let c = 0; c < columns.length; c++) {
      const vertex = r * columns.length + c;
      uvValues[vertex * 2] = (columns[c] + 0.5) / grid.ni;
      uvValues[vertex * 2 + 1] = (rows[r] + 0.5) / grid.nj;
      const coordinate = sampleCoordinate(grid, rows[r], columns[c]);
      if (!coordinate) {
        continue;
      }
      valid[vertex] = 1;
      projection.projectLatLonToArrays(
        coordinate.lat,
        coordinate.lon,
        positionValues,
        vertex * 3,
        latLonValues,
        vertex * 2
      );
    }
  }
  const indices = buildMeshIndices(
    valid,
    rows.length,
    columns.length,
    grid.shouldFlipLongitude
  );
  return { positionValues, latLonValues, uvValues, indices };
}

export type TCurvilinearHoverIndexData = TSerializedGeoSampleIndexData & {
  // Grid point (row-major data index) of every indexed sample.
  sampleIds: Uint32Array;
};

// The index only depends on the coordinates; callers attach the values of the
// field they display with attachCurvilinearHoverValues.
export function buildCurvilinearHoverIndexData(
  latitudes: Float32Array,
  longitudes: Float32Array
): TCurvilinearHoverIndexData {
  // KDBush cannot order NaN coordinates: they corrupt the tree and break
  // lookups for valid points too, so only finite points are indexed.
  let count = 0;
  for (let k = 0; k < latitudes.length; k++) {
    if (Number.isFinite(latitudes[k]) && Number.isFinite(longitudes[k])) {
      count++;
    }
  }
  const sampleIds = new Uint32Array(count);
  const sampleLatitudes = new Float64Array(count);
  const sampleLongitudes = new Float64Array(count);
  let sample = 0;
  for (let k = 0; k < latitudes.length; k++) {
    if (Number.isFinite(latitudes[k]) && Number.isFinite(longitudes[k])) {
      sampleIds[sample] = k;
      sampleLatitudes[sample] = latitudes[k];
      sampleLongitudes[sample] = longitudes[k];
      sample++;
    }
  }
  return {
    ...buildSerializedGeoSampleIndexData(
      sampleLatitudes,
      sampleLongitudes,
      new Float32Array(0)
    ),
    sampleIds,
  };
}

export function attachCurvilinearHoverValues(
  hoverIndexData: TCurvilinearHoverIndexData,
  values: Float32Array
): TSerializedGeoSampleIndexData {
  const sampleValues = new Float32Array(hoverIndexData.sampleIds.length);
  for (let sample = 0; sample < sampleValues.length; sample++) {
    sampleValues[sample] = values[hoverIndexData.sampleIds[sample]];
  }
  return { ...hoverIndexData, values: sampleValues };
}
