/**
 * GLSL shader code for GPU-based map projections.
 *
 * These shaders implement the same projection logic as d3-geo projections,
 * allowing projection center changes to be applied instantly via uniforms
 * rather than rebuilding geometry on the CPU.
 */

export const PROJECTION_TYPE_GLOBE = 0;
export const PROJECTION_TYPE_EQUIRECTANGULAR = 1;
export const PROJECTION_TYPE_MERCATOR = 2;
export const PROJECTION_TYPE_ROBINSON = 3;
export const PROJECTION_TYPE_MOLLWEIDE = 4;
export const PROJECTION_TYPE_CYLINDRICAL_EQUAL_AREA = 5;
export const PROJECTION_TYPE_AZIMUTHAL_EQUIDISTANT = 6;

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

  // Robinson projection lookup table (X and Y coefficients for each 5° latitude band)
  // Based on Robinson's original tabular definition
  const float robinsonX[19] = float[19](
    1.0000, 0.9986, 0.9954, 0.9900, 0.9822,
    0.9730, 0.9600, 0.9427, 0.9216, 0.8962,
    0.8679, 0.8350, 0.7986, 0.7597, 0.7186,
    0.6732, 0.6213, 0.5722, 0.5322
  );

  const float robinsonY[19] = float[19](
    0.0000, 0.0620, 0.1240, 0.1860, 0.2480,
    0.3100, 0.3720, 0.4340, 0.4958, 0.5571,
    0.6176, 0.6769, 0.7346, 0.7903, 0.8435,
    0.8936, 0.9394, 0.9761, 1.0000
  );

  // Normalize longitude to [-180, 180]
  float normalizeLon(float lon) {
    return mod(lon + 540.0, 360.0) - 180.0;
  }

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

  // Robinson projection (using lookup table with linear interpolation)
  // Matches d3-geo-projection's geoRobinson output with scale(1)
  vec3 projectRobinson(float lat, float lon, float centerLon, float centerLat) {
    vec2 rotated = rotateCoords(lat, lon, centerLon, centerLat);

    float absLat = abs(rotated.x);
    float index = absLat / 5.0;
    int i0 = int(floor(index));
    int i1 = min(i0 + 1, 18);
    float t = fract(index);

    // Linear interpolation of Robinson coefficients
    float xCoeff = mix(robinsonX[i0], robinsonX[i1], t);
    float yCoeff = mix(robinsonY[i0], robinsonY[i1], t);

    // d3 uses: x = λ * xCoeff, y = (π/2) * yCoeff * sign(φ)
    float x = xCoeff * rotated.y * DEG_TO_RAD;
    float y = yCoeff * sign(rotated.x) * (PI / 2.0);

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

    // Handle the center point (c = 0)
    if (c < 0.0001) {
      return vec3(0.0, 0.0, 0.0);
    }

    float k = c / sin(c);
    float x = k * cos(latRad) * sin(lonRad);
    float y = k * sin(latRad);

    return vec3(x, y, 0.0);
  }

  // Main projection function that dispatches to the appropriate projection
  vec3 projectLatLon(float lat, float lon, int projectionType, float centerLon, float centerLat, float radius) {
    if (projectionType == PROJ_GLOBE) {
      return projectGlobe(lat, lon, radius);
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
    } else if (projectionType == PROJ_AZIMUTHAL_EQUIDISTANT) {
      return projectAzimuthalEquidistant(lat, lon, centerLon, centerLat) * radius;
    }
    // Fallback to equirectangular
    return projectEquirectangular(lat, lon, centerLon, centerLat) * radius;
  }
`;

/**
 * Get the projection type constant for a given projection mode string
 */
export function getProjectionTypeFromMode(mode: string): number {
  switch (mode) {
    case "nearside_perspective":
      return PROJECTION_TYPE_GLOBE;
    case "equirectangular":
      return PROJECTION_TYPE_EQUIRECTANGULAR;
    case "mercator":
      return PROJECTION_TYPE_MERCATOR;
    case "robinson":
      return PROJECTION_TYPE_ROBINSON;
    case "mollweide":
      return PROJECTION_TYPE_MOLLWEIDE;
    case "cylindrical_equal_area":
      return PROJECTION_TYPE_CYLINDRICAL_EQUAL_AREA;
    case "azimuthal_equidistant":
      return PROJECTION_TYPE_AZIMUTHAL_EQUIDISTANT;
    default:
      return PROJECTION_TYPE_GLOBE;
  }
}
