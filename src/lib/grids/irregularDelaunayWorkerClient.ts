import {
  copyGridWorkerArray,
  createGridGeometryWorkerClient,
} from "./gridGeometryWorkerClient.ts";
import { GridGeometryWorkerMessageType } from "./gridGeometryWorkerProtocol.ts";
import type {
  TIrregularDelaunayBatch,
  TIrregularDelaunayWorkerMetadata,
  TIrregularDelaunayWorkerRequest,
} from "./irregularDelaunayWorkerProtocol.ts";

type TIrregularDelaunayBuildRequest = {
  latitudes: Float32Array;
  longitudes: Float32Array;
  latitudeShape: number[];
  longitudeShape: number[];
  data: Float32Array;
  batchSize: number;
  forceGeometryRebuild: boolean;
};

const client = createGridGeometryWorkerClient<
  TIrregularDelaunayWorkerRequest,
  TIrregularDelaunayWorkerMetadata,
  TIrregularDelaunayBatch
>(
  () =>
    new Worker(new URL("./irregularDelaunay.worker.ts", import.meta.url), {
      type: "module",
    }),
  true
);

export function buildIrregularDelaunayGrid(
  request: TIrregularDelaunayBuildRequest,
  callbacks: {
    onMetadata: (metadata: TIrregularDelaunayWorkerMetadata) => void;
    onBatch: (batch: TIrregularDelaunayBatch) => void;
  }
) {
  return client.build((requestId) => {
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
        latitudeShape: [...request.latitudeShape],
        longitudeShape: [...request.longitudeShape],
      },
      transfer: [latitudes.buffer, longitudes.buffer, data.buffer],
    };
  }, callbacks);
}

export const terminateIrregularDelaunayWorker = client.terminate;
