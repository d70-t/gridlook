interface BitroundCodecConfig {
  keepbits: number;
}
/**
 * Implementation simply taken over from zarrita.
 * For some magical reason zarrita has dropped bitround for Zarr V2?
 * We introduce it back again!
 */
export class BitroundCodec {
  kind = "array_to_array" as const;

  constructor(configuration: BitroundCodecConfig = { keepbits: 8 }) {
    if (configuration.keepbits < 0) {
      throw new Error("keepbits must be zero or positive");
    }
  }

  static fromConfig(config: unknown) {
    const validated = (config as BitroundCodecConfig) ?? { keepbits: 8 };
    return new BitroundCodec(validated);
  }

  encode(): never {
    throw new Error("encode not implemented");
  }

  /**
   * Decode a chunk of data (no-op).
   * @param arr - The chunk to decode
   * @returns The decoded chunk
   */
  decode(arr: Uint8Array) {
    return arr; // No-op as bit-rounding is lossy
  }
}
