#include "../../projection/glsl/projectionConstants.glsl"

uniform vec3 color;
uniform float opacity;
uniform int projectionType;
uniform float projectionRadius;
varying float vParticleAlpha;
varying vec3 vGlobePosition;

void main() {
  if (vParticleAlpha <= 0.0 || (projectionType == PROJ_GLOBE &&
      dot(normalize(vGlobePosition), cameraPosition) < projectionRadius)) {
    discard;
  }
  float radius = length(gl_PointCoord - 0.5) * 2.0;
  float edge = 1.0 - smoothstep(0.6, 1.0, radius);
  gl_FragColor = vec4(color, opacity * vParticleAlpha * edge);
}
