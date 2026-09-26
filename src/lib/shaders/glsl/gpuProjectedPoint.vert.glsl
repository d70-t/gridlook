#include "../../projection/glsl/projectionShaderFunctions.glsl"

uniform int projectionType;
uniform float centerLon;
uniform float centerLat;
uniform float projectionRadius;
uniform float basePointSize;
uniform float minPointSize;
uniform float maxPointSize;

attribute vec2 latLon;  // lat, lon in degrees
#include "./scalarTime.glsl"

attribute float data_value;
attribute float data_value_next;

varying float v_value;

void main() {
  v_value = scalarAtTime(data_value, data_value_next);
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
