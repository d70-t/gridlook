import { expect, it } from "vitest";

import { axisSides, containingPeriodic } from "@/lib/analysis/axisLocate.ts";

it.each([
  ["a whole turn", [0], [-180, 180], [[-180, 180]]],
  [
    "a cell past half a turn",
    [0, 100],
    [-200, 50, 50, 160],
    [
      [-200, 50],
      [50, 160],
    ],
  ],
  [
    "the same cell from its other end",
    [0, 100],
    [160, 50, 50, 160],
    [
      [-200, 50],
      [50, 160],
    ],
  ],
  ["sides about the seam", [0], [290, 30], [[-70, 30]]],
  [
    "descending hemispheres",
    [90, -90],
    [180, 0, 0, -180],
    [
      [0, 180],
      [-180, 0],
    ],
  ],
])(
  "keeps a periodic cell's interval around its centre: %s",
  (_, centres, bounds, cells) => {
    const sides = axisSides(centres, bounds, 360);
    expect(cells.map((_, k) => [sides.low[k], sides.high[k]])).toEqual(cells);
  }
);

it("finds every longitude in a cell wider than half a turn", () => {
  const sides = axisSides([0, 100], [160, 50, 50, 160], 360);
  expect(
    [-159, -70, 0, 60, 130, 170].map((v) => containingPeriodic(sides, v))
  ).toEqual([0, 0, 0, 1, 1, 0]);
});
