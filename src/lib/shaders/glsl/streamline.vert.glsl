#include "../../projection/glsl/projectionShaderFunctions.glsl"

uniform int projectionType;
uniform float centerLon;
uniform float centerLat;
uniform float projectionRadius;
uniform float layerDepth;

attribute vec2 latLon;
attribute float trailAlpha;

varying float vTrailAlpha;

void main() {
  vTrailAlpha = trailAlpha;
  vec3 projected = projectLatLon(
    latLon.x,
    latLon.y,
    projectionType,
    centerLon,
    centerLat,
    projectionRadius
  );
  projected.z += layerDepth;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(projected, 1.0);
}
