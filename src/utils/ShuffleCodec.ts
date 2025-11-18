import { registry } from "zarrita";

declare module "zarrita" {
  export class Codec {
    decode(data: Uint8Array): Promise<Uint8Array>;
    encode(data: Uint8Array): Promise<Uint8Array>;
  }
}

/**
 * Configuration options for ShuffleZlibCodec
 */
interface ShuffleConfig {
  /** Number of bytes per element (default: 1) */
  elementSize?: number;
  /** Compression level 0-9 (default: 1) */
  level?: 0 | 1 | -1 | 2 | 3 | 4 | 5 | 6 | 7 | 8 | 9 | undefined;
}

/**
 * Implements Numcodecs-style shuffle + zlib filter combo for Zarrita v2.
 * This codec combines byte shuffling with zlib compression.
 */
export class ShuffleCodec {
  private elementSize: number;
  kind = "bytes_to_bytes";

  static fromConfig(configuration: ShuffleConfig = {}) {
    return new ShuffleCodec(configuration);
  }

  constructor(configuration: ShuffleConfig = {}) {
    const { elementSize = 4 } = configuration;

    this.elementSize = elementSize;
  }

  async decode(data: Uint8Array): Promise<Uint8Array> {
    return unshuffle(data, this.elementSize);
  }

  /**
   * Encode (shuffle and compress) the data
   */
  encode(): never {
    throw new Error("encode not implemented");
  }
}

function unshuffle(data: Uint8Array, elementSize: number): Uint8Array {
  const length = data.length;
  const nElements = Math.floor(length / elementSize);
  const result = new Uint8Array(length);

  for (let byte = 0; byte < elementSize; byte++) {
    for (let i = 0; i < nElements; i++) {
      result[i * elementSize + byte] = data[byte * nElements + i];
    }
  }

  return result;
}

// Create registry and register codec
registry.set("shuffle", async () => ShuffleCodec);
