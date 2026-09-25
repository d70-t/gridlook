import type { GetOptions } from "zarrita";

type TChunkQueue = ReturnType<NonNullable<GetOptions["createQueue"]>>;

export const SCALAR_CHUNK_LIMITS = {
  TARGET_BYTES: 64 * 1024 * 1024,
  MAX_CONCURRENCY: 4,
} as const;

export function scalarChunkConcurrency(chunkBytes: number) {
  return Math.max(
    1,
    Math.min(
      SCALAR_CHUNK_LIMITS.MAX_CONCURRENCY,
      Math.floor(SCALAR_CHUNK_LIMITS.TARGET_BYTES / chunkBytes)
    )
  );
}

/** Zarrita calls onIdle after enqueuing the chunks for a selection. */
export function createGridDataQueue(
  concurrency: number,
  report?: (completed: number, total: number) => void
): TChunkQueue {
  if (!Number.isInteger(concurrency) || concurrency < 1) {
    throw new Error("Chunk concurrency must be a positive integer.");
  }
  const tasks: (() => Promise<void>)[] = [];
  return {
    add(task) {
      tasks.push(task);
    },
    async onIdle() {
      let next = 0;
      let completed = 0;
      let failed = false;
      report?.(0, tasks.length);
      const run = async () => {
        while (!failed && next < tasks.length) {
          const task = tasks[next++];
          try {
            await task();
            report?.(++completed, tasks.length);
          } catch (error) {
            failed = true;
            throw error;
          }
        }
      };
      const results = await Promise.allSettled(
        Array.from({ length: Math.min(concurrency, tasks.length) }, run)
      );
      tasks.length = 0;
      for (const result of results) {
        if (result.status === "rejected") {
          throw result.reason;
        }
      }
      return [];
    },
  };
}
