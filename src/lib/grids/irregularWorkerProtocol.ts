import type { TGridGeometryWorkerResponse } from "./gridGeometryWorkerProtocol.ts";
import type { TGridPointBatch } from "./gridWorkerTypes.ts";

import type {
  TProjectionCenter,
  TProjectionType,
} from "@/lib/projection/projectionUtils.ts";

export type TIrregularWorkerRequest = {
  requestId: number;
  type: "build";
  latitudes: Float32Array;
  longitudes: Float32Array;
  latitudeShape: number[];
  longitudeShape: number[];
  data: Float32Array;
  batchSize: number;
  projectionType: TProjectionType;
  projectionCenter: TProjectionCenter;
};

export type TIrregularWorkerMetadata = {
  totalBatches: number;
  estimatedSpacing: number;
};

export type TIrregularWorkerResponse = TGridGeometryWorkerResponse<
  TIrregularWorkerMetadata,
  TGridPointBatch
>;
