/// <reference lib="webworker" />

import { GridGeometryWorkerMessageType } from "./gridGeometryWorkerProtocol.ts";
import {
  buildHealpixGeometry,
  buildHealpixTexture,
} from "./healpixCalculations.ts";
import type {
  THealpixBatch,
  THealpixWorkerRequest,
  THealpixWorkerResponse,
} from "./healpixWorkerProtocol.ts";

import { decodeVariableDataInPlace } from "@/lib/data/variableDecoding.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

function postResponse(
  response: THealpixWorkerResponse,
  transfer: Transferable[] = []
) {
  workerScope.postMessage(response, transfer);
}

function postBatch(
  requestId: number,
  batch: Omit<THealpixBatch, "dataValues">
) {
  postResponse(
    { requestId, type: GridGeometryWorkerMessageType.BATCH, batch },
    [
      batch.positionValues.buffer,
      batch.latLonValues.buffer,
      batch.uv.buffer,
      batch.indices.buffer,
      batch.histogramSummary.bins.buffer,
    ]
  );
}

async function buildGrid(request: THealpixWorkerRequest) {
  // Install the message handler before WASM initialization yields to the event loop.
  const { Grid } = await import("healpix-geo");
  using grid = new Grid(request.grid);
  using textureGrid = grid.replace({ level: 0, scheme: "nested" });
  const { requestId, data, faceIndex } = request;
  if (!Number.isInteger(faceIndex) || faceIndex < 0 || faceIndex >= 12) {
    throw new Error("Invalid HEALPix face index.");
  }
  if (data.length !== (request.cells?.length ?? grid.nside ** 2)) {
    throw new Error("HEALPix data length does not match the grid.");
  }
  decodeVariableDataInPlace(
    data,
    request.attributes,
    request.missingValue,
    request.fillValue
  );
  const cellIndex = request.cells
    ? new Map(request.cells.map((cell, index) => [cell, index]))
    : undefined;
  const projection = new ProjectionHelper(
    request.projectionType,
    request.projectionCenter
  );
  postResponse({
    requestId,
    type: GridGeometryWorkerMessageType.METADATA,
    metadata: { totalBatches: 1 },
  });
  const { dataValues, histogramSummary } = buildHealpixTexture(
    data,
    faceIndex,
    grid.nside,
    cellIndex
  );
  postBatch(requestId, {
    batchIndex: 0,
    ...buildHealpixGeometry(textureGrid, BigInt(faceIndex), 65, projection),
    histogramSummary,
  });
  postResponse(
    {
      requestId,
      type: GridGeometryWorkerMessageType.HOVER_INDEX,
      hoverIndexData: dataValues,
    },
    [dataValues.buffer]
  );
  postResponse({ requestId, type: GridGeometryWorkerMessageType.DONE });
}

workerScope.onmessage = async (event: MessageEvent<THealpixWorkerRequest>) => {
  try {
    await buildGrid(event.data);
  } catch (error) {
    postResponse({
      requestId: event.data.requestId,
      type: GridGeometryWorkerMessageType.ERROR,
      message: error instanceof Error ? error.message : String(error),
    });
  }
};
