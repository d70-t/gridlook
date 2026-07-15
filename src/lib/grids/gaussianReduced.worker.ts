/// <reference lib="webworker" />

import {
  buildGaussianReducedBatch,
  buildGaussianReducedHoverIndexData,
  buildGaussianReducedRows,
  getGaussianReducedBatchCount,
} from "./gaussianReducedCalculations.ts";
import {
  type TGaussianReducedWorkerRequest,
  type TGaussianReducedWorkerResponse,
} from "./gaussianReducedWorkerProtocol.ts";

import { GridGeometryWorkerMessageType } from "@/lib/grids/gridGeometryWorkerProtocol.ts";
import {
  postGridGeometryBatch,
  postGridGeometryHoverIndex,
  postGridGeometryResponse,
} from "@/lib/grids/gridGeometryWorkerUtils.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

function postResponse(
  response: TGaussianReducedWorkerResponse,
  transfer: Transferable[] = []
) {
  postGridGeometryResponse(workerScope, response, transfer);
}

function postBatches(
  request: TGaussianReducedWorkerRequest,
  grid: ReturnType<typeof buildGaussianReducedRows>,
  totalBatches: number
) {
  const projection = new ProjectionHelper(
    request.projectionType,
    request.projectionCenter
  );
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const batch = buildGaussianReducedBatch(
      grid,
      batchIndex,
      request.batchSize,
      request.epsilon,
      projection
    );
    postGridGeometryBatch(workerScope, request.requestId, batch);
  }
}

function buildGrid(request: TGaussianReducedWorkerRequest) {
  const grid = buildGaussianReducedRows(
    request.latitudes,
    request.longitudes,
    request.data
  );
  const totalBatches = getGaussianReducedBatchCount(grid, request.batchSize);
  postResponse({
    requestId: request.requestId,
    type: GridGeometryWorkerMessageType.METADATA,
    metadata: { totalBatches },
  });
  postGridGeometryHoverIndex(
    workerScope,
    request.requestId,
    buildGaussianReducedHoverIndexData(grid)
  );
  postBatches(request, grid, totalBatches);
  postResponse({
    requestId: request.requestId,
    type: GridGeometryWorkerMessageType.DONE,
  });
}

workerScope.onmessage = (
  event: MessageEvent<TGaussianReducedWorkerRequest>
) => {
  try {
    buildGrid(event.data);
  } catch (error) {
    postResponse({
      requestId: event.data.requestId,
      type: GridGeometryWorkerMessageType.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
