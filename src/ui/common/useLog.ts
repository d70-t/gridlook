import { ToastType, useToast } from "./useToast.ts";

import { explainCodecError } from "@/lib/data/codecErrors.ts";
import { getErrorMessage, toNormalizedError } from "@/utils/errorHandling.ts";

// A codec or data-type failure is worth reading and worth writing down, so it
// stays up longer than a transient error.
const EXPLAINED_ERROR_DURATION = 12000;

export function useLog() {
  const { addToast } = useToast();

  function logError(maybeError: unknown, context?: string) {
    const error = toNormalizedError(maybeError);
    console.error(context, error, error?.stack);
    // A recognised codec problem describes itself better than the call site
    // can: "Could not fetch data" sends the reader to the network, which is
    // not where the problem is.
    const explanation = explainCodecError(maybeError);
    const prefix = explanation?.heading ?? context ?? "Error";
    addToast(prefix, {
      detail: explanation?.detail ?? `${getErrorMessage(error)}`,
      duration: explanation ? EXPLAINED_ERROR_DURATION : 4000,
      type: ToastType.DANGER,
    });
  }

  return { logError };
}
