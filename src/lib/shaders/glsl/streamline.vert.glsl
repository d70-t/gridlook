#include "../../projection/glsl/projectionShaderFunctions.glsl"

uniform int projectionType;
uniform float centerLonSin;
uniform float centerLonCos;
uniform float centerLatSin;
uniform float centerLatCos;
uniform float projectionRadius;
uniform float layerDepth;
uniform sampler2D pathTexture;
uniform vec2 pathTextureSize;
uniform float animationPhase;
uniform float trailSampleSeconds;
uniform float fadeInSeconds;
uniform float fadeOutSeconds;

attribute float trailOffset;
attribute float otherTrailOffset;
attribute float trailAlpha;
attribute vec3 pathInfo;

varying float vTrailAlpha;

vec4 readPathPoint(float pointIndex) {
  float row = floor(pointIndex / pathTextureSize.x);
  float column = pointIndex - row * pathTextureSize.x;
  vec2 uv = (vec2(column, row) + 0.5) / pathTextureSize;
  return texture2D(pathTexture, uv);
}

vec4 interpolatedPathPoint(float relativeIndex, float interpolation) {
  float index = clamp(relativeIndex, 0.0, pathInfo.y - 1.0);
  float nextIndex = min(index + 1.0, pathInfo.y - 1.0);
  vec4 start = readPathPoint(pathInfo.x + index);
  vec4 end = readPathPoint(pathInfo.x + nextIndex);
  return vec4(
    normalize(mix(start.xyz, end.xyz, interpolation)),
    mix(start.w, end.w, interpolation)
  );
}

vec2 rotateUnitVectorToLongitudePlane(vec3 point) {
  float relativeX = point.x * centerLonCos + point.y * centerLonSin;
  float relativeY = point.y * centerLonCos - point.x * centerLonSin;
  float rotatedX = point.z * centerLatSin + relativeX * centerLatCos;
  return vec2(rotatedX, relativeY);
}

vec4 rotateStreamlinePoint(vec3 point) {
  vec2 longitudePlane = rotateUnitVectorToLongitudePlane(point);
  float rotatedZ =
    point.z * centerLatCos -
    (point.x * centerLonCos + point.y * centerLonSin) * centerLatSin;
  return vec4(
    asin(clamp(rotatedZ, -1.0, 1.0)) * RAD_TO_DEG,
    atan(longitudePlane.y, longitudePlane.x) * RAD_TO_DEG,
    longitudePlane
  );
}

void main() {
  float animatedHead = mod(pathInfo.z + animationPhase, pathInfo.y);
  float headIndex = floor(animatedHead);
  float interpolation = fract(animatedHead);
  float pointIndex = headIndex + trailOffset;
  float otherPointIndex = headIndex + otherTrailOffset;
  bool validSegment =
    pointIndex >= 0.0 &&
    pointIndex + 1.0 < pathInfo.y &&
    otherPointIndex >= 0.0 &&
    otherPointIndex + 1.0 < pathInfo.y;

  vec4 pathPoint = interpolatedPathPoint(pointIndex, interpolation);
  float remainingSeconds =
    (pathInfo.y - 1.0 - animatedHead) * trailSampleSeconds;
  float lifeAlpha = min(
    1.0,
    min(
      animatedHead * trailSampleSeconds / fadeInSeconds,
      remainingSeconds / fadeOutSeconds
    )
  );
  vTrailAlpha = validSegment
    ? trailAlpha * max(lifeAlpha, 0.0) * pathPoint.w
    : 0.0;

  vec3 projected;
  if (projectionType == PROJ_GLOBE) {
    projected = pathPoint.xyz * projectionRadius;
  } else {
    vec4 otherPathPoint = interpolatedPathPoint(
      otherPointIndex,
      interpolation
    );
    vec4 rotated = rotateStreamlinePoint(pathPoint.xyz);
    vec2 otherLongitudePlane = rotateUnitVectorToLongitudePlane(
      otherPathPoint.xyz
    );
    // Detect the atan branch cut exactly from the two longitude-plane vectors,
    // without calculating the opposite endpoint's rotated longitude.
    float seamCross =
      rotated.w * otherLongitudePlane.x -
      rotated.z * otherLongitudePlane.y;
    bool discardSegment =
      rotated.w * otherLongitudePlane.y < 0.0 &&
      (rotated.w - otherLongitudePlane.y) * seamCross < 0.0;
    bool isAzimuthal =
      projectionType == PROJ_AZIMUTHAL_EQUIDISTANT ||
      projectionType == PROJ_AZIMUTHAL_HYBRID;
    if (isAzimuthal) {
      float clipCosine = cos(AZIMUTHAL_CLIP_ANGLE_RAD);
      discardSegment =
        discardSegment ||
        rotated.z < clipCosine ||
        otherLongitudePlane.x < clipCosine;
    }

    if (discardSegment) {
      // Avoid passing NaN or widely separated endpoints to line rasterization.
      // Both vertices see the same endpoint pair and collapse together.
      projected = vec3(0.0);
      vTrailAlpha = 0.0;
    } else {
      projected = projectRotatedLatLon(
        rotated.xy,
        projectionType,
        projectionRadius
      );
    }
  }
  projected.z += layerDepth;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(projected, 1.0);
}
