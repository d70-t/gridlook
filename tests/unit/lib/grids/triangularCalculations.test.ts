import { expect, it } from "vitest";

import { buildSerializedGeoSampleIndexData } from "@/lib/grids/gridWorkerCalculations.ts";
import {
  buildTriangularDataBatch,
  buildTriangularGeometryBatch,
  buildTriangularGrid,
  buildTriangularHoverIndexData,
  getTriangularBatchCount,
} from "@/lib/grids/triangularCalculations.ts";
import {
  PROJECTION_TYPES,
  ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";

const vertexX = new Float64Array([1, 0, 0]);
const vertexY = new Float64Array([0, 1, 0]);
const vertexZ = new Float64Array([0, 0, 1]);

function buildTestGrid(connectivity = new Int32Array([1, 2, 3])) {
  return buildTriangularGrid(connectivity, vertexX, vertexY, vertexZ);
}

it("builds outward-facing transferable triangular geometry", () => {
  const grid = buildTestGrid();
  const reversedGrid = buildTestGrid(new Int32Array([1, 3, 2]));
  const projection = new ProjectionHelper(
    PROJECTION_TYPES.NEARSIDE_PERSPECTIVE,
    { lat: 0, lon: 0 }
  );
  const batch = buildTriangularGeometryBatch(grid, 0, 10, projection);

  expect(reversedGrid.vertices).toEqual(grid.vertices);
  expect(getTriangularBatchCount(1, 10)).toBe(1);
  expect(Array.from(batch.positionValues)).toHaveLength(grid.vertices.length);
  for (let index = 0; index < grid.vertices.length; index++) {
    expect(batch.positionValues[index]).toBeCloseTo(grid.vertices[index]);
  }
  expect(batch.latLonValues).toEqual(new Float32Array([0, 0, 0, 90, 90, 0]));
});

it("builds data-only batches for timestep updates", () => {
  const batch = buildTriangularDataBatch(new Float32Array([4, 8, 12]), 1, 2);

  expect(batch.batchIndex).toBe(1);
  expect(batch.dataValues).toEqual(new Float32Array([12, 12, 12]));
});

it("builds the shared hover index from cached triangle centroids", () => {
  const hoverIndexData = buildTriangularHoverIndexData(
    buildTestGrid(),
    new Float32Array([7])
  );
  const emptyIndexData = buildSerializedGeoSampleIndexData(
    new Float64Array(0),
    new Float64Array(0),
    new Float32Array(0)
  );

  expect(hoverIndexData.latitudes[0]).toBeCloseTo(35.264, 3);
  expect(hoverIndexData.longitudes[0]).toBeCloseTo(45);
  expect(hoverIndexData.values).toEqual(new Float32Array([7]));
  expect(emptyIndexData.latitudes).toHaveLength(0);
});

it("rejects mismatched connectivity and data", () => {
  expect(() =>
    buildTriangularGrid(new Int32Array([1, 2]), vertexX, vertexY, vertexZ)
  ).toThrow("three rows");
  expect(() =>
    buildTriangularHoverIndexData(buildTestGrid(), new Float32Array(0))
  ).toThrow("1 cells but data has 0 values");
});
