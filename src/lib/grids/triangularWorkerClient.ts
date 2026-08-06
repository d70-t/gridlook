import {
  copyGridWorkerArray,
  createGridGeometryWorkerClient,
} from "./gridGeometryWorkerClient.ts";
import { GridGeometryWorkerMessageType } from "./gridGeometryWorkerProtocol.ts";
import {
  TriangularWorkerOperation,
  type TTriangularGeometryWorkerRequest,
  type TTriangularWorkerBatch,
  type TTriangularWorkerMetadata,
  type TTriangularWorkerRequest,
} from "./triangularWorkerProtocol.ts";

type TTriangularGeometryRequest = Omit<
  TTriangularGeometryWorkerRequest,
  "requestId" | "type" | "operation"
>;

const client = createGridGeometryWorkerClient<
  TTriangularWorkerRequest,
  TTriangularWorkerMetadata,
  TTriangularWorkerBatch
>(
  () =>
    new Worker(new URL("./triangular.worker.ts", import.meta.url), {
      type: "module",
    }),
  true
);

export function buildTriangularGeometry(
  request: TTriangularGeometryRequest,
  callbacks: {
    onMetadata: (metadata: TTriangularWorkerMetadata) => void;
    onBatch: (batch: TTriangularWorkerBatch) => void;
  }
) {
  return client.build(
    (requestId) => ({
      message: {
        ...request,
        requestId,
        type: GridGeometryWorkerMessageType.BUILD,
        operation: TriangularWorkerOperation.GEOMETRY,
        projectionCenter: {
          lat: request.projectionCenter.lat,
          lon: request.projectionCenter.lon,
        },
      },
      transfer: [
        request.vertexOfCell.buffer,
        request.vertexX.buffer,
        request.vertexY.buffer,
        request.vertexZ.buffer,
      ],
    }),
    callbacks
  );
}

export function buildTriangularData(
  request: { data: Float32Array; batchSize: number },
  callbacks: {
    onMetadata: (metadata: TTriangularWorkerMetadata) => void;
    onBatch: (batch: TTriangularWorkerBatch) => void;
  }
) {
  return client.build((requestId) => {
    const data = copyGridWorkerArray(request.data);
    return {
      message: {
        requestId,
        type: GridGeometryWorkerMessageType.BUILD,
        operation: TriangularWorkerOperation.DATA,
        data,
        batchSize: request.batchSize,
      },
      transfer: [data.buffer],
    };
  }, callbacks);
}

export const terminateTriangularWorker = client.terminate;
