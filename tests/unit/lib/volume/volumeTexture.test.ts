import { describe, expect, it } from "vitest";

import {
  buildVolumeTexture,
  chooseVolumeTextureDimensions,
  HIGH_RES_VOLUME_TEXTURE_BUDGET_BYTES,
} from "@/lib/volume/volumeTexture.ts";

describe("chooseVolumeTextureDimensions", () => {
  it("matches the nside 64 default", () => {
    expect(chooseVolumeTextureDimensions(64, 90, 2048)).toEqual({
      width: 512,
      height: 256,
      depth: 64,
      byteLength: 8 * 1024 * 1024,
    });
  });

  it("stays within both device and memory limits", () => {
    const dimensions = chooseVolumeTextureDimensions(
      512,
      120,
      1536,
      1,
      16 * 1024 * 1024
    );
    expect(dimensions.width).toBeLessThanOrEqual(1536);
    expect(dimensions.height).toBeLessThanOrEqual(1536);
    expect(dimensions.depth).toBeLessThanOrEqual(64);
    expect(dimensions.byteLength).toBeLessThanOrEqual(16 * 1024 * 1024);
  });

  it("allows a fine two-channel HEALPix grid to reach 2048 by 1024", () => {
    expect(
      chooseVolumeTextureDimensions(
        256,
        90,
        2048,
        2,
        HIGH_RES_VOLUME_TEXTURE_BUDGET_BYTES
      )
    ).toEqual({
      width: 2048,
      height: 1024,
      depth: 64,
      byteLength: 256 * 1024 * 1024,
    });
  });

  it("still respects a device's smaller 3D texture limit", () => {
    const dimensions = chooseVolumeTextureDimensions(
      256,
      90,
      1024,
      2,
      HIGH_RES_VOLUME_TEXTURE_BUDGET_BYTES
    );
    expect(dimensions.width).toBe(1024);
    expect(dimensions.height).toBe(512);
  });
});

describe("high-resolution volume texture dimensions", () => {
  it("uses 4096 by 2048 with half the depth for zoom 9 class grids", () => {
    const dimensions = chooseVolumeTextureDimensions(
      512,
      90,
      4096,
      2,
      HIGH_RES_VOLUME_TEXTURE_BUDGET_BYTES
    );
    expect(dimensions.width).toBe(4096);
    expect(dimensions.height).toBe(2048);
    expect(dimensions.depth).toBe(32);
    expect(dimensions.byteLength).toBe(512 * 1024 * 1024);
  });

  it("keeps full depth when the device is limited to 2048", () => {
    const dimensions = chooseVolumeTextureDimensions(
      512,
      90,
      2048,
      2,
      HIGH_RES_VOLUME_TEXTURE_BUDGET_BYTES
    );
    expect(dimensions.width).toBe(2048);
    expect(dimensions.height).toBe(1024);
    expect(dimensions.depth).toBe(64);
  });

  it("keeps four-channel volumes within budget using the standard tier", () => {
    const dimensions = chooseVolumeTextureDimensions(
      512,
      90,
      4096,
      4,
      HIGH_RES_VOLUME_TEXTURE_BUDGET_BYTES
    );
    expect(dimensions.width).toBe(2048);
    expect(dimensions.height).toBe(1024);
    expect(dimensions.depth).toBe(64);
    expect(dimensions.byteLength).toBe(512 * 1024 * 1024);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("buildVolumeTexture", () => {
  it("creates an 8-bit normalized density texture", () => {
    const sourceLevelCount = 2;
    const sourceCellCount = 12;
    const values = new Float32Array(sourceLevelCount * sourceCellCount);
    values.fill(1, 0, sourceCellCount);
    values.fill(3, sourceCellCount);
    const progress: Array<[number, number]> = [];
    const result = buildVolumeTexture(
      {
        nside: 1,
        sourceLevelCount,
        sourceCellCount,
        values: [values],
        dimensions: { width: 4, height: 2, depth: 2, byteLength: 32 },
      },
      (completed, total) => progress.push([completed, total])
    );

    expect(result.data).toHaveLength(16);
    expect(result.data).toBeInstanceOf(Uint8Array);
    expect(Math.min(...result.data)).toBeGreaterThan(0);
    expect(Math.max(...result.data)).toBe(255);
    const finalProgress = progress.at(-1);
    expect(finalProgress?.[0]).toBe(finalProgress?.[1]);
  });

  it("stores complete vertical columns contiguously", () => {
    const sourceCellCount = 12;
    const values = new Float32Array(sourceCellCount * 2);
    values.fill(1, 0, sourceCellCount);
    values.fill(3, sourceCellCount);

    const result = buildVolumeTexture({
      nside: 1,
      sourceLevelCount: 2,
      sourceCellCount,
      values: [values],
      dimensions: { width: 2, height: 1, depth: 2, byteLength: 4 },
    });

    expect(result.data[0]).toBeGreaterThan(result.data[1]);
    expect(result.data[0]).toBe(result.data[2]);
    expect(result.data[1]).toBe(result.data[3]);
  });

  it("uses geometric heights when supplied", () => {
    const sourceCellCount = 12;
    const values = new Float32Array(sourceCellCount * 2);
    const heights = new Float32Array(sourceCellCount * 2);
    values.fill(1, 0, sourceCellCount);
    values.fill(2, sourceCellCount);
    heights.fill(10_000, 0, sourceCellCount);
    heights.fill(0, sourceCellCount);
    const progress: Array<[number, number]> = [];

    const result = buildVolumeTexture(
      {
        nside: 1,
        sourceLevelCount: 2,
        sourceCellCount,
        values: [values],
        heights,
        dimensions: { width: 2, height: 1, depth: 3, byteLength: 12 },
      },
      (completed, total) => progress.push([completed, total])
    );

    expect(result.heightRange).toEqual({ min: 0, max: 10_000 });
    expect(result.data).toHaveLength(6);
    expect(progress).toContainEqual([sourceCellCount, 32]);
    expect(progress).toContainEqual([sourceCellCount * 2, 32]);
  });

  it("packs two fields into an RG8 texture", () => {
    const sourceCellCount = 12;
    const water = new Float32Array(sourceCellCount * 2).fill(1);
    const ice = new Float32Array(sourceCellCount * 2).fill(2);
    const result = buildVolumeTexture({
      nside: 1,
      sourceLevelCount: 2,
      sourceCellCount,
      values: [water, ice],
      dimensions: { width: 2, height: 1, depth: 2, byteLength: 16 },
    });

    expect(result.channelCount).toBe(2);
    expect(result.storageChannelCount).toBe(2);
    expect(result.data).toHaveLength(8);
    expect(result.data.every((value) => value === 255)).toBe(true);
  });

  it("rejects coordinates that do not match the source grid", () => {
    expect(() =>
      buildVolumeTexture({
        nside: 1,
        cellCoordinates: new Int32Array([0]),
        sourceLevelCount: 1,
        sourceCellCount: 2,
        values: [new Float32Array([1, 2])],
        dimensions: { width: 1, height: 1, depth: 1, byteLength: 1 },
      })
    ).toThrow("Volume coordinates do not match the source grid");
  });

  it("keeps a field unchanged when another field is packed beside it", () => {
    const sourceCellCount = 12;
    const sourceLevelCount = 3;
    const water = new Float32Array(sourceCellCount * sourceLevelCount);
    const ice = new Float32Array(sourceCellCount * sourceLevelCount);
    const heights = new Float32Array(sourceCellCount * sourceLevelCount);
    water.fill(1, 0, sourceCellCount * 2);
    ice.fill(1, sourceCellCount * 2);
    heights.fill(0, 0, sourceCellCount);
    heights.fill(5_000, sourceCellCount, sourceCellCount * 2);
    heights.fill(10_000, sourceCellCount * 2);
    const dimensions = { width: 2, height: 1, depth: 3, byteLength: 12 };

    const waterOnly = buildVolumeTexture({
      nside: 1,
      sourceLevelCount,
      sourceCellCount,
      values: [water],
      heights,
      dimensions,
    });
    const waterAndIce = buildVolumeTexture({
      nside: 1,
      sourceLevelCount,
      sourceCellCount,
      values: [water, ice],
      heights,
      dimensions,
    });

    expect(waterOnly.heightRange).toEqual({ min: 0, max: 5_000 });
    expect(waterAndIce.heightRange).toEqual(waterOnly.heightRange);
    const packedWater = Array.from(
      { length: waterOnly.data.length },
      (_, index) => waterAndIce.data[index * 2]
    );
    expect(packedWater).toEqual(Array.from(waterOnly.data));
  });
});
