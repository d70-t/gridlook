import {
  PATHLINE_WORKER_MESSAGE,
  type TPathlineWorkerMessage,
} from "./pathlineWorkerProtocol.ts";
import type { TPathlineWorkerTask } from "./pathlineWorkerTask.ts";

import "@/utils/disposablePolyfill.ts";

const send = (message: TPathlineWorkerMessage, transfer: Transferable[] = []) =>
  self.postMessage(message, { transfer });

self.onmessage = async (event: MessageEvent<TPathlineWorkerTask>) => {
  try {
    // Register onmessage before loading the WASM sampler: a top-level await can
    // otherwise consume the first message before the handler is installed.
    const { runPathlineWorkerTask } = await import("./pathlineWorkerTask.ts");
    let nextProgress = 0;
    let integrationMs = 0;
    const result = await runPathlineWorkerTask(
      event.data,
      (completed) => {
        // Check the clock once per particle, not per numerical step. Keep UI
        // messages bounded even when most seeds have no valid velocity data.
        const now = performance.now();
        if (now >= nextProgress) {
          nextProgress = now + 100;
          send({ type: PATHLINE_WORKER_MESSAGE.PROGRESS, completed });
        }
      },
      (ms) => {
        integrationMs = ms;
      }
    );
    send({ type: PATHLINE_WORKER_MESSAGE.DONE, result, integrationMs }, [
      result.positions.buffer,
      result.times.buffer,
      result.counts.buffer,
    ]);
  } catch (error) {
    send({
      type: PATHLINE_WORKER_MESSAGE.ERROR,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
