import { expect, it } from "vitest";

import { getRegularVolumeMapping } from "@/lib/volume/regularVolumeMapping.ts";
import { VOLUME_GRID_TYPES } from "@/lib/volume/volumeGrid.ts";
import {
  buildVolumeTexture,
  chooseRegularVolumeTextureDimensions,
} from "@/lib/volume/volumeTexture.ts";

it("maps descending latitude and an antimeridian-crossing regional grid", () => {
  const { sourceCells, bounds } = getRegularVolumeMapping(
    new Float32Array([21, 20]),
    new Float32Array([178, 179, -180, -179]),
    4,
    2
  );
  expect(bounds).toEqual({
    west: 177.5,
    east: 181.5,
    south: 19.5,
    north: 21.5,
  });
  expect(Array.from(sourceCells)).toEqual([4, 5, 6, 7, 0, 1, 2, 3]);
});

it("keeps descending longitude aligned with its source columns", () => {
  const { sourceCells, bounds } = getRegularVolumeMapping(
    new Float32Array([0, 1]),
    new Float32Array([-179, -180, 179, 178]),
    4,
    2
  );
  expect(bounds.east - bounds.west).toBe(4);
  expect(Array.from(sourceCells)).toEqual([3, 2, 1, 0, 7, 6, 5, 4]);
});

it("covers global longitude without extending beyond the poles", () => {
  const { sourceCells, bounds } = getRegularVolumeMapping(
    new Float32Array([-90, 0, 90]),
    new Float32Array([0, 90, 180, 270]),
    4,
    3
  );
  expect(bounds).toEqual({ west: -45, east: 315, south: -90, north: 90 });
  expect(Array.from(sourceCells)).toEqual(
    Array.from({ length: 12 }, (_, index) => index)
  );
});

it("rejects invalid axes instead of placing data on unrelated coordinates", () => {
  for (const latitudes of [
    [0, NaN],
    [0, 100],
    [0, 1, 0],
  ]) {
    expect(() =>
      getRegularVolumeMapping(
        new Float32Array(latitudes),
        new Float32Array([0, 1]),
        2,
        2
      )
    ).toThrow();
  }
});

it("uses regional resolution and respects memory and device limits", () => {
  expect(chooseRegularVolumeTextureDimensions(4, 3, 2, 2048, 1)).toEqual({
    width: 4,
    height: 3,
    depth: 2,
    byteLength: 24,
  });
  const dimensions = chooseRegularVolumeTextureDimensions(
    12000,
    3000,
    100,
    1024,
    3,
    1024 * 1024
  );
  expect(dimensions.width).toBeLessThanOrEqual(1024);
  expect(dimensions.height).toBeLessThanOrEqual(1024);
  expect(dimensions.depth).toBeLessThanOrEqual(64);
  expect(dimensions.byteLength).toBeLessThanOrEqual(1024 * 1024);
});

it("preserves vertical and horizontal data order in a regional volume", () => {
  const request = {
    grid: {
      kind: VOLUME_GRID_TYPES.REGULAR,
      latitudes: new Float32Array([21, 20]),
      longitudes: new Float32Array([178, 179]),
    },
    sourceLevelCount: 2,
    sourceCellCount: 4,
    values: [new Float32Array([0, 0, 1, 0, 0, 0, 0, 2])],
    levels: new Float32Array([0, 1000]),
    dimensions: { width: 2, height: 2, depth: 2, byteLength: 8 },
  };
  const progress: number[] = [];
  const result = buildVolumeTexture(request, (completed, total) =>
    progress.push(completed / total)
  );
  expect(result.bounds).toEqual({
    west: 177.5,
    east: 179.5,
    south: 19.5,
    north: 21.5,
  });
  expect(result.data[0]).toBeGreaterThan(0);
  expect(result.data[1]).toBe(0);
  expect(result.data[2]).toBe(0);
  expect(result.data[3]).toBe(255);
  expect(Array.from(result.data.slice(4))).toEqual([0, 0, 0, 0]);
  expect(progress.at(-1)).toBe(1);
  expect(
    progress.every(
      (value, index) => index === 0 || value >= progress[index - 1]
    )
  ).toBe(true);
  const reversed = buildVolumeTexture(
    {
      ...request,
      levels: new Float32Array([1000, 0]),
      values: [new Float32Array([0, 0, 0, 2, 0, 0, 1, 0])],
    },
    undefined
  );
  expect(reversed.data).toEqual(result.data);
});
