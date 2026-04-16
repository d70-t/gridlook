import * as THREE from "three";

import {
  getProjectionTypeFromMode,
  projectionShaderFunctions,
} from "@/lib/projection/projectionShaders.ts";
import {
  AZIMUTHAL_CLIP_ANGLE,
  type ProjectionHelper,
} from "@/lib/projection/projectionUtils.ts";

type TGpuProjectedLineOptions = {
  color: THREE.ColorRepresentation;
  radius: number;
  zOffset: number;
};

const OVERLAY_AZIMUTHAL_CLIP_MARGIN_DEGREES = 1.0;

const gpuProjectedLineVertexShader = `
${projectionShaderFunctions}

uniform int projectionType;
uniform float centerLon;
uniform float centerLat;
uniform float projectionRadius;
uniform float zOffset;

attribute vec2 latLon;
attribute vec2 segmentOtherLatLon;

varying float vHidden;
varying vec2 vProjectedXY;

bool isNanValue(float value) {
  return value != value;
}

bool isInvalidProjection(vec3 projected) {
  return isNanValue(projected.x) || isNanValue(projected.y) || isNanValue(projected.z);
}

void main() {
  vec3 projected = projectLatLon(
    latLon.x,
    latLon.y,
    projectionType,
    centerLon,
    centerLat,
    projectionRadius
  );
  vec2 rotated = rotateCoords(
    latLon.x,
    latLon.y,
    centerLon,
    centerLat
  );
  vec2 otherRotated = rotateCoords(
    segmentOtherLatLon.x,
    segmentOtherLatLon.y,
    centerLon,
    centerLat
  );
  vec3 otherProjected = projectLatLon(
    segmentOtherLatLon.x,
    segmentOtherLatLon.y,
    projectionType,
    centerLon,
    centerLat,
    projectionRadius
  );

  bool hideSegment =
    isInvalidProjection(projected) ||
    isInvalidProjection(otherProjected) ||
    (projectionType != PROJ_GLOBE &&
      abs(rotated.y - otherRotated.y) > 180.0);

  // For azimuthal projections, also hide segments whose projected endpoints
  // are far apart. After densification, geographic segments are <= 2 degrees,
  // so their projected distance is bounded. Wraparound artifacts near the
  // antipode produce projected distances >> radius.
  if (!hideSegment && (projectionType == PROJ_AZIMUTHAL_EQUIDISTANT || projectionType == PROJ_AZIMUTHAL_HYBRID)) {
    hideSegment = distance(projected.xy, otherProjected.xy) > projectionRadius;
  }

  vHidden = hideSegment ? 1.0 : 0.0;
  if (hideSegment) {
    vProjectedXY = vec2(0.0);
    gl_Position = vec4(2.0, 2.0, 2.0, 1.0);
    return;
  }

  vProjectedXY = projected.xy;
  projected.z += zOffset;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(projected, 1.0);
}
`;

const gpuProjectedLineFragmentShader = `
uniform vec3 lineColor;
uniform int projectionType;
uniform float azimuthalClipRadius;

varying float vHidden;
varying vec2 vProjectedXY;

const int PROJ_AZIMUTHAL_EQUIDISTANT = 6;
const int PROJ_AZIMUTHAL_HYBRID = 7;

void main() {
  if (vHidden > 0.5) {
    discard;
  }

  if (
    (projectionType == PROJ_AZIMUTHAL_EQUIDISTANT || projectionType == PROJ_AZIMUTHAL_HYBRID) &&
    length(vProjectedXY) > azimuthalClipRadius
  ) {
    discard;
  }

  gl_FragColor = vec4(lineColor, 1.0);
}
`;

export function makeGpuProjectedLineMaterial(
  options: TGpuProjectedLineOptions
) {
  return new THREE.ShaderMaterial({
    uniforms: {
      lineColor: { value: new THREE.Color(options.color) },
      projectionType: { value: 0 },
      centerLon: { value: 0.0 },
      centerLat: { value: 0.0 },
      projectionRadius: { value: options.radius },
      azimuthalClipRadius: {
        value:
          ((AZIMUTHAL_CLIP_ANGLE - OVERLAY_AZIMUTHAL_CLIP_MARGIN_DEGREES) *
            Math.PI) /
          180.0,
      },
      zOffset: { value: options.zOffset },
    },
    transparent: true,
    depthWrite: false,
    vertexShader: gpuProjectedLineVertexShader,
    fragmentShader: gpuProjectedLineFragmentShader,
  });
}

export function updateGpuProjectedLineMaterial(
  material: THREE.ShaderMaterial,
  helper: ProjectionHelper,
  options: Omit<TGpuProjectedLineOptions, "color">
) {
  material.uniforms.projectionType.value = getProjectionTypeFromMode(
    helper.type
  );
  material.uniforms.centerLon.value = helper.center.lon;
  material.uniforms.centerLat.value = helper.center.lat;
  material.uniforms.projectionRadius.value = options.radius;
  material.uniforms.zOffset.value = options.zOffset;
  material.depthTest = !helper.isFlat;
}
