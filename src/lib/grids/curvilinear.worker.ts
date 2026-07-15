/// <reference lib="webworker" />

import {
  buildCurvilinearBatch,
  buildCurvilinearHoverIndexData,
  detectCurvilinearColumnPeriodicity,
  detectCurvilinearLongitudeFlip,
  getCurvilinearBatchCount,
  type TCurvilinearGrid,
} from "./curvilinearCalculations.ts";
import type {
  TCurvilinearWorkerRequest,
  TCurvilinearWorkerResponse,
} from "./curvilinearWorkerProtocol.ts";

import { GridGeometryWorkerMessageType } from "@/lib/grids/gridGeometryWorkerProtocol.ts";
import {
  postGridGeometryBatch,
  postGridGeometryHoverIndex,
  postGridGeometryResponse,
} from "@/lib/grids/gridGeometryWorkerUtils.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

function postResponse(
  response: TCurvilinearWorkerResponse,
  transfer: Transferable[] = []
) {
  postGridGeometryResponse(workerScope, response, transfer);
}

function createGrid(request: TCurvilinearWorkerRequest): TCurvilinearGrid {
  return {
    latitudes: request.latitudes,
    longitudes: request.longitudes,
    data: request.data,
    nj: request.nj,
    ni: request.ni,
    shouldFlipLongitude: detectCurvilinearLongitudeFlip(
      request.longitudes,
      request.latitudes,
      request.missingValue,
      request.fillValue,
      request.nj,
      request.ni
    ),
    isPeriodicI: detectCurvilinearColumnPeriodicity(
      request.longitudes,
      request.nj,
      request.ni
    ),
  };
}

function postHoverIndex(requestId: number, grid: TCurvilinearGrid) {
  postGridGeometryHoverIndex(
    workerScope,
    requestId,
    buildCurvilinearHoverIndexData(grid)
  );
}

function postBatches(
  request: TCurvilinearWorkerRequest,
  grid: TCurvilinearGrid,
  totalBatches: number
) {
  const projection = new ProjectionHelper(
    request.projectionType,
    request.projectionCenter
  );
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    const batch = buildCurvilinearBatch(
      grid,
      batchIndex,
      request.batchSize,
      projection
    );
    postGridGeometryBatch(workerScope, request.requestId, batch);
  }
}

function buildGrid(request: TCurvilinearWorkerRequest) {
  const grid = createGrid(request);
  const totalBatches = getCurvilinearBatchCount(grid, request.batchSize);
  postResponse({
    requestId: request.requestId,
    type: GridGeometryWorkerMessageType.METADATA,
    metadata: {
      totalBatches,
      shouldFlipLongitude: grid.shouldFlipLongitude,
    },
  });
  postHoverIndex(request.requestId, grid);
  postBatches(request, grid, totalBatches);
  postResponse({
    requestId: request.requestId,
    type: GridGeometryWorkerMessageType.DONE,
  });
}

workerScope.onmessage = (event: MessageEvent<TCurvilinearWorkerRequest>) => {
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
