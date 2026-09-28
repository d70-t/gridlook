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
