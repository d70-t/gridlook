bool is_nan(float val) {
    uint bits = floatBitsToUint(val);
    // exponent all 1s (0x7F800000) AND non-zero mantissa = NaN
    // exponent all 1s AND zero mantissa = Infinity (not NaN)
    return (bits & 0x7F800000u) == 0x7F800000u && (bits & 0x007FFFFFu) != 0u;
}
