import { expect, it } from "vitest";

import { computeChunkLayout, formatBytes } from "@/lib/data/chunkLayout.ts";

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

it("formats bytes with binary units", () => {
  expect(formatBytes(1536)).toBe("1.50 KiB");
  expect(formatBytes(18_375_045_120)).toBe("17.11 GiB");
});
