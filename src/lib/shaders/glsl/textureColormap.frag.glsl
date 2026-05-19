#include "../../projection/glsl/projectionDomain.glsl"
#include "./colormapFunctions.glsl"
#include "./isNaN.glsl"
#include "./posterize.glsl"

uniform float addOffset;
uniform float scaleFactor;
uniform int colormap;
uniform float posterizeLevels;
uniform float hideBelowValue;
uniform sampler2D data;
uniform int projectionType;
uniform float projectionRadius;
uniform int edgeQuality;

varying vec2 vUv;
varying vec2 vProjectedXY;

void main() {
    float v_value = texture(data, vUv).r;
    if ((edgeQuality > 0 && !isInsideProjectionDomain(vProjectedXY, projectionType, projectionRadius))
    || is_nan(v_value) || v_value <= hideBelowValue) {
        discard;
    }
    gl_FragColor.a = 1.0;
    float normalized_value = clamp(addOffset + scaleFactor * v_value, 0.0, 1.0);
    normalized_value = posterize(normalized_value, posterizeLevels);

    #include "./applyColormap.glsl"
}
