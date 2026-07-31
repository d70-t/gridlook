#include "../../projection/glsl/projectionShaderFunctions.glsl"
#include "./projectionWrap.vert.glsl"

uniform int projectionType;
uniform float centerLon;
uniform float centerLat;
uniform vec3 projectionCenter;
uniform float projectionRadius;
uniform float layerDepth;
uniform int edgeQuality;

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
attribute float wrapDirection;

varying float vTrailAlpha;

vec4 readPathPoint(float pointIndex) {
  float row = floor(
    pointIndex / pathTextureSize.x
  );

  float column =
    pointIndex -
    row * pathTextureSize.x;

  vec2 uv =
    (
      vec2(column, row) +
      0.5
    ) /
    pathTextureSize;

  return texture2D(pathTexture, uv);
}

vec4 interpolatedPathPoint(
  float relativeIndex,
  float interpolation
) {
  float index = clamp(
    relativeIndex,
    0.0,
    pathInfo.y - 1.0
  );

  float nextIndex = min(
    index + 1.0,
    pathInfo.y - 1.0
  );

  vec4 start = readPathPoint(
    pathInfo.x + index
  );

  vec4 end = readPathPoint(
    pathInfo.x + nextIndex
  );

  return vec4(
    normalize(
      mix(
        start.xyz,
        end.xyz,
        interpolation
      )
    ),

    mix(
      start.w,
      end.w,
      interpolation
    )
  );
}

vec2 unitVectorToLatLon(vec3 point) {
  return vec2(
    asin(
      clamp(
        point.z,
        -1.0,
        1.0
      )
    ) *
    RAD_TO_DEG,

    atan(
      point.y,
      point.x
    ) *
    RAD_TO_DEG
  );
}

bool shouldCullLineWrapInstance(
  vec2 startLatLon,
  vec2 endLatLon,
  int projType,
  float cLon,
  float cLat,
  float wrapDir,
  int quality
) {
  bool isBaseInstance =
    abs(wrapDir) < 0.5;

  if (
    quality <= 0 ||
    !projectionUsesWrappedInstances(
      projType
    )
  ) {
    return !isBaseInstance;
  }

  vec2 rotatedStart = rotateCoords(
    startLatLon.x,
    startLatLon.y,
    cLon,
    cLat
  );

  vec2 rotatedEnd = rotateCoords(
    endLatLon.x,
    endLatLon.y,
    cLon,
    cLat
  );

  bool crossesWrap =
    abs(
      rotatedEnd.y -
      rotatedStart.y
    ) >
    180.0;

  return crossesWrap
    ? isBaseInstance
    : !isBaseInstance;
}

bool crossesAzimuthalClip(
  vec3 startPoint,
  vec3 endPoint,
  int projType,
  vec3 centerPoint
) {
  bool isAzimuthal =
    projType == PROJ_AZIMUTHAL_EQUIDISTANT ||
    projType == PROJ_AZIMUTHAL_HYBRID;

  if (!isAzimuthal) {
    return false;
  }

  // Cull both vertices of a segment before projectRotatedLatLon returns NaN
  // for either endpoint. The small inward margin also absorbs floating-point
  // disagreement at the azimuthal clip boundary.
  float clipCosine =
    cos(AZIMUTHAL_CLIP_ANGLE_RAD) +
    0.00001;

  return
    dot(startPoint, centerPoint) <= clipCosine ||
    dot(endPoint, centerPoint) <= clipCosine;
}

bool isInvalidProjection(vec3 projected) {
  return any(notEqual(projected, projected));
}

void main() {
  float animatedHead = mod(
    pathInfo.z + animationPhase,
    pathInfo.y
  );

  float headIndex =
    floor(animatedHead);

  float interpolation =
    fract(animatedHead);

  float pointIndex =
    headIndex + trailOffset;

  float otherPointIndex =
    headIndex + otherTrailOffset;

  bool validSegment =
    pointIndex >= 0.0 &&
    pointIndex + 1.0 < pathInfo.y &&
    otherPointIndex >= 0.0 &&
    otherPointIndex + 1.0 < pathInfo.y;

  vec4 pathPoint =
    interpolatedPathPoint(
      pointIndex,
      interpolation
    );

  vec4 otherPathPoint =
    interpolatedPathPoint(
      otherPointIndex,
      interpolation
    );

  float remainingSeconds =
    (
      pathInfo.y -
      1.0 -
      animatedHead
    ) *
    trailSampleSeconds;

  float lifeAlpha = min(
    1.0,
    min(
      animatedHead *
        trailSampleSeconds /
        fadeInSeconds,

      remainingSeconds /
        fadeOutSeconds
    )
  );

  vec2 pathLatLon =
    unitVectorToLatLon(
      pathPoint.xyz
    );

  vec2 otherPathLatLon =
    unitVectorToLatLon(
      otherPathPoint.xyz
    );

  bool cullWrapInstance =
    shouldCullLineWrapInstance(
      pathLatLon,
      otherPathLatLon,
      projectionType,
      centerLon,
      centerLat,
      wrapDirection,
      edgeQuality
    );

  bool cullAzimuthalSegment =
    crossesAzimuthalClip(
      pathPoint.xyz,
      otherPathPoint.xyz,
      projectionType,
      projectionCenter
    );

  bool visible =
    validSegment &&
    !cullWrapInstance &&
    !cullAzimuthalSegment;

  vec3 projected = vec3(0.0);

  if (visible) {
    if (
      projectionType ==
      PROJ_GLOBE
    ) {
      projected =
        pathPoint.xyz *
        projectionRadius;
    } else {
      projected = projectWithWrap(
        pathLatLon,
        projectionType,
        centerLon,
        centerLat,
        projectionRadius,
        wrapDirection,
        edgeQuality
      );

      bool isAzimuthal =
        projectionType == PROJ_AZIMUTHAL_EQUIDISTANT ||
        projectionType == PROJ_AZIMUTHAL_HYBRID;

      if (isAzimuthal) {
        vec3 otherProjected = projectWithWrap(
          otherPathLatLon,
          projectionType,
          centerLon,
          centerLat,
          projectionRadius,
          wrapDirection,
          edgeQuality
        );

        bool invalidProjection =
          isInvalidProjection(projected) ||
          isInvalidProjection(otherProjected);

        // Adjacent cached samples are less than one degree apart. A projected
        // segment this long can therefore only be an azimuthal discontinuity
        // near the antipodal rim, not a real streamline step.
        bool implausiblyLong =
          distance(projected.xy, otherProjected.xy) >
          projectionRadius;

        if (
          invalidProjection ||
          implausiblyLong
        ) {
          visible = false;
          projected = vec3(0.0);
        }
      }
    }
  }

  vTrailAlpha = visible
    ? trailAlpha *
      max(lifeAlpha, 0.0) *
      pathPoint.w
    : 0.0;

  projected.z += layerDepth;

  gl_Position =
    projectionMatrix *
    modelViewMatrix *
    vec4(projected, 1.0);
}
