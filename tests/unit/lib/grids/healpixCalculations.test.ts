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

it("crops a partially filled dense face to the extent of its finite values", () => {
  const nside = 8;
  const values = new Float32Array(nside * nside).fill(NaN);
  // Face-local (x, y) = (2..4, 5..6); nested pixel = spread(x) + 2 * spread(y).
  const pixelAt = (x: number, y: number) =>
    [...Array(3).keys()].reduce(
      (pixel, bit) =>
        pixel +
        (((x >> bit) & 1) << (2 * bit)) +
        (((y >> bit) & 1) << (2 * bit + 1)),
      0
    );
  for (let y = 5; y <= 6; y++) {
    for (let x = 2; x <= 4; x++) {
      values[pixelAt(x, y)] = 10 * y + x;
    }
  }
  const full = buildHealpixTexture(values, 3, nside);
  expect(full.dataRect).toEqual({ u: 0, v: 0, width: 1, height: 1 });

  const cropped = buildHealpixTexture(values, 3, nside, undefined, {
    cropDenseToData: true,
  });
  expect(cropped.dataRect).toEqual({
    u: 2 / nside,
    v: 5 / nside,
    width: 3 / nside,
    height: 2 / nside,
  });
  expect([cropped.width, cropped.height]).toEqual([3, 2]);
  expect([...cropped.dataValues]).toEqual([52, 53, 54, 62, 63, 64]);
  expect([cropped.histogramSummary.min, cropped.histogramSummary.max]).toEqual([
    full.histogramSummary.min,
    full.histogramSummary.max,
  ]);
});

it("keeps the whole face for dense faces that are full or empty", () => {
  const nside = 4;
  const filled = Float32Array.from({ length: nside * nside }, (_, i) => i);
  const empty = new Float32Array(nside * nside).fill(NaN);
  for (const values of [filled, empty]) {
    const texture = buildHealpixTexture(values, 0, nside, undefined, {
      cropDenseToData: true,
    });
    expect(texture.dataRect).toEqual({ u: 0, v: 0, width: 1, height: 1 });
    expect([texture.width, texture.height]).toEqual([nside, nside]);
  }
});

it("builds histograms without copying values and preserves invalid-value handling", () => {
  const values = new Float32Array([NaN, Infinity, -999, -888, -1, 0, 1, 2, 3]);
  expect([...buildHistogramSummary(values, 0, 2, 2, -999, -888).bins]).toEqual([
    2, 3,
  ]);
  expect([...buildHistogramSummary([5, NaN, 5], 5, 5, 2).bins]).toEqual([0, 2]);
  expect([...buildHistogramSummary([NaN], NaN, NaN, 2).bins]).toEqual([0, 0]);
  expect(values[0]).toBeNaN();
  expect(values[2]).toBe(-999);
});
