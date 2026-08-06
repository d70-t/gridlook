bool projectionUsesWrappedInstances(int projType) {
  return
    projType != PROJ_GLOBE &&
    projType != PROJ_AZIMUTHAL_EQUIDISTANT &&
    projType != PROJ_AZIMUTHAL_HYBRID;
}

bool shouldCullTriangleWrapInstance(
  vec2 triLatLon0,
  vec2 triLatLon1,
  vec2 triLatLon2,
  int projType,
  float cLon,
  float cLat,
  float wrapDir,
  int edgeQuality,
  int useTriangleWrapCull
) {
  if (
    edgeQuality <= 0 ||
    useTriangleWrapCull <= 0 ||
    !projectionUsesWrappedInstances(projType)
  ) {
    return false;
  }

  float lon0 = rotateCoords(triLatLon0.x, triLatLon0.y, cLon, cLat).y;
  float lon1 = rotateCoords(triLatLon1.x, triLatLon1.y, cLon, cLat).y;
  float lon2 = rotateCoords(triLatLon2.x, triLatLon2.y, cLon, cLat).y;
  float minLon = min(lon0, min(lon1, lon2));
  float maxLon = max(lon0, max(lon1, lon2));
  bool crossesWrap = maxLon - minLon > 180.0;
  bool isBaseInstance = abs(wrapDir) < 0.5;

  return crossesWrap ? isBaseInstance : !isBaseInstance;
}

vec3 projectWithWrap(
  vec2 latLon,
  int projType,
  float cLon,
  float cLat,
  float radius,
  float wrapDir,
  int edgeQuality
) {
  // Globe projection is oriented by the camera; projection center must not rotate it.
  if (projType == PROJ_GLOBE) {
    return projectGlobe(latLon.x, latLon.y, radius);
  }
  vec2 rotated = rotateCoords(latLon.x, latLon.y, cLon, cLat);
  if (edgeQuality > 0 && wrapDir > 0.5 && rotated.y < 0.0) {
    rotated.y += 360.0;
  } else if (edgeQuality > 0 && wrapDir < -0.5 && rotated.y > 0.0) {
    rotated.y -= 360.0;
  }
  return projectRotatedLatLon(rotated, projType, radius);
}
