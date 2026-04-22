import type { Float32, Float64 } from "zarrita";

interface BitroundCodecConfig {
  /** Number of bytes per element (default: 1) */
  keepbits: number;
}
/**
 * Implementation simply taken over from zarrita.
 * For some magical reason zarrita has dropped bitround for Zarr V2?
 * We introduce it back again!
 */
export class BitroundCodec<D extends Float64 | Float32> {
  kind = "array_to_array" as const;

  constructor(
    configuration: BitroundCodecConfig = { keepbits: 8 },
    _meta: { dataType: D }
  ) {
    if (configuration.keepbits < 0) {
      throw new Error("keepbits must be zero or positive");
    }
  }

  static fromConfig(config: unknown, meta: unknown) {
    const validated = (config as BitroundCodecConfig) ?? { keepbits: 8 };
    return new BitroundCodec(
      validated,
      meta as { dataType: Float32 | Float64 }
    );
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
