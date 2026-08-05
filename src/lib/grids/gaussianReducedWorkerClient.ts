import type {
  TGaussianReducedWorkerMetadata,
  TGaussianReducedWorkerRequest,
} from "./gaussianReducedWorkerProtocol.ts";
import {
  copyGridWorkerArray,
  createGridGeometryWorkerClient,
} from "./gridGeometryWorkerClient.ts";
import { GridGeometryWorkerMessageType } from "./gridGeometryWorkerProtocol.ts";
import type { TGridGeometryBatch } from "./gridWorkerTypes.ts";

import type {
  TProjectionCenter,
  TProjectionType,
} from "@/lib/projection/projectionUtils.ts";

type TGaussianReducedBuildRequest = {
  latitudes: Float64Array;
  longitudes: Float64Array;
  data: Float32Array;
  batchSize: number;
  epsilon: number;
  projectionType: TProjectionType;
  projectionCenter: TProjectionCenter;
};

const client = createGridGeometryWorkerClient<
  TGaussianReducedWorkerRequest,
  TGaussianReducedWorkerMetadata
>(
  () =>
    new Worker(new URL("./gaussianReduced.worker.ts", import.meta.url), {
      type: "module",
    })
);

export function buildGaussianReducedGrid(
  request: TGaussianReducedBuildRequest,
  callbacks: {
    onMetadata: (totalBatches: number) => void;
    onBatch: (batch: TGridGeometryBatch) => void;
  }
) {
  return client
    .build(
      (requestId) => {
        const latitudes = copyGridWorkerArray(request.latitudes);
        const longitudes = copyGridWorkerArray(request.longitudes);
        const data = copyGridWorkerArray(request.data);
        return {
          message: {
            ...request,
            requestId,
            type: GridGeometryWorkerMessageType.BUILD,
            latitudes,
            longitudes,
            data,
            projectionCenter: {
              lat: request.projectionCenter.lat,
              lon: request.projectionCenter.lon,
            },
          },
          transfer: [latitudes.buffer, longitudes.buffer, data.buffer],
        };
      },
      {
        onMetadata: ({ totalBatches }) => callbacks.onMetadata(totalBatches),
        onBatch: callbacks.onBatch,
      }
    )
    .then(({ hoverIndexData }) => hoverIndexData);
}

export const terminateGaussianReducedWorker = client.terminate;
