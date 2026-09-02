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
  return client.build((requestId) => {
    const vertexOfCell = copyGridWorkerArray(request.vertexOfCell);
    const vertexX = copyGridWorkerArray(request.vertexX);
    const vertexY = copyGridWorkerArray(request.vertexY);
    const vertexZ = copyGridWorkerArray(request.vertexZ);
    return {
      message: {
        ...request,
        requestId,
        type: GridGeometryWorkerMessageType.BUILD,
        operation: TriangularWorkerOperation.GEOMETRY,
        vertexOfCell,
        vertexX,
        vertexY,
        vertexZ,
        projectionCenter: {
          lat: request.projectionCenter.lat,
          lon: request.projectionCenter.lon,
        },
      },
      transfer: [
        vertexOfCell.buffer,
        vertexX.buffer,
        vertexY.buffer,
        vertexZ.buffer,
      ],
    };
  }, callbacks);
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
