import * as THREE from "three";

import {
  projectionShaderFunctions,
  PROJECTION_TYPE_BY_MODE,
  getProjectionTypeFromMode,
} from "../projection/projectionShaders.ts";
import {
  PROJECTION_TYPES,
  type ProjectionHelper,
} from "../projection/projectionUtils.ts";

import {
  applyColormapShaders,
  availableColormaps,
  colormapShaders,
  type TColorMap,
} from "./colormapShaders.ts";

const isNaNGLSL = `
bool is_nan(float val) {
    uint bits = floatBitsToUint(val);
    // exponent all 1s (0x7F800000) AND non-zero mantissa = NaN
    // exponent all 1s AND zero mantissa = Infinity (not NaN)
    return (bits & 0x7F800000u) == 0x7F800000u && (bits & 0x007FFFFFu) != 0u;
}
`;

const posterizeGLSL = `
float posterize(float value, float levels) {
    if (levels > 1.0) {
        float step = floor(value * levels);
        step = min(step, levels - 1.0);  // Prevent overflow at max value
        return step / (levels - 1.0);
    }
    return value;
}
`;

const projectionWrapVertexGLSL = `
bool projectionUsesWrappedInstances(int projType) {
  return
    projType != PROJ_GLOBE &&
    projType != PROJ_AZIMUTHAL_EQUIDISTANT &&
    projType != PROJ_AZIMUTHAL_HYBRID;
}

bool shouldCullTriangleWrapInstance(
  vec2 triLatLon0,
  vec2 triLatLon1,
  vec2 triLatLon2,
  int projType,
  float cLon,
  float cLat,
  float wrapDir,
  int edgeQuality,
  int useTriangleWrapCull
) {
  if (
    edgeQuality <= 0 ||
    useTriangleWrapCull <= 0 ||
    !projectionUsesWrappedInstances(projType)
  ) {
    return false;
  }

  float lon0 = rotateCoords(triLatLon0.x, triLatLon0.y, cLon, cLat).y;
  float lon1 = rotateCoords(triLatLon1.x, triLatLon1.y, cLon, cLat).y;
  float lon2 = rotateCoords(triLatLon2.x, triLatLon2.y, cLon, cLat).y;
  float minLon = min(lon0, min(lon1, lon2));
  float maxLon = max(lon0, max(lon1, lon2));
  bool crossesWrap = maxLon - minLon > 180.0;
  bool isBaseInstance = abs(wrapDir) < 0.5;

  return crossesWrap ? isBaseInstance : !isBaseInstance;
}

vec3 projectWithWrap(
  vec2 latLon,
  int projType,
  float cLon,
  float cLat,
  float radius,
  float wrapDir,
  int edgeQuality
) {
  // Globe projection is oriented by the camera; projection center must not rotate it.
  if (projType == PROJ_GLOBE) {
    return projectGlobe(latLon.x, latLon.y, radius);
  }
  vec2 rotated = rotateCoords(latLon.x, latLon.y, cLon, cLat);
  if (edgeQuality > 0 && wrapDir > 0.5 && rotated.y < 0.0) {
    rotated.y += 360.0;
  } else if (edgeQuality > 0 && wrapDir < -0.5 && rotated.y > 0.0) {
    rotated.y -= 360.0;
  }
  return projectRotatedLatLon(rotated, projType, radius);
}
`;

const textureColormapFragmentShader = `
${projectionShaderFunctions}

${colormapShaders}

${isNaNGLSL}

${posterizeGLSL}

uniform float addOffset;
uniform float scaleFactor;
uniform int colormap;
uniform float posterizeLevels;
uniform float hideBelowValue;
uniform sampler2D data;
uniform int projectionType;
uniform float projectionRadius;
uniform int edgeQuality;

varying vec2 vUv;
varying vec2 vProjectedXY;

void main() {
  if (edgeQuality > 0 && !isInsideProjectionDomain(vProjectedXY, projectionType, projectionRadius)) {
        discard;
    }
    gl_FragColor.a = 1.0;
    float v_value = texture(data, vUv).r;
    if (is_nan(v_value) || v_value <= hideBelowValue) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
        return;
    }
    float normalized_value = clamp(addOffset + scaleFactor * v_value, 0.0, 1.0);
    normalized_value = posterize(normalized_value, posterizeLevels);

    ${applyColormapShaders}
}`;

// credits: https://www.shadertoy.com/view/3lBXR3
//          https://github.com/mzucker/fit_colormaps
const scalarColormapFragmentShader = `
${projectionShaderFunctions}

${colormapShaders}

${isNaNGLSL}

${posterizeGLSL}

varying float v_value;
uniform float addOffset;
uniform float scaleFactor;
uniform int colormap;
uniform float posterizeLevels;
uniform float hideBelowValue;
uniform int projectionType;
uniform float projectionRadius;
uniform int edgeQuality;

varying vec2 vProjectedXY;

void main() {
    if (
    (edgeQuality > 0 && !isInsideProjectionDomain(vProjectedXY, projectionType, projectionRadius)) ||
        is_nan(v_value) ||
        v_value <= hideBelowValue
    ) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
        return;
    }
    float normalized_value = clamp(addOffset + scaleFactor * v_value, 0.0, 1.0);
    normalized_value = posterize(normalized_value, posterizeLevels);
    ${applyColormapShaders}
    gl_FragColor.a = 1.0;
}`;

const screenQuadValueVertexShader = `
    attribute float data_value;

    varying float v_value;

    void main() {
      v_value = data_value;
      gl_Position = vec4(position,1.0);
    }
    `;

const pointFalloffFragmentShader = `
${colormapShaders}

${isNaNGLSL}

${posterizeGLSL}

varying float v_value;
uniform float addOffset;
uniform float scaleFactor;
uniform int colormap;
uniform float posterizeLevels;
uniform float hideBelowValue;

void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;

    // Normalize scalar value for color mapping
    float normalized_value = clamp(addOffset + scaleFactor * v_value, 0.0, 1.0);
    normalized_value = posterize(normalized_value, posterizeLevels);
    float r2 = dot(uv, uv);
    // Soft circular splat using Gaussian falloff
    float falloff = exp(-r2 * 2.0); // Adjust the 4.0 as needed (sharpness)
    if (falloff < 0.01) discard; // Optional: discard transparent fragments


    if (is_nan(v_value) || v_value <= hideBelowValue) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
        return;
    }

    ${applyColormapShaders}
    gl_FragColor.a = falloff;
}`;

const compressedLutFragmentShader = `
${colormapShaders}

${isNaNGLSL}

${posterizeGLSL}

varying float v_value;
uniform float addOffset;
uniform float scaleFactor;
uniform int colormap;
uniform float posterizeLevels;
uniform float selLow;
uniform float selHigh;

void main() {
    if (v_value < selLow || v_value > selHigh) {
        // Sample the colormap at its minimum or maximum edge color
        float t_edge = v_value < selLow ? 0.0 : 1.0;
        float normalized_value = clamp(addOffset + scaleFactor * t_edge, 0.0, 1.0);
        normalized_value = posterize(normalized_value, posterizeLevels);
        ${applyColormapShaders}
        gl_FragColor.a = 1.0;
        return;
    }
    float range = max(selHigh - selLow, 0.0001);
    float t = (v_value - selLow) / range;
    float normalized_value = clamp(addOffset + scaleFactor * t, 0.0, 1.0);
    normalized_value = posterize(normalized_value, posterizeLevels);
    ${applyColormapShaders}
    gl_FragColor.a = 1.0;
}`;

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
 * Vertex shader for GPU-projected texture-based rendering (Regular/HEALPix grids).
 * Takes lat/lon as attributes and projects them on the GPU.
 */
const gpuProjectedTextureVertexShader = `
${projectionShaderFunctions}

${projectionWrapVertexGLSL}

uniform int projectionType;
uniform float centerLon;
uniform float centerLat;
uniform float projectionRadius;
uniform int edgeQuality;
uniform int useTriangleWrapCull;

attribute vec2 latLon;  // lat, lon in degrees
attribute float wrapDirection;
attribute vec2 triangleLatLon0;
attribute vec2 triangleLatLon1;
attribute vec2 triangleLatLon2;

varying vec2 vUv;
varying vec2 vProjectedXY;

void main() {
  vUv = uv;
  if (
    shouldCullTriangleWrapInstance(
      triangleLatLon0,
      triangleLatLon1,
      triangleLatLon2,
      projectionType,
      centerLon,
      centerLat,
      wrapDirection,
      edgeQuality,
      useTriangleWrapCull
    )
  ) {
    vProjectedXY = vec2(1000000.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }
  vec3 projected = projectWithWrap(
    latLon,
    projectionType,
    centerLon,
    centerLat,
    projectionRadius,
    wrapDirection,
    edgeQuality
  );
  vProjectedXY = projected.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(projected, 1.0);
}
`;

/**
 * Vertex shader for GPU-projected mesh-based rendering (Triangular/Curvilinear/Gaussian grids).
 * Takes lat/lon as attributes and projects them on the GPU.
 */
const gpuProjectedMeshVertexShader = `
${projectionShaderFunctions}

${projectionWrapVertexGLSL}

uniform int projectionType;
uniform float centerLon;
uniform float centerLat;
uniform float projectionRadius;
uniform float pointSize;
uniform int edgeQuality;

attribute vec2 latLon;  // lat, lon in degrees
attribute float data_value;
attribute float wrapDirection;

varying float v_value;
varying vec2 vProjectedXY;

void main() {
  v_value = data_value;
  vec3 projected = projectWithWrap(
    latLon,
    projectionType,
    centerLon,
    centerLat,
    projectionRadius,
    wrapDirection,
    edgeQuality
  );
  vProjectedXY = projected.xy;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(projected, 1.0);
  if (pointSize > 0.0) {
    gl_PointSize = pointSize;
  }
}
`;

/**
 * Vertex shader for GPU-projected point clouds (Irregular grids).
 */
const gpuProjectedPointVertexShader = `
${projectionShaderFunctions}

uniform int projectionType;
uniform float centerLon;
uniform float centerLat;
uniform float projectionRadius;
uniform float basePointSize;
uniform float minPointSize;
uniform float maxPointSize;

attribute vec2 latLon;  // lat, lon in degrees
attribute float data_value;

varying float v_value;

void main() {
  v_value = data_value;
  vec3 projected = projectLatLon(
    latLon.x,
    latLon.y,
    projectionType,
    centerLon,
    centerLat,
    projectionRadius
  );
  vec4 mvPosition = modelViewMatrix * vec4(projected, 1.0);
  gl_Position = projectionMatrix * mvPosition;

  float sizeFactor = basePointSize;
  gl_PointSize = clamp(sizeFactor, minPointSize, maxPointSize);
}
`;

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
    transparent: true,
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
      pointSize: { value: 0.0 },
      colormap: { value: availableColormaps[colormap] },
      posterizeLevels: { value: 0.0 },
      hideBelowValue: { value: -1e38 },
      // Projection uniforms
      projectionType: {
        value: PROJECTION_TYPE_BY_MODE[PROJECTION_TYPES.NEARSIDE_PERSPECTIVE],
      },
      centerLon: { value: 0.0 },
      centerLat: { value: 0.0 },
      projectionRadius: { value: 1.0 },
      edgeQuality: { value: 1 },
    },
    transparent: true,
    vertexShader: gpuProjectedMeshVertexShader,
    fragmentShader: scalarColormapFragmentShader,
  });
  (material.defaultAttributeValues as Record<string, unknown>).wrapDirection = [
    0,
  ];
  return material;
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
