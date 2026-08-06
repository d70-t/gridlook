import {
  copyGridWorkerArray,
  createGridGeometryWorkerClient,
} from "./gridGeometryWorkerClient.ts";
import { GridGeometryWorkerMessageType } from "./gridGeometryWorkerProtocol.ts";
import type { TGridPointBatch } from "./gridWorkerTypes.ts";
import type {
  TIrregularWorkerMetadata,
  TIrregularWorkerRequest,
} from "./irregularWorkerProtocol.ts";

import type {
  TProjectionCenter,
  TProjectionType,
} from "@/lib/projection/projectionUtils.ts";

type TIrregularBuildRequest = {
  latitudes: Float32Array;
  longitudes: Float32Array;
  latitudeShape: number[];
  longitudeShape: number[];
  data: Float32Array;
  batchSize: number;
  projectionType: TProjectionType;
  projectionCenter: TProjectionCenter;
};

const client = createGridGeometryWorkerClient<
  TIrregularWorkerRequest,
  TIrregularWorkerMetadata,
  TGridPointBatch
>(
  () =>
    new Worker(new URL("./irregular.worker.ts", import.meta.url), {
      type: "module",
    })
);

export function buildIrregularGrid(
  request: TIrregularBuildRequest,
  callbacks: {
    onMetadata: (metadata: TIrregularWorkerMetadata) => void;
    onBatch: (batch: TGridPointBatch) => void;
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
        projectionCenter: {
          lat: request.projectionCenter.lat,
          lon: request.projectionCenter.lon,
        },
      },
      transfer: [latitudes.buffer, longitudes.buffer, data.buffer],
    };
  }, callbacks);
}

export const terminateIrregularWorker = client.terminate;
