#include "../../projection/glsl/projectionShaderFunctions.glsl"
#include "./projectionWrap.vert.glsl"

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
