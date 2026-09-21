// Export the currently rendered data grid as an equirectangular GeoTIFF layer.
// The grid is rendered offscreen with projection forced to equirectangular at
// center (0, 0), independent of the projection active in the viewer.

import { zlib } from "fflate";
import { globals, writeArrayBuffer, type GeotiffWriterMetadata } from "geotiff";
import * as THREE from "three";

import {
  GLOBAL_TEXTURE_BOUNDS,
  getLongitudeSpan,
  type TGeoBounds,
} from "@/lib/layers/equirectLayer.ts";
import {
  GridTextureExportUserDataKey,
  TextureExportVCoordinate,
  type TRegularLatLonTextureExportMetadata,
} from "@/lib/layers/gridExportMetadata.ts";
import {
  createTriangleWrapProjectionGeometry,
  setupProjectionGeometryWrap,
} from "@/lib/projection/projectionEdgeQuality.ts";
import { getProjectionTypeFromMode } from "@/lib/projection/projectionShaders.ts";
import { PROJECTION_TYPES } from "@/lib/projection/projectionUtils.ts";
import textureColormapFragmentShader from "@/lib/shaders/glsl/textureColormap.frag.glsl";

const FALLBACK_EXPORT_PIXELS_PER_DEGREE = 8192 / 360;
const MIN_EXPORT_SIZE = 1;
const GEOMETRY_EXPORT_SIZE = { width: 8192, height: 4096 } as const;
const MIN_GLOBAL_LONGITUDE_COVERAGE_DEGREES = 359;

type TUniformValue = { value: unknown };
type TGridObject = THREE.Mesh | THREE.Points;
type TExportSize = { width: number; height: number };
type TAlphaCrop = { x: number; y: number; width: number; height: number };
type TRegularTextureExport = {
  material: THREE.ShaderMaterial;
  texture: THREE.Texture;
  size: TExportSize;
  metadata: TRegularLatLonTextureExportMetadata;
};
type TTextureFilterState = {
  minFilter: THREE.TextureFilter;
  magFilter: THREE.MagnificationTextureFilter;
  generateMipmaps: boolean;
};
type TRendererState = {
  clearColor: THREE.Color;
  clearAlpha: number;
  renderTarget: THREE.WebGLRenderTarget | null;
  viewport: THREE.Vector4;
  scissor: THREE.Vector4;
  scissorTest: boolean;
};

const EXPORT_WRAP_INSTANCE_COUNT = 3;
const GeoTiffRasterType = {
  AREA: 1,
} as const;
type TGeoTiffRasterType =
  (typeof GeoTiffRasterType)[keyof typeof GeoTiffRasterType];
const GeoTiffModelType = {
  GEOGRAPHIC: 2,
} as const;
type TGeoTiffModelType =
  (typeof GeoTiffModelType)[keyof typeof GeoTiffModelType];
const GeoTiffCompression = {
  DEFLATE: 8,
} as const;
type TGeoTiffCompression =
  (typeof GeoTiffCompression)[keyof typeof GeoTiffCompression];
const TIFF_DEFLATE_LEVEL = 6;
const CLASSIC_TIFF_MAX_UINT32 = 0xffffffff;
const GEO_TIFF_WGS_84_CITATION = "WGS 84";
const TIFF_HEADER_DUMMY_PIXELS = new Uint8Array([0]);
const TRIANGLE_WRAP_ATTRIBUTE_NAMES = [
  "triangleLatLon0",
  "triangleLatLon1",
  "triangleLatLon2",
] as const;
const DIRECT_TEXTURE_EXPORT_VERTEX_SHADER = `
varying vec2 vUv;
varying vec2 vProjectedXY;

void main() {
  vUv = uv;
  vProjectedXY = vec2(0.0);
  gl_Position = vec4(position.xy, 0.0, 1.0);
}
`;

function isGridDataMaterial(
  material: THREE.Material | THREE.Material[]
): material is THREE.ShaderMaterial {
  return (
    material instanceof THREE.ShaderMaterial &&
    material.uniforms?.colormap !== undefined &&
    material.uniforms?.projectionType !== undefined
  );
}

function collectGridObjects(scene: THREE.Scene) {
  const gridObjects: TGridObject[] = [];

  scene.traverse((object) => {
    if (!object.visible) {
      return;
    }

    if (!(object instanceof THREE.Mesh) && !(object instanceof THREE.Points)) {
      return;
    }

    const renderable = object as TGridObject;
    if (isGridDataMaterial(renderable.material)) {
      gridObjects.push(renderable);
    }
  });

  return gridObjects;
}

function normalizeLongitude360(lon: number) {
  return ((lon % 360) + 360) % 360;
}

function normalizeLongitude180(lon: number) {
  const normalized = ((lon + 180) % 360) + (lon + 180 < 0 ? 360 : 0);
  return normalized - 180;
}

function getLongitudeBounds(
  longitudes: number[]
): Pick<TGeoBounds, "west" | "east"> {
  if (longitudes.length === 0) {
    throw new Error("No longitudes available for GeoTIFF export.");
  }
  const normalizedLongitudes = [
    ...new Set(longitudes.map(normalizeLongitude360)),
  ].sort((a, b) => a - b);

  if (normalizedLongitudes.length === 1) {
    const lon = normalizeLongitude180(normalizedLongitudes[0]);
    return { west: lon - 0.5, east: lon + 0.5 };
  }

  let largestGap = Number.NEGATIVE_INFINITY;
  let largestGapIndex = 0;
  for (let index = 0; index < normalizedLongitudes.length; index++) {
    const lon = normalizedLongitudes[index];
    const next =
      index === normalizedLongitudes.length - 1
        ? normalizedLongitudes[0] + 360
        : normalizedLongitudes[index + 1];
    const gap = next - lon;
    if (gap > largestGap) {
      largestGap = gap;
      largestGapIndex = index;
    }
  }
  const coveredSpan = 360 - largestGap;
  if (coveredSpan >= MIN_GLOBAL_LONGITUDE_COVERAGE_DEGREES) {
    return {
      west: GLOBAL_TEXTURE_BOUNDS.west,
      east: GLOBAL_TEXTURE_BOUNDS.east,
    };
  }

  const west =
    normalizedLongitudes[(largestGapIndex + 1) % normalizedLongitudes.length];
  const east = normalizedLongitudes[largestGapIndex];
  return {
    west: normalizeLongitude180(west),
    east: normalizeLongitude180(east),
  };
}

function getGeoBoundsFromLatLonValues(values: readonly number[]): TGeoBounds {
  const longitudes: number[] = [];
  let south = Number.POSITIVE_INFINITY;
  let north = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < values.length; index += 2) {
    const lat = values[index];
    const lon = values[index + 1];
    if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
      continue;
    }
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    longitudes.push(lon);
  }
  if (!Number.isFinite(south) || !Number.isFinite(north)) {
    throw new Error(
      "No latitude/longitude geometry available for GeoTIFF export."
    );
  }
  if (south === north) {
    south -= 0.5;
    north += 0.5;
  }
  const { west, east } = getLongitudeBounds(longitudes);
  return { west, south, east, north };
}

function getGeoBounds(objects: TGridObject[]): TGeoBounds {
  const values: number[] = [];
  for (const object of objects) {
    const latLon = object.geometry.getAttribute("latLon");
    if (!latLon) {
      continue;
    }
    for (let index = 0; index < latLon.count; index++) {
      values.push(latLon.getX(index), latLon.getY(index));
    }
  }
  return getGeoBoundsFromLatLonValues(values);
}

function getTextureImageSize(texture: THREE.Texture): TExportSize | undefined {
  const image = texture.image as
    { width?: number; height?: number } | undefined;
  const width = image?.width;
  const height = image?.height;
  if (
    typeof width === "number" &&
    typeof height === "number" &&
    width > 0 &&
    height > 0
  ) {
    return { width, height };
  }
  return undefined;
}

function getUniqueDataTextureSizes(objects: TGridObject[]) {
  const sizes = new Map<string, TExportSize>();
  for (const object of objects) {
    const material = object.material as THREE.ShaderMaterial;
    const texture = material.uniforms.data?.value;
    if (!(texture instanceof THREE.Texture)) {
      continue;
    }
    const size = getTextureImageSize(texture);
    if (size) {
      sizes.set(texture.uuid, size);
    }
  }
  return [...sizes.values()];
}

function isRegularLatLonTextureExportMetadata(
  metadata: unknown
): metadata is TRegularLatLonTextureExportMetadata {
  return (
    typeof metadata === "object" &&
    metadata !== null &&
    "bounds" in metadata &&
    "topV" in metadata
  );
}

function getTextureExportMetadata(
  object: TGridObject
): TRegularLatLonTextureExportMetadata | undefined {
  const metadata =
    object.userData[GridTextureExportUserDataKey.METADATA] ??
    object.geometry.userData[GridTextureExportUserDataKey.METADATA];
  return isRegularLatLonTextureExportMetadata(metadata) ? metadata : undefined;
}

function sameGeoBounds(a: TGeoBounds, b: TGeoBounds) {
  return (
    a.west === b.west &&
    a.south === b.south &&
    a.east === b.east &&
    a.north === b.north
  );
}

function getRegularTextureExport(
  objects: TGridObject[]
): TRegularTextureExport | undefined {
  let result: TRegularTextureExport | undefined;
  for (const object of objects) {
    if (!(object instanceof THREE.Mesh)) {
      return undefined;
    }
    const metadata = getTextureExportMetadata(object);
    const material = object.material as THREE.ShaderMaterial;
    const texture = material.uniforms.data?.value;
    if (!metadata || !(texture instanceof THREE.Texture)) {
      return undefined;
    }
    const size = getTextureImageSize(texture);
    if (!size) {
      return undefined;
    }
    if (!result) {
      result = { material, texture, size, metadata };
      continue;
    }
    if (
      result.texture !== texture ||
      result.size.width !== size.width ||
      result.size.height !== size.height ||
      result.metadata.topV !== metadata.topV ||
      !sameGeoBounds(result.metadata.bounds, metadata.bounds)
    ) {
      return undefined;
    }
  }
  return result;
}

function getAttributeSampleCount(objects: TGridObject[]) {
  return objects.reduce((count, object) => {
    const dataValues = object.geometry.getAttribute("data_value");
    const latLon = object.geometry.getAttribute("latLon");
    return count + (dataValues?.count ?? latLon?.count ?? 0);
  }, 0);
}

function getSizeFromPixelCount(
  pixelCount: number,
  bounds: TGeoBounds
): TExportSize {
  const lonSpan = Math.max(getLongitudeSpan(bounds), 1);
  const latSpan = Math.max(bounds.north - bounds.south, 1);
  const aspect = lonSpan / latSpan;
  const width = Math.max(
    MIN_EXPORT_SIZE,
    Math.round(Math.sqrt(pixelCount * aspect))
  );
  const height = Math.max(MIN_EXPORT_SIZE, Math.round(width / aspect));
  return { width, height };
}

function getFallbackExportSize(bounds: TGeoBounds): TExportSize {
  return {
    width: Math.max(
      MIN_EXPORT_SIZE,
      Math.round(getLongitudeSpan(bounds) * FALLBACK_EXPORT_PIXELS_PER_DEGREE)
    ),
    height: Math.max(
      MIN_EXPORT_SIZE,
      Math.round(
        (bounds.north - bounds.south) * FALLBACK_EXPORT_PIXELS_PER_DEGREE
      )
    ),
  };
}

function getGeoTiffExportSize(
  bounds: TGeoBounds,
  textureSizes: TExportSize[],
  sampleCount: number
): TExportSize {
  if (textureSizes.length === 1) {
    return textureSizes[0];
  }
  if (sampleCount > 0) {
    return GEOMETRY_EXPORT_SIZE;
  }
  const texturePixelCount = textureSizes.reduce(
    (total, size) => total + size.width * size.height,
    0
  );
  if (texturePixelCount > 0) {
    return getSizeFromPixelCount(texturePixelCount, bounds);
  }
  return getFallbackExportSize(bounds);
}

function clampExportSize(size: TExportSize, maxSize: number): TExportSize {
  const scale = Math.min(1, maxSize / size.width, maxSize / size.height);
  return {
    width: Math.max(MIN_EXPORT_SIZE, Math.floor(size.width * scale)),
    height: Math.max(MIN_EXPORT_SIZE, Math.floor(size.height * scale)),
  };
}

function getExportSize(
  objects: TGridObject[],
  bounds: TGeoBounds,
  renderer: THREE.WebGLRenderer
) {
  const size = getGeoTiffExportSize(
    bounds,
    getUniqueDataTextureSizes(objects),
    getAttributeSampleCount(objects)
  );
  return clampExportSize(size, renderer.capabilities.maxTextureSize);
}

function configureProjectionUniforms(material: THREE.ShaderMaterial) {
  const uniforms = material.uniforms as Record<string, TUniformValue>;
  if (uniforms.projectionType) {
    uniforms.projectionType.value = getProjectionTypeFromMode(
      PROJECTION_TYPES.EQUIRECTANGULAR
    );
  }
  if (uniforms.centerLon) {
    uniforms.centerLon.value = 0;
  }
  if (uniforms.centerLat) {
    uniforms.centerLat.value = 0;
  }
  if (uniforms.edgeQuality) {
    uniforms.edgeQuality.value = 1;
  }
  if (uniforms.useTriangleWrapCull) {
    uniforms.useTriangleWrapCull.value = 1;
  }
  if (uniforms.projectionRadius) {
    uniforms.projectionRadius.value = 1;
  }
  material.depthTest = false;
  material.depthWrite = false;
}

function hasTriangleWrapAttributes(geometry: THREE.BufferGeometry) {
  return TRIANGLE_WRAP_ATTRIBUTE_NAMES.every((name) =>
    Boolean(geometry.getAttribute(name))
  );
}

function createGeoTiffExportGeometry(
  source: THREE.BufferGeometry,
  useTriangleWrapCull: boolean
) {
  const geometry = source.clone();
  if (
    useTriangleWrapCull &&
    geometry.getAttribute("latLon") &&
    !hasTriangleWrapAttributes(geometry)
  ) {
    geometry.deleteAttribute("wrapDirection");
    const wrappedGeometry = createTriangleWrapProjectionGeometry(
      geometry as THREE.InstancedBufferGeometry
    );
    geometry.dispose();
    return wrappedGeometry;
  }
  return geometry;
}

function configureExportGeometry(geometry: THREE.BufferGeometry) {
  const instancedGeometry = geometry as THREE.InstancedBufferGeometry;
  if (!instancedGeometry.isInstancedBufferGeometry) {
    return;
  }
  if (!geometry.getAttribute("wrapDirection")) {
    setupProjectionGeometryWrap(instancedGeometry);
  }
  instancedGeometry.instanceCount = EXPORT_WRAP_INSTANCE_COUNT;
}

function cloneGridMaterial(material: THREE.ShaderMaterial) {
  const clone = material.clone();
  for (const [key, uniform] of Object.entries(material.uniforms)) {
    if (uniform.value instanceof THREE.Texture) {
      const clonedTexture = clone.uniforms[key]?.value;
      if (
        clonedTexture instanceof THREE.Texture &&
        clonedTexture !== uniform.value
      ) {
        clonedTexture.dispose();
      }
      clone.uniforms[key].value = uniform.value;
    }
  }
  return clone;
}

function cloneGridObject(object: TGridObject): TGridObject {
  const geometry = createGeoTiffExportGeometry(
    object.geometry,
    object instanceof THREE.Mesh
  );
  const material = cloneGridMaterial(object.material as THREE.ShaderMaterial);
  configureExportGeometry(geometry);
  configureProjectionUniforms(material);

  const clone =
    object instanceof THREE.Points
      ? new THREE.Points(geometry, material)
      : new THREE.Mesh(geometry, material);
  clone.matrix.copy(object.matrixWorld);
  clone.matrixAutoUpdate = false;
  clone.renderOrder = object.renderOrder;
  clone.frustumCulled = false;
  return clone;
}

function createExportScene(scene: THREE.Scene) {
  scene.updateMatrixWorld(true);
  const exportScene = new THREE.Scene();
  const clones = collectGridObjects(scene).map(cloneGridObject);
  for (const clone of clones) {
    exportScene.add(clone);
  }
  return { exportScene, clones };
}

function disposeExportObjects(objects: TGridObject[]) {
  for (const object of objects) {
    object.geometry.dispose();
    (object.material as THREE.Material).dispose();
  }
}

function saveRendererState(renderer: THREE.WebGLRenderer): TRendererState {
  const clearColor = new THREE.Color();
  const viewport = new THREE.Vector4();
  const scissor = new THREE.Vector4();
  renderer.getClearColor(clearColor);
  renderer.getViewport(viewport);
  renderer.getScissor(scissor);
  return {
    clearColor,
    clearAlpha: renderer.getClearAlpha(),
    renderTarget: renderer.getRenderTarget() as THREE.WebGLRenderTarget | null,
    viewport,
    scissor,
    scissorTest: renderer.getScissorTest(),
  };
}

function restoreRendererState(
  renderer: THREE.WebGLRenderer,
  state: TRendererState
) {
  renderer.setRenderTarget(state.renderTarget);
  renderer.setViewport(
    state.viewport.x,
    state.viewport.y,
    state.viewport.z,
    state.viewport.w
  );
  renderer.setScissor(
    state.scissor.x,
    state.scissor.y,
    state.scissor.z,
    state.scissor.w
  );
  renderer.setScissorTest(state.scissorTest);
  renderer.setClearColor(state.clearColor, state.clearAlpha);
}

function readTargetPixels(
  renderer: THREE.WebGLRenderer,
  target: THREE.WebGLRenderTarget,
  size: TExportSize
): Uint8Array {
  const pixels = new Uint8Array(size.width * size.height * 4);
  renderer.readRenderTargetPixels(
    target,
    0,
    0,
    size.width,
    size.height,
    pixels
  );
  return pixels;
}

function flipPixelsTopDown(pixels: Uint8Array, size: TExportSize) {
  const flipped = new Uint8Array(pixels.length);
  const rowBytes = size.width * 4;
  for (let y = 0; y < size.height; y++) {
    const src = (size.height - 1 - y) * rowBytes;
    flipped.set(pixels.subarray(src, src + rowBytes), y * rowBytes);
  }
  return flipped;
}

function getAlphaCrop(
  pixels: Uint8Array,
  size: TExportSize
): TAlphaCrop | undefined {
  let minX = size.width;
  let minY = size.height;
  let maxX = -1;
  let maxY = -1;
  for (let y = 0; y < size.height; y++) {
    for (let x = 0; x < size.width; x++) {
      const alpha = pixels[(y * size.width + x) * 4 + 3];
      if (alpha === 0) {
        continue;
      }
      minX = Math.min(minX, x);
      minY = Math.min(minY, y);
      maxX = Math.max(maxX, x);
      maxY = Math.max(maxY, y);
    }
  }
  if (maxX < minX || maxY < minY) {
    return undefined;
  }
  return {
    x: minX,
    y: minY,
    width: maxX - minX + 1,
    height: maxY - minY + 1,
  };
}

function cropPixels(
  pixels: Uint8Array,
  size: TExportSize,
  crop: TAlphaCrop
): Uint8Array {
  const cropped = new Uint8Array(crop.width * crop.height * 4);
  const targetRowBytes = crop.width * 4;
  for (let y = 0; y < crop.height; y++) {
    const sourceStart = ((crop.y + y) * size.width + crop.x) * 4;
    cropped.set(
      pixels.subarray(sourceStart, sourceStart + targetRowBytes),
      y * targetRowBytes
    );
  }
  return cropped;
}

function getCroppedGeoBounds(
  bounds: TGeoBounds,
  size: TExportSize,
  crop: TAlphaCrop
): TGeoBounds {
  const lonSpan = getLongitudeSpan(bounds);
  const latSpan = bounds.north - bounds.south;
  return {
    west: bounds.west + (crop.x / size.width) * lonSpan,
    east: bounds.west + ((crop.x + crop.width) / size.width) * lonSpan,
    north: bounds.north - (crop.y / size.height) * latSpan,
    south: bounds.north - ((crop.y + crop.height) / size.height) * latSpan,
  };
}

function assertClassicTiffUInt32(value: number, label: string) {
  if (
    !Number.isInteger(value) ||
    value < 0 ||
    value > CLASSIC_TIFF_MAX_UINT32
  ) {
    throw new Error(`${label} is too large for classic TIFF.`);
  }
}

function makeGeoTiffMetadata(
  size: TExportSize,
  bounds: TGeoBounds,
  byteCount: number
): GeotiffWriterMetadata {
  const lonSpan = getLongitudeSpan(bounds);
  return {
    width: size.width,
    height: size.height,
    BitsPerSample: [8, 8, 8, 8],
    SampleFormat: [1, 1, 1, 1],
    SamplesPerPixel: 4,
    ExtraSamples: globals.ExtraSamplesValues.Unassalpha,
    PhotometricInterpretation: globals.photometricInterpretations.RGB,
    Compression: GeoTiffCompression.DEFLATE satisfies TGeoTiffCompression,
    RowsPerStrip: size.height,
    StripByteCounts: [byteCount],
    ModelPixelScale: [
      lonSpan / size.width,
      (bounds.north - bounds.south) / size.height,
      0,
    ],
    ModelTiepoint: [0, 0, 0, bounds.west, bounds.north, 0],
    GeographicTypeGeoKey: 4326,
    GeogCitationGeoKey: GEO_TIFF_WGS_84_CITATION,
    GTModelTypeGeoKey: GeoTiffModelType.GEOGRAPHIC satisfies TGeoTiffModelType,
    GTRasterTypeGeoKey: GeoTiffRasterType.AREA satisfies TGeoTiffRasterType,
  };
}

function getArrayBufferBlobPart(data: Uint8Array): ArrayBuffer {
  const buffer = data.buffer;
  if (buffer instanceof ArrayBuffer) {
    if (data.byteOffset === 0 && data.byteLength === buffer.byteLength) {
      return buffer;
    }
    return buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
  }
  const copy = new Uint8Array(data.byteLength);
  copy.set(data);
  return copy.buffer;
}

function encodeCompressedPixelsToGeoTiffBlob(
  compressedPixels: Uint8Array,
  size: TExportSize,
  bounds: TGeoBounds
): Blob {
  assertClassicTiffUInt32(size.width, "GeoTIFF width");
  assertClassicTiffUInt32(size.height, "GeoTIFF height");
  assertClassicTiffUInt32(compressedPixels.byteLength, "GeoTIFF strip");
  // Reuse geotiff.js for TIFF/GeoKey metadata, but keep its pixel loop out of the hot path.
  const headerWithDummyStrip = writeArrayBuffer(
    TIFF_HEADER_DUMMY_PIXELS,
    makeGeoTiffMetadata(size, bounds, compressedPixels.byteLength)
  );
  const header = headerWithDummyStrip.slice(
    0,
    headerWithDummyStrip.byteLength - TIFF_HEADER_DUMMY_PIXELS.byteLength
  );
  assertClassicTiffUInt32(header.byteLength, "GeoTIFF header");
  assertClassicTiffUInt32(
    header.byteLength + compressedPixels.byteLength,
    "GeoTIFF output"
  );
  return new Blob([header, getArrayBufferBlobPart(compressedPixels)], {
    type: "image/tiff",
  });
}

function compressTiffStrip(
  pixels: Uint8Array,
  canConsumePixels: boolean
): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    zlib(
      pixels,
      { consume: canConsumePixels, level: TIFF_DEFLATE_LEVEL },
      (error, data) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(data);
      }
    );
  });
}

async function encodePixelsToGeoTiffBlob(
  pixels: Uint8Array,
  size: TExportSize,
  bounds: TGeoBounds,
  cropAlpha = true
): Promise<Blob> {
  let tiffPixels = pixels;
  let tiffSize = size;
  let tiffBounds = bounds;
  let canConsumeTiffPixels = false;
  if (cropAlpha) {
    const crop = getAlphaCrop(pixels, size);
    if (!crop) {
      throw new Error("Grid export produced no visible pixels.");
    }
    tiffPixels = cropPixels(pixels, size, crop);
    tiffSize = { width: crop.width, height: crop.height };
    tiffBounds = getCroppedGeoBounds(bounds, size, crop);
    canConsumeTiffPixels = true;
  }
  const compressedPixels = await compressTiffStrip(
    tiffPixels,
    canConsumeTiffPixels
  );
  const blob = encodeCompressedPixelsToGeoTiffBlob(
    compressedPixels,
    tiffSize,
    tiffBounds
  );
  return blob;
}

function createExportRenderTarget(size: TExportSize) {
  return new THREE.WebGLRenderTarget(size.width, size.height);
}

function createDirectTextureExportGeometry(
  topV: TRegularLatLonTextureExportMetadata["topV"]
) {
  const bottomV =
    topV === TextureExportVCoordinate.TOP
      ? TextureExportVCoordinate.BOTTOM
      : TextureExportVCoordinate.TOP;
  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute(
    "position",
    new THREE.Float32BufferAttribute(
      [-1, -1, 0, 1, -1, 0, -1, 1, 0, 1, 1, 0],
      3
    )
  );
  geometry.setAttribute(
    "uv",
    new THREE.Float32BufferAttribute(
      [0, bottomV, 1, bottomV, 0, topV, 1, topV],
      2
    )
  );
  geometry.setIndex([0, 1, 2, 1, 3, 2]);
  return geometry;
}

function createDirectTextureExportMaterial(source: THREE.ShaderMaterial) {
  const material = cloneGridMaterial(source);
  material.vertexShader = DIRECT_TEXTURE_EXPORT_VERTEX_SHADER;
  material.fragmentShader = textureColormapFragmentShader;
  material.depthTest = false;
  material.depthWrite = false;
  if (material.uniforms.edgeQuality) {
    material.uniforms.edgeQuality.value = 0;
  }
  return material;
}

function setTextureNearestSampling(
  texture: THREE.Texture
): TTextureFilterState {
  const state = {
    minFilter: texture.minFilter,
    magFilter: texture.magFilter,
    generateMipmaps: texture.generateMipmaps,
  };
  texture.minFilter = THREE.NearestFilter;
  texture.magFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.needsUpdate = true;
  return state;
}

function restoreTextureSampling(
  texture: THREE.Texture,
  state: TTextureFilterState
) {
  texture.minFilter = state.minFilter;
  texture.magFilter = state.magFilter;
  texture.generateMipmaps = state.generateMipmaps;
  texture.needsUpdate = true;
}

async function exportRegularTextureAsGeoTiff(
  renderer: THREE.WebGLRenderer,
  config: TRegularTextureExport
) {
  const target = createExportRenderTarget(config.size);
  const scene = new THREE.Scene();
  const camera = new THREE.Camera();
  const geometry = createDirectTextureExportGeometry(config.metadata.topV);
  const material = createDirectTextureExportMaterial(config.material);
  const mesh = new THREE.Mesh(geometry, material);
  scene.add(mesh);
  const savedRendererState = saveRendererState(renderer);
  const savedTextureState = setTextureNearestSampling(config.texture);

  let pixels: Uint8Array;
  try {
    renderer.setRenderTarget(target);
    renderer.setViewport(0, 0, config.size.width, config.size.height);
    renderer.setScissorTest(false);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    pixels = flipPixelsTopDown(
      readTargetPixels(renderer, target, config.size),
      config.size
    );
  } finally {
    restoreTextureSampling(config.texture, savedTextureState);
    restoreRendererState(renderer, savedRendererState);
    geometry.dispose();
    material.dispose();
    target.dispose();
  }

  return encodePixelsToGeoTiffBlob(
    pixels,
    config.size,
    config.metadata.bounds,
    false
  );
}

/**
 * Render the visible data-grid objects as an equirectangular GeoTIFF
 * (transparent background) at center (0, 0) and return the image blob.
 */
export async function exportGridAsGeoTiffTexture(
  renderer: THREE.WebGLRenderer,
  scene: THREE.Scene
): Promise<Blob> {
  const gridObjects = collectGridObjects(scene);
  if (gridObjects.length === 0) {
    throw new Error("No grid layer is visible for GeoTIFF export.");
  }
  const regularTextureExport = getRegularTextureExport(gridObjects);
  if (regularTextureExport) {
    return exportRegularTextureAsGeoTiff(renderer, regularTextureExport);
  }
  const bounds = getGeoBounds(gridObjects);
  const size = getExportSize(gridObjects, bounds, renderer);
  const camera = new THREE.OrthographicCamera(
    THREE.MathUtils.degToRad(bounds.west),
    THREE.MathUtils.degToRad(bounds.west + getLongitudeSpan(bounds)),
    THREE.MathUtils.degToRad(bounds.north),
    THREE.MathUtils.degToRad(bounds.south),
    0.1,
    10
  );
  camera.position.set(0, 0, 5);

  const target = createExportRenderTarget(size);
  const { exportScene, clones } = createExportScene(scene);
  const savedRendererState = saveRendererState(renderer);

  let pixels: Uint8Array;
  try {
    renderer.setRenderTarget(target);
    renderer.setViewport(0, 0, size.width, size.height);
    renderer.setScissorTest(false);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(exportScene, camera);
    pixels = flipPixelsTopDown(readTargetPixels(renderer, target, size), size);
  } finally {
    restoreRendererState(renderer, savedRendererState);
    disposeExportObjects(clones);
    target.dispose();
  }

  return encodePixelsToGeoTiffBlob(pixels, size, bounds);
}
