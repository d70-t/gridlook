import { Grid } from "healpix-geo";
import { expect, it } from "vitest";

import "@/utils/disposablePolyfill.ts";
import {
  healpixBlockLevel,
  healpixBlockRanges,
  healpixNeededBlocks,
  healpixViewBlocks,
} from "@/lib/grids/healpixWindow.ts";
import { createSortedCells } from "@/lib/grids/sortedCells.ts";

const box = {
  latMin: 40,
  latMax: 41,
  lonStart: -100,
  lonSpan: 1,
  centreLat: 40.5,
  centreLon: -99.5,
};

it("covers a view with the blocks six orders above the level", () => {
  using grid = new Grid({ scheme: "nested", level: 12 });
  expect(healpixBlockLevel(12)).toBe(6);
  const blocks = healpixViewBlocks(grid, box);
  // an order-6 cell is about 0.9° wide: a 1° box touches a handful
  expect(blocks.length).toBeGreaterThanOrEqual(2);
  expect(blocks.length).toBeLessThanOrEqual(9);
  using blockGrid = new Grid({ scheme: "nested", level: 6 });
  const corners = Float64Array.of(-100, 40, -99, 41, -99.5, 40.5);
  for (const block of blockGrid.lonLatToHealpix(corners)) {
    expect(blocks).toContain(Number(block));
  }
  // the margin only ever adds blocks
  const wider = healpixViewBlocks(grid, box, 0.5);
  expect(wider.length).toBeGreaterThan(blocks.length);
  expect(blocks.every((block) => wider.includes(block))).toBe(true);
});

it("keeps the blocks nearest the view centre within the budget", () => {
  using grid = new Grid({ scheme: "nested", level: 12 });
  // the camera is over (20°N, 60°E), off the middle of the box
  const wide = {
    latMin: -60,
    latMax: 60,
    lonStart: -120,
    lonSpan: 240,
    centreLat: 20,
    centreLon: 60,
  };
  const blocks = healpixViewBlocks(grid, wide, 0.5, 16);
  expect(blocks).toHaveLength(16);
  using blockGrid = new Grid({ scheme: "nested", level: 6 });
  const below = Number(blockGrid.lonLatToHealpix(Float64Array.of(60, 20))[0]);
  expect(blocks).toContain(below);
});

it("cuts a polar view down around the camera, not around longitude 0", () => {
  using grid = new Grid({ scheme: "nested", level: 14 });
  // every longitude is in view; the camera is over 88.5°N 120°E
  const polar = {
    latMin: 86.6,
    latMax: 90,
    lonStart: -180,
    lonSpan: 360,
    centreLat: 88.5,
    centreLon: 120,
  };
  const blocks = healpixViewBlocks(grid, polar, 0.5, 192);
  expect(blocks.length).toBeLessThanOrEqual(192);
  using blockGrid = new Grid({ scheme: "nested", level: 8 });
  const below = Number(
    blockGrid.lonLatToHealpix(Float64Array.of(120, 88.5))[0]
  );
  expect(blocks).toContain(below);
});

/** What a camera `distance` globe radii from the centre sees of the globe. */
function globeCap(lat: number, lon: number, distance: number) {
  const radius = (Math.acos(1 / distance) * 180) / Math.PI;
  const overPole = lat + radius >= 90 || lat - radius <= -90;
  const halfSpan = overPole
    ? 180
    : (Math.asin(
        Math.sin((radius * Math.PI) / 180) / Math.cos((lat * Math.PI) / 180)
      ) *
        180) /
      Math.PI;
  return {
    latMin: Math.max(lat - radius, -90),
    latMax: Math.min(lat + radius, 90),
    lonStart: overPole ? -180 : lon - halfSpan,
    lonSpan: 2 * halfSpan,
    centreLat: lat,
    centreLon: lon,
  };
}

it("loads every block a view needs, wherever the camera is", () => {
  const budget = 192;
  for (const level of [9, 12, 20]) {
    using grid = new Grid({ scheme: "nested", level });
    using blockGrid = new Grid({ scheme: "nested", level: level - 6 });
    // from a hemisphere in view down to a view within the budget
    for (const distance of [26.9, 2, 1.05, 1.0005]) {
      for (let lat = -90; lat <= 90; lat += 7.5) {
        for (const lon of [-36.5647, 10, 135, -180]) {
          const view = globeCap(lat, lon, distance);
          const loaded = healpixViewBlocks(grid, view, 0.5, budget);
          const needed = healpixNeededBlocks(grid, view, budget);
          const at = `level ${level}, distance ${distance}, ${lat}°N ${lon}°E`;
          expect(loaded.length, at).toBeLessThanOrEqual(budget);
          expect(
            needed.filter((block) => !loaded.includes(block)),
            at
          ).toEqual([]);
          // and it is not empty: the block below the camera is needed
          const below = blockGrid.lonLatToHealpix(Float64Array.of(lon, lat));
          expect(needed, at).toContain(Number(below[0]));
        }
      }
    }
  }
});

it("needs every block of a view within the budget", () => {
  using grid = new Grid({ scheme: "nested", level: 12 });
  expect(healpixNeededBlocks(grid, box, 192).sort((a, b) => a - b)).toEqual(
    healpixViewBlocks(grid, box)
  );
  // also of a view that takes most of the budget: 12 blocks by 12 at 70°N
  const large = {
    latMin: 64.5,
    latMax: 75.5,
    lonStart: -16,
    lonSpan: 32,
    centreLat: 70,
    centreLon: 0,
  };
  const view = healpixViewBlocks(grid, large);
  expect(view.length).toBeGreaterThan(96);
  expect(view.length).toBeLessThanOrEqual(192);
  expect(healpixNeededBlocks(grid, large, 192).sort((a, b) => a - b)).toEqual(
    view
  );
  const loaded = healpixViewBlocks(grid, large, 0.5, 192);
  expect(loaded).toHaveLength(192);
  expect(view.filter((block) => !loaded.includes(block))).toEqual([]);
});

it("fills the budget of a view too large for it, also next to a pole", () => {
  for (const level of [9, 12, 20]) {
    using grid = new Grid({ scheme: "nested", level });
    for (const lat of [0, 51.3543, 75, 85, 89, 89.9, -89]) {
      const view = globeCap(lat, -36.5647, 26.9);
      const at = `level ${level}, ${lat}°N`;
      expect(healpixViewBlocks(grid, view, 0.5, 192), at).toHaveLength(192);
      expect(healpixNeededBlocks(grid, view, 192), at).toHaveLength(96);
    }
  }
});

it("keeps the window of a view too large for it over a move of a block", () => {
  // the camera moves east by 20 block sides in quarter sides
  for (const level of [9, 12, 20]) {
    using grid = new Grid({ scheme: "nested", level });
    const side = 58.63 / 2 ** (level - 6);
    for (const distance of [26.9, 3]) {
      for (const lat of [0, 51.3543, 75, 85, -85]) {
        let reloads = 0;
        let loaded: number[] = [];
        for (let step = 0; step <= 80; step++) {
          const lon = (step * side) / 4 / Math.cos((lat * Math.PI) / 180);
          const view = globeCap(lat, lon, distance);
          const needed = healpixNeededBlocks(grid, view, 192);
          if (needed.some((block) => !loaded.includes(block))) {
            reloads++;
            loaded = healpixViewBlocks(grid, view, 0.5, 192);
          }
        }
        // the first load, and then one about every two block sides
        // the first load, and then one about every two and a half sides
        expect(
          reloads,
          `level ${level}, distance ${distance}, ${lat}°N`
        ).toBeLessThanOrEqual(10);
      }
    }
  }
});

it("uses whole faces for levels of at most six orders", () => {
  using grid = new Grid({ scheme: "nested", level: 4 });
  expect(healpixBlockLevel(4)).toBe(0);
  expect(healpixViewBlocks(grid, box)).toHaveLength(1);
});

it("merges neighbouring blocks into contiguous cell ranges", () => {
  expect(healpixBlockRanges([3, 4, 5, 9], 4096)).toEqual([
    { start: 3 * 4096, end: 6 * 4096 },
    { start: 9 * 4096, end: 10 * 4096 },
  ]);
});

it("searches a sorted cell coordinate chunk by chunk", async () => {
  const stored = Array.from({ length: 1000 }, (_, index) => 5000 + 3 * index);
  const reads: number[] = [];
  const cells = createSortedCells(stored.length, 64, async (start, end) => {
    reads.push(start / 64);
    return BigInt64Array.from(stored.slice(start, end), BigInt);
  });
  expect(await cells.lowerBound(5000)).toBe(0);
  expect(await cells.lowerBound(5301)).toBe(101);
  expect(await cells.lowerBound(9999)).toBe(1000);
  expect(await cells.slice(100, 103)).toEqual([5300, 5303, 5306]);
  expect(await cells.isAscending()).toBe(true);
  // 16 chunks, each read at most once
  expect(new Set(reads).size).toBe(reads.length);
  expect(reads.length).toBeLessThan(16);

  const shuffled = createSortedCells(4, 2, async (start) =>
    start === 0 ? [7, 3] : [1, 2]
  );
  expect(await shuffled.isAscending()).toBe(false);
});

it("finds a coordinate out of order in the chunks a search reads", async () => {
  // four sorted runs stored as A, C, B, D: the first and last chunk look fine
  const stored = [100, 101, 300, 301, 200, 201, 400, 401];
  const cells = createSortedCells(stored.length, 2, async (start, end) =>
    stored.slice(start, end)
  );
  expect(await cells.isAscending()).toBe(true);
  await expect(cells.lowerBound(200)).rejects.toThrow(/ascending/);
  expect(await cells.isAscending()).toBe(false);
});

it("searches a coordinate with more than 2**31 cells", async () => {
  // 76 level-7 parent cells at level 20, one after the other with gaps
  const parents = Array.from({ length: 76 }, (_, index) => 10943 + 2 * index);
  const perParent = 4 ** 13;
  const chunk = 262144;
  const cells = createSortedCells(
    parents.length * perParent,
    chunk,
    async (start, end) =>
      Float64Array.from(
        { length: end - start },
        (_, offset) =>
          parents[Math.floor((start + offset) / perParent)] * perParent +
          ((start + offset) % perParent)
      )
  );
  for (const parent of [0, 40, 75]) {
    const target = parents[parent] * perParent + 12345;
    expect(await cells.lowerBound(target)).toBe(parent * perParent + 12345);
  }
});
