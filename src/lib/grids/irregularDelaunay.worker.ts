/// <reference lib="webworker" />

import {
  buildIrregularDelaunayDataBatch,
  buildIrregularDelaunayGeometryBatch,
  buildIrregularDelaunayGrid,
  buildIrregularDelaunayHoverIndexData,
  getIrregularDelaunayBatchCount,
  type TIrregularDelaunayGrid,
} from "./irregularDelaunayCalculations.ts";
import type {
  TIrregularDelaunayWorkerRequest,
  TIrregularDelaunayWorkerResponse,
} from "./irregularDelaunayWorkerProtocol.ts";

import { GridGeometryWorkerMessageType } from "@/lib/grids/gridGeometryWorkerProtocol.ts";
import {
  postGridDataValueBatch,
  postGridGeometryHoverIndex,
  postGridGeometryResponse,
  postGridPointBatch,
} from "@/lib/grids/gridGeometryWorkerUtils.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;
let cachedGrid: TIrregularDelaunayGrid | null = null;
let cachedPointCount = 0;

function postResponse(
  response: TIrregularDelaunayWorkerResponse,
  transfer: Transferable[] = []
) {
  postGridGeometryResponse(workerScope, response, transfer);
}

function postBatches(
  request: TIrregularDelaunayWorkerRequest,
  grid: TIrregularDelaunayGrid,
  totalBatches: number,
  rebuildGeometry: boolean
) {
  for (let batchIndex = 0; batchIndex < totalBatches; batchIndex++) {
    if (rebuildGeometry) {
      postGridPointBatch(
        workerScope,
        request.requestId,
        buildIrregularDelaunayGeometryBatch(
          grid,
          request.data,
          batchIndex,
          request.batchSize
        )
      );
    } else {
      postGridDataValueBatch(
        workerScope,
        request.requestId,
        buildIrregularDelaunayDataBatch(
          grid,
          request.data,
          batchIndex,
          request.batchSize
        )
      );
    }
  }
}

function buildGrid(request: TIrregularDelaunayWorkerRequest) {
  const rebuildGeometry =
    request.forceGeometryRebuild ||
    !cachedGrid ||
    cachedPointCount !== request.data.length;
  if (rebuildGeometry) {
    cachedGrid = buildIrregularDelaunayGrid(
      request.latitudes,
      request.longitudes,
      request.latitudeShape,
      request.longitudeShape,
      request.data.length
    );
    cachedPointCount = request.data.length;
  }
  const grid = cachedGrid!;
  const totalBatches = getIrregularDelaunayBatchCount(grid, request.batchSize);
  postResponse({
    requestId: request.requestId,
    type: GridGeometryWorkerMessageType.METADATA,
    metadata: { totalBatches, rebuildGeometry },
  });
  postGridGeometryHoverIndex(
    workerScope,
    request.requestId,
    buildIrregularDelaunayHoverIndexData(grid, request.data)
  );
  postBatches(request, grid, totalBatches, rebuildGeometry);
  postResponse({
    requestId: request.requestId,
    type: GridGeometryWorkerMessageType.DONE,
  });
}

workerScope.onmessage = (
  event: MessageEvent<TIrregularDelaunayWorkerRequest>
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
