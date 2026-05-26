#include "../../projection/glsl/projectionDomain.glsl"
#include "./colormapFunctions.glsl"
#include "./isNaN.glsl"
#include "./posterize.glsl"

varying float v_value;
uniform float addOffset;
uniform float scaleFactor;
uniform int colormap;
uniform float posterizeLevels;
uniform float hideBelowValue;
uniform int projectionType;
uniform float projectionRadius;
uniform int edgeQuality;

varying vec2 vProjectedXY;

void main() {
    if (
    (edgeQuality > 0 && !isInsideProjectionDomain(vProjectedXY, projectionType, projectionRadius)) ||
        is_nan(v_value) ||
        v_value <= hideBelowValue
    ) {
        discard;
    }
    float normalized_value = clamp(addOffset + scaleFactor * v_value, 0.0, 1.0);
    normalized_value = posterize(normalized_value, posterizeLevels);
    #include "./applyColormap.glsl"
    gl_FragColor.a = 1.0;
}
