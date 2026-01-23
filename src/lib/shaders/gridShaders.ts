import * as THREE from "three";

import {
  projectionShaderFunctions,
  PROJECTION_TYPE_BY_MODE,
  getProjectionTypeFromMode,
} from "../projection/projectionShaders";
import {
  PROJECTION_TYPES,
  type TProjectionType,
} from "../projection/projectionUtils";

import {
  applyColormapShaders,
  availableColormaps,
  colormapShaders,
  type TColorMap,
} from "./colormapShaders";

const isNaNGLSL = `
bool is_nan(float v) {
    return v != v;
}
`;

const textureColormapFragmentShader = `
${colormapShaders}

${isNaNGLSL}


uniform float addOffset;
uniform float scaleFactor;
uniform float missingValue;
uniform float fillValue;
uniform int colormap;
uniform sampler2D data;

varying vec2 vUv;

void main() {
    gl_FragColor.a = 1.0;
    float v_value = texture(data, vUv).r;
    if (is_nan(v_value) || v_value == fillValue || v_value == missingValue) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
        return;
    }
    float normalized_value = clamp(addOffset + scaleFactor * v_value, 0.0, 1.0);

    ${applyColormapShaders}
}`;

// credits: https://www.shadertoy.com/view/3lBXR3
//          https://github.com/mzucker/fit_colormaps
const scalarColormapFragmentShader = `
${colormapShaders}

${isNaNGLSL}

varying float v_value;
uniform float addOffset;
uniform float scaleFactor;
uniform int colormap;
uniform float missingValue;
uniform float fillValue;

void main() {
    if (is_nan(v_value) || v_value == fillValue || v_value == missingValue) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
        return;
    }
    float normalized_value = clamp(addOffset + scaleFactor * v_value, 0.0, 1.0);
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

varying float v_value;
uniform float addOffset;
uniform float scaleFactor;
uniform int colormap;
uniform float fillValue;
uniform float missingValue;

void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;

    // Normalize scalar value for color mapping
    float normalized_value = clamp(addOffset + scaleFactor * v_value, 0.0, 1.0);
    float r2 = dot(uv, uv);
    // Soft circular splat using Gaussian falloff
    float falloff = exp(-r2 * 2.0); // Adjust the 4.0 as needed (sharpness)
    if (falloff < 0.01) discard; // Optional: discard transparent fragments


    if (is_nan(v_value) || v_value == fillValue || v_value == missingValue) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
        return;
    }

    ${applyColormapShaders}
    gl_FragColor.a = falloff;
}`;

export function makeColormapLutMaterial(
  colormap: TColorMap = "turbo",
  addOffset: 0 | 1,
  scaleFactor: 1 | -1
) {
  const material = new THREE.ShaderMaterial({
    uniforms: {
      addOffset: { value: addOffset },
      scaleFactor: { value: scaleFactor },
      colormap: { value: availableColormaps[colormap] },
    },

    vertexShader: screenQuadValueVertexShader,
    fragmentShader: scalarColormapFragmentShader,
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

uniform int projectionType;
uniform float centerLon;
uniform float centerLat;
uniform float projectionRadius;

attribute vec2 latLon;  // lat, lon in degrees

varying vec2 vUv;

void main() {
  vUv = uv;
  vec3 projected = projectLatLon(latLon.x, latLon.y, projectionType, centerLon, centerLat, projectionRadius);
  gl_Position = projectionMatrix * modelViewMatrix * vec4(projected, 1.0);
}
`;

/**
 * Vertex shader for GPU-projected mesh-based rendering (Triangular/Curvilinear/Gaussian grids).
 * Takes lat/lon as attributes and projects them on the GPU.
 */
const gpuProjectedMeshVertexShader = `
${projectionShaderFunctions}

uniform int projectionType;
uniform float centerLon;
uniform float centerLat;
uniform float projectionRadius;
uniform float pointSize;

attribute vec2 latLon;  // lat, lon in degrees
attribute float data_value;

varying float v_value;

void main() {
  v_value = data_value;
  vec3 projected = projectLatLon(latLon.x, latLon.y, projectionType, centerLon, centerLat, projectionRadius);
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
  vec3 projected = projectLatLon(latLon.x, latLon.y, projectionType, centerLon, centerLat, projectionRadius);
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
      fillValue: { value: Number.POSITIVE_INFINITY },
      missingValue: { value: Number.POSITIVE_INFINITY },
      data: { value: texture },
      // Projection uniforms
      projectionType: {
        value: PROJECTION_TYPE_BY_MODE[PROJECTION_TYPES.NEARSIDE_PERSPECTIVE],
      },
      centerLon: { value: 0.0 },
      centerLat: { value: 0.0 },
      projectionRadius: { value: 1.0 },
    },
    transparent: true,
    vertexShader: gpuProjectedTextureVertexShader,
    fragmentShader: textureColormapFragmentShader,
  });
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
      fillValue: { value: Number.POSITIVE_INFINITY },
      missingValue: { value: Number.POSITIVE_INFINITY },
      // Projection uniforms
      projectionType: {
        value: PROJECTION_TYPE_BY_MODE[PROJECTION_TYPES.NEARSIDE_PERSPECTIVE],
      },
      centerLon: { value: 0.0 },
      centerLat: { value: 0.0 },
      projectionRadius: { value: 1.0 },
    },
    transparent: true,
    vertexShader: gpuProjectedMeshVertexShader,
    fragmentShader: scalarColormapFragmentShader,
  });
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
      fillValue: { value: Number.POSITIVE_INFINITY },
      missingValue: { value: Number.POSITIVE_INFINITY },
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
  projectionType: TProjectionType,
  centerLon: number,
  centerLat: number,
  radius: number = 1.0
) {
  const projectionTypeId = getProjectionTypeFromMode(projectionType);
  if (material.uniforms.projectionType) {
    material.uniforms.projectionType.value = projectionTypeId;
  }
  if (material.uniforms.centerLon) {
    material.uniforms.centerLon.value = centerLon;
  }
  if (material.uniforms.centerLat) {
    material.uniforms.centerLat.value = centerLat;
  }
  if (material.uniforms.projectionRadius) {
    material.uniforms.projectionRadius.value = radius;
  }
}
