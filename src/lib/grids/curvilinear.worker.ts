/// <reference lib="webworker" />

import { buildCurvilinearHoverIndexData } from "./curvilinearCalculations.ts";
import type {
  TCurvilinearWorkerRequest,
  TCurvilinearWorkerResponse,
} from "./curvilinearWorkerProtocol.ts";

import { GridGeometryWorkerMessageType } from "@/lib/grids/gridGeometryWorkerProtocol.ts";
import { postGridGeometryResponse } from "@/lib/grids/gridGeometryWorkerUtils.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

function postResponse(
  response: TCurvilinearWorkerResponse,
  transfer: Transferable[] = []
) {
  postGridGeometryResponse(workerScope, response, transfer);
}

// The mesh is built on the main thread from a small subsample; only the hover
// index over every grid point is expensive enough for the worker.
function buildHoverIndex(request: TCurvilinearWorkerRequest) {
  postResponse({
    requestId: request.requestId,
    type: GridGeometryWorkerMessageType.METADATA,
    metadata: { totalBatches: 0 },
  });
  const hoverIndexData = buildCurvilinearHoverIndexData(
    request.latitudes,
    request.longitudes
  );
  postResponse(
    {
      requestId: request.requestId,
      type: GridGeometryWorkerMessageType.HOVER_INDEX,
      hoverIndexData,
    },
    [
      hoverIndexData.indexData,
      hoverIndexData.latitudes.buffer,
      hoverIndexData.longitudes.buffer,
      hoverIndexData.sampleIds.buffer,
    ]
  );
  postResponse({
    requestId: request.requestId,
    type: GridGeometryWorkerMessageType.DONE,
  });
}

workerScope.onmessage = (event: MessageEvent<TCurvilinearWorkerRequest>) => {
  try {
    buildHoverIndex(event.data);
  } catch (error) {
    postResponse({
      requestId: event.data.requestId,
      type: GridGeometryWorkerMessageType.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
