import type { Chunk, CodecMetadata, DataType } from "zarrita";

const LOG_BIN_COUNT = 254;
const MAX_CENTROID_CODE = 253;
const HIGH_CUTOFF_CODE = 254;
const NAN_CODE = 255;

type TChunkMeta = {
  codecs: CodecMetadata[];
  dataType: DataType;
  fillValue: unknown;
  shape: number[];
};

type TLogBinsConfig = {
  high: number;
  low: number;
};

export class LogBinsCodec {
  readonly kind = "array_to_array" as const;
  readonly #bins: Float32Array;
  readonly #centroids: Float32Array;

  constructor(low: number, high: number) {
    validateRange(low, high);
    this.#bins = createLogBins(low, high);
    this.#centroids = createCentroids(this.#bins);
  }

  static fromConfig(configuration: unknown) {
    const config = parseConfig(configuration);
    return new LogBinsCodec(config.low, config.high);
  }

  encode(data: Uint8Array): Uint8Array;
  encode(chunk: Chunk<"float32">): Chunk<"uint8">;
  encode(data: Uint8Array | Chunk<"float32">): Uint8Array | Chunk<"uint8"> {
    if (data instanceof Uint8Array) {
      throw new Error("LogBins codec is an array-to-array codec");
    }

    const chunk = data;
    if (!(chunk.data instanceof Float32Array)) {
      throw new Error("LogBins codec can only encode Float32Array data");
    }

    const encoded = new Uint8Array(chunk.data.length);
    for (let i = 0; i < chunk.data.length; i++) {
      encoded[i] = this.#encodeValue(chunk.data[i]);
    }

    return { data: encoded, shape: chunk.shape, stride: chunk.stride };
  }

  decode(data: Uint8Array): Uint8Array;
  decode(chunk: Chunk<"uint8">): Chunk<"float32">;
  decode(data: Uint8Array | Chunk<"uint8">): Uint8Array | Chunk<"float32"> {
    if (data instanceof Uint8Array) {
      throw new Error("LogBins codec is an array-to-array codec");
    }

    const chunk = data;
    if (!(chunk.data instanceof Uint8Array)) {
      throw new Error("LogBins codec can only decode Uint8Array data");
    }

    const decoded = new Float32Array(chunk.data.length);
    for (let i = 0; i < chunk.data.length; i++) {
      decoded[i] = this.#decodeValue(chunk.data[i]);
    }

    return { data: decoded, shape: chunk.shape, stride: chunk.stride };
  }

  getEncodedMeta(meta: TChunkMeta): TChunkMeta {
    return {
      ...meta,
      dataType: "uint8",
      fillValue: this.#encodeFillValue(meta.fillValue),
    };
  }

  #decodeValue(value: number) {
    if (value === 0) {
      return 0;
    }
    if (value === HIGH_CUTOFF_CODE) {
      return this.#bins[this.#bins.length - 1];
    }
    if (value === NAN_CODE) {
      return NaN;
    }
    return this.#centroids[Math.min(value, MAX_CENTROID_CODE) - 1];
  }

  #encodeFillValue(value: unknown) {
    if (value === null || value === undefined) {
      return value;
    }
    if (typeof value !== "number") {
      return value;
    }
    return this.#encodeValue(value);
  }

  #encodeValue(value: number) {
    if (Number.isNaN(value)) {
      return NAN_CODE;
    }
    return Math.min(
      countBinsLessThanOrEqualTo(value, this.#bins),
      NAN_CODE - 1
    );
  }
}

function parseConfig(configuration: unknown): TLogBinsConfig {
  if (
    typeof configuration === "object" &&
    configuration !== null &&
    "low" in configuration &&
    "high" in configuration
  ) {
    const low = Number(configuration.low);
    const high = Number(configuration.high);
    validateRange(low, high);
    return { high, low };
  }

  throw new Error("LogBins codec requires numeric low and high configuration");
}

function validateRange(low: number, high: number) {
  if (
    !Number.isFinite(low) ||
    !Number.isFinite(high) ||
    low <= 0 ||
    high <= low
  ) {
    throw new Error("LogBins codec requires 0 < low < high");
  }
}

function createLogBins(low: number, high: number) {
  const bins = new Float32Array(LOG_BIN_COUNT);
  const logLow = Math.log10(low);
  const logStep = (Math.log10(high) - logLow) / (LOG_BIN_COUNT - 1);

  for (let i = 0; i < bins.length; i++) {
    bins[i] = Math.pow(10, logLow + i * logStep);
  }

  return bins;
}

function createCentroids(bins: Float32Array) {
  const centroids = new Float32Array(bins.length - 1);
  for (let i = 0; i < centroids.length; i++) {
    centroids[i] = 0.5 * (bins[i] + bins[i + 1]);
  }
  return centroids;
}

function countBinsLessThanOrEqualTo(value: number, bins: Float32Array) {
  let low = 0;
  let high = bins.length;

  while (low < high) {
    const mid = Math.floor((low + high) / 2);
    if (value < bins[mid]) {
      high = mid;
    } else {
      low = mid + 1;
    }
  }

  return low;
}
