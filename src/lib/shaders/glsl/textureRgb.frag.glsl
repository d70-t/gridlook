#include "../../projection/glsl/projectionDomain.glsl"
#include "./isNaN.glsl"

uniform float rgbLow;
uniform float rgbHigh;
uniform float gamma;
uniform float opacity;
uniform sampler2D data;
uniform vec2 dataUvOffset;
uniform vec2 dataUvScale;
uniform int clipToDataRect;
uniform int projectionType;
uniform float projectionRadius;
uniform int edgeQuality;

varying vec2 vUv;
varying vec2 vProjectedXY;

void main() {
    vec2 dataUv = (vUv - dataUvOffset) / dataUvScale;
    if (clipToDataRect == 1
    && (dataUv.x < 0.0 || dataUv.x > 1.0 || dataUv.y < 0.0 || dataUv.y > 1.0)) {
        discard;
    }
    vec3 value = texture(data, dataUv).rgb;
    // A value missing in any channel would shift the colour, so hide the pixel.
    if ((edgeQuality > 0 && !isInsideProjectionDomain(vProjectedXY, projectionType, projectionRadius))
    || is_nan(value.r) || is_nan(value.g) || is_nan(value.b)) {
        discard;
    }
    float range = rgbHigh - rgbLow;
    vec3 normalized = range == 0.0
        ? vec3(0.5)
        : clamp((value - rgbLow) / range, 0.0, 1.0);
    gl_FragColor = vec4(pow(normalized, vec3(1.0 / gamma)), opacity);
}
