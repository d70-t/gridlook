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
  if (isNormalizedError(maybeError)) return maybeError;

  try {
    return new Error(JSON.stringify(maybeError));
  } catch {
    // fallback in case there's an error stringifying the maybeError
    // like with circular references for example.
    return new Error(String(maybeError));
  }
}

export function getErrorMessage(error: unknown) {
  return toNormalizedError(error).message;
}
