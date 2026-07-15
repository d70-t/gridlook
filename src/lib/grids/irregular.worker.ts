/// <reference lib="webworker" />

import {
  buildIrregularBatch,
  buildIrregularGridData,
  buildIrregularHoverIndexData,
  getIrregularBatchCount,
} from "./irregularCalculations.ts";
import type {
  TIrregularWorkerRequest,
  TIrregularWorkerResponse,
} from "./irregularWorkerProtocol.ts";

import { GridGeometryWorkerMessageType } from "@/lib/grids/gridGeometryWorkerProtocol.ts";
import {
  postGridGeometryHoverIndex,
  postGridGeometryResponse,
  postGridPointBatch,
} from "@/lib/grids/gridGeometryWorkerUtils.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

function postResponse(
  response: TIrregularWorkerResponse,
  transfer: Transferable[] = []
) {
  postGridGeometryResponse(workerScope, response, transfer);
}

function buildGrid(request: TIrregularWorkerRequest) {
  const projection = new ProjectionHelper(
    request.projectionType,
    request.projectionCenter
  );
  const grid = buildIrregularGridData(
    request.latitudes,
    request.longitudes,
    request.latitudeShape,
    request.longitudeShape,
    request.data,
    projection
  );
  const totalBatches = getIrregularBatchCount(grid, request.batchSize);
  postResponse({
    requestId: request.requestId,
    type: GridGeometryWorkerMessageType.METADATA,
    metadata: { totalBatches, estimatedSpacing: grid.estimatedSpacing },
  });
  postGridGeometryHoverIndex(
    workerScope,
    request.requestId,
    buildIrregularHoverIndexData(grid)
  );
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    postGridPointBatch(
      workerScope,
      request.requestId,
      buildIrregularBatch(grid, batchIndex, request.batchSize)
    );
  }
  postResponse({
    requestId: request.requestId,
    type: GridGeometryWorkerMessageType.DONE,
  });
}

workerScope.onmessage = (event: MessageEvent<TIrregularWorkerRequest>) => {
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
