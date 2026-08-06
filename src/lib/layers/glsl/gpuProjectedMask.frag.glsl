#include "../../projection/glsl/projectionConstants.glsl"

uniform sampler2D maskTexture;
uniform vec4 textureBounds;
uniform float opacity;

varying vec3 vSpherePosition;

float longitudeToTextureU(float lon) {
  float west = textureBounds.x;
  float east = textureBounds.z;
  float span = east - west;
  float sampleLon = lon;
  if (span <= 0.0) {
    span += 360.0;
    if (sampleLon < west) sampleLon += 360.0;
  } else {
    if (sampleLon < west) sampleLon += 360.0;
    if (sampleLon > east) sampleLon -= 360.0;
  }
  return (sampleLon - west) / span;
}

void main() {
  vec3 spherePosition = normalize(vSpherePosition);
  float lon = degrees(atan(spherePosition.y, spherePosition.x));
  float lat = degrees(asin(clamp(spherePosition.z, -1.0, 1.0)));
  float u = longitudeToTextureU(lon);
  float v = (lat - textureBounds.y) / (textureBounds.w - textureBounds.y);
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) {
    discard;
  }
  vec4 texColor = texture2D(maskTexture, vec2(u, v));
  if (texColor.a < 0.01) {
    discard;
  }
  gl_FragColor = vec4(texColor.rgb, texColor.a * opacity);
  #include <colorspace_fragment>
}
