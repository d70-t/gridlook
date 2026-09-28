import type { TPathlineTrajectories } from "./pathlineTrajectories.ts";

export const PATHLINE_WORKER_MESSAGE = {
  PROGRESS: "progress",
  DONE: "done",
  ERROR: "error",
} as const;
export type TPathlineWorkerMessage =
  | { type: typeof PATHLINE_WORKER_MESSAGE.PROGRESS; completed: number }
  | {
      type: typeof PATHLINE_WORKER_MESSAGE.DONE;
      result: TPathlineTrajectories;
      integrationMs: number;
    }
  | { type: typeof PATHLINE_WORKER_MESSAGE.ERROR; error: string };
