import { expect, it } from "vitest";

import { polygonCrossings } from "@/lib/analysis/sphere.ts";

const at = (lat: number, lon: number) => ({ lat, lon });

it("v31: a square has no crossing; a bow tie crosses once, closing edge included", () => {
  expect(
    polygonCrossings([at(0, 0), at(0, 10), at(10, 10), at(10, 0)])
  ).toEqual([]);
  // 0→1 and 2→3 cross in the middle.
  expect(
    polygonCrossings([at(0, 0), at(10, 10), at(10, 0), at(0, 10)])
  ).toEqual([[0, 2]]);
  // The closing edge (3→0) crosses 1→2.
  expect(
    polygonCrossings([at(0, 0), at(0, 10), at(10, 0), at(10, 10)])
  ).toEqual([[1, 3]]);
  // Three points cannot cross.
  expect(polygonCrossings([at(0, 0), at(0, 10), at(10, 0)])).toEqual([]);
});

it("v31: edges are great-circle arcs (as the reducer reads them), across the dateline", () => {
  // A thin quadrilateral across 180°: no crossing.
  expect(
    polygonCrossings([at(-5, 175), at(-5, -175), at(5, -175), at(5, 175)])
  ).toEqual([]);
  // A bow tie whose crossing is on the dateline.
  expect(
    polygonCrossings([at(0, 170), at(10, -170), at(10, 170), at(0, -170)])
  ).toEqual([[0, 2]]);
});
