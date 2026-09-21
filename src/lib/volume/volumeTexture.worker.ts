/// <reference lib="webworker" />

import "@/utils/disposablePolyfill.ts";

import { VOLUME_GRID_TYPES } from "./volumeGrid.ts";
import { buildVolumeTexture } from "./volumeTexture.ts";
import type {
  TVolumeTextureWorkerRequest,
  TVolumeTextureWorkerResponse,
} from "./volumeTextureWorkerProtocol.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (
  event: MessageEvent<TVolumeTextureWorkerRequest>
) => {
  try {
    const { grid } = event.data;
    using healpix =
      grid.kind === VOLUME_GRID_TYPES.HEALPIX
        ? new (await import("healpix-geo")).Grid(grid.options)
        : undefined;
    const result = buildVolumeTexture(
      event.data,
      (completed, total) => {
        const response: TVolumeTextureWorkerResponse = {
          requestId: event.data.requestId,
          type: "progress",
          completed,
          total,
        };
        workerScope.postMessage(response);
      },
      healpix
    );
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
