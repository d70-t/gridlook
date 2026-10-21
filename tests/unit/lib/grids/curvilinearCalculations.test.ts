import { expect, it } from "vitest";

import {
  attachCurvilinearHoverValues,
  buildCurvilinearHoverIndexData,
  buildCurvilinearMesh,
  detectCurvilinearColumnPeriodicity,
  detectCurvilinearLongitudeFlip,
  type TCurvilinearGrid,
} from "@/lib/grids/curvilinearCalculations.ts";
import { createSerializedGeoSampleIndex } from "@/lib/grids/serializedGeoSampleIndex.ts";
import {
  PROJECTION_TYPES,
  ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";

const projection = new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, {
  lat: 0,
  lon: 0,
});

function buildTestGrid(): TCurvilinearGrid {
  return {
    latitudes: new Float32Array([0, 0, 0, 1, 1, 1]),
    longitudes: new Float32Array([0, 120, 240, 0, 120, 240]),
    nj: 2,
    ni: 3,
    shouldFlipLongitude: false,
    isPeriodicI: true,
  };
}

function vertexAt(
  values: Float32Array,
  columnCount: number,
  row: number,
  column: number
) {
  const vertex = row * columnCount + column;
  return [values[vertex * 2], values[vertex * 2 + 1]];
}

it("detects curvilinear winding and column periodicity", () => {
  expect(
    detectCurvilinearLongitudeFlip(
      new Float32Array([0, 1, 0, 1]),
      new Float32Array([0, 0, 1, 1]),
      NaN,
      NaN,
      2,
      2
    )
  ).toBe(false);
  expect(
    detectCurvilinearLongitudeFlip(
      new Float32Array([0, 1, 0, 1]),
      new Float32Array([1, 1, 0, 0]),
      NaN,
      NaN,
      2,
      2
    )
  ).toBe(true);
  expect(
    detectCurvilinearColumnPeriodicity(
      new Float32Array([0, 120, 240, 0, 120, 240]),
      2,
      3
    )
  ).toBe(true);
});

it("maps vertices to texel centres and closes periodic grids", () => {
  const mesh = buildCurvilinearMesh(buildTestGrid(), 512, projection);
  // rows: -0.5, 0, 1, 1.5; columns: 0, 1, 2 and the wrap column 3
  const columnCount = 4;

  expect(mesh.uvValues).toHaveLength(4 * columnCount * 2);
  expect(vertexAt(mesh.uvValues, columnCount, 1, 0)).toEqual([
    Math.fround(0.5 / 3),
    0.25,
  ]);
  expect(vertexAt(mesh.uvValues, columnCount, 0, 1)[1]).toBe(0);
  expect(vertexAt(mesh.uvValues, columnCount, 3, 1)[1]).toBe(1);
  // The wrap column repeats column 0 past the texture edge (RepeatWrapping).
  expect(vertexAt(mesh.uvValues, columnCount, 1, 3)[0]).toBe(
    Math.fround(3.5 / 3)
  );
  expect(vertexAt(mesh.latLonValues, columnCount, 1, 3)).toEqual([0, 0]);
  // Half-cell borders are extrapolated from the two outermost rows.
  expect(vertexAt(mesh.latLonValues, columnCount, 0, 0)[0]).toBe(-0.5);
  expect(vertexAt(mesh.latLonValues, columnCount, 3, 0)[0]).toBe(1.5);
  expect(mesh.indices).toHaveLength(3 * 3 * 6);
});

it("subsamples large grids while keeping the original texel positions", () => {
  const grid: TCurvilinearGrid = {
    latitudes: Float32Array.from({ length: 25 }, (_, k) => Math.floor(k / 5)),
    longitudes: Float32Array.from({ length: 25 }, (_, k) => k % 5),
    nj: 5,
    ni: 5,
    shouldFlipLongitude: false,
    isPeriodicI: false,
  };
  const mesh = buildCurvilinearMesh(grid, 3, projection);
  // rows and columns: -0.5, 0, 2, 4, 4.5
  const columnCount = 5;

  expect(mesh.uvValues).toHaveLength(5 * columnCount * 2);
  expect(vertexAt(mesh.uvValues, columnCount, 2, 2)).toEqual([0.5, 0.5]);
  expect(vertexAt(mesh.latLonValues, columnCount, 2, 2)).toEqual([2, 2]);
  expect(vertexAt(mesh.latLonValues, columnCount, 0, 0)).toEqual([-0.5, -0.5]);
});

it("skips quads touching invalid coordinates and honours flipped winding", () => {
  const grid = buildTestGrid();
  grid.longitudes = new Float32Array([0, 1, 2, 0, 1, 2]);
  grid.isPeriodicI = false;
  const complete = buildCurvilinearMesh(grid, 512, projection);
  grid.shouldFlipLongitude = true;
  const flipped = buildCurvilinearMesh(grid, 512, projection);
  grid.latitudes = new Float32Array([0, 0, 0, 1, 1, NaN]);
  const withHole = buildCurvilinearMesh(grid, 512, projection);

  // rows -0.5, 0, 1, 1.5 x columns -0.5, 0, 1, 2, 2.5
  expect(complete.indices).toHaveLength(3 * 4 * 6);
  expect(Array.from(complete.indices.slice(0, 6))).toEqual([0, 6, 5, 0, 1, 6]);
  expect(Array.from(flipped.indices.slice(0, 6))).toEqual([0, 5, 6, 0, 6, 1]);
  // The NaN point and the border vertices extrapolated from it are invalid.
  expect(withHole.indices.length).toBeLessThan(complete.indices.length);
  expect(withHole.indices.length).toBeGreaterThan(0);
});

it("indexes finite grid points and maps hover values back to data order", () => {
  const grid = buildTestGrid();
  // Off-disk/land points without coordinates must not break the index.
  grid.latitudes[1] = NaN;
  const hoverIndexData = buildCurvilinearHoverIndexData(
    grid.latitudes,
    grid.longitudes
  );
  const index = createSerializedGeoSampleIndex(
    attachCurvilinearHoverValues(
      hoverIndexData,
      new Float32Array([1, 2, 3, 4, 5, 6])
    )
  );

  expect(Array.from(hoverIndexData.sampleIds)).toEqual([0, 2, 3, 4, 5]);
  expect(index.findNearest(1, 240)?.value).toBe(6);
  expect(index.findNearest(1, 120)?.value).toBe(5);
  expect(index.findNearest(0, 0)?.value).toBe(1);
});
