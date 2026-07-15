import type { TGridGeometryWorkerResponse } from "./gridGeometryWorkerProtocol.ts";

import type {
  TProjectionCenter,
  TProjectionType,
} from "@/lib/projection/projectionUtils.ts";

export type TCurvilinearWorkerRequest = {
  requestId: number;
  type: "build";
  latitudes: Float32Array;
  longitudes: Float32Array;
  data: Float32Array;
  nj: number;
  ni: number;
  batchSize: number;
  missingValue: number;
  fillValue: number;
  projectionType: TProjectionType;
  projectionCenter: TProjectionCenter;
};

export type TCurvilinearWorkerMetadata = {
  totalBatches: number;
  shouldFlipLongitude: boolean;
};

export type TCurvilinearWorkerResponse =
  TGridGeometryWorkerResponse<TCurvilinearWorkerMetadata>;
