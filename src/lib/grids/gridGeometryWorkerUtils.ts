import type { TGridGeometryWorkerResponse } from "./gridGeometryWorkerProtocol.ts";
import { GridGeometryWorkerMessageType } from "./gridGeometryWorkerProtocol.ts";
import type {
  TGridDataValueBatch,
  TGridGeometryBatch,
  TGridPointBatch,
  TGridPositionBatch,
  TSerializedGeoSampleIndexData,
  TGridWorkerBatch,
} from "./gridWorkerTypes.ts";

export function postGridGeometryResponse<
  TMetadata,
  TBatch extends TGridWorkerBatch = TGridGeometryBatch,
>(
  workerScope: DedicatedWorkerGlobalScope,
  response: TGridGeometryWorkerResponse<TMetadata, TBatch>,
  transfer: Transferable[] = []
) {
  workerScope.postMessage(response, transfer);
}

export function postGridGeometryHoverIndex<TMetadata>(
  workerScope: DedicatedWorkerGlobalScope,
  requestId: number,
  hoverIndexData: TSerializedGeoSampleIndexData
) {
  postGridGeometryResponse<TMetadata>(
    workerScope,
    {
      requestId,
      type: GridGeometryWorkerMessageType.HOVER_INDEX,
      hoverIndexData,
    },
    [
      hoverIndexData.indexData,
      hoverIndexData.latitudes.buffer,
      hoverIndexData.longitudes.buffer,
      hoverIndexData.values.buffer,
    ]
  );
}

export function postGridGeometryBatch<TMetadata>(
  workerScope: DedicatedWorkerGlobalScope,
  requestId: number,
  batch: TGridGeometryBatch
) {
  postGridGeometryResponse<TMetadata>(
    workerScope,
    {
      requestId,
      type: GridGeometryWorkerMessageType.BATCH,
      batch,
    },
    [
      batch.positionValues.buffer,
      batch.dataValues.buffer,
      batch.latLonValues.buffer,
      batch.indices.buffer,
    ]
  );
}

export function postGridPointBatch<TMetadata>(
  workerScope: DedicatedWorkerGlobalScope,
  requestId: number,
  batch: TGridPointBatch
) {
  postGridGeometryResponse<TMetadata, typeof batch>(
    workerScope,
    {
      requestId,
      type: GridGeometryWorkerMessageType.BATCH,
      batch,
    },
    [
      batch.positionValues.buffer,
      batch.dataValues.buffer,
      batch.latLonValues.buffer,
    ]
  );
}

export function postGridDataValueBatch<TMetadata>(
  workerScope: DedicatedWorkerGlobalScope,
  requestId: number,
  batch: TGridDataValueBatch
) {
  postGridGeometryResponse<TMetadata, TGridDataValueBatch>(
    workerScope,
    {
      requestId,
      type: GridGeometryWorkerMessageType.BATCH,
      batch,
    },
    [batch.dataValues.buffer]
  );
}

export function postGridPositionBatch<TMetadata>(
  workerScope: DedicatedWorkerGlobalScope,
  requestId: number,
  batch: TGridPositionBatch
) {
  postGridGeometryResponse<TMetadata, TGridPositionBatch>(
    workerScope,
    {
      requestId,
      type: GridGeometryWorkerMessageType.BATCH,
      batch,
    },
    [batch.positionValues.buffer, batch.latLonValues.buffer]
  );
}
