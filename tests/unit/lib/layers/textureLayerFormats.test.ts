import * as THREE from "three";
import { expect, it } from "vitest";

import {
  configureEquirectangularTexture,
  getLongitudeSpan,
  normalizeGeoTiffBounds,
  TextureLayerSampling,
} from "@/lib/layers/equirectLayer.ts";
import {
  isGeoTiffLayerSource,
  isSupportedTextureLayerFile,
} from "@/lib/layers/textureLayerFormats.ts";

it("accepts image files and GeoTIFF files as texture layers", () => {
  expect(
    isSupportedTextureLayerFile(
      new File([], "layer.png", { type: "image/png" })
    )
  ).toBe(true);
  expect(
    isSupportedTextureLayerFile(new File([], "regional.tif", { type: "" }))
  ).toBe(true);
  expect(
    isSupportedTextureLayerFile(new File([], "regional.geotiff", { type: "" }))
  ).toBe(true);
  expect(
    isSupportedTextureLayerFile(new File([], "metadata.json", { type: "" }))
  ).toBe(false);
});

it("detects GeoTIFF sources from MIME type or extension", () => {
  expect(isGeoTiffLayerSource(new Blob([], { type: "image/tiff" }))).toBe(true);
  expect(isGeoTiffLayerSource(new Blob(), "regional.tiff")).toBe(true);
  expect(isGeoTiffLayerSource(new Blob([], { type: "image/png" }))).toBe(false);
});

it("normalizes longitude-latitude GeoTIFF bounds", () => {
  expect(normalizeGeoTiffBounds([-123, 38, -119, 42])).toEqual({
    west: -123,
    south: 38,
    east: -119,
    north: 42,
  });
  expect(
    getLongitudeSpan({ west: 170, south: -10, east: -170, north: 10 })
  ).toBe(20);
});

it("rejects non-geographic GeoTIFF bounds", () => {
  expect(() =>
    normalizeGeoTiffBounds([500000, 4500000, 510000, 4510000])
  ).toThrow("longitude/latitude");
});

it("marks image layer textures as display RGB", () => {
  const texture = configureEquirectangularTexture(new THREE.Texture());

  expect(texture.colorSpace).toBe(THREE.SRGBColorSpace);
});

it("can configure GeoTIFF textures with pixel-preserving sampling", () => {
  const texture = configureEquirectangularTexture(
    new THREE.Texture(),
    { west: -10, south: -5, east: 10, north: 5 },
    TextureLayerSampling.PIXELATED
  );

  expect(texture.minFilter).toBe(THREE.NearestFilter);
  expect(texture.magFilter).toBe(THREE.NearestFilter);
  expect(texture.anisotropy).toBe(1);
});
