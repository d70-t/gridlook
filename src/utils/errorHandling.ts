// Handling catch-clauses in TypeScript is quite annoying as you can throw
// essentially everything in JS.
// This is a workaround to get clean error messages
// Credits:
// https://kentcdodds.com/blog/get-a-catch-block-error-message-with-typescript

type NormalizedError = {
  message: string;
  stack?: unknown;
};

function isNormalizedError(error: unknown): error is NormalizedError {
  return (
    typeof error === "object" &&
    error !== null &&
    "message" in error &&
    typeof (error as Record<string, unknown>).message === "string"
  );
}

export function toNormalizedError(maybeError: unknown): NormalizedError {
  if (isNormalizedError(maybeError)) {
    return maybeError;
  }

  try {
    return new Error(JSON.stringify(maybeError));
  } catch {
    // fallback in case there's an error stringifying the maybeError
    // like with circular references for example.
    return new Error(String(maybeError));
  }
}

export function getErrorMessage(error: unknown) {
  const errorMessage = toNormalizedError(error).message;
  // strip quotation marks added by JSON.stringify
  return errorMessage.replace(/^"(.*)"$/, "$1");
}

/**
 * Flatten an error to a string that survives `postMessage`.
 *
 * zarrita reports a codec that threw as a `CodecPipelineError` naming the
 * codec, with the reason it threw — a checksum mismatch, a truncated chunk —
 * on `cause`. Structured-cloning an Error keeps neither the subclass nor the
 * cause, so a worker that posts back only `error.message` drops the reason
 * before anyone can read it. Appending the cause keeps both halves.
 */
export function flattenErrorMessage(error: unknown): string {
  if (!(error instanceof Error)) {
    return String(error);
  }
  const cause = error.cause instanceof Error ? error.cause.message : undefined;
  return cause ? `${error.message} — ${cause}` : error.message;
}
