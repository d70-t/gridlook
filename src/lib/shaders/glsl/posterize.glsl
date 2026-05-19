float posterize(float value, float levels) {
    if (levels > 1.0) {
        float step = floor(value * levels);
        step = min(step, levels - 1.0);  // Prevent overflow at max value
        return step / (levels - 1.0);
    }
    return value;
}
