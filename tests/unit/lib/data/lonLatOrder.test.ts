import { expect, it } from "vitest";

import { hasTrailingLonLatDimensions } from "@/lib/data/coordinateVariables.ts";
import { transposeLastTwoDimensions } from "@/lib/data/dimensionHandling.ts";
import { expandLonMajorCells } from "@/lib/data/irregularGridHelpers.ts";

// (lon, lat) = (3, 2): value = 10 * lon index + lat index
const LON_LAT_DATA = Float32Array.from([0, 1, 10, 11, 20, 21]);

it("detects dimensions ending in (lon, lat)", () => {
  expect(
    hasTrailingLonLatDimensions(["time", "depth", "longitude", "latitude"])
  ).toBe(true);
  expect(hasTrailingLonLatDimensions(["time", "lat", "lon"])).toBe(false);
  expect(hasTrailingLonLatDimensions(["lat"])).toBe(false);
});

it("transposes (lon, lat) data to (lat, lon) rows", () => {
  expect([...transposeLastTwoDimensions(LON_LAT_DATA, [3, 2])]).toEqual([
    0, 10, 20, 1, 11, 21,
  ]);
  // leading dimensions are transposed plane by plane
  const twoSteps = Float32Array.from([...LON_LAT_DATA, ...LON_LAT_DATA]);
  expect([...transposeLastTwoDimensions(twoSteps, [2, 3, 2])]).toEqual([
    0, 10, 20, 1, 11, 21, 0, 10, 20, 1, 11, 21,
  ]);
});

it("pairs each (lon, lat) cell with its coordinates", () => {
  const { latitudes, longitudes } = expandLonMajorCells(
    Float32Array.from([-60, -50]),
    Float32Array.from([0, 90, 180])
  );
  expect([...latitudes]).toEqual([-60, -50, -60, -50, -60, -50]);
  expect([...longitudes]).toEqual([0, 0, 90, 90, 180, 180]);
});
