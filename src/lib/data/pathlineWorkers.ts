import {
  planPathlineTrajectories,
  type TPathlineConfig,
  type TPathlineIntegrationOptions,
  type TPathlineTrajectories,
} from "./pathlineTrajectories.ts";
import {
  PATHLINE_WORKER_MESSAGE,
  type TPathlineWorkerMessage,
} from "./pathlineWorkerProtocol.ts";
import type {
  TPathlineWorkerInput,
  TPathlineWorkerTask,
} from "./pathlineWorkerTask.ts";

export function pathlineWorkerLimit() {
  return Math.max(1, globalThis.navigator?.hardwareConcurrency || 4);
}
export function pathlineWorkerCount(config: TPathlineConfig) {
  const count = config.workerCount ?? 1;
  if (
    !Number.isSafeInteger(count) ||
    count < 1 ||
    count > pathlineWorkerLimit()
  ) {
    throw new Error(
      `Choose between 1 and ${pathlineWorkerLimit()} integration workers.`
    );
  }
  return Math.min(count, config.particleCount);
}

/** A job owns its workers; termination cancels even a long synchronous RK solve. */
// eslint-disable-next-line max-lines-per-function
export function integratePathlinesInWorkers(
  input: TPathlineWorkerInput,
  config: TPathlineConfig,
  options: Pick<
    TPathlineIntegrationOptions,
    "signal" | "isCurrent" | "onProgress"
  > & {
    warmup?: boolean;
    onTiming?: (milliseconds: number, particles: number) => void;
  } = {}
): Promise<TPathlineTrajectories> {
  const count = pathlineWorkerCount(config);
  const plan = planPathlineTrajectories(input.times, config);
  // eslint-disable-next-line max-lines-per-function
  return new Promise((resolve, reject) => {
    const workers: Worker[] = [];
    const progress = new Array<number>(count).fill(0);
    let finished = 0,
      settled = false;
    let result: TPathlineTrajectories | undefined;
    function cleanup() {
      settled = true;
      for (const worker of workers) {
        worker.terminate();
      }
      options.signal?.removeEventListener("abort", cancel);
    }
    function fail(error: Error) {
      if (!settled) {
        cleanup();
        reject(error);
      }
    }
    function cancel() {
      fail(new DOMException("Pathline integration cancelled", "AbortError"));
    }
    function current() {
      if (settled) {
        return false;
      }
      if (options.signal?.aborted || options.isCurrent?.() === false) {
        cancel();
        return false;
      }
      return true;
    }
    options.signal?.addEventListener("abort", cancel, { once: true });
    try {
      if (!current()) {
        return;
      }
      // ponytail: each worker owns a velocity/grid copy. SharedArrayBuffer would
      // remove these copies but requires cross-origin isolation of the app.
      for (let i = 0; i < count; i++) {
        const start = Math.floor((i * config.particleCount) / count);
        const end = Math.floor(((i + 1) * config.particleCount) / count);
        const worker = new Worker(
          new URL("./pathline.worker.ts", import.meta.url),
          { type: "module" }
        );
        workers.push(worker);
        // eslint-disable-next-line max-lines-per-function
        worker.onmessage = ({ data }: MessageEvent<TPathlineWorkerMessage>) => {
          if (!current()) {
            return;
          }
          try {
            if (data.type === PATHLINE_WORKER_MESSAGE.ERROR) {
              throw new Error(data.error);
            }
            if (data.type === PATHLINE_WORKER_MESSAGE.PROGRESS) {
              if (
                !Number.isSafeInteger(data.completed) ||
                data.completed < progress[i] ||
                data.completed > end - start
              ) {
                throw new Error("Invalid pathline worker progress.");
              }
              progress[i] = data.completed;
            } else if (data.type === PATHLINE_WORKER_MESSAGE.DONE) {
              const part = data.result;
              const records = (end - start) * plan.capacity;
              if (
                !Number.isFinite(data.integrationMs) ||
                data.integrationMs < 0 ||
                !(part.positions instanceof Float32Array) ||
                !(part.times instanceof Float64Array) ||
                !(part.counts instanceof Uint32Array) ||
                part.capacity !== plan.capacity ||
                part.counts.length !== end - start ||
                part.times.length !== records ||
                part.positions.length !== records * 3 ||
                part.start !== input.times[0] ||
                part.end !== input.times.at(-1)
              ) {
                throw new Error("Invalid pathline worker result.");
              }
              options.onTiming?.(data.integrationMs, end - start);
              worker.terminate();
              worker.onmessage = null;
              if (count === 1) {
                result = part;
              } else {
                result ??= {
                  positions: new Float32Array(plan.records * 3),
                  times: new Float64Array(plan.records),
                  counts: new Uint32Array(config.particleCount),
                  capacity: plan.capacity,
                  start: part.start,
                  end: part.end,
                };
                result.positions.set(part.positions, start * plan.capacity * 3);
                result.times.set(part.times, start * plan.capacity);
                result.counts.set(part.counts, start);
              }
              progress[i] = end - start;
              finished++;
            } else {
              throw new Error("Unexpected pathline worker message.");
            }
            options.onProgress?.(
              progress.reduce((sum, n) => sum + n, 0),
              config.particleCount
            );
            if (finished === count) {
              cleanup();
              resolve(result!);
            }
          } catch (error) {
            fail(error instanceof Error ? error : new Error(String(error)));
          }
        };
        worker.onerror = (event) => {
          event.preventDefault();
          fail(new Error(event.message || "Pathline worker failed."));
        };
        worker.onmessageerror = () =>
          fail(new Error("Pathline worker response could not be read."));
        const task: TPathlineWorkerTask = {
          ...input,
          config: { ...config },
          start,
          end,
          warmup: options.warmup,
        };
        worker.postMessage(task);
      }
    } catch (error) {
      fail(error instanceof Error ? error : new Error(String(error)));
    }
  });
}
