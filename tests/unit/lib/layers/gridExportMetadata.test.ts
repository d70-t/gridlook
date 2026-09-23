import { expect, it } from "vitest";

import { normalizeGeoTiffBounds } from "@/lib/layers/equirectLayer.ts";
import {
  getRegularLatLonGridBounds,
  isUniformlySpaced,
} from "@/lib/layers/gridExportMetadata.ts";

it("keeps MODIS Float32 cell edges within geographic image bounds", () => {
  // Actual first/second and penultimate/last coordinates from MODIS_LAI.
  const bounds = getRegularLatLonGridBounds(
    new Float32Array([
      89.9749984741211, 89.92500305175781, -89.92500305175781,
      -89.9750061035156,
    ]),
    new Float32Array([
      -179.9750061035156, -179.9250030517578, 179.9250030517578,
      179.9750061035156,
    ])
  )!;

  expect(
    normalizeGeoTiffBounds([
      bounds.west,
      bounds.south,
      bounds.east,
      bounds.north,
    ])
  ).toEqual(bounds);
  expect(bounds.west).toBe(-180);
  expect(bounds.east).toBe(180);
});

it("preserves the center of a global longitude grid starting at zero", () => {
  const bounds = getRegularLatLonGridBounds(
    new Float32Array([-45, 45]),
    Float32Array.from({ length: 7200 }, (_, index) => index * 0.05)
  )!;

  expect(bounds.east - bounds.west).toBe(360);
  expect(bounds.west).toBeCloseTo(-0.025, 5);
});

it("flags equal-area (EASE-Grid) latitude spacing as non-uniform", () => {
  // Cylindrical equal-area grids space latitude rows more widely toward the
  // poles, so mapping them onto a texture with linear row spacing would
  // distort the image. A handful of real CASM/EASE-Grid 2.0 latitude steps,
  // increasing from equator to pole.
  const latitudes = Float32Array.from([
    -55.177, -54.838, -54.502, 4.025, 4.221, 4.418, 72.372, 73.023, 73.7,
    74.405, 75.143, 75.918, 76.737, 77.61, 78.547, 79.567,
  ]);
  expect(isUniformlySpaced(latitudes)).toBe(false);
});

it("keeps a truly uniform grid usable for direct-texture export", () => {
  const latitudes = Float32Array.from(
    { length: 100 },
    (_, index) => -90 + index * (180 / 99)
  );
  expect(isUniformlySpaced(latitudes)).toBe(true);
});
