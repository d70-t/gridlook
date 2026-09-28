#include "../../projection/glsl/projectionShaderFunctions.glsl"
#include "./projectionWrap.vert.glsl"
#include "./pathProjection.vert.glsl"

uniform int projectionType;
uniform float centerLon;
uniform float centerLat;
uniform vec3 projectionCenter;
uniform float projectionRadius;
uniform int edgeQuality;
#ifdef PATHLINE_PREVIEW
uniform sampler2D previewPositions;
uniform sampler2D previewLifetimes;
uniform ivec2 previewFrames;
uniform vec2 previewStart;
uniform vec2 previewEnd;
uniform uint particleCount;
#else
uniform sampler2D paths;
uniform sampler2D timeLow;
attribute uvec2 pathRange;
#endif
uniform vec2 currentTime;
uniform float fadeSeconds;
uniform float particleSize;
varying float vParticleAlpha;
varying vec3 vGlobePosition;

#ifdef PATHLINE_PREVIEW
vec3 previewPoint(uint frame, uint particle) {
  uint index = frame * particleCount + particle;
  uint width = uint(textureSize(previewPositions, 0).x);
  return texelFetch(previewPositions, ivec2(index % width, index / width), 0).xyz;
}
#else
ivec2 pathTexel(uint index) {
  uint width = uint(textureSize(paths, 0).x);
  return ivec2(index % width, index / width);
}

float timeFromNow(uint index) {
  ivec2 texel = pathTexel(index);
  // Split seconds retain sub-step precision even over long source time ranges.
  return (texelFetch(paths, texel, 0).w - currentTime.x) +
    (texelFetch(timeLow, texel, 0).r - currentTime.y);
}

#endif

void main() {
  vec3 point = vec3(0.0);
#ifdef PATHLINE_PREVIEW
  uint particle = uint(gl_VertexID);
  uint width = uint(textureSize(previewLifetimes, 0).x);
  vec4 life = texelFetch(previewLifetimes, ivec2(particle % width, particle / width), 0);
  float begin = (life.x - currentTime.x) + (life.y - currentTime.y);
  float end = (life.z - currentTime.x) + (life.w - currentTime.y);
  bool visible = begin < end && begin <= 0.0 && end >= 0.0;
  if (visible) {
    float ta = max(begin, (previewStart.x - currentTime.x) + (previewStart.y - currentTime.y));
    float tb = min(end, (previewEnd.x - currentTime.x) + (previewEnd.y - currentTime.y));
    vec3 a = previewPoint(uint(previewFrames.x), particle);
    vec3 b = previewPoint(uint(previewFrames.y), particle);
    // ponytail: keyframe interpolation can shortcut curved tracks. Full trajectory
    // mode and video export use all stored numerical samples instead.
    point = mix(a, b, tb > ta ? clamp(-ta / (tb - ta), 0.0, 1.0) : 0.0);
    visible = dot(point, point) > 0.000000000001;
    if (visible) point = normalize(point);
  }
#else
  // One point per trajectory. Find its bracketing numerical samples on the GPU;
  // no geometry or sample uploads are needed when playing or seeking.
  uint first = pathRange.x;
  // Empty trajectories use an exclusive end equal to the first slot.
  uint last = max(first + 1u, pathRange.y) - 1u;
  float begin = timeFromNow(first);
  float end = timeFromNow(max(first, last));
  bool visible = last > first && begin <= 0.0 && end >= 0.0;
  if (visible) {
    uint low = first;
    uint high = last;
    // Integer addressing preserves adjacent records beyond the float 2^24 limit.
    for (int i = 0; i < 32; i++) {
      if (high - low <= 1u) break;
      uint middle = low + (high - low) / 2u;
      if (timeFromNow(middle) <= 0.0) low = middle;
      else high = middle;
    }
    float ta = timeFromNow(low);
    float tb = timeFromNow(high);
    vec3 a = texelFetch(paths, pathTexel(low), 0).xyz;
    vec3 b = texelFetch(paths, pathTexel(high), 0).xyz;
    point = normalize(mix(a, b, clamp(-ta / (tb - ta), 0.0, 1.0)));
  }
#endif
  vec3 projected = vec3(0.0);
  if (visible) {
    vec2 latLon = unitVectorToLatLon(point);
    visible = !crossesAzimuthalClip(point, point, projectionType, projectionCenter);
    if (visible) {
      projected = projectWithWrap(latLon, projectionType, centerLon, centerLat,
        projectionRadius, 0.0, edgeQuality);
      visible = !isInvalidProjection(projected);
      if (visible && projectionType == PROJ_GLOBE) {
        visible = dot(normalize(projected), cameraPosition) >= projectionRadius;
      }
    }
  }
  // Fade at actual trajectory ends, including the selection boundaries. An
  // interior seed anchor is not a birth event and never resets the particle.
  float fade = min(fadeSeconds, max((end - begin) * 0.5, 0.000001));
  vParticleAlpha = visible ? smoothstep(0.0, fade, -begin) * smoothstep(0.0, fade, end) : 0.0;
  vGlobePosition = visible ? projected : vec3(0.0);
  // Hidden/faded particles must not all rasterize at the globe's center.
  gl_Position = visible && vParticleAlpha > 0.0
    ? projectionMatrix * modelViewMatrix * vec4(vGlobePosition, 1.0)
    : vec4(0.0, 0.0, 2.0, 1.0);
  gl_PointSize = particleSize;
}
