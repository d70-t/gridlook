import { expect, it } from "vitest";

import {
  buildGaussianReducedGrid,
  createGaussianReducedSampleIndex,
} from "@/lib/grids/gaussianReducedCalculations.ts";

// Stored south to north to check that rows are sorted north to south.
const latitudes = new Float64Array([-45, -45, 45, 45, 45, 45]);
const longitudes = new Float64Array([0, 180, 0, 90, 180, 270]);
const values = new Float32Array([1, 2, 3, 4, 5, 6]);

it("builds the row table north to south", () => {
  const grid = buildGaussianReducedGrid(latitudes, longitudes);

  expect(grid.rowLatitudes).toEqual(new Float64Array([45, -45]));
  expect(grid.rowPointCounts).toEqual(new Uint32Array([4, 2]));
  expect(grid.rowOffsets).toEqual(new Uint32Array([2, 0]));
});

it("finds the cell centered on each point", () => {
  const index = createGaussianReducedSampleIndex(
    buildGaussianReducedGrid(latitudes, longitudes),
    values
  );

  expect(index.findNearest(89, 44)).toEqual({ lat: 45, lon: 0, value: 3 });
  expect(index.findNearest(1, 46)).toEqual({ lat: 45, lon: 90, value: 4 });
  expect(index.findNearest(30, -46)).toEqual({ lat: 45, lon: -90, value: 6 });
  expect(index.findNearest(-1, 89)).toEqual({ lat: -45, lon: 0, value: 1 });
  expect(index.findNearest(-89, -91)).toEqual({
    lat: -45,
    lon: -180,
    value: 2,
  });
});

it("rejects rows that are not evenly spaced or not contiguous", () => {
  expect(() =>
    buildGaussianReducedGrid(
      new Float64Array([0, 0, 0]),
      new Float64Array([0, 10, 20])
    )
  ).toThrow("evenly spaced");
  expect(() =>
    buildGaussianReducedGrid(
      new Float64Array([0, 0, 10, 0]),
      new Float64Array([0, 180, 0, 0])
    )
  ).toThrow("contiguously");
});
