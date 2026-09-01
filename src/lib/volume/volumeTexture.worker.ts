/// <reference lib="webworker" />

import { buildVolumeTexture } from "./volumeTexture.ts";
import type {
  TVolumeTextureWorkerRequest,
  TVolumeTextureWorkerResponse,
} from "./volumeTextureWorkerProtocol.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = (event: MessageEvent<TVolumeTextureWorkerRequest>) => {
  try {
    const result = buildVolumeTexture(event.data, (completed, total) => {
      const response: TVolumeTextureWorkerResponse = {
        requestId: event.data.requestId,
        type: "progress",
        completed,
        total,
      };
      workerScope.postMessage(response);
    });
    const response: TVolumeTextureWorkerResponse = {
      requestId: event.data.requestId,
      type: "result",
      ...result,
    };
    workerScope.postMessage(response, [result.data.buffer]);
  } catch (error) {
    const response: TVolumeTextureWorkerResponse = {
      requestId: event.data.requestId,
      type: "error",
      message: error instanceof Error ? error.message : String(error),
    };
    workerScope.postMessage(response);
  }
};
