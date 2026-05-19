#include "./colormapFunctions.glsl"
#include "./posterize.glsl"

varying float v_value;
uniform float addOffset;
uniform float scaleFactor;
uniform int colormap;
uniform float posterizeLevels;
uniform float selLow;
uniform float selHigh;

void main() {
    float t;
    if (v_value < selLow || v_value > selHigh) {
        // Sample the colormap at its minimum or maximum edge color
        t = v_value < selLow ? 0.0 : 1.0;
    } else {
        float range = max(selHigh - selLow, 0.0001);
        t = (v_value - selLow) / range;
    }

    float normalized_value = clamp(addOffset + scaleFactor * t, 0.0, 1.0);
    normalized_value = posterize(normalized_value, posterizeLevels);

    #include "./applyColormap.glsl"
    gl_FragColor.a = 1.0;
}
