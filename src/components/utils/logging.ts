import { useToast } from "primevue/usetoast";
import { toNormalizedError } from "./errorHandling";

export function useLog() {
  const toast = useToast();

  function logError(maybeError: unknown, context?: string) {
    const error = toNormalizedError(maybeError);
    console.error(context, error, error?.stack);
    const prefix = context !== undefined ? `${context}: ` : "";
    toast.add({
      detail: `${prefix}${error.message}`,
      life: 3000,
    });
  }

  return { logError };
}
