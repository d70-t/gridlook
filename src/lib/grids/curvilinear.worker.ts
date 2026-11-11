/// <reference lib="webworker" />

import { buildCurvilinearHoverIndexData } from "./curvilinearCalculations.ts";
import {
  CurvilinearWorkerRequestType,
  type TCurvilinearHoverIndexRequest,
  type TCurvilinearProjectionRequest,
  type TCurvilinearWorkerRequest,
  type TCurvilinearWorkerResponse,
  type TCurvilinearWorkerResult,
} from "./curvilinearWorkerProtocol.ts";

import { projectGridToLonLat } from "@/lib/data/crsInverse.ts";
import { GridGeometryWorkerMessageType } from "@/lib/grids/gridGeometryWorkerProtocol.ts";
import { postGridGeometryResponse } from "@/lib/grids/gridGeometryWorkerUtils.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

function postResponse(
  response: TCurvilinearWorkerResponse,
  transfer: Transferable[] = []
) {
  postGridGeometryResponse(workerScope, response, transfer);
}

// Every request computes one result and has no geometry batches.
function postResult(
  requestId: number,
  result: TCurvilinearWorkerResult,
  transfer: Transferable[]
) {
  postResponse({
    requestId,
    type: GridGeometryWorkerMessageType.METADATA,
    metadata: { totalBatches: 0 },
  });
  postResponse(
    {
      requestId,
      type: GridGeometryWorkerMessageType.HOVER_INDEX,
      hoverIndexData: result,
    },
    transfer
  );
  postResponse({
    requestId,
    type: GridGeometryWorkerMessageType.DONE,
  });
}

// The mesh is built on the main thread from a small subsample; only the hover
// index over every grid point is expensive enough for the worker.
function buildHoverIndex(request: TCurvilinearHoverIndexRequest) {
  const hoverIndexData = buildCurvilinearHoverIndexData(
    request.latitudes,
    request.longitudes
  );
  postResult(request.requestId, hoverIndexData, [
    hoverIndexData.indexData,
    hoverIndexData.latitudes.buffer,
    hoverIndexData.longitudes.buffer,
    hoverIndexData.sampleIds.buffer,
  ]);
}

// Projecting every cell centre of a fine level takes seconds; here it leaves
// the main thread free, and the result is transferred rather than copied.
function projectGrid(request: TCurvilinearProjectionRequest) {
  const coordinates = projectGridToLonLat(request.x, request.y, request.crs);
  postResult(request.requestId, coordinates, [
    coordinates.latitudes.buffer,
    coordinates.longitudes.buffer,
  ]);
}

workerScope.onmessage = (event: MessageEvent<TCurvilinearWorkerRequest>) => {
  try {
    if (event.data.type === CurvilinearWorkerRequestType.PROJECT) {
      projectGrid(event.data);
    } else {
      buildHoverIndex(event.data);
    }
  } catch (error) {
    postResponse({
      requestId: event.data.requestId,
      type: GridGeometryWorkerMessageType.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
