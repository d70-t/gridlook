import { expect, it } from "vitest";

import {
  cellsNear,
  regionContains,
  REGION_KINDS,
  type TRegion,
} from "@/lib/analysis/regionCover.ts";
import { preparePolygon } from "@/lib/analysis/sphere.ts";

const polygon = (vertices: [number, number][]): TRegion => ({
  kind: REGION_KINDS.POLYGON,
  polygon: preparePolygon(vertices.map(([lat, lon]) => ({ lat, lon }))),
});

const range = (n: number) => Array.from({ length: n }, (_, k) => k);

/** The cells inside, as row,column keys: tested near the region only. */
function near(region: TRegion, lats: number[], lons: number[]) {
  let tests = 0;
  const found: string[] = [];
  for (const [i, j] of cellsNear(
    region,
    lats,
    lons,
    range(lats.length),
    range(lons.length)
  )) {
    tests++;
    if (regionContains(region, lats[i], lons[j])) {
      found.push(`${i},${j}`);
    }
  }
  return { found: found.sort(), tests };
}

function everyCell(region: TRegion, lats: number[], lons: number[]) {
  const found: string[] = [];
  for (const i of range(lats.length)) {
    for (const j of range(lons.length)) {
      if (regionContains(region, lats[i], lons[j])) {
        found.push(`${i},${j}`);
      }
    }
  }
  return found.sort();
}

it("independent review of interim45: the cells near a region are those an exhaustive test finds", () => {
  let seed = 7;
  const random = () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0;
    return seed / 2 ** 32;
  };
  // Grids of either order, across the antimeridian, and near a pole.
  const grids = [
    {
      lats: range(40).map((k) => -60 + 3 * k),
      lons: range(60).map((k) => 6 * k),
    },
    {
      lats: range(30).map((k) => 89 - 0.5 * k),
      lons: range(50).map((k) => -180 + 7.2 * k),
    },
    {
      lats: range(25).map((k) => -10 + k),
      lons: range(40).map((k) => 160 + k),
    },
  ];
  for (const { lats, lons } of grids) {
    for (let n = 0; n < 20; n++) {
      const lat = lats[Math.floor(random() * lats.length)];
      const lon = lons[Math.floor(random() * lons.length)];
      const size = 1 + 30 * random();
      const corners = range(3 + Math.floor(4 * random())).map((k, _, all) => {
        const angle = (2 * Math.PI * k) / all.length;
        const r = size * (0.4 + 0.6 * random());
        return [
          Math.max(-89.9, Math.min(89.9, lat + r * Math.sin(angle))),
          lon + r * Math.cos(angle),
        ] as [number, number];
      });
      const region = polygon(corners);
      expect(near(region, lats, lons).found).toEqual(
        everyCell(region, lats, lons)
      );
    }
  }
});

it("independent review of interim45: a sliver over 3,000 × 4,000 cells is tested near its edges only", () => {
  const lats = range(3000).map((k) => -15 + 0.01 * k);
  const lons = range(4000).map((k) => -20 + 0.01 * k);
  // Two millionths of a degree wide, from (0°, 0°) to (1°, 1°).
  const region = polygon([
    [0, 0],
    [1, 1 - 2e-6],
    [1, 1],
    [0, 2e-6],
  ]);
  const { found, tests } = near(region, lats, lons);
  // Exhaustively 12 million tests were made before (24 million per plan).
  expect(tests).toBeLessThan(100_000);
  expect(found.length).toBeLessThan(400);
});
