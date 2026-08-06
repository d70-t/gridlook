#include "../../projection/glsl/projectionConstants.glsl"

uniform vec3 lineColor;
uniform int projectionType;
uniform float azimuthalClipRadius;

varying float vHidden;
varying vec2 vProjectedXY;

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
