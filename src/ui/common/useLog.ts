import { ToastType, useToast } from "./useToast.ts";

import { getErrorMessage, toNormalizedError } from "@/utils/errorHandling.ts";

export function useLog() {
  const { addToast } = useToast();

  function logError(maybeError: unknown, context?: string) {
    const error = toNormalizedError(maybeError);
    console.error(context, error, error?.stack);
    const prefix = context ?? "Error";
    addToast(prefix, {
      detail: `${getErrorMessage(error)}`,
      duration: 4000,
      type: ToastType.DANGER,
    });
  }

  return { logError };
}
