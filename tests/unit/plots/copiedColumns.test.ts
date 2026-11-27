import { expect, it } from "vitest";

import { repeatedColumns } from "@/lib/analysis/operations.ts";

const boundsOf = (lons: number[], half: number) =>
  Float64Array.from(lons.flatMap((x) => [x - half, x + half]));

it("review of interim45: copied columns offset from the ends are repeats", () => {
  // Eight 45° cells, 315° copied at −45° and 0° at 360°.
  const lons = [-45, 0, 45, 90, 135, 180, 225, 270, 315, 360];
  expect([...repeatedColumns({ values: lons })].sort((a, b) => a - b)).toEqual([
    0, 9,
  ]);
  const bounded = lons.slice();
  expect(
    [
      ...repeatedColumns({ values: bounded, bounds: boundsOf(bounded, 22.5) }),
    ].sort((a, b) => a - b)
  ).toEqual([0, 9]);
  // Two columns copied each side.
  const two = [-90, -45, 0, 45, 90, 135, 180, 225, 270, 315, 360, 405];
  expect([...repeatedColumns({ values: two })].sort((a, b) => a - b)).toEqual([
    0, 1, 10, 11,
  ]);
});

it("review of interim45: distinct cells at the ends stay", () => {
  // A plain global axis, and one ending in its own cell [315°, 360°].
  expect(
    repeatedColumns({ values: [0, 45, 90, 135, 180, 225, 270, 315] }).size
  ).toBe(0);
  const lons = [22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5, 360];
  const bounds = Float64Array.from([
    ...lons.slice(0, 8).flatMap((x) => [x - 22.5, x + 22.5]),
    315,
    360,
  ]);
  expect(repeatedColumns({ values: lons, bounds }).size).toBe(0);
  // Columns 0.0000004° apart are two cells; 360.0000004° copies the second.
  expect(
    repeatedColumns({ values: [0, 0.0000004, 0.0000008, 360.0000004] }).size
  ).toBe(1);
  // The same centre with other bounds is another cell.
  const other = [-45, 0, 45, 90, 135, 180, 225, 270, 315];
  const b = boundsOf(other, 22.5);
  b[0] = -60;
  expect(repeatedColumns({ values: other, bounds: b }).size).toBe(0);
});
