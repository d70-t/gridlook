import { expect, it } from "vitest";

import {
  computeChunkLayout,
  formatBytes,
  readChunkRanges,
} from "@/lib/data/chunkLayout.ts";

it("counts the chunks and bytes read for one step", () => {
  const layout = computeChunkLayout(
    [
      { name: "time", size: 100, isSpatial: false },
      { name: "lat", size: 180, isSpatial: true },
      { name: "lon", size: 360, isSpatial: true },
    ],
    [24, 100, 360],
    4
  );

  expect(layout.dimensions.map((d) => d.chunkCount)).toEqual([5, 2, 1]);
  expect(layout.totalChunks).toBe(10);
  expect(layout.chunkBytes).toBe(24 * 100 * 360 * 4);
  expect(layout.stepChunks).toBe(2);
  expect(layout.stepBytes).toBe(2 * 24 * 100 * 360 * 4);
  expect(layout.shownBytes).toBe(180 * 360 * 4);
});

it("treats a missing chunk size as one chunk spanning the dimension", () => {
  const layout = computeChunkLayout(
    [{ name: "cell", size: 50, isSpatial: true }],
    [null],
    8
  );

  expect(layout.dimensions[0].chunkSize).toBe(50);
  expect(layout.stepBytes).toBe(layout.shownBytes);
});

it("counts only the chunks a view window reads", () => {
  const layout = computeChunkLayout(
    [
      { name: "time", size: 100, isSpatial: false },
      {
        name: "lat",
        size: 180,
        isSpatial: true,
        ranges: [{ start: 90, end: 120 }],
      },
      {
        name: "lon",
        size: 360,
        isSpatial: true,
        // a window across the seam
        ranges: [
          { start: 350, end: 360 },
          { start: 0, end: 20 },
        ],
      },
    ],
    [24, 50, 100],
    4
  );

  expect(layout.dimensions[1].readChunks).toEqual([{ start: 1, end: 3 }]);
  expect(layout.dimensions[2].readChunks).toEqual([
    { start: 0, end: 1 },
    { start: 3, end: 4 },
  ]);
  expect(layout.dimensions.map((d) => d.overhead)).toEqual([
    24,
    100 / 30,
    160 / 30,
  ]);
  expect(layout.stepChunks).toBe(4);
  expect(layout.stepBytes).toBe(4 * 24 * 50 * 100 * 4);
  expect(layout.shownBytes).toBe(30 * 30 * 4);
  expect(layout.levelBytes).toBe(180 * 360 * 4);
});

it("merges adjacent ranges and follows strides", () => {
  expect(
    readChunkRanges(
      [
        { start: 40, end: 48 },
        { start: 0, end: 8 },
        { start: 8, end: 12 },
      ],
      10
    )
  ).toEqual([
    { start: 0, end: 2 },
    { start: 4, end: 5 },
  ]);
  // reads 0, 3, 6: the last index read, not `end`, bounds the chunks
  expect(readChunkRanges([{ start: 0, end: 9, step: 3 }], 4)).toEqual([
    { start: 0, end: 2 },
  ]);
  // a stride longer than a chunk skips chunks
  expect(readChunkRanges([{ start: 0, end: 30, step: 10 }], 4)).toEqual([
    { start: 0, end: 1 },
    { start: 2, end: 3 },
    { start: 5, end: 6 },
  ]);
  expect(readChunkRanges([{ start: 5, end: 5 }], 4)).toEqual([]);
});

it("formats bytes with binary units", () => {
  expect(formatBytes(1536)).toBe("1.50 KiB");
  expect(formatBytes(18_375_045_120)).toBe("17.11 GiB");
});
