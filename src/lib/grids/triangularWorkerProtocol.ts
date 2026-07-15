import type { TGridGeometryWorkerResponse } from "./gridGeometryWorkerProtocol.ts";
import type {
  TGridDataValueBatch,
  TGridPositionBatch,
} from "./gridWorkerTypes.ts";

import type {
  TProjectionCenter,
  TProjectionType,
} from "@/lib/projection/projectionUtils.ts";

export const TriangularWorkerOperation = {
  GEOMETRY: "geometry",
  DATA: "data",
} as const;

export type TTriangularWorkerOperation =
  (typeof TriangularWorkerOperation)[keyof typeof TriangularWorkerOperation];

export type TTriangularGeometryWorkerRequest = {
  requestId: number;
  type: "build";
  operation: typeof TriangularWorkerOperation.GEOMETRY;
  vertexOfCell: Int32Array;
  vertexX: Float32Array | Float64Array;
  vertexY: Float32Array | Float64Array;
  vertexZ: Float32Array | Float64Array;
  batchSize: number;
  projectionType: TProjectionType;
  projectionCenter: TProjectionCenter;
};

export type TTriangularDataWorkerRequest = {
  requestId: number;
  type: "build";
  operation: typeof TriangularWorkerOperation.DATA;
  data: Float32Array;
  batchSize: number;
};

export type TTriangularWorkerRequest =
  | TTriangularGeometryWorkerRequest
  | TTriangularDataWorkerRequest;

export type TTriangularWorkerBatch = TGridPositionBatch | TGridDataValueBatch;

export type TTriangularWorkerMetadata = {
  operation: TTriangularWorkerOperation;
  totalBatches: number;
};

export type TTriangularWorkerResponse = TGridGeometryWorkerResponse<
  TTriangularWorkerMetadata,
  TTriangularWorkerBatch
>;
