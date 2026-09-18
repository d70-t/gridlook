#include "../../projection/glsl/inverseProjection.glsl"

uniform sampler2D maskTexture;
uniform vec4 textureBounds;
uniform float opacity;
uniform int projectionType;
uniform float centerLon;
uniform float centerLat;

varying vec2 vProjectedCoord;

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
  vec3 result = inverseProjectLatLon(vProjectedCoord.x, vProjectedCoord.y, projectionType);
  if (result.z < 0.0) discard;

  vec2 geo = unrotateCoords(result.x, result.y, centerLon, centerLat);

  // Normalize longitude to [-180, 180]
  float lon = mod(geo.y + 180.0, 360.0) - 180.0;

  float u = longitudeToTextureU(lon);
  float v = (geo.x - textureBounds.y) / (textureBounds.w - textureBounds.y);
  if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) discard;

  vec4 texColor = texture2D(maskTexture, vec2(u, v));
  if (texColor.a < 0.01) discard;
  gl_FragColor = vec4(texColor.rgb, texColor.a * opacity);
  #include <colorspace_fragment>
}
