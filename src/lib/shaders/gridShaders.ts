import * as THREE from "three";

import {
  PROJECTION_TYPE_BY_MODE,
  getProjectionTypeFromMode,
} from "../projection/projectionShaders.ts";
import {
  PROJECTION_TYPES,
  type ProjectionHelper,
} from "../projection/projectionUtils.ts";

import { availableColormaps, type TColorMap } from "./colormapShaders.ts";
import compressedLutFragmentShader from "./glsl/compressedLut.frag.glsl";
import gpuProjectedMeshVertexShader from "./glsl/gpuProjectedMesh.vert.glsl";
import gpuProjectedPointVertexShader from "./glsl/gpuProjectedPoint.vert.glsl";
import gpuProjectedTextureVertexShader from "./glsl/gpuProjectedTexture.vert.glsl";
import pointFalloffFragmentShader from "./glsl/pointFalloff.frag.glsl";
import scalarColormapFragmentShader from "./glsl/scalarColormap.frag.glsl";
import screenQuadValueVertexShader from "./glsl/screenQuadValue.vert.glsl";
import textureColormapFragmentShader from "./glsl/textureColormap.frag.glsl";

export function makeCompressedColormapLutMaterial(
  colormap: TColorMap = "turbo",
  addOffset: 0 | 1,
  scaleFactor: 1 | -1
) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      addOffset: { value: addOffset },
      scaleFactor: { value: scaleFactor },
      colormap: { value: availableColormaps[colormap] },
      posterizeLevels: { value: 0.0 },
      selLow: { value: 0.0 },
      selHigh: { value: 1.0 },
    },
    vertexShader: screenQuadValueVertexShader,
    fragmentShader: compressedLutFragmentShader,
  });
  return material;
}

export function getColormapScaleOffset(
  low: number,
  high: number,
  invertColormap: boolean
) {
  let addOffset: number;
  let scaleFactor: number;

  // Handle edge case where min equals max (single value dataset)
  if (high === low) {
    addOffset = 0.5;
    scaleFactor = 0.0;
    return { addOffset, scaleFactor };
  }

  if (invertColormap) {
    scaleFactor = -1 / (high - low);
    addOffset = -high * scaleFactor;
  } else {
    scaleFactor = 1 / (high - low);
    addOffset = -low * scaleFactor;
  }
  return { addOffset, scaleFactor };
}

// =============================================================================
// GPU-Projected Shaders
// =============================================================================
// These shaders perform map projection on the GPU, allowing instant center
// changes without geometry rebuilds.

/**
 * Create a GPU-projected texture material for Regular/HEALPix grids.
 * Projection is done on the GPU, allowing instant center changes.
 */
export function makeGpuProjectedTextureMaterial(
  texture: THREE.Texture,
  colormap: TColorMap = "turbo",
  addOffset: number,
  scaleFactor: number
) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      addOffset: { value: addOffset },
      scaleFactor: { value: scaleFactor },
      colormap: { value: availableColormaps[colormap] },
      posterizeLevels: { value: 0.0 },
      hideBelowValue: { value: -1e38 },
      hideAboveValue: { value: 1e38 },
      data: { value: texture },
      // Projection uniforms
      projectionType: {
        value: PROJECTION_TYPE_BY_MODE[PROJECTION_TYPES.NEARSIDE_PERSPECTIVE],
      },
      centerLon: { value: 0.0 },
      centerLat: { value: 0.0 },
      projectionRadius: { value: 1.0 },
      edgeQuality: { value: 1 },
      useTriangleWrapCull: { value: 0 },
    },
    vertexShader: gpuProjectedTextureVertexShader,
    fragmentShader: textureColormapFragmentShader,
  });
  (material.defaultAttributeValues as Record<string, unknown>).wrapDirection = [
    0,
  ];
  (material.defaultAttributeValues as Record<string, unknown>).triangleLatLon0 =
    [0, 0];
  (material.defaultAttributeValues as Record<string, unknown>).triangleLatLon1 =
    [0, 0];
  (material.defaultAttributeValues as Record<string, unknown>).triangleLatLon2 =
    [0, 0];
  return material;
}

/**
 * Create a GPU-projected mesh material for vertex-valued grids.
 * Projection is done on the GPU, allowing instant center changes.
 */
export function makeGpuProjectedMeshMaterial(
  colormap: TColorMap = "turbo",
  addOffset: 1.0 | 0.0 = 0.0,
  scaleFactor: -1.0 | 1.0 = 1.0
) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      addOffset: { value: addOffset },
      scaleFactor: { value: scaleFactor },
      colormap: { value: availableColormaps[colormap] },
      posterizeLevels: { value: 0.0 },
      hideBelowValue: { value: -1e38 },
      hideAboveValue: { value: 1e38 },
      // Projection uniforms
      projectionType: {
        value: PROJECTION_TYPE_BY_MODE[PROJECTION_TYPES.NEARSIDE_PERSPECTIVE],
      },
      centerLon: { value: 0.0 },
      centerLat: { value: 0.0 },
      projectionRadius: { value: 1.0 },
      edgeQuality: { value: 1 },
      useTriangleWrapCull: { value: 0 },
    },
    vertexShader: gpuProjectedMeshVertexShader,
    fragmentShader: scalarColormapFragmentShader,
  });
  (material.defaultAttributeValues as Record<string, unknown>).wrapDirection = [
    0,
  ];
  (material.defaultAttributeValues as Record<string, unknown>).triangleLatLon0 =
    [0, 0];
  (material.defaultAttributeValues as Record<string, unknown>).triangleLatLon1 =
    [0, 0];
  (material.defaultAttributeValues as Record<string, unknown>).triangleLatLon2 =
    [0, 0];
  return material;
}

export function makeInvertableGpuMeshMaterial(
  colormap: TColorMap,
  invert: boolean
) {
  return invert
    ? makeGpuProjectedMeshMaterial(colormap, 1.0, -1.0)
    : makeGpuProjectedMeshMaterial(colormap, 0.0, 1.0);
}

/**
 * Create a GPU-projected point material for irregular grids.
 * Projection is done on the GPU, allowing instant center changes.
 */
export function makeGpuProjectedPointMaterial(
  colormap: TColorMap = "turbo",
  addOffset: 1.0 | 0.0 = 0.0,
  scaleFactor: -1.0 | 1.0 = 1.0
) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      addOffset: { value: addOffset },
      scaleFactor: { value: scaleFactor },
      basePointSize: { value: 5.0 },
      minPointSize: { value: 1.0 },
      maxPointSize: { value: 10.0 },
      posterizeLevels: { value: 0.0 },
      hideBelowValue: { value: -1e38 },
      hideAboveValue: { value: 1e38 },
      colormap: { value: availableColormaps[colormap] },
      // Projection uniforms
      projectionType: {
        value: PROJECTION_TYPE_BY_MODE[PROJECTION_TYPES.NEARSIDE_PERSPECTIVE],
      },
      centerLon: { value: 0.0 },
      centerLat: { value: 0.0 },
      projectionRadius: { value: 1.0 },
    },
    transparent: true,
    depthWrite: false,
    depthTest: true,
    vertexShader: gpuProjectedPointVertexShader,
    fragmentShader: pointFalloffFragmentShader,
  });
  return material;
}

/**
 * Update projection uniforms on a GPU-projected material.
 * This is the fast path - no geometry rebuild needed.
 */
export function updateProjectionUniforms(
  material: THREE.ShaderMaterial,
  projectionHelper: Pick<ProjectionHelper, "type" | "center">,
  radius: number = 1.0,
  mesh?: THREE.Mesh,
  useAccurateEdges = true
) {
  const projectionTypeId = getProjectionTypeFromMode(projectionHelper.type);
  if (material.uniforms.projectionType) {
    material.uniforms.projectionType.value = projectionTypeId;
  }
  if (material.uniforms.centerLon) {
    material.uniforms.centerLon.value = projectionHelper.center.lon;
  }
  if (material.uniforms.centerLat) {
    material.uniforms.centerLat.value = projectionHelper.center.lat;
  }
  if (material.uniforms.projectionRadius) {
    material.uniforms.projectionRadius.value = radius;
  }
  if (material.uniforms.edgeQuality) {
    material.uniforms.edgeQuality.value = useAccurateEdges ? 1 : 0;
  }
  material.depthTest =
    projectionHelper.type === PROJECTION_TYPES.NEARSIDE_PERSPECTIVE;

  if (mesh) {
    setProjectionGeometryInstanceCount(
      mesh.geometry,
      getProjectionInstanceCount(projectionHelper.type, useAccurateEdges)
    );
  }
}

function getProjectionInstanceCount(
  projectionType: Pick<ProjectionHelper, "type">["type"],
  useAccurateEdges: boolean
) {
  return useAccurateEdges && shouldUseProjectionWrapInstances(projectionType)
    ? 3
    : 1;
}

function shouldUseProjectionWrapInstances(
  projectionType: Pick<ProjectionHelper, "type">["type"]
) {
  return (
    projectionType !== PROJECTION_TYPES.NEARSIDE_PERSPECTIVE &&
    projectionType !== PROJECTION_TYPES.AZIMUTHAL_EQUIDISTANT &&
    projectionType !== PROJECTION_TYPES.AZIMUTHAL_HYBRID
  );
}

function setProjectionGeometryInstanceCount(
  geometry: THREE.BufferGeometry,
  count: number
) {
  const instancedGeometry = geometry as THREE.InstancedBufferGeometry;
  if (instancedGeometry.isInstancedBufferGeometry) {
    if (instancedGeometry.instanceCount === count) {
      return;
    }
    instancedGeometry.instanceCount = count;
  }
}

/**
 * Add the instanced wrapDirection attribute to a geometry.
 * Must be called on every new geometry before it is used in a projection mesh.
 */
export function addWrapDirectionAttribute(
  geometry: THREE.InstancedBufferGeometry
): void {
  setProjectionGeometryInstanceCount(geometry, 1);

  const wrapDirs = new Float32Array([0, 1, -1]);
  geometry.setAttribute(
    "wrapDirection",
    new THREE.InstancedBufferAttribute(wrapDirs, 1)
  );
}

/**
 * Create the most efficient projection mesh for the current projection mode.
 * Uses a plain Mesh with InstancedBufferGeometry instead of InstancedMesh,
 * avoiding instanceMatrix/program overhead because wrapDirection is the only
 * per-instance value we need.
 *
 * The geometry renders up to 3 wrap instances:
 * Instance 0: wrapDirection=0 (normal rendering)
 * Instance 1: wrapDirection=+1 (shift negative rotatedLon by +360)
 * Instance 2: wrapDirection=-1 (shift positive rotatedLon by -360)
 * Call addWrapDirectionAttribute(geometry) before calling this.
 */
export function createProjectionInstancedMesh(
  geometry: THREE.InstancedBufferGeometry,
  material: THREE.Material,
  projectionType?: Pick<ProjectionHelper, "type">["type"],
  useAccurateEdges = true
): THREE.Mesh {
  setProjectionGeometryInstanceCount(
    geometry,
    projectionType
      ? getProjectionInstanceCount(projectionType, useAccurateEdges)
      : 1
  );
  const mesh = new THREE.Mesh(geometry, material);
  return mesh;
}
