import {
  copyGridWorkerArray,
  createGridGeometryWorkerClient,
} from "./gridGeometryWorkerClient.ts";
import type {
  THealpixBatch,
  THealpixBuildRequest,
  THealpixWorkerMetadata,
  THealpixWorkerRequest,
} from "./healpixWorkerProtocol.ts";

const client = createGridGeometryWorkerClient<
  THealpixWorkerRequest,
  THealpixWorkerMetadata,
  THealpixBatch,
  Float32Array
>(
  () =>
    new Worker(new URL("./healpix.worker.ts", import.meta.url), {
      type: "module",
    })
);

export function buildHealpixGrid(
  request: THealpixBuildRequest,
  onBatch: (batch: THealpixBatch) => void
) {
  return client
    .build(
      (requestId) => {
        const data = copyGridWorkerArray(request.data);
        return {
          message: { ...request, requestId, data },
          transfer: [data.buffer],
        };
      },
      { onMetadata: () => {}, onBatch }
    )
    .then(({ hoverIndexData }) => hoverIndexData);
}

export const terminateHealpixWorker = client.terminate;
