import type {
  TGridGeometryBatch,
  TSerializedGeoSampleIndexData,
  TGridWorkerBatch,
} from "./gridWorkerTypes.ts";

export const GridGeometryWorkerMessageType = {
  BUILD: "build",
  METADATA: "metadata",
  BATCH: "batch",
  HOVER_INDEX: "hoverIndex",
  DONE: "done",
  ERROR: "error",
} as const;

type TGridGeometryWorkerMessageType =
  (typeof GridGeometryWorkerMessageType)[keyof typeof GridGeometryWorkerMessageType];

type TGridGeometryWorkerResponseBase = {
  requestId: number;
  type: TGridGeometryWorkerMessageType;
};

export type TGridGeometryWorkerResponse<
  TMetadata,
  TBatch extends TGridWorkerBatch = TGridGeometryBatch,
> =
  | (TGridGeometryWorkerResponseBase & {
      type: typeof GridGeometryWorkerMessageType.METADATA;
      metadata: TMetadata;
    })
  | (TGridGeometryWorkerResponseBase & {
      type: typeof GridGeometryWorkerMessageType.BATCH;
      batch: TBatch;
    })
  | (TGridGeometryWorkerResponseBase & {
      type: typeof GridGeometryWorkerMessageType.HOVER_INDEX;
      hoverIndexData: TSerializedGeoSampleIndexData;
    })
  | (TGridGeometryWorkerResponseBase & {
      type: typeof GridGeometryWorkerMessageType.DONE;
    })
  | (TGridGeometryWorkerResponseBase & {
      type: typeof GridGeometryWorkerMessageType.ERROR;
      message: string;
    });
