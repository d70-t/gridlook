export function downsampleDataTexture(
  src: Float32Array,
  srcWidth: number,
  srcHeight: number,
  dstWidth: number,
  dstHeight: number
): Float32Array {
  const dst = new Float32Array(dstWidth * dstHeight);
  for (let y = 0; y < dstHeight; y++) {
    const srcY = Math.round((y * (srcHeight - 1)) / (dstHeight - 1));
    for (let x = 0; x < dstWidth; x++) {
      const srcX = Math.round((x * (srcWidth - 1)) / (dstWidth - 1));
      dst[y * dstWidth + x] = src[srcY * srcWidth + srcX];
    }
  }
  return dst;
}
