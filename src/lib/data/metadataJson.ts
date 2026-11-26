import * as zarr from "zarrita";

/**
 * zarrita reports unparsable metadata as "Failed to decode JSON" without
 * naming the file, and gridlook's format probing treats that like "not this
 * format", so the reader ends up with an unrelated error. A common cause is a
 * writer (Python's `json.dumps`) emitting a bare `NaN` for `fill_value`: JSON
 * has no NaN, Zarr spells it `"NaN"`. This store extension checks metadata
 * files as they are read and throws an error that names the file and the
 * problem.
 */

const METADATA_KEY =
  /(?:^|\/)(?:\.zmetadata|\.zarray|\.zattrs|\.zgroup|zarr\.json)$/;
const BARE_NON_FINITE = /[:,[]\s*(-?(?:NaN|Infinity))\s*[,}\]]/;
const MESSAGE_PREFIX = "Invalid Zarr metadata";

export class MetadataJsonError extends Error {
  name = "MetadataJsonError";
}

function describe(key: string, text: string, cause: unknown) {
  const bare = BARE_NON_FINITE.exec(text);
  if (bare) {
    const line = text.slice(0, bare.index).split("\n").length;
    return (
      `${MESSAGE_PREFIX} in "${key}": line ${line} has a bare ${bare[1]}, ` +
      `which is not valid JSON. Zarr writes it as a string, e.g. ` +
      `"fill_value": "${bare[1]}".`
    );
  }
  const reason = cause instanceof Error ? cause.message : String(cause);
  return `${MESSAGE_PREFIX} in "${key}": not valid JSON (${reason}).`;
}

function assertMetadataJson(key: string, bytes: Uint8Array) {
  const text = new TextDecoder().decode(bytes);
  try {
    JSON.parse(text);
  } catch (cause) {
    throw new MetadataJsonError(describe(key, text, cause), { cause });
  }
}

// ponytail: metadata is parsed twice (here and in zarrita); the byte cache
// wrapped around this keeps it to once per file.
export const withMetadataJsonCheck = zarr.defineStoreExtension((store) => ({
  async get(key, options) {
    const bytes = await store.get(key, options);
    if (bytes && METADATA_KEY.test(key)) {
      assertMetadataJson(key, bytes);
    }
    return bytes;
  },
}));

/** Toast text; matched by message as worker errors arrive flattened. */
export function explainMetadataJsonError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(MESSAGE_PREFIX)
    ? { heading: MESSAGE_PREFIX, detail: message }
    : undefined;
}
