#include "../../projection/glsl/projectionShaderFunctions.glsl"

// Unrotate: inverse of rotateCoords. Recovers geographic (lat, lon) from
// the rotated frame produced by the forward projection.
vec2 unrotateCoords(float rotatedLat, float rotatedLon, float cLon, float cLat) {
  float latRad = rotatedLat * DEG_TO_RAD;
  float lonRad = rotatedLon * DEG_TO_RAD;
  float cLatRad = cLat * DEG_TO_RAD;

  float cosLat = cos(latRad);
  float sinLat = sin(latRad);
  float cosLon = cos(lonRad);
  float sinLon = sin(lonRad);
  float cosCLat = cos(cLatRad);
  float sinCLat = sin(cLatRad);

  float newSinLat = sinLat * cosCLat + cosLat * cosLon * sinCLat;
  float newLat = asin(clamp(newSinLat, -1.0, 1.0));

  float y = cosLat * sinLon;
  float x = cosLat * cosLon * cosCLat - sinLat * sinCLat;
  float newLon = atan(y, x) + cLon * DEG_TO_RAD;

  return vec2(newLat * RAD_TO_DEG, newLon * RAD_TO_DEG);
}

// --- Inverse projection functions ---
// Each returns vec3(rotatedLat, rotatedLon, valid).
// valid < 0 means the point is outside the projection domain.

vec3 inverseEquirectangular(float x, float y) {
  float rLon = x * RAD_TO_DEG;
  float rLat = y * RAD_TO_DEG;
  if (abs(rLat) > 90.0 || abs(rLon) > 180.0) return vec3(0.0, 0.0, -1.0);
  return vec3(rLat, rLon, 1.0);
}

vec3 inverseMercator(float x, float y) {
  float rLon = x * RAD_TO_DEG;
  float rLat = (2.0 * atan(exp(y)) - PI * 0.5) * RAD_TO_DEG;
  if (abs(rLat) > MERCATOR_LAT_LIMIT || abs(rLon) > 180.0) return vec3(0.0, 0.0, -1.0);
  return vec3(rLat, rLon, 1.0);
}

vec3 inverseCylindricalEqualArea(float x, float y) {
  float sinLat = y / CYLINDRICAL_EQUAL_AREA_SCALE;
  if (abs(sinLat) > 1.0) return vec3(0.0, 0.0, -1.0);
  float rLon = x * CYLINDRICAL_EQUAL_AREA_SCALE * RAD_TO_DEG;
  if (abs(rLon) > 180.0) return vec3(0.0, 0.0, -1.0);
  return vec3(asin(sinLat) * RAD_TO_DEG, rLon, 1.0);
}

vec3 inverseMollweide(float x, float y) {
  float sinTheta = y / sqrt(2.0);
  if (abs(sinTheta) > 1.0) return vec3(0.0, 0.0, -1.0);
  float theta = asin(sinTheta);
  float cosTheta = cos(theta);

  float rLon;
  if (abs(cosTheta) < 0.0001) {
    rLon = 0.0;
  } else {
    rLon = (PI * x / (2.0 * sqrt(2.0) * cosTheta)) * RAD_TO_DEG;
  }
  if (abs(rLon) > 180.0) return vec3(0.0, 0.0, -1.0);

  float sinLatVal = (2.0 * theta + sin(2.0 * theta)) / PI;
  if (abs(sinLatVal) > 1.0) return vec3(0.0, 0.0, -1.0);
  return vec3(asin(sinLatVal) * RAD_TO_DEG, rLon, 1.0);
}

vec3 inverseRobinson(float x, float y) {
  vec3 inv = robinsonYInvert(abs(y));
  if (inv.x < 0.0) return vec3(0.0, 0.0, -1.0);

  float latDeg = (inv.x + inv.y) * 5.0;
  if (y < 0.0) latDeg = -latDeg;

  if (abs(inv.z) < 0.0001) return vec3(0.0, 0.0, -1.0);
  float rLon = (x / inv.z) * RAD_TO_DEG;
  if (abs(rLon) > 180.0) return vec3(0.0, 0.0, -1.0);
  return vec3(latDeg, rLon, 1.0);
}

vec3 inverseAzimuthalEquidistant(float x, float y) {
  float rho = sqrt(x * x + y * y);
  if (rho > AZIMUTHAL_CLIP_ANGLE_RAD) return vec3(0.0, 0.0, -1.0);
  if (rho < 0.0001) return vec3(0.0, 0.0, 1.0);

  float c = rho;
  float sinC = sin(c);
  float cosC = cos(c);
  float rLat = asin(clamp(y * sinC / rho, -1.0, 1.0)) * RAD_TO_DEG;
  float rLon = atan(x * sinC, rho * cosC) * RAD_TO_DEG;
  return vec3(rLat, rLon, 1.0);
}

vec3 inverseAzimuthalHybrid(float x, float y) {
  float rho = sqrt(x * x + y * y);
  if (rho > AZIMUTHAL_CLIP_ANGLE_RAD) return vec3(0.0, 0.0, -1.0);
  if (rho < 0.0001) return vec3(0.0, 0.0, 1.0);

  // Newton-Raphson: solve mix(rhoEA(c), rhoED(c), blend(c)) = rho for c
  float c = rho;
  for (int iter = 0; iter < 8; iter++) {
    float sinC = sin(c);
    float cosC = cos(c);
    float rhoEA = sqrt(max(0.0, 2.0 - 2.0 * clamp(cosC, -1.0, 1.0)));
    float rhoED = c;
    float blend = getAzimuthalEffectiveBlend(
      AZIMUTHAL_HYBRID_BLEND, AZIMUTHAL_HYBRID_RIM_BLEND,
      AZIMUTHAL_HYBRID_FAR_BLEND, c
    );
    float f = mix(rhoEA, rhoED, blend) - rho;
    if (abs(f) < 0.0001) break;
    float drhoEA = (rhoEA > 0.0001) ? sinC / rhoEA : 1.0;
    float df = mix(drhoEA, 1.0, blend);
    if (abs(df) < 0.0001) break;
    c -= f / df;
    c = max(0.0001, c);
  }

  if (c > AZIMUTHAL_CLIP_ANGLE_RAD) return vec3(0.0, 0.0, -1.0);
  float sinC = sin(c);
  float cosC = cos(c);
  float rLat = asin(clamp(y * sinC / rho, -1.0, 1.0)) * RAD_TO_DEG;
  float rLon = atan(x * sinC, rho * cosC) * RAD_TO_DEG;

  // Round-trip validation: forward-project the result and verify it matches.
  // The blended forward mapping is non-monotonic near the clip boundary,
  // so the Newton-Raphson solver can converge to ghost solutions.
  vec3 fwd = projectAzimuthalHybridRotated(vec2(rLat, rLon));
  float errSq = (fwd.x - x) * (fwd.x - x) + (fwd.y - y) * (fwd.y - y);
  if (errSq > 0.001) return vec3(0.0, 0.0, -1.0);

  return vec3(rLat, rLon, 1.0);
}

vec3 inverseProjectLatLon(float x, float y, int projType) {
  if (projType == PROJ_EQUIRECTANGULAR) return inverseEquirectangular(x, y);
  if (projType == PROJ_MERCATOR) return inverseMercator(x, y);
  if (projType == PROJ_ROBINSON) return inverseRobinson(x, y);
  if (projType == PROJ_MOLLWEIDE) return inverseMollweide(x, y);
  if (projType == PROJ_CYLINDRICAL_EQUAL_AREA) return inverseCylindricalEqualArea(x, y);
  if (projType == PROJ_AZIMUTHAL_EQUIDISTANT) return inverseAzimuthalEquidistant(x, y);
  if (projType == PROJ_AZIMUTHAL_HYBRID) return inverseAzimuthalHybrid(x, y);
  return vec3(0.0, 0.0, -1.0);
}

uniform sampler2D maskTexture;
uniform float opacity;
uniform int projectionType;
uniform float centerLon;
uniform float centerLat;

varying vec2 vProjectedCoord;

void main() {
  vec3 result = inverseProjectLatLon(vProjectedCoord.x, vProjectedCoord.y, projectionType);
  if (result.z < 0.0) discard;

  vec2 geo = unrotateCoords(result.x, result.y, centerLon, centerLat);

  // Normalize longitude to [-180, 180]
  float lon = mod(geo.y + 180.0, 360.0) - 180.0;

  // Convert to equirectangular texture UV
  float u = (lon + 180.0) / 360.0;
  float v = (geo.x + 90.0) / 180.0;

  vec4 texColor = texture2D(maskTexture, vec2(u, v));
  if (texColor.a < 0.01) discard;
  gl_FragColor = vec4(texColor.rgb, texColor.a * opacity);
}
