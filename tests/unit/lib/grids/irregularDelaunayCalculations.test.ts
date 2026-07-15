import { expect, it } from "vitest";

import {
  buildIrregularDelaunayDataBatch,
  buildIrregularDelaunayGeometryBatch,
  buildIrregularDelaunayGrid,
  buildIrregularDelaunayHoverIndexData,
  computeTriangleAverage,
  getIrregularDelaunayBatchCount,
} from "@/lib/grids/irregularDelaunayCalculations.ts";

function buildTestGrid() {
  return buildIrregularDelaunayGrid(
    new Float32Array([0, 0, 1, 1]),
    new Float32Array([0, 1, 1, 0]),
    [4],
    [4],
    4
  );
}

it("triangulates and builds transferable Delaunay geometry batches", () => {
  const grid = buildTestGrid();
  const data = new Float32Array([1, 2, 3, 4]);
  const batch = buildIrregularDelaunayGeometryBatch(grid, data, 0, 10);

  expect(grid.triangleIndices).toHaveLength(6);
  expect(getIrregularDelaunayBatchCount(grid, 10)).toBe(1);
  expect(batch.positionValues).toHaveLength(18);
  expect(batch.latLonValues).toHaveLength(12);
  expect(batch.dataValues).toHaveLength(6);
  for (let triangleOffset = 0; triangleOffset < 6; triangleOffset += 3) {
    expect(batch.dataValues[triangleOffset]).toBe(
      batch.dataValues[triangleOffset + 1]
    );
    expect(batch.dataValues[triangleOffset]).toBe(
      batch.dataValues[triangleOffset + 2]
    );
  }
});

it("builds data-only batches when cached geometry can be reused", () => {
  const grid = buildTestGrid();
  const batch = buildIrregularDelaunayDataBatch(
    grid,
    new Float32Array([10, 20, 30, 40]),
    0,
    10
  );

  expect(batch.dataValues).toHaveLength(6);
  expect(batch.dataValues[0]).toBe(batch.dataValues[1]);
  expect(batch.dataValues[0]).toBe(batch.dataValues[2]);
  expect(batch.dataValues[3]).toBe(batch.dataValues[4]);
  expect(batch.dataValues[3]).toBe(batch.dataValues[5]);
});

it("ignores invalid vertices and builds hover data from shared helpers", () => {
  expect(computeTriangleAverage(NaN, 3, 9)).toBe(6);
  expect(computeTriangleAverage(NaN, Infinity, -Infinity)).toBeNaN();

  const hoverIndexData = buildIrregularDelaunayHoverIndexData(
    buildTestGrid(),
    new Float32Array([1, 2, 3, 4])
  );
  expect(hoverIndexData.latitudes).toEqual(new Float64Array([0, 0, 1, 1]));
  expect(hoverIndexData.longitudes).toEqual(new Float64Array([0, 1, 1, 0]));
  expect(hoverIndexData.values).toEqual(new Float32Array([1, 2, 3, 4]));
});
