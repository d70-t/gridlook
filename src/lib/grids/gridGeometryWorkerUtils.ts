import type {
  TGridGeometryWorkerMetadata,
  TGridGeometryWorkerResponse,
} from "./gridGeometryWorkerProtocol.ts";
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
  TMetadata extends TGridGeometryWorkerMetadata,
  TBatch extends TGridWorkerBatch = TGridGeometryBatch,
>(
  workerScope: DedicatedWorkerGlobalScope,
  response: TGridGeometryWorkerResponse<TMetadata, TBatch>,
  transfer: Transferable[] = []
) {
  workerScope.postMessage(response, transfer);
}

type TTransferSource = ArrayBuffer | ArrayBufferView;

function getTransferableBuffers(sources: TTransferSource[]) {
  const transfer = new Set<Transferable>();
  for (const source of sources) {
    const buffer = ArrayBuffer.isView(source) ? source.buffer : source;
    if (buffer instanceof ArrayBuffer) {
      transfer.add(buffer);
    }
  }
  return [...transfer];
}

export function postGridGeometryHoverIndex<
  TMetadata extends TGridGeometryWorkerMetadata,
>(
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
    getTransferableBuffers([
      hoverIndexData.indexData,
      hoverIndexData.latitudes,
      hoverIndexData.longitudes,
      hoverIndexData.values,
    ])
  );
}

export function postGridGeometryBatch<
  TMetadata extends TGridGeometryWorkerMetadata,
>(
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
    getTransferableBuffers([
      batch.positionValues,
      batch.dataValues,
      batch.latLonValues,
      batch.indices,
    ])
  );
}

export function postGridPointBatch<
  TMetadata extends TGridGeometryWorkerMetadata,
>(
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
    getTransferableBuffers([
      batch.positionValues,
      batch.dataValues,
      batch.latLonValues,
    ])
  );
}

export function postGridDataValueBatch<
  TMetadata extends TGridGeometryWorkerMetadata,
>(
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
    getTransferableBuffers([batch.dataValues])
  );
}

export function postGridPositionBatch<
  TMetadata extends TGridGeometryWorkerMetadata,
>(
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
    getTransferableBuffers([batch.positionValues, batch.latLonValues])
  );
}
