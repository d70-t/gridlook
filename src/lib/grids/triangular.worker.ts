/// <reference lib="webworker" />

import {
  buildTriangularDataBatch,
  buildTriangularGeometryBatch,
  buildTriangularGrid,
  buildTriangularHoverIndexData,
  getTriangularBatchCount,
  type TTriangularGrid,
} from "./triangularCalculations.ts";
import {
  TriangularWorkerOperation,
  type TTriangularDataWorkerRequest,
  type TTriangularGeometryWorkerRequest,
  type TTriangularWorkerRequest,
  type TTriangularWorkerResponse,
} from "./triangularWorkerProtocol.ts";

import { GridGeometryWorkerMessageType } from "@/lib/grids/gridGeometryWorkerProtocol.ts";
import {
  postGridDataValueBatch,
  postGridGeometryHoverIndex,
  postGridGeometryResponse,
  postGridPositionBatch,
} from "@/lib/grids/gridGeometryWorkerUtils.ts";
import { buildSerializedGeoSampleIndexData } from "@/lib/grids/gridWorkerCalculations.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let cachedGrid: TTriangularGrid | null = null;

function postResponse(
  response: TTriangularWorkerResponse,
  transfer: Transferable[] = []
) {
  postGridGeometryResponse(workerScope, response, transfer);
}

function postDone(requestId: number) {
  postResponse({
    requestId,
    type: GridGeometryWorkerMessageType.DONE,
  });
}

function buildGeometry(request: TTriangularGeometryWorkerRequest) {
  cachedGrid = buildTriangularGrid(
    request.vertexOfCell,
    request.vertexX,
    request.vertexY,
    request.vertexZ
  );
  const triangleCount = cachedGrid.vertices.length / 9;
  const totalBatches = getTriangularBatchCount(
    triangleCount,
    request.batchSize
  );
  postResponse({
    requestId: request.requestId,
    type: GridGeometryWorkerMessageType.METADATA,
    metadata: { operation: request.operation, totalBatches },
  });
  postGridGeometryHoverIndex(
    workerScope,
    request.requestId,
    buildSerializedGeoSampleIndexData(
      new Float64Array(0),
      new Float64Array(0),
      new Float32Array(0)
    )
  );
  const projection = new ProjectionHelper(
    request.projectionType,
    request.projectionCenter
  );
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    postGridPositionBatch(
      workerScope,
      request.requestId,
      buildTriangularGeometryBatch(
        cachedGrid,
        batchIndex,
        request.batchSize,
        projection
      )
    );
  }
  postDone(request.requestId);
}

function buildData(request: TTriangularDataWorkerRequest) {
  if (!cachedGrid) {
    throw new Error("Triangular grid geometry has not been built.");
  }
  const hoverIndexData = buildTriangularHoverIndexData(
    cachedGrid,
    request.data
  );
  const totalBatches = getTriangularBatchCount(
    request.data.length,
    request.batchSize
  );
  postResponse({
    requestId: request.requestId,
    type: GridGeometryWorkerMessageType.METADATA,
    metadata: { operation: request.operation, totalBatches },
  });
  postGridGeometryHoverIndex(workerScope, request.requestId, hoverIndexData);
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    postGridDataValueBatch(
      workerScope,
      request.requestId,
      buildTriangularDataBatch(request.data, batchIndex, request.batchSize)
    );
  }
  postDone(request.requestId);
}

workerScope.onmessage = (event: MessageEvent<TTriangularWorkerRequest>) => {
  try {
    if (event.data.operation === TriangularWorkerOperation.GEOMETRY) {
      buildGeometry(event.data);
    } else {
      buildData(event.data);
    }
  } catch (error) {
    postResponse({
      requestId: event.data.requestId,
      type: GridGeometryWorkerMessageType.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
