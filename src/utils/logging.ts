import { useToast } from "primevue/usetoast";

import { getErrorMessage, toNormalizedError } from "./errorHandling";

export function useLog() {
  const toast = useToast();

  function logError(maybeError: unknown, context?: string) {
    const error = toNormalizedError(maybeError);
    console.error("Logged error:", error);
    const prefix = context ?? "Error";
    toast.add({
      summary: prefix,
      detail: `${getErrorMessage(error)}`,
      severity: "error",
      life: 4000,
    });
  }

  return { logError };
}
