import { afterEach, beforeEach, expect, it, vi } from "vitest";

import { PATHLINE_GRID } from "@/lib/data/pathlineField.ts";
import type { TPathlineConfig } from "@/lib/data/pathlineTrajectories.ts";
import {
  PATHLINE_WORKER_MESSAGE,
  type TPathlineWorkerMessage,
} from "@/lib/data/pathlineWorkerProtocol.ts";
import { integratePathlinesInWorkers } from "@/lib/data/pathlineWorkers.ts";
import {
  runPathlineWorkerTask,
  type TPathlineWorkerInput,
  type TPathlineWorkerTask,
} from "@/lib/data/pathlineWorkerTask.ts";

const workers: TTestWorker[] = [];
let hold = false;
class TTestWorker {
  onmessage: ((event: MessageEvent<TPathlineWorkerMessage>) => void) | null =
    null;
  onerror: ((event: ErrorEvent) => void) | null = null;
  onmessageerror: (() => void) | null = null;
  terminate = vi.fn();
  task?: TPathlineWorkerTask;
  constructor() {
    workers.push(this);
  }
  postMessage(task: TPathlineWorkerTask) {
    this.task = structuredClone(task);
    if (!hold) {
      // Deliberately complete the final range first, to exercise ordered merging.
      setTimeout(
        () => {
          void this.run();
        },
        task.start === 0 ? 10 : 0
      );
    }
  }
  emit(data: TPathlineWorkerMessage) {
    if (!this.terminate.mock.calls.length) {
      this.onmessage?.({ data } as MessageEvent<TPathlineWorkerMessage>);
    }
  }
  async run() {
    let integrationMs = 0;
    const result = await runPathlineWorkerTask(
      this.task!,
      (completed) =>
        this.emit({ type: PATHLINE_WORKER_MESSAGE.PROGRESS, completed }),
      (ms) => {
        integrationMs = ms;
      }
    );
    const transferred = structuredClone(result, {
      transfer: [
        result.positions.buffer,
        result.times.buffer,
        result.counts.buffer,
      ],
    });
    this.emit({
      type: PATHLINE_WORKER_MESSAGE.DONE,
      result: transferred,
      integrationMs,
    });
  }
}
const config: TPathlineConfig = {
  particleCount: 7,
  randomSeed: 42,
  sampleSeconds: 10,
  maxStepSeconds: 5,
  maxStepMetres: 1000,
  errorToleranceMetres: 1,
};
const input: TPathlineWorkerInput = {
  grid: {
    kind: PATHLINE_GRID.REGULAR,
    x: new Float32Array([-180, -90, 0, 90]),
    y: new Float32Array([-89, 89]),
  },
  times: [0, 30, 90],
  fields: [1, 3, 2].map((u) => ({
    u: new Float32Array(8).fill(u),
    v: new Float32Array(8),
    gridRelative: false,
  })),
};
beforeEach(() => {
  workers.length = 0;
  hold = false;
  vi.stubGlobal("Worker", TTestWorker);
  vi.stubGlobal("navigator", { hardwareConcurrency: 8 });
});
afterEach(() => vi.unstubAllGlobals());

it("merges worker ranges deterministically without transferring retained velocity data", async () => {
  const baseline = await integratePathlinesInWorkers(input, {
    ...config,
    workerCount: 1,
  });
  const onProgress = vi.fn();
  const parallel = await integratePathlinesInWorkers(
    input,
    { ...config, workerCount: 4 },
    { onProgress }
  );
  expect(parallel).toEqual(baseline);
  expect(workers).toHaveLength(5);
  expect(
    workers.every((worker) => worker.terminate.mock.calls.length > 0)
  ).toBe(true);
  expect(input.fields[0].u.byteLength).toBe(32);
  expect(onProgress).toHaveBeenLastCalledWith(7, 7);
  let previous = 0;
  for (const [done] of onProgress.mock.calls) {
    expect(done).toBeGreaterThanOrEqual(previous);
    previous = done;
  }
});

it("terminates all workers immediately on cancellation and ignores late messages", async () => {
  hold = true;
  const controller = new AbortController();
  const onProgress = vi.fn();
  const job = integratePathlinesInWorkers(
    input,
    { ...config, workerCount: 4 },
    { signal: controller.signal, onProgress }
  );
  controller.abort();
  await expect(job).rejects.toMatchObject({ name: "AbortError" });
  expect(
    workers.every((worker) => worker.terminate.mock.calls.length === 1)
  ).toBe(true);
  workers[0].onmessage?.({
    data: { type: PATHLINE_WORKER_MESSAGE.PROGRESS, completed: 1 },
  } as MessageEvent<TPathlineWorkerMessage>);
  expect(onProgress).not.toHaveBeenCalled();
});

it("does not allocate a worker for an already-cancelled job", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(
    integratePathlinesInWorkers(input, config, { signal: controller.signal })
  ).rejects.toMatchObject({ name: "AbortError" });
  expect(workers).toHaveLength(0);
});

it.each(["solver", "startup", "decode", "stale", "malformed"])(
  "releases every worker after %s failure",
  async (failure) => {
    hold = true;
    let current = true;
    const job = integratePathlinesInWorkers(
      input,
      { ...config, workerCount: 2 },
      { isCurrent: () => current }
    );
    if (failure === "solver") {
      workers[0].emit({
        type: PATHLINE_WORKER_MESSAGE.ERROR,
        error: "Invalid field",
      });
    }
    if (failure === "startup") {
      workers[0].onerror?.({
        preventDefault: vi.fn(),
        message: "Worker startup failed",
      } as unknown as ErrorEvent);
    }
    if (failure === "decode") {
      workers[0].onmessageerror?.();
    }
    if (failure === "stale") {
      current = false;
      workers[0].emit({ type: PATHLINE_WORKER_MESSAGE.PROGRESS, completed: 0 });
    }
    if (failure === "malformed") {
      workers[0].emit({
        type: PATHLINE_WORKER_MESSAGE.PROGRESS,
        completed: 99,
      });
    }
    await expect(job).rejects.toBeInstanceOf(Error);
    expect(
      workers.every((worker) => worker.terminate.mock.calls.length === 1)
    ).toBe(true);
  }
);

it("rejects invalid worker counts before starting work and limits workers to particles", async () => {
  for (const workerCount of [0, 1.5, NaN, 9]) {
    expect(() =>
      integratePathlinesInWorkers(input, { ...config, workerCount })
    ).toThrow(/workers/);
  }
  await integratePathlinesInWorkers(input, {
    ...config,
    particleCount: 2,
    workerCount: 8,
  });
  expect(workers).toHaveLength(2);
});

it("reports worker integration time separately from startup and preserves results after warmup", async () => {
  const baseline = await integratePathlinesInWorkers(input, config);
  const onTiming = vi.fn();
  const warmed = await integratePathlinesInWorkers(input, config, {
    warmup: true,
    onTiming,
  });
  expect(warmed).toEqual(baseline);
  expect(workers.at(-1)!.task!.warmup).toBe(true);
  expect(onTiming).toHaveBeenCalledOnce();
  expect(onTiming.mock.calls[0][0]).toBeGreaterThanOrEqual(0);
  expect(onTiming.mock.calls[0][1]).toBe(config.particleCount);
});
