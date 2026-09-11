#include "../../projection/glsl/projectionConstants.glsl"

uniform vec3 color;
uniform float opacity;
uniform int projectionType;
uniform float projectionRadius;

varying float vTrailAlpha;
varying vec3 vGlobePosition;

void main() {
  // Surface stacking ignores depth, so explicitly hide the far side of the globe.
  if (projectionType == PROJ_GLOBE &&
      dot(normalize(vGlobePosition), cameraPosition) < projectionRadius) {
    discard;
  }
  gl_FragColor = vec4(color, opacity * vTrailAlpha);
}
