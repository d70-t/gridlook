#include "./projectionConstants.glsl"

// Robinson projection lookup table (X and Y coefficients)
// Matches d3-geo-projection's K array exactly
// Y values are pre-multiplied by 1.593415793900743 (pi/2 scaling factor)
const float robinsonK[40] = float[40](
  // [X, Y] pairs for each 5° band from -5° to 90° (20 entries)
  0.9986, -0.09879178,    // index 0: edge case for interpolation
  1.0000,  0.00000000,    // index 1: 0°
  0.9986,  0.09879178,    // index 2: 5°
  0.9954,  0.19758356,    // index 3: 10°
  0.9900,  0.29637534,    // index 4: 15°
  0.9822,  0.39516712,    // index 5: 20°
  0.9730,  0.49395890,    // index 6: 25°
  0.9600,  0.59275068,    // index 7: 30°
  0.9427,  0.69154245,    // index 8: 35°
  0.9216,  0.79001555,    // index 9: 40°
  0.8962,  0.88769194,    // index 10: 45°
  0.8679,  0.98409359,    // index 11: 50°
  0.8350,  1.07858315,    // index 12: 55°
  0.7986,  1.17052324,    // index 13: 60°
  0.7597,  1.25927650,    // index 14: 65°
  0.7186,  1.34404622,    // index 15: 70°
  0.6732,  1.42387635,    // index 16: 75°
  0.6213,  1.49685480,    // index 17: 80°
  0.5722,  1.55533316,    // index 18: 85°
  0.5322,  1.59341579     // index 19: 90°
);

// Shared Robinson Y-inversion: given |y|, finds the interpolation bucket
// and parameter. Returns vec3(i0, di, xCoeff). Returns vec3(-1,0,0) if out of range.
vec3 robinsonYInvert(float absY) {
  if (absY > robinsonK[39]) return vec3(-1.0, 0.0, 0.0);

  int i0 = 0;
  for (int i = 0; i <= 17; i++) {
    if (absY <= robinsonK[(i + 2) * 2 + 1]) {
      i0 = i;
      break;
    }
    i0 = i;
  }

  float ax = robinsonK[i0 * 2];
  float ay = robinsonK[i0 * 2 + 1];
  float bx = robinsonK[(i0 + 1) * 2];
  float by = robinsonK[(i0 + 1) * 2 + 1];
  float cx = robinsonK[(i0 + 2) * 2];
  float cy = robinsonK[(i0 + 2) * 2 + 1];

  float di = (abs(cy - by) > 0.0001) ? (absY - by) / (cy - by) : 0.0;
  di = clamp(di, 0.0, 1.0);
  for (int iter = 0; iter < 5; iter++) {
    float yCoeff = by + di * (cy - ay) / 2.0 + di * di * (cy - 2.0 * by + ay) / 2.0;
    float dyCoeff = (cy - ay) / 2.0 + di * (cy - 2.0 * by + ay);
    if (abs(dyCoeff) < 0.0001) break;
    di = clamp(di - (yCoeff - absY) / dyCoeff, 0.0, 1.0);
  }

  float xCoeff = bx + di * (cx - ax) / 2.0 + di * di * (cx - 2.0 * bx + ax) / 2.0;
  return vec3(float(i0), di, xCoeff);
}

float robinsonXLimit(float y) {
  vec3 inv = robinsonYInvert(abs(y));
  if (inv.x < 0.0) return -1.0;
  return inv.z * PI;
}

bool isInsideProjectionDomain(vec2 projected, int projectionType, float radius) {
  float safeRadius = max(abs(radius), 0.0001);
  vec2 p = projected / safeRadius;
  float epsilon = 0.0005;

  if (projectionType == PROJ_EQUIRECTANGULAR) {
    return abs(p.x) <= PI + epsilon && abs(p.y) <= PI * 0.5 + epsilon;
  } else if (projectionType == PROJ_MERCATOR) {
    float latLimitRad = MERCATOR_LAT_LIMIT * DEG_TO_RAD;
    float yLimit = log(tan(PI / 4.0 + latLimitRad / 2.0));
    return abs(p.x) <= PI + epsilon && abs(p.y) <= yLimit + epsilon;
  } else if (projectionType == PROJ_ROBINSON) {
    float xLimit = robinsonXLimit(p.y);
    return xLimit >= 0.0 && abs(p.x) <= xLimit + epsilon;
  } else if (projectionType == PROJ_MOLLWEIDE) {
    float yLimit = sqrt(2.0);
    float xLimit = 2.0 * sqrt(2.0) * sqrt(max(0.0, 1.0 - (p.y * p.y) / 2.0));
    return abs(p.y) <= yLimit + epsilon && abs(p.x) <= xLimit + epsilon;
  } else if (projectionType == PROJ_CYLINDRICAL_EQUAL_AREA) {
    return
      abs(p.x) <= PI / CYLINDRICAL_EQUAL_AREA_SCALE + epsilon &&
      abs(p.y) <= CYLINDRICAL_EQUAL_AREA_SCALE + epsilon;
  } else if (projectionType == PROJ_AZIMUTHAL_EQUIDISTANT || projectionType == PROJ_AZIMUTHAL_HYBRID) {
    return length(p) <= AZIMUTHAL_CLIP_ANGLE_RAD + epsilon;
  }

  return true;
}
