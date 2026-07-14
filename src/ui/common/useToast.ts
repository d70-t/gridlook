import { ref, type Ref } from "vue";

export const ToastType = {
  INFO: "info",
  SUCCESS: "success",
  WARNING: "warning",
  DANGER: "danger",
} as const;

export type TToastType = (typeof ToastType)[keyof typeof ToastType];

export type TToast = {
  id: number;
  summary: string;
  detail?: string;
  type: TToastType;
};

export type TAddToastOptions = {
  detail?: string;
  duration?: number;
  type?: TToastType;
};

type TUseToast = {
  toasts: Ref<TToast[]>;
  addToast: (summary: string, options?: TAddToastOptions) => number;
  removeToast: (toastId: number) => void;
};

const toasts = ref<TToast[]>([]);
let id = 0;

export function useToast(): TUseToast {
  function addToast(summary: string, options: TAddToastOptions = {}): number {
    const toastId = id++;
    const duration = options.duration ?? 3000;
    const type = options.type ?? ToastType.INFO;
    const toast: TToast = { id: toastId, summary, type };

    if (options.detail !== undefined) {
      toast.detail = options.detail;
    }

    toasts.value.push(toast);
    globalThis.setTimeout(() => removeToast(toastId), duration);

    return toastId;
  }

  function removeToast(toastId: number): void {
    toasts.value = toasts.value.filter((t) => t.id !== toastId);
  }

  return { toasts, addToast, removeToast };
}
