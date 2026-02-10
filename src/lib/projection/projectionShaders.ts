/**
 * GLSL shader code for GPU-based map projections.
 *
 * These shaders implement the same projection logic as d3-geo projections,
 * allowing projection center changes to be applied instantly via uniforms
 * rather than rebuilding geometry on the CPU.
 */

import { PROJECTION_TYPES, type TProjectionType } from "./projectionUtils";

export const PROJECTION_TYPE_BY_MODE = {
  [PROJECTION_TYPES.NEARSIDE_PERSPECTIVE]: 0,
  [PROJECTION_TYPES.EQUIRECTANGULAR]: 1,
  [PROJECTION_TYPES.MERCATOR]: 2,
  [PROJECTION_TYPES.ROBINSON]: 3,
  [PROJECTION_TYPES.MOLLWEIDE]: 4,
  [PROJECTION_TYPES.CYLINDRICAL_EQUAL_AREA]: 5,
  [PROJECTION_TYPES.AZIMUTHAL_EQUIDISTANT]: 6,
} as const;

export type TProjectionTypeId =
  (typeof PROJECTION_TYPE_BY_MODE)[TProjectionType];

/**
 * GLSL functions for map projections.
 * These are included in the vertex shader to transform lat/lon to projected coordinates.
 */
export const projectionShaderFunctions = `
  #define PI 3.141592653589793
  #define DEG_TO_RAD 0.017453292519943295
  #define RAD_TO_DEG 57.29577951308232
  #define MERCATOR_LAT_LIMIT 85.0

  #define PROJ_GLOBE 0
  #define PROJ_EQUIRECTANGULAR 1
  #define PROJ_MERCATOR 2
  #define PROJ_ROBINSON 3
  #define PROJ_MOLLWEIDE 4
  #define PROJ_CYLINDRICAL_EQUAL_AREA 5
  #define PROJ_AZIMUTHAL_EQUIDISTANT 6

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

  // Apply rotation to coordinates (for projection center)
  // This rotates the sphere so that (centerLon, centerLat) becomes (0, 0)
  vec2 rotateCoords(float lat, float lon, float centerLon, float centerLat) {
    // Convert to radians
    float latRad = lat * DEG_TO_RAD;
    float lonRad = (lon - centerLon) * DEG_TO_RAD;
    float centerLatRad = centerLat * DEG_TO_RAD;

    // Spherical rotation around the center
    float cosLat = cos(latRad);
    float sinLat = sin(latRad);
    float cosLon = cos(lonRad);
    float sinLon = sin(lonRad);
    float cosCenterLat = cos(centerLatRad);
    float sinCenterLat = sin(centerLatRad);

    // New latitude after rotation
    float newSinLat = sinLat * cosCenterLat - cosLat * cosLon * sinCenterLat;
    float newLat = asin(clamp(newSinLat, -1.0, 1.0));

    // New longitude after rotation
    float y = cosLat * sinLon;
    float x = sinLat * sinCenterLat + cosLat * cosLon * cosCenterLat;
    float newLon = atan(y, x);

    return vec2(newLat * RAD_TO_DEG, newLon * RAD_TO_DEG);
  }

  // Globe projection (3D sphere)
  vec3 projectGlobe(float lat, float lon, float radius) {
    float latRad = lat * DEG_TO_RAD;
    float lonRad = lon * DEG_TO_RAD;

    float x = radius * cos(latRad) * cos(lonRad);
    float y = radius * cos(latRad) * sin(lonRad);
    float z = radius * sin(latRad);

    return vec3(x, y, z);
  }

  // Equirectangular projection (Plate Carrée)
  vec3 projectEquirectangular(float lat, float lon, float centerLon, float centerLat) {
    vec2 rotated = rotateCoords(lat, lon, centerLon, centerLat);
    float x = rotated.y * DEG_TO_RAD;  // lon in radians
    float y = rotated.x * DEG_TO_RAD;  // lat in radians
    return vec3(x, y, 0.0);
  }

  // Mercator projection
  vec3 projectMercator(float lat, float lon, float centerLon, float centerLat) {
    vec2 rotated = rotateCoords(lat, lon, centerLon, centerLat);
    float safeLat = clamp(rotated.x, -MERCATOR_LAT_LIMIT, MERCATOR_LAT_LIMIT);
    float latRad = safeLat * DEG_TO_RAD;
    float x = rotated.y * DEG_TO_RAD;
    float y = log(tan(PI / 4.0 + latRad / 2.0));
    return vec3(x, y, 0.0);
  }

  // Robinson projection (using quadratic interpolation to match d3-geo-projection)
  // Uses the same 3-point interpolation formula as d3's robinsonRaw function
  vec3 projectRobinson(float lat, float lon, float centerLon, float centerLat) {
    vec2 rotated = rotateCoords(lat, lon, centerLon, centerLat);
    float latRad = rotated.x * DEG_TO_RAD;

    // d3 formula: i = min(18, abs(phi) * 36 / pi)
    float i = min(18.0, abs(latRad) * 36.0 / PI);
    int i0 = int(floor(i));
    float di = i - float(i0);

    // Get three consecutive points for quadratic interpolation
    // K array has [X, Y] pairs, so multiply index by 2
    float ax = robinsonK[i0 * 2];
    float ay = robinsonK[i0 * 2 + 1];
    float bx = robinsonK[(i0 + 1) * 2];
    float by = robinsonK[(i0 + 1) * 2 + 1];
    int i2 = min(i0 + 2, 19);
    float cx = robinsonK[i2 * 2];
    float cy = robinsonK[i2 * 2 + 1];

    // d3's quadratic interpolation formula:
    // result = b + di * (c - a) / 2 + di * di * (c - 2*b + a) / 2
    float xCoeff = bx + di * (cx - ax) / 2.0 + di * di * (cx - 2.0 * bx + ax) / 2.0;
    float yCoeff = by + di * (cy - ay) / 2.0 + di * di * (cy - 2.0 * by + ay) / 2.0;

    // d3 uses: x = lambda * xCoeff (lambda in radians)
    // Y values are already pre-scaled by pi/2
    float x = xCoeff * rotated.y * DEG_TO_RAD;
    float y = sign(rotated.x) * yCoeff;

    return vec3(x, y, 0.0);
  }

  // Mollweide projection (using Newton-Raphson iteration)
  vec3 projectMollweide(float lat, float lon, float centerLon, float centerLat) {
    vec2 rotated = rotateCoords(lat, lon, centerLon, centerLat);
    float latRad = rotated.x * DEG_TO_RAD;

    // Newton-Raphson to solve 2*theta + sin(2*theta) = PI * sin(lat)
    float theta = latRad;
    float target = PI * sin(latRad);

    // 5 iterations is typically enough for good accuracy
    for (int iter = 0; iter < 5; iter++) {
      float sinTheta = sin(theta);
      float cosTheta = cos(theta);
      float f = 2.0 * theta + sin(2.0 * theta) - target;
      float df = 2.0 + 2.0 * cos(2.0 * theta);
      if (abs(df) < 0.0001) break;
      theta = theta - f / df;
    }

    float x = (2.0 * sqrt(2.0) / PI) * rotated.y * DEG_TO_RAD * cos(theta);
    float y = sqrt(2.0) * sin(theta);

    return vec3(x, y, 0.0);
  }

  // Cylindrical Equal Area projection (Lambert)
  // Matches d3-geo-projection's geoCylindricalEqualArea output with scale(1)
  // D3 uses: x = λ / k, y = sin(φ) * k where k ≈ 1.2792 (derived from default scale)
  vec3 projectCylindricalEqualArea(float lat, float lon, float centerLon, float centerLat) {
    vec2 rotated = rotateCoords(lat, lon, centerLon, centerLat);
    float k = 1.2792006328649603;  // From d3-geo-projection internal scaling
    float x = rotated.y * DEG_TO_RAD / k;
    float y = sin(rotated.x * DEG_TO_RAD) * k;
    return vec3(x, y, 0.0);
  }

  // Azimuthal Equidistant projection
  // Distances from center point are preserved
  vec3 projectAzimuthalEquidistant(float lat, float lon, float centerLon, float centerLat) {
    vec2 rotated = rotateCoords(lat, lon, centerLon, centerLat);
    float latRad = rotated.x * DEG_TO_RAD;
    float lonRad = rotated.y * DEG_TO_RAD;

    // Angular distance from center (which is now at 0,0 after rotation)
    float cosC = cos(latRad) * cos(lonRad);
    float c = acos(clamp(cosC, -1.0, 1.0));

    // Clip points beyond ~173 degrees (3.02 radians) to avoid antipodal singularity
    // Return NaN to cause GPU to discard the geometry entirely
    if (c > 3.02) {
      float nan = sqrt(-1.0);  // Generate NaN
      return vec3(nan, nan, nan);
    }

    // Handle the center point (c = 0)
    if (c < 0.0001) {
      return vec3(0.0, 0.0, 0.0);
    }

    // Compute k = c / sin(c)
    float sinC = sin(c);
    float k = c / sinC;

    float x = k * cos(latRad) * sin(lonRad);
    float y = k * sin(latRad);

    return vec3(x, y, 0.0);
  }

  // Main projection function that dispatches to the appropriate projection
  vec3 projectLatLon(float lat, float lon, int projectionType, float centerLon, float centerLat, float radius) {
    if (projectionType == PROJ_AZIMUTHAL_EQUIDISTANT) {
      return projectAzimuthalEquidistant(lat, lon, centerLon, centerLat) * radius;
    } else if (projectionType == PROJ_EQUIRECTANGULAR) {
      return projectEquirectangular(lat, lon, centerLon, centerLat) * radius;
    } else if (projectionType == PROJ_MERCATOR) {
      return projectMercator(lat, lon, centerLon, centerLat) * radius;
    } else if (projectionType == PROJ_ROBINSON) {
      return projectRobinson(lat, lon, centerLon, centerLat) * radius;
    } else if (projectionType == PROJ_MOLLWEIDE) {
      return projectMollweide(lat, lon, centerLon, centerLat) * radius;
    } else if (projectionType == PROJ_CYLINDRICAL_EQUAL_AREA) {
      return projectCylindricalEqualArea(lat, lon, centerLon, centerLat) * radius;
    } else {
      return projectGlobe(lat, lon, radius);
    }
  }
`;

/**
 * Get the projection type constant for a given projection mode string
 */
export function getProjectionTypeFromMode(mode: string): number {
  const typedMode = mode as TProjectionType;
  return (
    PROJECTION_TYPE_BY_MODE[typedMode] ??
    PROJECTION_TYPE_BY_MODE[PROJECTION_TYPES.NEARSIDE_PERSPECTIVE]
  );
}
