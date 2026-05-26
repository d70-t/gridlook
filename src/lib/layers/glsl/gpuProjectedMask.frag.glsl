#include "../../projection/glsl/projectionConstants.glsl"

uniform sampler2D maskTexture;
uniform float opacity;

varying vec3 vSpherePosition;

void main() {
  vec3 spherePosition = normalize(vSpherePosition);
  float lon = atan(spherePosition.y, spherePosition.x);
  float lat = asin(clamp(spherePosition.z, -1.0, 1.0));
  float u = (lon + PI) / (2.0 * PI);
  float v = (lat + PI * 0.5) / PI;
  vec4 texColor = texture2D(maskTexture, vec2(u, v));
  if (texColor.a < 0.01) {
    discard;
  }
  gl_FragColor = vec4(texColor.rgb, texColor.a * opacity);
}
