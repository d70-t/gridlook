import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { ToastType, useToast } from "@/ui/common/useToast.ts";

const { addToast, toasts } = useToast();

beforeEach(() => {
  vi.useFakeTimers();
  toasts.value = [];
});

afterEach(() => {
  vi.clearAllTimers();
  vi.useRealTimers();
  toasts.value = [];
});

it("adds toasts and removes them after their duration", () => {
  const toastId = addToast("Saved", {
    detail: "The layer was saved.",
    duration: 10,
    type: ToastType.SUCCESS,
  });

  expect(toasts.value).toEqual([
    {
      id: toastId,
      summary: "Saved",
      detail: "The layer was saved.",
      type: ToastType.SUCCESS,
    },
  ]);

  vi.advanceTimersByTime(10);

  expect(toasts.value).toEqual([]);
});
