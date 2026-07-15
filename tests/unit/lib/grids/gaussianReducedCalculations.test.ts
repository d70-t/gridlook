import { expect, it } from "vitest";

import {
  buildGaussianReducedBatch,
  buildGaussianReducedHoverIndexData,
  buildGaussianReducedRows,
  getGaussianReducedBatchCount,
} from "@/lib/grids/gaussianReducedCalculations.ts";
import { createSerializedGeoSampleIndex } from "@/lib/grids/serializedGeoSampleIndex.ts";
import {
  PROJECTION_TYPES,
  ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";

function buildTestGrid() {
  return buildGaussianReducedRows(
    new Float64Array([10, 10, 0, 0]),
    new Float64Array([0, 180, 0, 180]),
    new Float32Array([1, 2, 3, 4])
  );
}

it("builds transferable Gaussian reduced geometry batches", () => {
  const grid = buildTestGrid();
  const projection = new ProjectionHelper(
    PROJECTION_TYPES.NEARSIDE_PERSPECTIVE,
    { lat: 0, lon: 0 }
  );
  const batch = buildGaussianReducedBatch(grid, 0, 64, 0.002, projection);

  expect(getGaussianReducedBatchCount(grid, 64)).toBe(1);
  expect(batch.positionValues).toHaveLength(24);
  expect(batch.latLonValues).toHaveLength(16);
  expect(batch.dataValues).toEqual(new Float32Array([1, 1, 1, 1, 2, 2, 2, 2]));
  expect(batch.indices).toEqual(
    new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7])
  );
});

it("reconstructs the worker-built hover index without rebuilding it", () => {
  const hoverIndexData = buildGaussianReducedHoverIndexData(buildTestGrid());
  const index = createSerializedGeoSampleIndex(hoverIndexData);

  expect(hoverIndexData.latitudes).toEqual(new Float64Array([5, 5]));
  expect(index.findNearest(5, -80)).toEqual({ lat: 5, lon: -90, value: 1 });
  expect(index.findNearest(5, 80)).toEqual({ lat: 5, lon: 90, value: 2 });
});
