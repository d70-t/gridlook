// Generic equirectangular texture layer rendering.
// Renders an equirectangular texture either onto the globe (GPU-projected
// sphere) or onto flat projections (quad with inverse-projection shader).
// Used by the built-in land/sea mask and by user-uploaded texture layers.

import * as d3 from "d3-geo";
import { fromBlob, type TypedArrayWithDimensions } from "geotiff";
import * as THREE from "three";

import flatInverseFragmentShader from "./glsl/flatInverse.frag.glsl";
import flatInverseVertexShader from "./glsl/flatInverse.vert.glsl";
import gpuProjectedMaskFragmentShader from "./glsl/gpuProjectedMask.frag.glsl";
import gpuProjectedMaskVertexShader from "./glsl/gpuProjectedMask.vert.glsl";
import { ResourceCache } from "./ResourceCache.ts";
import { isGeoTiffLayerSource } from "./textureLayerFormats.ts";

import { getProjectionTypeFromMode } from "@/lib/projection/projectionShaders.ts";
import type { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";

export const LAND_SEA_MASK_MODES = {
  OFF: "off",
  SEA: "sea",
  LAND: "land",
  GLOBE: "globe",
} as const;

export type TLandSeaMaskMode =
  (typeof LAND_SEA_MASK_MODES)[keyof typeof LAND_SEA_MASK_MODES];

export type TGeoBounds = {
  west: number;
  south: number;
  east: number;
  north: number;
};

export type TImageLayerTexture = {
  texture: THREE.Texture;
  bounds: TGeoBounds;
};

export const TextureLayerSampling = {
  SMOOTH: "smooth",
  PIXELATED: "pixelated",
} as const;

export type TTextureLayerSampling =
  (typeof TextureLayerSampling)[keyof typeof TextureLayerSampling];

// All equirect layers share the coastline radius so there is no parallax
// drift when the camera orbits; layering is handled purely via renderOrder.
const GLOBE_LAYER_RADIUS = 1.003;
const GRID_RESOLUTION = { latSegments: 180, lonSegments: 360 };
export const GLOBAL_TEXTURE_BOUNDS: TGeoBounds = {
  west: -180,
  south: -90,
  east: 180,
  north: 90,
};
const GeoTiffModelType = {
  GEOGRAPHIC: 2,
} as const;
type TGeoTiffModelType =
  (typeof GeoTiffModelType)[keyof typeof GeoTiffModelType];
const GeoTiffAngularUnit = {
  DEGREE: 9102,
} as const;
type TGeoTiffAngularUnit =
  (typeof GeoTiffAngularUnit)[keyof typeof GeoTiffAngularUnit];
const COORDINATE_EPSILON = 1e-6;

type TGeoTiffImage = {
  getBitsPerSample(sampleIndex?: number): number;
  getBoundingBox(): number[];
  getGeoKeys(): Partial<Record<string, unknown>> | null;
  getHeight(): number;
  getSamplesPerPixel(): number;
  getWidth(): number;
  readRGB(options: {
    enableAlpha: boolean;
    interleave: true;
  }): Promise<TypedArrayWithDimensions>;
};

// =============================================================================
// Canvas helpers
// =============================================================================

export function createLayerCanvas(width = 8192, height = 4096) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, width, height);
  return { canvas, ctx, width, height };
}

export function getLongitudeSpan(bounds: TGeoBounds): number {
  const span = bounds.east - bounds.west;
  return span > 0 ? span : span + 360;
}

function isGlobalTextureBounds(bounds: TGeoBounds) {
  return (
    Math.abs(getLongitudeSpan(bounds) - 360) < COORDINATE_EPSILON &&
    bounds.south <= -90 + COORDINATE_EPSILON &&
    bounds.north >= 90 - COORDINATE_EPSILON
  );
}

export function configureEquirectangularTexture(
  texture: THREE.Texture,
  bounds: TGeoBounds = GLOBAL_TEXTURE_BOUNDS,
  sampling: TTextureLayerSampling = TextureLayerSampling.SMOOTH
) {
  texture.colorSpace = THREE.SRGBColorSpace;
  texture.wrapS = isGlobalTextureBounds(bounds)
    ? THREE.RepeatWrapping
    : THREE.ClampToEdgeWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = sampling === TextureLayerSampling.PIXELATED ? 1 : 16;
  texture.generateMipmaps = false;
  texture.minFilter =
    sampling === TextureLayerSampling.PIXELATED
      ? THREE.NearestFilter
      : THREE.LinearFilter;
  texture.magFilter =
    sampling === TextureLayerSampling.PIXELATED
      ? THREE.NearestFilter
      : THREE.LinearFilter;
  texture.needsUpdate = true;
  return texture;
}

export function copyAntimeridianEdge(
  ctx: CanvasRenderingContext2D,
  width: number
) {
  const edge = ctx.getImageData(0, 0, 1, ctx.canvas.height);
  ctx.putImageData(edge, width - 1, 0);
}

export function createEquirectangularPath(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number
): d3.GeoPath {
  const projection = d3
    .geoEquirectangular()
    .translate([width / 2, height / 2])
    .scale(width / (2 * Math.PI));
  return d3.geoPath(projection, ctx);
}

function getEquirectangularPathHeight(width: number): number {
  return width / 2;
}

function createRegionalEquirectangularPath(
  ctx: CanvasRenderingContext2D,
  width: number,
  bounds: TGeoBounds
): { path: d3.GeoPath; pathHeight: number } {
  const lonSpan = getLongitudeSpan(bounds);
  const latSpan = bounds.north - bounds.south;
  const scale = width / THREE.MathUtils.degToRad(lonSpan);
  const pathHeight = THREE.MathUtils.degToRad(latSpan) * scale;
  const projection = d3
    .geoEquirectangular()
    .translate([
      -THREE.MathUtils.degToRad(bounds.west) * scale,
      THREE.MathUtils.degToRad(bounds.north) * scale,
    ])
    .scale(scale)
    .clipExtent([
      [0, 0],
      [width, pathHeight],
    ]);
  return { path: d3.geoPath(projection, ctx), pathHeight };
}

/**
 * Cut the current canvas content to land (`"land"`) or sea (`"sea"`) using
 * the natural-earth land polygons. `"off"`/`"globe"` leave it untouched.
 */
export async function applyLandSeaCutout(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  mode: TLandSeaMaskMode,
  bounds: TGeoBounds = GLOBAL_TEXTURE_BOUNDS
): Promise<void> {
  if (mode !== LAND_SEA_MASK_MODES.LAND && mode !== LAND_SEA_MASK_MODES.SEA) {
    return;
  }
  const land = await ResourceCache.loadLandGeoJSON();
  const { path, pathHeight } = isGlobalTextureBounds(bounds)
    ? {
        path: createEquirectangularPath(
          ctx,
          width,
          getEquirectangularPathHeight(width)
        ),
        pathHeight: getEquirectangularPathHeight(width),
      }
    : createRegionalEquirectangularPath(ctx, width, bounds);
  ctx.save();
  ctx.scale(1, height / pathHeight);
  ctx.beginPath();
  path(land);
  ctx.globalCompositeOperation =
    mode === LAND_SEA_MASK_MODES.LAND ? "destination-in" : "destination-out";
  ctx.fill();
  ctx.restore();
}

function getGeoKeyNumber(
  image: TGeoTiffImage,
  key: string
): number | undefined {
  const value = image.getGeoKeys()?.[key];
  const numberValue = Number(value);
  return Number.isFinite(numberValue) ? numberValue : undefined;
}

function isGeographicGeoTiff(image: TGeoTiffImage): boolean {
  const modelType = getGeoKeyNumber(image, "GTModelTypeGeoKey");
  if (modelType !== undefined) {
    return (
      modelType === (GeoTiffModelType.GEOGRAPHIC satisfies TGeoTiffModelType)
    );
  }
  return (
    getGeoKeyNumber(image, "GeographicTypeGeoKey") !== undefined &&
    getGeoKeyNumber(image, "ProjectedCSTypeGeoKey") === undefined
  );
}

function hasDegreeAngularUnits(image: TGeoTiffImage): boolean {
  const angularUnit = getGeoKeyNumber(image, "GeogAngularUnitsGeoKey");
  return (
    angularUnit === undefined ||
    angularUnit === (GeoTiffAngularUnit.DEGREE satisfies TGeoTiffAngularUnit)
  );
}

function clampLatitude(latitude: number) {
  if (latitude < -90 && latitude >= -90 - COORDINATE_EPSILON) {
    return -90;
  }
  if (latitude > 90 && latitude <= 90 + COORDINATE_EPSILON) {
    return 90;
  }
  return latitude;
}

export function normalizeGeoTiffBounds(boundingBox: number[]): TGeoBounds {
  const [west, southValue, east, northValue] = boundingBox;
  const south = clampLatitude(Math.min(southValue, northValue));
  const north = clampLatitude(Math.max(southValue, northValue));
  const bounds = { west, south, east, north };
  const lonSpan = getLongitudeSpan(bounds);
  if (
    ![bounds.west, bounds.south, bounds.east, bounds.north].every(
      Number.isFinite
    ) ||
    south < -90 ||
    north > 90 ||
    north <= south ||
    lonSpan <= 0 ||
    lonSpan > 360 + COORDINATE_EPSILON
  ) {
    throw new Error(
      "GeoTIFF layers must use longitude/latitude bounds in degrees."
    );
  }
  return bounds;
}

function getGeoTiffBounds(image: TGeoTiffImage): TGeoBounds {
  if (!isGeographicGeoTiff(image) || !hasDegreeAngularUnits(image)) {
    throw new Error(
      "Only longitude/latitude GeoTIFF layers are supported. Reproject the GeoTIFF to EPSG:4326 before uploading."
    );
  }
  return normalizeGeoTiffBounds(image.getBoundingBox());
}

function getColorChannelMax(
  image: TGeoTiffImage,
  data: TypedArrayWithDimensions,
  channel: number
) {
  if (data instanceof Uint8Array || data instanceof Uint8ClampedArray) {
    return 255;
  }
  if (data instanceof Float32Array || data instanceof Float64Array) {
    return 1;
  }
  const sampleIndex = Math.min(channel, image.getSamplesPerPixel() - 1);
  return 2 ** image.getBitsPerSample(sampleIndex) - 1;
}

function toColorByte(value: number, max: number) {
  if (!Number.isFinite(value)) {
    return 0;
  }
  return Math.max(0, Math.min(255, Math.round((value / max) * 255)));
}

function putRgbRasterOnCanvas(
  image: TGeoTiffImage,
  ctx: CanvasRenderingContext2D,
  raster: TypedArrayWithDimensions
) {
  const pixelCount = raster.width * raster.height;
  const channelCount = raster.length / pixelCount;
  if (channelCount < 3) {
    throw new Error("GeoTIFF layer could not be decoded as RGB.");
  }
  const channelMax = [
    getColorChannelMax(image, raster, 0),
    getColorChannelMax(image, raster, 1),
    getColorChannelMax(image, raster, 2),
    getColorChannelMax(image, raster, 3),
  ];
  const imageData = ctx.createImageData(raster.width, raster.height);
  for (let pixelIndex = 0; pixelIndex < pixelCount; pixelIndex++) {
    const sourceIndex = pixelIndex * channelCount;
    const targetIndex = pixelIndex * 4;
    imageData.data[targetIndex] = toColorByte(
      raster[sourceIndex],
      channelMax[0]
    );
    imageData.data[targetIndex + 1] = toColorByte(
      raster[sourceIndex + 1],
      channelMax[1]
    );
    imageData.data[targetIndex + 2] = toColorByte(
      raster[sourceIndex + 2],
      channelMax[2]
    );
    imageData.data[targetIndex + 3] =
      channelCount >= 4
        ? toColorByte(raster[sourceIndex + 3], channelMax[3])
        : 255;
  }
  ctx.putImageData(imageData, 0, 0);
}

async function createGeoTiffLayerTexture(
  blob: Blob,
  maskMode: TLandSeaMaskMode
): Promise<TImageLayerTexture> {
  const tiff = await fromBlob(blob);
  const image = (await tiff.getImage()) as TGeoTiffImage;
  const bounds = getGeoTiffBounds(image);
  const raster = await image.readRGB({ interleave: true, enableAlpha: true });
  const { canvas, ctx, width, height } = createLayerCanvas(
    image.getWidth(),
    image.getHeight()
  );
  putRgbRasterOnCanvas(image, ctx, raster);
  await applyLandSeaCutout(ctx, width, height, maskMode, bounds);
  return {
    texture: configureEquirectangularTexture(
      new THREE.CanvasTexture(canvas),
      bounds,
      TextureLayerSampling.PIXELATED
    ),
    bounds,
  };
}

/**
 * Build a layer texture from an image blob, optionally cut out to land or sea.
 * PNG alpha is preserved. GeoTIFFs keep their native raster size and bounds.
 */
export async function createImageLayerTexture(
  blob: Blob,
  maskMode: TLandSeaMaskMode,
  name?: string
): Promise<TImageLayerTexture> {
  if (isGeoTiffLayerSource(blob, name)) {
    return createGeoTiffLayerTexture(blob, maskMode);
  }
  const image = await createImageBitmap(blob);
  const { canvas, ctx, width, height } = createLayerCanvas(
    image.width,
    image.height
  );
  ctx.drawImage(image, 0, 0, width, height);
  image.close();
  await applyLandSeaCutout(ctx, width, height, maskMode);
  return {
    texture: configureEquirectangularTexture(new THREE.CanvasTexture(canvas)),
    bounds: GLOBAL_TEXTURE_BOUNDS,
  };
}

// =============================================================================
// Mesh creation
// =============================================================================

/**
 * Quad covering the flat projection's coordinate space; the fragment shader
 * clips to the actual projection boundary via inverse projection.
 */
function createFlatQuadGeometry(): THREE.BufferGeometry {
  const extent = 4.0;
  const vertices = new Float32Array(
    [
      [-extent, -extent],
      [extent, -extent],
      [extent, extent],
      [-extent, extent],
    ].flatMap(([x, y]) => [x, y, 0])
  );
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices, 3)
  );
  geometry.setIndex([0, 1, 2, 0, 2, 3]);
  return geometry;
}

/**
 * Sphere geometry with wrapped indices and no duplicated antimeridian vertex
 * column; the fragment shader derives UVs from the sphere position.
 */
function createGlobeGeometry(): THREE.BufferGeometry {
  const { latSegments, lonSegments } = GRID_RESOLUTION;
  const vertices: number[] = [];
  const indices: number[] = [];

  for (let latIdx = 0; latIdx <= latSegments; latIdx++) {
    const latRad = THREE.MathUtils.degToRad(90 - (latIdx / latSegments) * 180);
    const cosLat = Math.cos(latRad);
    const sinLat = Math.sin(latRad);
    for (let lonIdx = 0; lonIdx < lonSegments; lonIdx++) {
      const lonRad = THREE.MathUtils.degToRad(
        (lonIdx / lonSegments) * 360 - 180
      );
      vertices.push(
        cosLat * Math.cos(lonRad),
        cosLat * Math.sin(lonRad),
        sinLat
      );
    }
  }

  for (let latIdx = 0; latIdx < latSegments; latIdx++) {
    for (let lonIdx = 0; lonIdx < lonSegments; lonIdx++) {
      const nextLonIdx = (lonIdx + 1) % lonSegments;
      const a = latIdx * lonSegments + lonIdx;
      const b = (latIdx + 1) * lonSegments + lonIdx;
      const c = latIdx * lonSegments + nextLonIdx;
      const d = (latIdx + 1) * lonSegments + nextLonIdx;
      indices.push(a, b, c, c, b, d);
    }
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(vertices, 3)
  );
  geometry.setIndex(indices);
  return geometry;
}

function createTextureBoundsVector(bounds: TGeoBounds) {
  return new THREE.Vector4(
    bounds.west,
    bounds.south,
    bounds.east,
    bounds.north
  );
}

/**
 * Create a mesh rendering an equirectangular texture under the current
 * projection. Globe: GPU-projected sphere. Flat: inverse-projection quad.
 * Stack position (renderOrder/blending) is applied separately via
 * `applyLayerStackPosition`.
 */
export function createEquirectLayerMesh(
  texture: THREE.Texture,
  projectionHelper: ProjectionHelper,
  name: string,
  bounds: TGeoBounds = GLOBAL_TEXTURE_BOUNDS
): THREE.Mesh {
  let geometry: THREE.BufferGeometry;
  let material: THREE.ShaderMaterial;
  const textureBounds = createTextureBoundsVector(bounds);

  if (projectionHelper.isFlat) {
    geometry = createFlatQuadGeometry();
    material = new THREE.ShaderMaterial({
      uniforms: {
        maskTexture: { value: texture },
        textureBounds: { value: textureBounds },
        opacity: { value: 1.0 },
        projectionType: {
          value: getProjectionTypeFromMode(projectionHelper.type),
        },
        centerLon: { value: projectionHelper.center.lon },
        centerLat: { value: projectionHelper.center.lat },
      },
      vertexShader: flatInverseVertexShader,
      fragmentShader: flatInverseFragmentShader,
      side: THREE.DoubleSide,
      depthWrite: false,
      depthTest: false,
    });
  } else {
    geometry = createGlobeGeometry();
    material = new THREE.ShaderMaterial({
      uniforms: {
        maskTexture: { value: texture },
        textureBounds: { value: textureBounds },
        projectionRadius: { value: GLOBE_LAYER_RADIUS },
        opacity: { value: 1.0 },
      },
      vertexShader: gpuProjectedMaskVertexShader,
      fragmentShader: gpuProjectedMaskFragmentShader,
      side: THREE.FrontSide,
      depthWrite: false,
      depthTest: false,
    });
  }

  const mesh = new THREE.Mesh(geometry, material);
  mesh.name = name;
  mesh.frustumCulled = false;
  return mesh;
}

/**
 * Position a layer mesh in the render stack.
 * Layers above the grid (renderOrder > 0) use the transparent pass so they
 * paint over the (opaque) data grid. Layers below the grid must stay in the
 * opaque pass (drawn before the grid) but keep alpha blending so PNG
 * transparency is respected.
 */
export function applyLayerStackPosition(
  mesh: THREE.Mesh,
  renderOrder: number
): void {
  const material = mesh.material as THREE.ShaderMaterial;
  mesh.renderOrder = renderOrder;
  if (renderOrder > 0) {
    material.transparent = true;
    material.blending = THREE.NormalBlending;
  } else {
    material.transparent = false;
    material.blending = THREE.CustomBlending;
    material.blendSrc = THREE.SrcAlphaFactor;
    material.blendDst = THREE.OneMinusSrcAlphaFactor;
    material.blendEquation = THREE.AddEquation;
  }
  material.needsUpdate = true;
}

/**
 * Update projection uniforms on an existing layer mesh (fast path for
 * projection center changes; no geometry rebuild).
 */
export function updateEquirectLayerProjection(
  mesh: THREE.Object3D | undefined,
  projectionHelper: ProjectionHelper
): void {
  if (!mesh || !(mesh instanceof THREE.Mesh)) {
    return;
  }
  const material = mesh.material as THREE.ShaderMaterial;
  if (!material.uniforms) {
    return;
  }
  if (material.uniforms.projectionType) {
    material.uniforms.projectionType.value = getProjectionTypeFromMode(
      projectionHelper.type
    );
  }
  if (material.uniforms.centerLon) {
    material.uniforms.centerLon.value = projectionHelper.center.lon;
  }
  if (material.uniforms.centerLat) {
    material.uniforms.centerLat.value = projectionHelper.center.lat;
  }
  material.needsUpdate = true;
}

/** Dispose a layer mesh including its geometry and texture. */
export function disposeLayerMesh(mesh: THREE.Mesh): void {
  mesh.geometry?.dispose();
  const material = mesh.material as THREE.ShaderMaterial;
  const texture = material.uniforms?.maskTexture?.value as
    | THREE.Texture
    | undefined;
  texture?.dispose();
  material?.dispose();
}
