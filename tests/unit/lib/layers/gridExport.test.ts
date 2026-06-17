import { fromArrayBuffer } from "geotiff";
import * as THREE from "three";
import { expect, it } from "vitest";

import {
  createExportRenderTarget,
  createGeoTiffExportGeometry,
  encodePixelsToGeoTiffBlob,
  getAlphaCrop,
  getCroppedGeoBounds,
  getGeoBoundsFromLatLonValues,
  getGeoTiffExportSize,
} from "@/lib/layers/gridExport.ts";
import { getRegularLatLonGridBounds } from "@/lib/layers/gridExportMetadata.ts";

it("computes compact regional GeoTIFF bounds from lat/lon geometry", () => {
  const bounds = getGeoBoundsFromLatLonValues([
    38, -123, 42, -123, 42, -119, 38, -119,
  ]);

  expect(bounds).toEqual({
    west: -123,
    south: 38,
    east: -119,
    north: 42,
  });
});

it("keeps antimeridian-crossing bounds compact", () => {
  const bounds = getGeoBoundsFromLatLonValues([
    -10, 170, 10, 170, 10, -170, -10, -170,
  ]);

  expect(bounds).toEqual({
    west: 170,
    south: -10,
    east: -170,
    north: 10,
  });
});

it("computes longitude bounds for many distinct grid points", () => {
  const pointCount = 150_000;
  const values: number[] = [];
  for (let index = 0; index < pointCount; index++) {
    values.push(index % 2, -180 + (index * 360) / pointCount);
  }

  expect(getGeoBoundsFromLatLonValues(values)).toEqual({
    west: -180,
    south: 0,
    east: 180,
    north: 1,
  });
});

it("treats near-global mesh coverage as global GeoTIFF bounds", () => {
  const values: number[] = [];
  const step = 0.703125;
  const pointCount = Math.floor(359.296875 / step) + 1;
  for (let index = 0; index < pointCount; index++) {
    const lon = 45 + index * step;
    values.push(index % 2 === 0 ? -90 : 90, lon > 180 ? lon - 360 : lon);
  }

  expect(getGeoBoundsFromLatLonValues(values)).toEqual({
    west: -180,
    south: -90,
    east: 180,
    north: 90,
  });
});

it("uses a single data texture size as the GeoTIFF export size", () => {
  expect(
    getGeoTiffExportSize(
      { west: -123, south: 38, east: -119, north: 42 },
      [{ width: 1052, height: 784 }],
      0
    )
  ).toEqual({ width: 1052, height: 784 });
});

it("computes source-ordered cell-edge bounds for regular lat/lon textures", () => {
  expect(
    getRegularLatLonGridBounds(
      new Float32Array([-88.75, -87.5, -86.25]),
      new Float32Array([0, 2.5, 5])
    )
  ).toEqual({
    west: -1.25,
    east: 6.25,
    south: -89.375,
    north: -85.625,
  });
});

it("uses a high export size for geometry-valued grids", () => {
  expect(
    getGeoTiffExportSize(
      { west: -10, south: -5, east: 10, north: 5 },
      [],
      20_000
    )
  ).toEqual({ width: 8192, height: 4096 });
});

it("crops transparent export pixels and updates bounds", () => {
  const size = { width: 4, height: 3 };
  const pixels = new Uint8Array(size.width * size.height * 4);
  pixels[(1 * size.width + 1) * 4 + 3] = 255;
  pixels[(1 * size.width + 2) * 4 + 3] = 255;

  const crop = getAlphaCrop(pixels, size);

  expect(crop).toEqual({ x: 1, y: 1, width: 2, height: 1 });
  expect(
    getCroppedGeoBounds(
      { west: -20, south: -15, east: 20, north: 15 },
      size,
      crop!
    )
  ).toEqual({
    west: -10,
    south: -5,
    east: 10,
    north: 5,
  });
});

it("exports raw render target pixels without color-space conversion", () => {
  const target = createExportRenderTarget({ width: 4, height: 4 });

  expect(target.texture.colorSpace).toBe(THREE.NoColorSpace);
});

it("adds triangle wrap attributes for mesh GeoTIFF export", () => {
  const geometry = new THREE.InstancedBufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0, 1, 1, 0], 3)
  );
  geometry.setAttribute(
    "latLon",
    new THREE.Float32BufferAttribute([0, 177.5, 0, -180, 1, 177.5, 1, -180], 2)
  );
  geometry.setAttribute(
    "wrapDirection",
    new THREE.InstancedBufferAttribute(new Float32Array([0, 1, -1]), 1)
  );
  geometry.setIndex([0, 1, 2, 1, 3, 2]);

  const exportGeometry = createGeoTiffExportGeometry(geometry, true);

  expect(exportGeometry.index).toBeNull();
  expect(exportGeometry.getAttribute("triangleLatLon0")).toBeDefined();
  expect(exportGeometry.getAttribute("triangleLatLon1")).toBeDefined();
  expect(exportGeometry.getAttribute("triangleLatLon2")).toBeDefined();
  expect(exportGeometry.getAttribute("wrapDirection")).toBeUndefined();
});

it("can encode a regular texture GeoTIFF without alpha cropping", async () => {
  const size = { width: 4, height: 2 };
  const pixels = new Uint8Array(size.width * size.height * 4);
  pixels[(0 * size.width + 1) * 4] = 20;
  pixels[(0 * size.width + 1) * 4 + 3] = 255;

  const blob = await encodePixelsToGeoTiffBlob(
    pixels,
    size,
    {
      west: -1.25,
      south: -90,
      east: 8.75,
      north: -85,
    },
    false
  );

  const tiff = await fromArrayBuffer(await blob.arrayBuffer());
  const image = await tiff.getImage();
  expect(image.getWidth()).toBe(4);
  expect(image.getHeight()).toBe(2);
  const raster = await image.readRGB({ interleave: true, enableAlpha: true });
  expect(Array.from(raster)).toEqual(Array.from(pixels));
});

it("encodes exported pixels as a compressed GeoTIFF", async () => {
  const size = { width: 64, height: 64 };
  const pixels = new Uint8Array(size.width * size.height * 4);
  for (let index = 0; index < size.width * size.height; index++) {
    pixels[index * 4] = 20;
    pixels[index * 4 + 1] = 40;
    pixels[index * 4 + 2] = 60;
    pixels[index * 4 + 3] = 255;
  }

  const blob = await encodePixelsToGeoTiffBlob(pixels, size, {
    west: -10,
    south: -5,
    east: 10,
    north: 5,
  });

  expect(blob.size).toBeLessThan(pixels.byteLength);
  const tiff = await fromArrayBuffer(await blob.arrayBuffer());
  const image = await tiff.getImage();
  const raster = await image.readRGB({ interleave: true, enableAlpha: true });
  expect(Array.from(raster)).toEqual(Array.from(pixels));
});
