#include "./projectionDomain.glsl"

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

float getAzimuthalEffectiveBlend(
  float blend,
  float rimBlend,
  float farBlend,
  float c
) {
  float rimWeight = smoothstep(
    AZIMUTHAL_RIM_BLEND_START,
    AZIMUTHAL_RIM_BLEND_END,
    c / PI
  );
  float farWeight = smoothstep(
    AZIMUTHAL_FAR_BLEND_START,
    AZIMUTHAL_FAR_BLEND_END,
    c / PI
  );
  return clamp(blend + rimBlend * rimWeight + farBlend * farWeight, 0.0, 1.0);
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
vec3 projectEquirectangularRotated(vec2 rotated) {
  float x = rotated.y * DEG_TO_RAD;  // lon in radians
  float y = rotated.x * DEG_TO_RAD;  // lat in radians
  return vec3(x, y, 0.0);
}

// Mercator projection
vec3 projectMercatorRotated(vec2 rotated) {
  float safeLat = clamp(rotated.x, -MERCATOR_LAT_LIMIT, MERCATOR_LAT_LIMIT);
  float latRad = safeLat * DEG_TO_RAD;
  float x = rotated.y * DEG_TO_RAD;
  float y = log(tan(PI / 4.0 + latRad / 2.0));
  return vec3(x, y, 0.0);
}

// Robinson projection (using quadratic interpolation to match d3-geo-projection)
// Uses the same 3-point interpolation formula as d3's robinsonRaw function
vec3 projectRobinsonRotated(vec2 rotated) {
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
vec3 projectMollweideRotated(vec2 rotated) {
  float latRad = rotated.x * DEG_TO_RAD;

  // Newton-Raphson to solve 2*theta + sin(2*theta) = PI * sin(lat)
  float theta = latRad;
  float target = PI * sin(latRad);

  // 5 iterations is typically enough for good accuracy
  for (int iter = 0; iter < 5; iter++) {
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
vec3 projectCylindricalEqualAreaRotated(vec2 rotated) {
  float x = rotated.y * DEG_TO_RAD / CYLINDRICAL_EQUAL_AREA_SCALE;
  float y = sin(rotated.x * DEG_TO_RAD) * CYLINDRICAL_EQUAL_AREA_SCALE;
  return vec3(x, y, 0.0);
}

// Azimuthal blend between equal-area (0.0) and equidistant (1.0)
// This keeps the same azimuthal direction and interpolates the radial distance.
vec3 projectAzimuthalHybridRotated(vec2 rotated) {
  float latRad = rotated.x * DEG_TO_RAD;
  float lonRad = rotated.y * DEG_TO_RAD;

  float cosLat = cos(latRad);
  float sinLat = sin(latRad);
  float cosLon = cos(lonRad);
  float sinLon = sin(lonRad);
  float cosC = clamp(cosLat * cosLon, -1.0, 1.0);
  float c = acos(cosC);

  if (c > AZIMUTHAL_CLIP_ANGLE_RAD) {
    float nan = sqrt(-1.0);
    return vec3(nan, nan, nan);
  }
  if (c < 0.0001) {
    return vec3(0.0, 0.0, 0.0);
  }

  float sinC = sin(c);
  if (abs(sinC) < 0.0001) {
    float nan = sqrt(-1.0);
    return vec3(nan, nan, nan);
  }

  float rhoEqualArea = sqrt(max(0.0, 2.0 - 2.0 * cosC));
  float rhoEquidistant = c;
  float effectiveBlend = getAzimuthalEffectiveBlend(
    AZIMUTHAL_HYBRID_BLEND,
    AZIMUTHAL_HYBRID_RIM_BLEND,
    AZIMUTHAL_HYBRID_FAR_BLEND,
    c
  );
  float rho = mix(rhoEqualArea, rhoEquidistant, effectiveBlend);
  float k = rho / sinC;

  return vec3(k * cosLat * sinLon, k * sinLat, 0.0);
}

// Azimuthal Equidistant projection
// Distances from center point are preserved
vec3 projectAzimuthalEquidistantRotated(vec2 rotated) {
  float latRad = rotated.x * DEG_TO_RAD;
  float lonRad = rotated.y * DEG_TO_RAD;

  float cosC = cos(latRad) * cos(lonRad);
  float c = acos(clamp(cosC, -1.0, 1.0));

  if (c > AZIMUTHAL_CLIP_ANGLE_RAD) {
    float nan = sqrt(-1.0);
    return vec3(nan, nan, nan);
  }
  if (c < 0.0001) {
    return vec3(0.0, 0.0, 0.0);
  }

  float sinC = sin(c);
  float k = c / sinC;

  float x = k * cos(latRad) * sin(lonRad);
  float y = k * sin(latRad);

  return vec3(x, y, 0.0);
}

vec3 projectRotatedLatLon(vec2 rotated, int projectionType, float radius) {
  if (projectionType == PROJ_EQUIRECTANGULAR) {
    return projectEquirectangularRotated(rotated) * radius;
  } else if (projectionType == PROJ_MERCATOR) {
    return projectMercatorRotated(rotated) * radius;
  } else if (projectionType == PROJ_ROBINSON) {
    return projectRobinsonRotated(rotated) * radius;
  } else if (projectionType == PROJ_MOLLWEIDE) {
    return projectMollweideRotated(rotated) * radius;
  } else if (projectionType == PROJ_CYLINDRICAL_EQUAL_AREA) {
    return projectCylindricalEqualAreaRotated(rotated) * radius;
  } else if (projectionType == PROJ_AZIMUTHAL_HYBRID) {
    return projectAzimuthalHybridRotated(rotated) * radius;
  } else if (projectionType == PROJ_AZIMUTHAL_EQUIDISTANT) {
    return projectAzimuthalEquidistantRotated(rotated) * radius;
  } else {
    return projectGlobe(rotated.x, rotated.y, radius);
  }
}

// Main projection function that dispatches to the appropriate projection
vec3 projectLatLon(
  float lat,
  float lon,
  int projectionType,
  float centerLon,
  float centerLat,
  float radius
) {
  if (projectionType == PROJ_GLOBE) {
    return projectGlobe(lat, lon, radius);
  }

  vec2 rotated = rotateCoords(lat, lon, centerLon, centerLat);
  return projectRotatedLatLon(rotated, projectionType, radius);
}
