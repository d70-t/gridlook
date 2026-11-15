type TWaiting = { go: () => void; priority: number };

/** After every waiting task of the same or a higher priority. */
function enqueue(waiting: TWaiting[], entry: TWaiting) {
  const at = waiting.findIndex((other) => other.priority > entry.priority);
  waiting.splice(at < 0 ? waiting.length : at, 0, entry);
}

/** Wait in the queue for a slot handed over; leave it if `signal` aborts. */
function wait(waiting: TWaiting[], priority: number, signal?: AbortSignal) {
  return new Promise<void>((resolve, reject) => {
    const go = () => {
      signal?.removeEventListener("abort", abort);
      resolve();
    };
    const abort = () => {
      const at = waiting.findIndex((entry) => entry.go === go);
      if (at >= 0) {
        waiting.splice(at, 1);
      }
      reject(signal?.reason ?? new Error("Aborted"));
    };
    enqueue(waiting, { go, priority });
    signal?.addEventListener("abort", abort, { once: true });
  });
}

/**
 * At most `size` tasks at once; the rest wait, the lower `priority` first
 * and in order within one (a restored session describes the windows on
 * screen before minimized ones). A waiting task whose signal aborts leaves
 * the queue and never starts.
 */
export function createSlots(size: number) {
  let busy = 0;
  const waiting: TWaiting[] = [];

  function release() {
    const next = waiting.shift();
    if (next) {
      // The slot passes straight to the next task.
      next.go();
    } else {
      busy--;
    }
  }

  async function acquire(signal?: AbortSignal, priority = 0) {
    if (signal?.aborted) {
      throw signal.reason ?? new Error("Aborted");
    }
    if (busy < size) {
      busy++;
      return;
    }
    await wait(waiting, priority, signal);
  }

  return {
    /** Run `task` in a slot; the slot frees when it settles. */
    async run<T>(
      task: () => Promise<T>,
      signal?: AbortSignal,
      priority = 0
    ): Promise<T> {
      await acquire(signal, priority);
      try {
        return await task();
      } finally {
        release();
      }
    },
    /** Tasks running and waiting (for tests and diagnostics). */
    get load() {
      return { running: busy, waiting: waiting.length };
    },
  };
}
