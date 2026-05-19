#include "../../projection/glsl/projectionShaderFunctions.glsl"
#include "./projectionWrap.vert.glsl"

uniform int projectionType;
uniform float centerLon;
uniform float centerLat;
uniform float projectionRadius;
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
}
