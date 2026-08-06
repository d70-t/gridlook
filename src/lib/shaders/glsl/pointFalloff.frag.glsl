#include "./colormapFunctions.glsl"
#include "./isNaN.glsl"
#include "./posterize.glsl"

varying float v_value;
uniform float addOffset;
uniform float scaleFactor;
uniform int colormap;
uniform float posterizeLevels;
uniform float hideBelowValue;
uniform float hideAboveValue;

void main() {
    vec2 uv = gl_PointCoord * 2.0 - 1.0;
    float r2 = dot(uv, uv);
    // Soft circular splat using Gaussian falloff
    float falloff = exp(-r2 * 2.0);
    if (falloff < 0.01) discard;

    if (is_nan(v_value) || v_value <= hideBelowValue || v_value >= hideAboveValue) {
        gl_FragColor = vec4(0.0, 0.0, 0.0, 0.0);
        return;
    }

    float normalized_value = clamp(addOffset + scaleFactor * v_value, 0.0, 1.0);
    normalized_value = posterize(normalized_value, posterizeLevels);

    #include "./applyColormap.glsl"
    gl_FragColor.a = falloff;
}
