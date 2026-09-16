#include "../../projection/glsl/projectionConstants.glsl"

uniform vec3 lineColor;
uniform int projectionType;
uniform float azimuthalClipRadius;
uniform float projectionRadius;

varying float vHidden;
varying vec2 vProjectedXY;
varying vec3 vGlobePosition;

void main() {
  if (vHidden > 0.5) {
    discard;
  }

  // A surface point faces the camera only on this side of the tangent horizon.
  // Test per fragment so segments crossing the horizon are clipped, not dropped.
  if (projectionType == PROJ_GLOBE &&
      dot(normalize(vGlobePosition), cameraPosition) < projectionRadius) {
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
