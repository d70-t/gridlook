import { expect, it } from "vitest";

import {
  locateOnAxis,
  longitudeWeightAt,
  type TRectilinearAxis,
} from "@/lib/grids/analysisGrid.ts";

/** Two cells, [0°, 270°] and [270°, 360°], at the given centres. */
function axis(centres: number[], bounds = [0, 270, 270, 360]) {
  return {
    values: Float64Array.from(centres),
    bounds: Float64Array.from(bounds),
    periodic: true,
    longitude: true,
  } satisfies TRectilinearAxis;
}

it("independent review of interim41: a wide cell keeps its width and points wherever its centre sits", () => {
  // Values 0 and 100: the area mean is 25 for either centre.
  for (const centres of [
    [135, 315],
    [45, 315],
    [45, -45],
  ]) {
    const lon = axis(centres);
    const [a, b] = [longitudeWeightAt(lon, 0), longitudeWeightAt(lon, 1)];
    expect(a / (a + b)).toBeCloseTo(0.75, 12);
    expect((0 * a + 100 * b) / (a + b)).toBeCloseTo(25, 12);
    // 180° and 250° are in the first cell, 300° in the second.
    expect(locateOnAxis(lon, 180).index).toBe(0);
    expect(locateOnAxis(lon, 250).index).toBe(0);
    expect(locateOnAxis(lon, -110).index).toBe(0);
    expect(locateOnAxis(lon, 300).index).toBe(1);
  }
  // The same cells on −180°…180°, written across the seam.
  const shifted = axis([45, -45], [0, -90, -90, 0]);
  expect(longitudeWeightAt(shifted, 0) / (2 * Math.PI)).toBeCloseTo(0.75, 12);
  expect(locateOnAxis(shifted, 180).index).toBe(0);
});
