import { ref, type Ref } from "vue";

export const ToastType = {
  INFO: "info",
  SUCCESS: "success",
  WARNING: "warning",
  DANGER: "danger",
} as const;

export type TToastType = (typeof ToastType)[keyof typeof ToastType];

/** One button on the toast (e.g. Undo); using it closes the toast. */
type TToastAction = { label: string; run: () => void };

type TToast = {
  id: number;
  summary: string;
  detail?: string;
  type: TToastType;
  action?: TToastAction;
  /** A one-line notice: small, no large icon. */
  compact?: boolean;
  /** A picture of the gesture instead of the type's icon. */
  icon?: "right-click";
};

type TAddToastOptions = {
  detail?: string;
  duration?: number;
  type?: TToastType;
  action?: TToastAction;
  compact?: boolean;
  icon?: "right-click";
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
    if (options.action) {
      toast.action = options.action;
    }
    if (options.compact) {
      toast.compact = true;
    }
    if (options.icon) {
      toast.icon = options.icon;
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
