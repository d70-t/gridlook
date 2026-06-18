import { fromArrayBuffer } from "geotiff";
import * as THREE from "three";
import { expect, it } from "vitest";

import { exportGridAsGeoTiffTexture } from "@/lib/layers/gridExport.ts";
import {
  GridTextureExportUserDataKey,
  getRegularLatLonGridBounds,
  TextureExportVCoordinate,
} from "@/lib/layers/gridExportMetadata.ts";

type TPixelFill = (
  pixels: Uint8Array,
  size: { width: number; height: number }
) => void;

function writeTopDownPixelsToReadBuffer(
  target: Uint8Array,
  size: { width: number; height: number },
  topDownPixels: Uint8Array
) {
  const rowBytes = size.width * 4;
  for (let y = 0; y < size.height; y++) {
    const sourceStart = y * rowBytes;
    const targetStart = (size.height - 1 - y) * rowBytes;
    target.set(
      topDownPixels.subarray(sourceStart, sourceStart + rowBytes),
      targetStart
    );
  }
}

function createSolidPixels(size: { width: number; height: number }) {
  const pixels = new Uint8Array(size.width * size.height * 4);
  for (let index = 0; index < size.width * size.height; index++) {
    pixels[index * 4] = 20;
    pixels[index * 4 + 1] = 40;
    pixels[index * 4 + 2] = 60;
    pixels[index * 4 + 3] = 255;
  }
  return pixels;
}

function createMockRenderer(fillPixels: TPixelFill): THREE.WebGLRenderer {
  return {
    capabilities: { maxTextureSize: 64 },
    getClearColor: (target: THREE.Color) => target.set(0x000000),
    getClearAlpha: () => 0,
    getRenderTarget: () => null,
    getViewport: (target: THREE.Vector4) => target.set(0, 0, 1, 1),
    getScissor: (target: THREE.Vector4) => target.set(0, 0, 1, 1),
    getScissorTest: () => false,
    setRenderTarget: () => undefined,
    setViewport: () => undefined,
    setScissor: () => undefined,
    setScissorTest: () => undefined,
    setClearColor: () => undefined,
    clear: () => undefined,
    render: () => undefined,
    readRenderTargetPixels: (
      _target: THREE.WebGLRenderTarget,
      _x: number,
      _y: number,
      width: number,
      height: number,
      pixels: Uint8Array
    ) => fillPixels(pixels, { width, height }),
  } as unknown as THREE.WebGLRenderer;
}

function createGridMaterial(dataTexture?: THREE.Texture) {
  return new THREE.ShaderMaterial({
    uniforms: {
      colormap: { value: null },
      projectionType: { value: 0 },
      data: { value: dataTexture },
    },
  });
}

function createPointGridScene(latLonValues: number[]) {
  const scene = new THREE.Scene();
  const geometry = new THREE.BufferGeometry();
  const pointCount = latLonValues.length / 2;
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(new Float32Array(pointCount * 3), 3)
  );
  geometry.setAttribute(
    "latLon",
    new THREE.Float32BufferAttribute(latLonValues, 2)
  );
  scene.add(new THREE.Points(geometry, createGridMaterial()));
  return scene;
}

function createRegularTextureScene(
  size: { width: number; height: number },
  bounds: { west: number; south: number; east: number; north: number }
) {
  const scene = new THREE.Scene();
  const texture = new THREE.Texture();
  texture.image = size;
  const geometry = new THREE.BufferGeometry();
  geometry.userData[GridTextureExportUserDataKey.METADATA] = {
    bounds,
    topV: TextureExportVCoordinate.TOP,
  };
  scene.add(new THREE.Mesh(geometry, createGridMaterial(texture)));
  return scene;
}

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

it("exports a regular texture GeoTIFF without alpha cropping", async () => {
  const size = { width: 4, height: 2 };
  const pixels = new Uint8Array(size.width * size.height * 4);
  pixels[(0 * size.width + 1) * 4] = 20;
  pixels[(0 * size.width + 1) * 4 + 3] = 255;
  const bounds = { west: -1.25, south: -90, east: 8.75, north: -85 };
  const renderer = createMockRenderer((target, targetSize) =>
    writeTopDownPixelsToReadBuffer(target, targetSize, pixels)
  );

  const blob = await exportGridAsGeoTiffTexture(
    renderer,
    createRegularTextureScene(size, bounds)
  );

  const tiff = await fromArrayBuffer(await blob.arrayBuffer());
  const image = await tiff.getImage();
  expect(image.getWidth()).toBe(4);
  expect(image.getHeight()).toBe(2);
  expect(image.getBoundingBox()).toEqual([-1.25, -90, 8.75, -85]);
  expect(image.getGeoKeys()).toMatchObject({
    GeographicTypeGeoKey: 4326,
    GeogCitationGeoKey: "WGS 84",
    GTModelTypeGeoKey: 2,
    GTRasterTypeGeoKey: 1,
  });
  const raster = await image.readRGB({ interleave: true, enableAlpha: true });
  expect(Array.from(raster)).toEqual(Array.from(pixels));
});

it("treats near-global geometry coverage as global GeoTIFF bounds", async () => {
  const values: number[] = [];
  const step = 0.703125;
  const pointCount = Math.floor(359.296875 / step) + 1;
  for (let index = 0; index < pointCount; index++) {
    const lon = 45 + index * step;
    values.push(index % 2 === 0 ? -90 : 90, lon > 180 ? lon - 360 : lon);
  }
  const renderer = createMockRenderer((target, size) =>
    writeTopDownPixelsToReadBuffer(target, size, createSolidPixels(size))
  );

  const blob = await exportGridAsGeoTiffTexture(
    renderer,
    createPointGridScene(values)
  );

  const tiff = await fromArrayBuffer(await blob.arrayBuffer());
  const image = await tiff.getImage();
  expect(image.getBoundingBox()).toEqual([-180, -90, 180, 90]);
  expect(blob.size).toBeLessThan(image.getWidth() * image.getHeight() * 4);
});
