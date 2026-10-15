#include "../../projection/glsl/inverseProjection.glsl"

#define WEB_MERCATOR_LAT_LIMIT 85.0511287798066
// sin(WEB_MERCATOR_LAT_LIMIT) and its atanh.
#define SIN_LAT_LIMIT 0.9962720762207499
#define PSI_LIMIT 3.141592653589793
#define TWO_PI 6.283185307179586
// Keeps bilinear filtering inside a tile's atlas slot.
#define HALF_TEXEL (0.5 / 256.0)

// Whole world at a low zoom, in Web-Mercator tile layout.
uniform sampler2D baseTexture;
// Tiles in fixed slots; atlasSlots is its size in slots (columns, rows).
uniform sampler2D atlasTexture;
uniform vec2 atlasSlots;
// One texel per tile of detailWindow (x, y, width, height in tiles at
// 2^zoom = detailTiles; 0 when there is none): slot column, slot row,
// levels up to the parent actually shown, and alpha 1 when present.
uniform sampler2D pageTable;
uniform vec4 detailWindow;
uniform float detailTiles;
// A point near the view, in Mercator and in detail window tiles. Positions
// are computed as small offsets from it, which float32 holds precisely.
uniform vec2 referenceMercator;
uniform vec2 referenceTile;
uniform float opacity;
// Equirectangular land coverage in alpha, to hide the land or water of
// raster basemaps; vector basemaps leave them out when drawing their tiles.
uniform sampler2D landMask;
uniform bool showLand;
uniform bool showWater;
// Labels of vector basemaps, drawn onto an image of a tile window (labelSize
// tiles at 2^zoom = labelTiles; 0 without labels) and laid onto the map.
uniform sampler2D labelImage;
uniform float labelTiles;
uniform vec2 labelSize;
// The reference point in label window tiles, like referenceTile.
uniform vec2 labelReferenceTile;

// Camera position minus the reference point, computed on the CPU in double
// precision.
uniform vec3 cameraOffset;
varying vec3 vRayDirection;

#ifdef FLAT
uniform int projectionType;
uniform float centerLon;
uniform float centerLat;
// The reference point on the map plane.
uniform vec2 referenceProjected;
// With useExpansion, map offsets d become Mercator offsets
// u - (uᵀQx u, uᵀQy u) with u = J d: J row-major, Q as (xx, xy, yy).
// Without it (zoomed-out views) the inverse projection is used directly.
uniform bool useExpansion;
uniform vec4 expansionJacobian;
uniform vec3 expansionCurvatureX;
uniform vec3 expansionCurvatureY;
#else
// sin/cos of the reference latitude and longitude.
uniform vec4 referenceTrig;
// atanh(sin(reference latitude)), the Mercator y before scaling.
uniform float referencePsi;
// |camera|^2 - 1, computed on the CPU in double precision.
uniform float cameraHeightTerm;
#endif

// GPU atanh/atan lose relative precision for the tiny offsets of close views.
float offsetAtanh(float x) {
  if (abs(x) < 0.01) {
    float x2 = x * x;
    return x * (1.0 + x2 * (1.0 / 3.0 + x2 * 0.2));
  }
  return atanh(x);
}

float offsetAtan(float y, float x) {
  if (abs(y) < 0.01 * x) {
    float r = y / x;
    float r2 = r * r;
    return r * (1.0 - r2 * (1.0 / 3.0 - r2 * 0.2));
  }
  return atan(y, x);
}

#ifdef FLAT
vec2 getMercatorOffset() {
  // Intersection with the map plane z = 0, relative to the reference point.
  if (vRayDirection.z >= 0.0) discard;
  float t = -cameraOffset.z / vRayDirection.z;
  vec2 mapOffset = cameraOffset.xy + t * vRayDirection.xy;
  vec2 projected = referenceProjected + mapOffset;

  vec3 result = inverseProjectLatLon(projected.x, projected.y, projectionType);
  if (result.z < 0.0) discard;
  if (useExpansion) {
    vec2 u = vec2(
      dot(expansionJacobian.xy, mapOffset),
      dot(expansionJacobian.zw, mapOffset)
    );
    vec3 uu = vec3(u.x * u.x, 2.0 * u.x * u.y, u.y * u.y);
    return u - vec2(dot(expansionCurvatureX, uu), dot(expansionCurvatureY, uu));
  }
  vec2 geo = unrotateCoords(result.x, result.y, centerLon, centerLat);
  // Beyond the Mercator limit the outermost tile row is stretched to the pole.
  float latRad = radians(clamp(geo.x, -WEB_MERCATOR_LAT_LIMIT, WEB_MERCATOR_LAT_LIMIT));
  vec2 mercator = vec2(
    fract((geo.y + 180.0) / 360.0),
    0.5 - log(tan(PI * 0.25 + latRad * 0.5)) / TWO_PI
  );
  vec2 offset = mercator - referenceMercator;
  offset.x -= floor(offset.x + 0.5);
  return offset;
}
#else
vec2 getMercatorOffset() {
  float sinLat = referenceTrig.x;
  float cosLat = referenceTrig.y;
  float sinLon = referenceTrig.z;
  float cosLon = referenceTrig.w;
  vec3 reference = vec3(cosLat * cosLon, cosLat * sinLon, sinLat);

  // Nearer intersection with the unit sphere, in its numerically stable form.
  vec3 direction = normalize(vRayDirection);
  float b = dot(reference + cameraOffset, direction);
  float discriminant = b * b - cameraHeightTerm;
  if (b >= 0.0 || discriminant < 0.0) discard;
  float t = cameraHeightTerm / (-b + sqrt(discriminant));
  // Hit point minus the reference point.
  vec3 offset = cameraOffset + t * direction;

  float lonOffset = offsetAtan(
    dot(offset, vec3(-sinLon, cosLon, 0.0)),
    cosLat + dot(offset, vec3(cosLon, sinLon, 0.0))
  );
  // Mercator y is atanh(sin(lat)); atanh(a) - atanh(b) =
  // atanh((a - b) / (1 - ab)) keeps the difference precise.
  float hitSinLat = sinLat + offset.z;
  float psiOffset = abs(hitSinLat) > SIN_LAT_LIMIT
    ? sign(hitSinLat) * PSI_LIMIT - referencePsi
    : offsetAtanh(offset.z / (1.0 - hitSinLat * sinLat));
  return vec2(lonOffset, -psiOffset) / TWO_PI;
}
#endif

void main() {
  vec2 offset = getMercatorOffset();
  vec2 mercator = referenceMercator + offset;

  // Canvas textures are flipped, so tile row 0 is at v = 1.
  vec4 color = texture2D(
    baseTexture,
    vec2(fract(mercator.x), 1.0 - clamp(mercator.y, 0.0, 1.0))
  );
  if (detailTiles > 0.0) {
    vec2 tile = referenceTile + offset * detailTiles;
    vec2 local = vec2(mod(tile.x, detailTiles), tile.y);
    if (local.x < detailWindow.z && local.y >= 0.0 && local.y < detailWindow.w) {
      ivec2 cell = ivec2(local);
      vec4 entry = texelFetch(pageTable, cell, 0);
      if (entry.a > 0.5) {
        ivec3 page = ivec3(entry.rgb * 255.0 + 0.5);
        // Position inside the tile, or inside its parent `page.z` levels up,
        // from integer tile indices so it stays exact at every zoom.
        ivec2 tileIndex = ivec2(
          (int(detailWindow.x) + cell.x) % int(detailTiles),
          int(detailWindow.y) + cell.y
        );
        int levelMask = (1 << page.z) - 1;
        vec2 inTile = (vec2(tileIndex & levelMask) + fract(local)) / float(1 << page.z);
        inTile = clamp(inTile, HALF_TEXEL, 1.0 - HALF_TEXEL);
        vec4 detail = texture2D(atlasTexture, (vec2(page.xy) + inTile) / atlasSlots);
        color = mix(color, detail, detail.a);
      }
    }
  }
  if (!showLand || !showWater) {
    float lat = atan(sinh(PI * (1.0 - 2.0 * clamp(mercator.y, 0.0, 1.0))));
    float land = texture2D(landMask, vec2(fract(mercator.x), lat / PI + 0.5)).a;
    color.a *= (showLand ? land : 0.0) + (showWater ? 1.0 - land : 0.0);
  }
  if (labelTiles > 0.0) {
    vec2 labelTile = labelReferenceTile + offset * labelTiles;
    labelTile.x = mod(labelTile.x, labelTiles);
    if (labelTile.x < labelSize.x && labelTile.y >= 0.0 && labelTile.y < labelSize.y) {
      vec4 label = texture2D(labelImage, vec2(labelTile.x, labelSize.y - labelTile.y) / labelSize);
      // The label over the map.
      float alpha = label.a + color.a * (1.0 - label.a);
      if (alpha > 0.0) {
        color.rgb = (label.rgb * label.a + color.rgb * color.a * (1.0 - label.a)) / alpha;
      }
      color.a = alpha;
    }
  }
  if (color.a < 0.01) discard;
  gl_FragColor = vec4(color.rgb, color.a * opacity);
  // Encode explicitly; see the color space note in AGENTS.md.
  gl_FragColor = sRGBTransferOETF(gl_FragColor);
}
