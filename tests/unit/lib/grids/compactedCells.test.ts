import { expect, it } from "vitest";

import {
  createCompactedCells,
  createRangeCells,
  decodeZuniq,
  encodeZuniq,
} from "@/lib/grids/compactedCells.ts";

// zuniq ids of the level-7 cells 10974 and 10975, as written by healpix-geo
const Z10974 = 386130891488886784n;
const Z10975 = 386166075860975616n;

it("decodes the zuniq ids of healpix-geo", () => {
  expect(decodeZuniq(Z10974)).toEqual({ level: 7, ipix: 10974n });
  expect(decodeZuniq(Z10975)).toEqual({ level: 7, ipix: 10975n });
  expect(decodeZuniq(encodeZuniq(29, 12n * 4n ** 29n - 1n))).toEqual({
    level: 29,
    ipix: 12n * 4n ** 29n - 1n,
  });
  expect(decodeZuniq(encodeZuniq(0, 11n))).toEqual({ level: 0, ipix: 11n });
  expect(() => decodeZuniq(0n)).toThrow();
});

it("places the cells of the parents one after the other", async () => {
  const cells = createCompactedCells(9, BigUint64Array.of(Z10974, Z10975));
  const size = 16; // 4 ** (9 - 7)
  expect(cells.length).toBe(2 * size);
  expect(await cells.isAscending()).toBe(true);
  expect(await cells.lowerBound(0)).toBe(0);
  expect(await cells.lowerBound(10974 * size)).toBe(0);
  expect(await cells.lowerBound(10974 * size + 5)).toBe(5);
  // the gap between the parents is not stored
  expect(await cells.lowerBound(10975 * size)).toBe(size);
  expect(await cells.lowerBound(10975 * size + 3)).toBe(size + 3);
  expect(await cells.lowerBound(10976 * size)).toBe(2 * size);
  expect(await cells.lowerBound(1e12)).toBe(2 * size);
  const all = await cells.slice(0, 2 * size);
  expect(all[0]).toBe(10974 * size);
  expect(all[size - 1]).toBe(10975 * size - 1);
  expect(all[size]).toBe(10975 * size);
  expect(all).toHaveLength(2 * size);
  expect(await cells.slice(size - 2, size + 2)).toEqual([
    10975 * size - 2,
    10975 * size - 1,
    10975 * size,
    10975 * size + 1,
  ]);
  expect(await cells.slice(3, 3)).toEqual([]);
});

it("keeps a parent apart from its far neighbour but merges adjacent ones", async () => {
  const cells = createCompactedCells(
    8,
    [10974n, 10975n, 20000n].map((cell) => encodeZuniq(7, cell))
  );
  expect(cells.length).toBe(3 * 4);
  expect(await cells.lowerBound(10975 * 4 + 4)).toBe(2 * 4);
  expect(await cells.lowerBound(20000 * 4 + 1)).toBe(2 * 4 + 1);
});

it("takes cells of the data level and mixed levels", async () => {
  const cells = createCompactedCells(7, [
    encodeZuniq(7, 3n),
    encodeZuniq(6, 1n), // nested ids 4..7
    encodeZuniq(5, 1n), // nested ids 16..31
  ]);
  expect(cells.length).toBe(1 + 4 + 16);
  expect(await cells.slice(0, 21)).toEqual([
    3, 4, 5, 6, 7, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30,
    31,
  ]);
  expect(await cells.lowerBound(8)).toBe(5);
});

it("rejects ids that are not ascending, overlap, or are finer than the data", () => {
  expect(() =>
    createCompactedCells(8, [Z10975, Z10974] as unknown as bigint[])
  ).toThrow("ascending");
  expect(() =>
    createCompactedCells(8, [encodeZuniq(6, 1n), encodeZuniq(7, 5n)])
  ).toThrow("ascending");
  expect(() => createCompactedCells(5, [Z10974])).toThrow("finer");
});

it("accepts plain numbers when they are exact", async () => {
  const cells = createCompactedCells(7, [Number(encodeZuniq(2, 1n))]);
  expect(cells.length).toBe(4 ** 5);
  expect(await cells.lowerBound(4 ** 5)).toBe(0);
});

it("reads ranges of level-29 nested ids", async () => {
  const shift = 4n ** 22n; // cells of level 29 in a level-7 cell
  const cells = createRangeCells(7, [
    10974n * shift,
    10976n * shift,
    20000n * shift,
    20001n * shift,
  ]);
  expect(cells.length).toBe(3);
  expect(await cells.slice(0, 3)).toEqual([10974, 10975, 20000]);
  expect(await cells.lowerBound(10975)).toBe(1);
  expect(await cells.lowerBound(10976)).toBe(2);
  expect(await cells.lowerBound(20001)).toBe(3);
});

it("rejects ranges with a start but no end", () => {
  const shift = 4n ** 22n;
  expect(() =>
    createRangeCells(7, [10974n * shift, 10976n * shift, 20000n * shift])
  ).toThrow("without its end");
});
