import { expect, it } from "vitest";

import {
  buildCurvilinearBatch,
  buildCurvilinearHoverIndexData,
  detectCurvilinearColumnPeriodicity,
  detectCurvilinearLongitudeFlip,
  type TCurvilinearGrid,
} from "@/lib/grids/curvilinearCalculations.ts";
import {
  PROJECTION_TYPES,
  ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";

function buildTestGrid(): TCurvilinearGrid {
  return {
    latitudes: new Float32Array([0, 0, 0, 1, 1, 1]),
    longitudes: new Float32Array([0, 120, 240, 0, 120, 240]),
    data: new Float32Array([1, 2, 3, 4, 5, 6]),
    nj: 2,
    ni: 3,
    shouldFlipLongitude: false,
    isPeriodicI: true,
  };
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

it("builds transferable curvilinear geometry and hover data", () => {
  const grid = buildTestGrid();
  const projection = new ProjectionHelper(
    PROJECTION_TYPES.NEARSIDE_PERSPECTIVE,
    { lat: 0, lon: 0 }
  );
  const batch = buildCurvilinearBatch(grid, 0, 30, projection);
  const hoverIndexData = buildCurvilinearHoverIndexData(grid);

  expect(batch.positionValues).toHaveLength(36);
  expect(batch.latLonValues).toHaveLength(24);
  expect(batch.dataValues).toEqual(
    new Float32Array([1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3])
  );
  expect(batch.indices).toEqual(
    new Uint32Array([0, 1, 2, 0, 2, 3, 4, 5, 6, 4, 6, 7, 8, 9, 10, 8, 10, 11])
  );
  expect(hoverIndexData.latitudes).toEqual(new Float64Array([0, 0, 0]));
  expect(hoverIndexData.values).toEqual(new Float32Array([1, 2, 3]));
});

it("mirrors cell boundaries for a non-periodic regional grid", () => {
  const grid = buildTestGrid();
  grid.longitudes = new Float32Array([0, 1, 2, 0, 1, 2]);
  grid.isPeriodicI = false;
  const projection = new ProjectionHelper(
    PROJECTION_TYPES.NEARSIDE_PERSPECTIVE,
    { lat: 0, lon: 0 }
  );

  const batch = buildCurvilinearBatch(grid, 0, 30, projection);

  expect(Array.from(batch.latLonValues.slice(0, 8))).toEqual([
    0.5, -0.5, -0.5, 0.5, 0.5, 0.5, -0.5, -0.5,
  ]);
});
