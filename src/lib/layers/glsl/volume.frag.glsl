precision highp float;
precision highp sampler3D;

uniform sampler3D volumeData;
uniform float innerRadius;
uniform float outerRadius;
uniform float opacity;
uniform int stepCount;
uniform int channelCount;
uniform vec3 channelColors[4];
uniform float channelOpacities[4];

in vec3 volumeWorldPosition;
out vec4 outputColor;

uniform int projectionType;
uniform float centerLon;
uniform float centerLat;
uniform vec4 textureBounds;

#include "../../projection/glsl/inverseProjection.glsl"
const int MAX_STEP_COUNT = 72;

vec2 intersectSphere(vec3 origin, vec3 direction, float radius) {
  float b = dot(origin, direction);
  float c = dot(origin, origin) - radius * radius;
  float discriminant = b * b - c;
  if (discriminant < 0.0) {
    return vec2(1.0, -1.0);
  }
  float root = sqrt(discriminant);
  return vec2(-b - root, -b + root);
}

float screenNoise(vec2 point) {
  return fract(sin(dot(point, vec2(12.9898, 78.233))) * 43758.5453);
}

vec3 sphericalTextureCoordinate(vec3 position) {
  float radius = length(position);
  float longitude = atan(position.y, position.x);
  float latitude = asin(clamp(position.z / radius, -1.0, 1.0));
  return vec3(
    longitude * RAD_TO_DEG,
    latitude * RAD_TO_DEG,
    clamp((radius - innerRadius) / (outerRadius - innerRadius), 0.0, 1.0)
  );
}

void main() {
  vec3 rayOrigin = cameraPosition;
  vec3 rayDirection = normalize(volumeWorldPosition - cameraPosition);
  float rayStart = 0.0;
  float rayEnd = 1.0;
  vec2 geographic = vec2(0.0);
  if (projectionType == PROJ_GLOBE) {
    vec2 outerHit = intersectSphere(rayOrigin, rayDirection, outerRadius);
    if (outerHit.y <= 0.0) discard;
    rayStart = max(outerHit.x, 0.0);
    rayEnd = outerHit.y;
    vec2 innerHit = intersectSphere(rayOrigin, rayDirection, innerRadius);
    if (innerHit.x > rayStart && innerHit.x < rayEnd) rayEnd = innerHit.x;
    if (rayEnd <= rayStart) discard;
  } else {
    vec3 projected = inverseProjectLatLon(volumeWorldPosition.x, volumeWorldPosition.y, projectionType);
    if (projected.z < 0.0) discard;
    geographic = unrotateCoords(projected.x, projected.y, centerLon, centerLat).yx;
  }
  float stepLength = (rayEnd - rayStart) / float(stepCount);
  float jitter = screenNoise(gl_FragCoord.xy);
  vec4 accumulated = vec4(0.0);

  for (int stepIndex = 0; stepIndex < MAX_STEP_COUNT; stepIndex++) {
    if (stepIndex >= stepCount) {
      break;
    }
    float distanceAlongRay =
      rayStart + (float(stepIndex) + jitter) * stepLength;
    vec3 samplePosition = rayOrigin + rayDirection * distanceAlongRay;
    // Flat maps composite the same column from its top down to the surface.
    vec3 textureCoordinate = projectionType == PROJ_GLOBE
      ? sphericalTextureCoordinate(samplePosition)
      : vec3(geographic, 1.0 - distanceAlongRay);
    float longitudeSpan = textureBounds.z - textureBounds.x;
    float longitudeOffset = mod(textureCoordinate.x - textureBounds.x, 360.0);
    textureCoordinate.x = longitudeOffset / longitudeSpan;
    textureCoordinate.y = (textureCoordinate.y - textureBounds.y) / (textureBounds.w - textureBounds.y);
    if (textureCoordinate.x > 1.0 || textureCoordinate.y < 0.0 || textureCoordinate.y > 1.0) continue;
    // The CPU stores complete vertical columns contiguously: texture X is
    // altitude, Y is longitude, and Z is latitude.
    vec4 channelDensities = texture(
      volumeData,
      vec3(textureCoordinate.z, textureCoordinate.x, textureCoordinate.y)
    );
    float combinedDensity = 0.0;
    vec3 weightedColor = vec3(0.0);
    for (int channel = 0; channel < 4; channel++) {
      if (channel >= channelCount) {
        break;
      }
      float channelDensity =
        channelDensities[channel] * channelOpacities[channel];
      combinedDensity += channelDensity;
      weightedColor += channelDensity * channelColors[channel];
    }
    float density = smoothstep(0.015, 0.75, min(combinedDensity, 1.0));

    float relativeStep = projectionType == PROJ_GLOBE ? stepLength / (outerRadius - innerRadius) : stepLength;
    float sampleAlpha =
      (1.0 - exp(-density * 5.0 * relativeStep)) * opacity;
    vec3 cloudColor = weightedColor / max(combinedDensity, 0.0001);
    accumulated.rgb +=
      (1.0 - accumulated.a) * sampleAlpha * cloudColor;
    accumulated.a += (1.0 - accumulated.a) * sampleAlpha;

    if (accumulated.a > 0.985) {
      break;
    }
  }

  if (accumulated.a <= 0.001) {
    discard;
  }
  outputColor = vec4(
    accumulated.rgb / max(accumulated.a, 0.0001),
    accumulated.a
  );
}
