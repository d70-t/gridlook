import type { TVolumeTextureBuildRequest } from "./volumeTexture.ts";
import type {
  TVolumeTextureWorkerRequest,
  TVolumeTextureWorkerResponse,
} from "./volumeTextureWorkerProtocol.ts";

let worker: Worker | undefined;
let nextRequestId = 0;
const pending = new Map<
  number,
  {
    resolve: (
      result: Extract<TVolumeTextureWorkerResponse, { type: "result" }>
    ) => void;
    reject: (error: Error) => void;
    onProgress?: (completed: number, total: number) => void;
  }
>();

function rejectPending(error: Error) {
  for (const request of pending.values()) {
    request.reject(error);
  }
  pending.clear();
}

function getWorker() {
  if (worker) {
    return worker;
  }
  worker = new Worker(new URL("./volumeTexture.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (event: MessageEvent<TVolumeTextureWorkerResponse>) => {
    const request = pending.get(event.data.requestId);
    if (!request) {
      return;
    }
    if (event.data.type === "progress") {
      request.onProgress?.(event.data.completed, event.data.total);
      return;
    }
    pending.delete(event.data.requestId);
    if (event.data.type === "error") {
      request.reject(new Error(event.data.message));
      return;
    }
    request.resolve(event.data);
  };
  worker.onerror = (event) => {
    rejectPending(new Error(event.message));
    worker?.terminate();
    worker = undefined;
  };
  return worker;
}

export function buildVolumeTextureInWorker(
  request: TVolumeTextureBuildRequest,
  onProgress?: (completed: number, total: number) => void
) {
  const requestId = ++nextRequestId;
  const { values, heights, cellCoordinates } = request;
  const message: TVolumeTextureWorkerRequest = {
    ...request,
    requestId,
    values,
    heights,
    cellCoordinates,
  };
  const transfer: Transferable[] = values.map(
    (field) => field.buffer as ArrayBuffer
  );
  if (heights) {
    transfer.push(heights.buffer);
  }
  if (cellCoordinates) {
    transfer.push(cellCoordinates.buffer);
  }
  return new Promise<Extract<TVolumeTextureWorkerResponse, { type: "result" }>>(
    (resolve, reject) => {
      pending.set(requestId, { resolve, reject, onProgress });
      getWorker().postMessage(message, transfer);
    }
  );
}

export function terminateVolumeTextureWorker() {
  worker?.terminate();
  worker = undefined;
  rejectPending(new Error("Volume texture worker terminated."));
}
