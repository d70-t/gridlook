// Generic equirectangular texture layer rendering.
// Renders an equirectangular texture either onto the globe (GPU-projected
// sphere) or onto flat projections (quad with inverse-projection shader).
// Used by the built-in land/sea mask and by user-uploaded texture layers.

import * as d3 from "d3-geo";
import * as THREE from "three";

import flatInverseFragmentShader from "./glsl/flatInverse.frag.glsl";
import flatInverseVertexShader from "./glsl/flatInverse.vert.glsl";
import gpuProjectedMaskFragmentShader from "./glsl/gpuProjectedMask.frag.glsl";
import gpuProjectedMaskVertexShader from "./glsl/gpuProjectedMask.vert.glsl";
import { ResourceCache } from "./ResourceCache.ts";

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

// All equirect layers share the coastline radius so there is no parallax
// drift when the camera orbits; layering is handled purely via renderOrder.
const GLOBE_LAYER_RADIUS = 1.003;
const GRID_RESOLUTION = { latSegments: 180, lonSegments: 360 };

// =============================================================================
// Canvas helpers
// =============================================================================

export function createLayerCanvas(width = 4096, height = 2048) {
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, width, height);
  return { canvas, ctx, width, height };
}

export function configureEquirectangularTexture(texture: THREE.Texture) {
  texture.wrapS = THREE.RepeatWrapping;
  texture.wrapT = THREE.ClampToEdgeWrapping;
  texture.anisotropy = 16;
  texture.generateMipmaps = false;
  texture.minFilter = THREE.LinearFilter;
  texture.magFilter = THREE.LinearFilter;
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

/**
 * Cut the current canvas content to land (`"land"`) or sea (`"sea"`) using
 * the natural-earth land polygons. `"off"`/`"globe"` leave it untouched.
 */
export async function applyLandSeaCutout(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  mode: TLandSeaMaskMode
): Promise<void> {
  if (mode !== LAND_SEA_MASK_MODES.LAND && mode !== LAND_SEA_MASK_MODES.SEA) {
    return;
  }
  const land = await ResourceCache.loadLandGeoJSON();
  const pathHeight = getEquirectangularPathHeight(width);
  const path = createEquirectangularPath(ctx, width, pathHeight);
  ctx.save();
  ctx.scale(1, height / pathHeight);
  ctx.beginPath();
  path(land);
  ctx.globalCompositeOperation =
    mode === LAND_SEA_MASK_MODES.LAND ? "destination-in" : "destination-out";
  ctx.fill();
  ctx.restore();
}

/**
 * Build an equirectangular THREE texture from an image blob (JPG/PNG),
 * optionally cut out to land or sea. PNG alpha is preserved.
 */
export async function createImageLayerTexture(
  blob: Blob,
  maskMode: TLandSeaMaskMode
): Promise<THREE.Texture> {
  const image = await createImageBitmap(blob);
  const { canvas, ctx, width, height } = createLayerCanvas(
    image.width,
    image.height
  );
  ctx.drawImage(image, 0, 0, width, height);
  image.close();
  await applyLandSeaCutout(ctx, width, height, maskMode);
  return configureEquirectangularTexture(new THREE.CanvasTexture(canvas));
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

/**
 * Create a mesh rendering an equirectangular texture under the current
 * projection. Globe: GPU-projected sphere. Flat: inverse-projection quad.
 * Stack position (renderOrder/blending) is applied separately via
 * `applyLayerStackPosition`.
 */
export function createEquirectLayerMesh(
  texture: THREE.Texture,
  projectionHelper: ProjectionHelper,
  name: string
): THREE.Mesh {
  let geometry: THREE.BufferGeometry;
  let material: THREE.ShaderMaterial;

  if (projectionHelper.isFlat) {
    geometry = createFlatQuadGeometry();
    material = new THREE.ShaderMaterial({
      uniforms: {
        maskTexture: { value: texture },
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
