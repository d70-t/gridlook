#include "../../projection/glsl/projectionShaderFunctions.glsl"
#include "../../shaders/glsl/isNaN.glsl"

uniform int projectionType;
uniform float centerLon;
uniform float centerLat;
uniform float projectionRadius;
uniform float zOffset;

attribute vec2 latLon;
attribute vec2 segmentOtherLatLon;

varying float vHidden;
varying vec2 vProjectedXY;

bool isInvalidProjection(vec3 projected) {
  return is_nan(projected.x) || is_nan(projected.y) || is_nan(projected.z);
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
