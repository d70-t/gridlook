uniform float scalarMix;

float scalarAtTime(float first, float next) {
    if (scalarMix <= 0.0) return first;
    if (scalarMix >= 1.0) return next;
    return mix(first, next, scalarMix);
}
