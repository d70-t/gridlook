import proj4 from "proj4";
import { expect, it } from "vitest";

import {
  getProjectedVolumeMapping,
  isSupportedVolumeCRS,
} from "@/lib/volume/projectedVolumeMapping.ts";
import { VOLUME_GRID_TYPES } from "@/lib/volume/volumeGrid.ts";
import { buildVolumeTexture } from "@/lib/volume/volumeTexture.ts";

const lambert =
  "+proj=lcc +lat_1=56.7 +lat_2=56.7 +lat_0=56.7 +lon_0=25 +a=6367470 +b=6367470 +units=m";
const grid = {
  kind: VOLUME_GRID_TYPES.PROJECTED,
  x: new Float32Array([-1999248, -1014248, -29248]),
  y: new Float32Array([-609541, 125459, 860459]),
  crs: lambert,
};

it("maps a regional Lambert volume to its native cells and leaves the exterior empty", () => {
  const width = 32,
    height = 24;
  const { sourceCells, bounds } = getProjectedVolumeMapping(
    grid,
    width,
    height
  );
  const transform = proj4("EPSG:4326", lambert);
  expect(sourceCells).toContain(-1);
  for (const cell of [0, 4, 8]) {
    expect(sourceCells).toContain(cell);
  }
  for (let i = 0; i < sourceCells.length; i++) {
    const lon =
      bounds.west + (((i % width) + 0.5) / width) * (bounds.east - bounds.west);
    const lat =
      bounds.south +
      ((Math.floor(i / width) + 0.5) / height) * (bounds.north - bounds.south);
    const [x, y] = transform.forward([lon, lat]);
    const column = Math.round((x - grid.x[0]) / (grid.x[1] - grid.x[0]));
    const row = Math.round((y - grid.y[0]) / (grid.y[1] - grid.y[0]));
    expect(sourceCells[i]).toBe(
      row < 0 || row >= 3 || column < 0 || column >= 3
        ? -1
        : row * 3 + column + 0
    );
  }
  const reversed = getProjectedVolumeMapping(
    { ...grid, x: grid.x.slice().reverse(), y: grid.y.slice().reverse() },
    width,
    height
  );
  expect(reversed.bounds).toEqual(bounds);
  expect(Array.from(reversed.sourceCells)).toEqual(
    Array.from(sourceCells, (cell) => (cell < 0 ? -1 : 8 - cell))
  );
});

it("reuses geographic sampling for Web Mercator and preserves descending rows", () => {
  const transform = proj4("EPSG:4326", "EPSG:3857");
  const projected = {
    kind: VOLUME_GRID_TYPES.PROJECTED,
    crs: "EPSG:3857",
    x: Float32Array.from([10, 11], (lon) => transform.forward([lon, 0])[0]),
    y: Float32Array.from([56, 55], (lat) => transform.forward([0, lat])[1]),
  };
  const { sourceCells, bounds } = getProjectedVolumeMapping(projected, 2, 2);
  expect(Array.from(sourceCells)).toEqual([2, 3, 0, 1]);
  expect(bounds.west).toBeCloseTo(9.5, 4);
  expect(bounds.north).toBeCloseTo(56.5, 4);
});

it("builds Lambert volume columns without filling cells outside the domain", () => {
  const dimensions = { width: 16, height: 12, depth: 2, byteLength: 384 };
  const result = buildVolumeTexture(
    {
      grid,
      sourceCellCount: 9,
      sourceLevelCount: 2,
      values: [new Float32Array(18).fill(1)],
      levels: new Float32Array([0, 1000]),
      dimensions,
    },
    undefined
  );
  const { sourceCells } = getProjectedVolumeMapping(
    grid,
    dimensions.width,
    dimensions.height
  );
  for (let i = 0; i < sourceCells.length; i++) {
    expect(result.data[i * 2] > 0).toBe(sourceCells[i] >= 0);
    expect(result.data[i * 2 + 1] > 0).toBe(sourceCells[i] >= 0);
  }
});

it("rejects unknown projections and invalid native axes", () => {
  for (const crs of [
    undefined,
    "invalid",
    "EPSG:4326",
    "+proj=stere +lat_0=90 +datum=WGS84",
  ]) {
    expect(isSupportedVolumeCRS(crs)).toBe(false);
  }
  for (const x of [
    new Float32Array([0]),
    new Float32Array([0, NaN]),
    new Float32Array([0, 2, 1]),
  ]) {
    expect(() => getProjectedVolumeMapping({ ...grid, x }, 4, 4)).toThrow();
  }
});
