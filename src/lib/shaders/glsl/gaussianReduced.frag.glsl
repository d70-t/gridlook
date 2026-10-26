#include "../../projection/glsl/projectionDomain.glsl"
#include "./colormapFunctions.glsl"
#include "./isNaN.glsl"
#include "./posterize.glsl"

uniform float addOffset;
uniform float scaleFactor;
uniform int colormap;
uniform float posterizeLevels;
uniform float hideBelowValue;
uniform float hideAboveValue;
uniform float opacity;
// Data values in file order, row-major over the texture.
uniform sampler2D data;
// Per row (north to south): latitude and first longitude in microdegrees,
// point count and data index of the first point.
uniform highp isampler2D rows;
uniform int rowCount;
uniform int projectionType;
uniform float projectionRadius;
uniform int edgeQuality;

varying vec2 vUv;  // lon, lat in degrees
varying vec2 vProjectedXY;

ivec2 texelAt(int index, int width) {
    return ivec2(index % width, index / width);
}

ivec4 fetchRow(int row) {
    return texelFetch(rows, texelAt(row, textureSize(rows, 0).x), 0);
}

float rowLatitude(int row) {
    return float(fetchRow(row).x) * 1e-6;
}

// Nearest row in latitude; mirrors findGaussianReducedPoint.
int findRow(float lat) {
    int low = 0;
    int high = rowCount;
    for (int i = 0; i < 32 && low < high; i++) {
        int mid = (low + high) / 2;
        if (rowLatitude(mid) > lat) {
            low = mid + 1;
        } else {
            high = mid;
        }
    }
    if (low == rowCount
    || (low > 0 && rowLatitude(low - 1) - lat < lat - rowLatitude(low))) {
        return low - 1;
    }
    return low;
}

void main() {
    ivec4 row = fetchRow(findRow(vUv.y));
    float spacing = 360.0 / float(row.z);
    float firstLongitude = float(row.y) * 1e-6;
    int column = int(floor(mod(vUv.x - firstLongitude + 0.5 * spacing, 360.0) / spacing)) % row.z;
    float v_value = texelFetch(data, texelAt(row.w + column, textureSize(data, 0).x), 0).r;
    if ((edgeQuality > 0 && !isInsideProjectionDomain(vProjectedXY, projectionType, projectionRadius))
    || is_nan(v_value) || v_value <= hideBelowValue || v_value >= hideAboveValue) {
        discard;
    }
    gl_FragColor.a = opacity;
    float normalized_value = clamp(addOffset + scaleFactor * v_value, 0.0, 1.0);
    normalized_value = posterize(normalized_value, posterizeLevels);

    #include "./applyColormap.glsl"
}
