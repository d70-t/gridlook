import { expect, it } from "vitest";

import {
  buildHealpixTexture,
  getHealpixFaceDataRect,
  getHealpixFaceRange,
  getHealpixTextureIndex,
} from "@/lib/grids/healpixCalculations.ts";
import { buildHistogramSummary } from "@/utils/histogram.ts";

it("splits a level-13 grid into contiguous 256 MiB float32 faces", () => {
  const nside = 8192;
  for (let face = 0; face < 12; face++) {
    const range = getHealpixFaceRange(face, nside);
    expect(range.start).toBe(face * nside ** 2);
    expect(range.end).toBe((face + 1) * nside ** 2);
    expect((range.end - range.start) * 4).toBe(256 * 1024 ** 2);
  }
});

it("reads shuffled sparse cells from the correct face and skips empty faces", () => {
  const cells = [191, 4, 0];
  expect(getHealpixFaceRange(0, 4, cells)).toEqual({
    start: 1,
    end: 3,
    cells: [4, 0],
  });
  expect(getHealpixFaceRange(1, 4, cells)).toEqual({
    start: 0,
    end: 0,
    cells: [],
  });
  expect(getHealpixFaceRange(11, 4, cells)).toEqual({
    start: 0,
    end: 1,
    cells: [191],
  });
});

it("derives the same regional extent before and after loading face values", () => {
  const cells = [191, 4, 0];
  const values = new Float32Array([3, 2, 1]);
  expect(getHealpixFaceDataRect(0, 4, cells)).toEqual({
    u: 0,
    v: 0,
    width: 0.75,
    height: 0.25,
  });
  expect(getHealpixFaceDataRect(1, 4, cells)).toBeNull();
  for (const face of [0, 11]) {
    expect(getHealpixFaceDataRect(face, 4, cells)).toEqual(
      buildHealpixTexture(values, face, 4, cells).dataRect
    );
  }
});

it("uses texture storage for exact nested-pixel hover values", () => {
  const values = Float32Array.from({ length: 16 }, (_, pixel) => pixel);
  const texture = buildHealpixTexture(values, 11, 4).dataValues;
  expect([...texture]).toEqual([
    0, 1, 4, 5, 2, 3, 6, 7, 8, 9, 12, 13, 10, 11, 14, 15,
  ]);
  for (let pixel = 0; pixel < 16; pixel++) {
    expect(texture[getHealpixTextureIndex(pixel, 4)]).toBe(pixel);
  }
  expect(getHealpixTextureIndex(2 ** 24, 8192)).toBe(4096);
  expect(getHealpixTextureIndex(8192 ** 2 - 1, 8192)).toBe(8192 ** 2 - 1);
});

it("builds histograms without copying values and preserves invalid-value handling", () => {
  const values = new Float32Array([NaN, Infinity, -999, -888, -1, 0, 1, 2, 3]);
  expect([...buildHistogramSummary(values, 0, 2, 2, -999, -888).bins]).toEqual([
    2, 3,
  ]);
  expect([...buildHistogramSummary([5, NaN, 5], 5, 5, 2).bins]).toEqual([2, 0]);
  expect([...buildHistogramSummary([NaN], NaN, NaN, 2).bins]).toEqual([0, 0]);
  expect(values[0]).toBeNaN();
  expect(values[2]).toBe(-999);
});
