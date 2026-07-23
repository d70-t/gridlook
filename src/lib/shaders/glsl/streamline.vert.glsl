#include "../../projection/glsl/projectionShaderFunctions.glsl"

uniform int projectionType;
uniform float centerLon;
uniform float centerLat;
uniform float projectionRadius;
uniform float layerDepth;

attribute vec2 latLon;
attribute float trailAlpha;

varying float vTrailAlpha;

float azimuthalAngularDistance(vec2 rotated) {
  float latRad = rotated.x * DEG_TO_RAD;
  float lonRad = rotated.y * DEG_TO_RAD;
  return acos(clamp(cos(latRad) * cos(lonRad), -1.0, 1.0));
}

void main() {
  vTrailAlpha = trailAlpha;
  vec3 projected;
  if (projectionType == PROJ_GLOBE) {
    projected = projectGlobe(latLon.x, latLon.y, projectionRadius);
  } else {
    vec2 rotated = rotateCoords(latLon.x, latLon.y, centerLon, centerLat);
    // The position attribute carries the other endpoint of this line segment.
    // Comparing rotated longitudes makes the seam follow projection-center
    // changes, including the clipped antipodal seam of azimuthal maps.
    vec2 otherRotated = rotateCoords(
      position.x,
      position.y,
      centerLon,
      centerLat
    );
    bool discardSegment = abs(rotated.y - otherRotated.y) > 180.0;
    bool isAzimuthal =
      projectionType == PROJ_AZIMUTHAL_EQUIDISTANT ||
      projectionType == PROJ_AZIMUTHAL_HYBRID;
    if (isAzimuthal) {
      discardSegment =
        discardSegment ||
        azimuthalAngularDistance(rotated) > AZIMUTHAL_CLIP_ANGLE_RAD ||
        azimuthalAngularDistance(otherRotated) > AZIMUTHAL_CLIP_ANGLE_RAD;
    }

    if (discardSegment) {
      // Avoid passing NaN or widely separated endpoints to line rasterization.
      // Both vertices see the same endpoint pair and collapse together.
      projected = vec3(0.0);
      vTrailAlpha = 0.0;
    } else {
      projected = projectRotatedLatLon(
        rotated,
        projectionType,
        projectionRadius
      );
    }
  }
  projected.z += layerDepth;
  gl_Position = projectionMatrix * modelViewMatrix * vec4(projected, 1.0);
}
