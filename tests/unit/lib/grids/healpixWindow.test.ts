import { Grid } from "healpix-geo";
import { expect, it } from "vitest";

import "@/utils/disposablePolyfill.ts";
import {
  healpixBlockLevel,
  healpixBlockRanges,
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
