import type {
  TCurvilinearWorkerMetadata,
  TCurvilinearWorkerRequest,
} from "./curvilinearWorkerProtocol.ts";
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

type TCurvilinearBuildRequest = {
  latitudes: Float32Array;
  longitudes: Float32Array;
  data: Float32Array;
  nj: number;
  ni: number;
  batchSize: number;
  missingValue: number;
  fillValue: number;
  projectionType: TProjectionType;
  projectionCenter: TProjectionCenter;
};

const client = createGridGeometryWorkerClient<
  TCurvilinearWorkerRequest,
  TCurvilinearWorkerMetadata
>(
  () =>
    new Worker(new URL("./curvilinear.worker.ts", import.meta.url), {
      type: "module",
    })
);

export function buildCurvilinearGrid(
  request: TCurvilinearBuildRequest,
  callbacks: {
    onMetadata: (metadata: TCurvilinearWorkerMetadata) => void;
    onBatch: (batch: TGridGeometryBatch) => void;
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
        projectionCenter: {
          lat: request.projectionCenter.lat,
          lon: request.projectionCenter.lon,
        },
      },
      transfer: [latitudes.buffer, longitudes.buffer, data.buffer],
    };
  }, callbacks);
}

export const terminateCurvilinearWorker = client.terminate;
