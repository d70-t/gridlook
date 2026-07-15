import { expect, it } from "vitest";

import { reconcileCoordinateArrays } from "@/lib/data/irregularGridHelpers.ts";
import {
  buildIrregularBatch,
  buildIrregularGridData,
  buildIrregularHoverIndexData,
  getIrregularBatchCount,
} from "@/lib/grids/irregularCalculations.ts";
import {
  PROJECTION_TYPES,
  ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";

function buildTestGrid() {
  return buildIrregularGridData(
    new Float32Array([0, 0, 0]),
    new Float32Array([0, 1, 2]),
    [3],
    [3],
    new Float32Array([10, 20, 30]),
    new ProjectionHelper(PROJECTION_TYPES.NEARSIDE_PERSPECTIVE, {
      lat: 0,
      lon: 0,
    })
  );
}

it("projects and batches irregular point data", () => {
  const grid = buildTestGrid();
  const firstBatch = buildIrregularBatch(grid, 0, 2);
  const secondBatch = buildIrregularBatch(grid, 1, 2);

  expect(getIrregularBatchCount(grid, 2)).toBe(2);
  expect(firstBatch.positionValues).toHaveLength(6);
  expect(firstBatch.latLonValues).toEqual(new Float32Array([0, 0, 0, 1]));
  expect(firstBatch.dataValues).toEqual(new Float32Array([10, 20]));
  expect(secondBatch.dataValues).toEqual(new Float32Array([30]));
  expect(grid.estimatedSpacing).toBeGreaterThan(0);
});

it("builds the shared serialized hover index from reconciled coordinates", () => {
  const hoverIndexData = buildIrregularHoverIndexData(buildTestGrid());

  expect(hoverIndexData.latitudes).toEqual(new Float64Array([0, 0, 0]));
  expect(hoverIndexData.longitudes).toEqual(new Float64Array([0, 1, 2]));
  expect(hoverIndexData.values).toEqual(new Float32Array([10, 20, 30]));
});

it("expands separate coordinate axes without duplicating worker logic", () => {
  const coordinates = reconcileCoordinateArrays(
    new Float32Array([10, 20]),
    new Float32Array([1, 2, 3]),
    [2],
    [3],
    6
  );

  expect(coordinates.latitudes).toEqual(
    new Float32Array([10, 10, 10, 20, 20, 20])
  );
  expect(coordinates.longitudes).toEqual(new Float32Array([1, 2, 3, 1, 2, 3]));
});
