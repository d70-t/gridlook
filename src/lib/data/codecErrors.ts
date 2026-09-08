import * as zarr from "zarrita";

/**
 * A dataset whose chunks use a codec gridlook has no decoder for behaves
 * exactly like a dataset that is merely slow or unreachable: the repository
 * opens, every variable is listed, and the failure only arrives on the first
 * chunk read. zarrita raises a precise error at that point — it names the
 * codec — but the message reaches the reader under a "Could not fetch data"
 * heading that points at the network, which is the wrong place to look.
 *
 * This module classifies those errors and rewrites them into something that
 * says which codec is missing. It changes no behaviour and adds no data path:
 * an unsupported dataset still fails, it just says why. Naming the codec is
 * also what makes the gap reportable — an unsupported codec is invisible until
 * someone runs into a dataset that uses it.
 *
 * Errors are matched both structurally and by message text, because the grid
 * data worker flattens errors to a plain string before posting them back to
 * the main thread (see `src/lib/grids/gridData.worker.ts`), so by the time one
 * reaches the UI its class and fields are gone.
 */

export type TCodecErrorExplanation = {
  heading: string;
  detail: string;
};

const UNKNOWN_CODEC = /^Unknown codec:\s*(\S+)/;
const CODEC_PIPELINE = /^Failed to (?:de|en)code chunk via codec "([^"]+)"/;
const UNSUPPORTED_DATA_TYPE = /^Unknown or unsupported dataType:\s*(\S+)/;

/** The `: reason` the worker appends when flattening a wrapped error. */
const FLATTENED_CAUSE = /(?:^|\s)—\s(.+)$/;

function messageOf(error: unknown) {
  if (error instanceof Error) {
    return error.message;
  }
  return typeof error === "string" ? error : "";
}

function causeMessageOf(error: unknown) {
  if (error instanceof Error && error.cause instanceof Error) {
    return error.cause.message;
  }
  // Across the worker boundary the cause survives only as flattened text.
  return messageOf(error).match(FLATTENED_CAUSE)?.[1];
}

function unknownCodecName(error: unknown) {
  if (zarr.isZarritaError(error, "UnknownCodecError")) {
    return error.codec;
  }
  return messageOf(error).match(UNKNOWN_CODEC)?.[1];
}

function failingCodecName(error: unknown) {
  if (zarr.isZarritaError(error, "CodecPipelineError")) {
    return error.codec;
  }
  return messageOf(error).match(CODEC_PIPELINE)?.[1];
}

function unsupportedDataType(error: unknown) {
  return messageOf(error).match(UNSUPPORTED_DATA_TYPE)?.[1];
}

function explainUnknownCodec(codec: string): TCodecErrorExplanation {
  return {
    heading: `Unsupported codec: ${codec}`,
    detail:
      `This dataset's chunks are compressed with "${codec}", which gridlook ` +
      `has no decoder for. The data and the connection are fine — only the ` +
      `codec is missing. Quote that codec name when reporting it.`,
  };
}

function explainCodecFailure(
  codec: string,
  cause: string | undefined
): TCodecErrorExplanation {
  return {
    heading: `Codec failed: ${codec}`,
    detail: cause
      ? `Decoding a chunk with "${codec}" failed: ${cause}`
      : `Decoding a chunk with "${codec}" failed. The codec is available but ` +
        `rejected this dataset's chunks.`,
  };
}

function explainUnsupportedDataType(dataType: string): TCodecErrorExplanation {
  const isFloat16 = dataType.startsWith("float16");
  return {
    heading: `Unsupported data type: ${dataType}`,
    detail: isFloat16
      ? `This variable is stored as ${dataType}, which this browser cannot ` +
        `represent. Chrome 135, Firefox 129 or Safari 26 and newer support it.`
      : `This variable is stored as ${dataType}, which gridlook cannot read.`,
  };
}

/**
 * Recognise a codec or data-type failure and describe it in the reader's
 * terms. Returns `undefined` for everything else, so callers fall back to
 * whatever they showed before.
 */
export function explainCodecError(
  error: unknown
): TCodecErrorExplanation | undefined {
  const missingCodec = unknownCodecName(error);
  if (missingCodec) {
    return explainUnknownCodec(missingCodec);
  }

  const brokenCodec = failingCodecName(error);
  if (brokenCodec) {
    return explainCodecFailure(brokenCodec, causeMessageOf(error));
  }

  const dataType = unsupportedDataType(error);
  if (dataType) {
    return explainUnsupportedDataType(dataType);
  }

  return undefined;
}
