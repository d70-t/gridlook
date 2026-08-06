import type { TGridGeometryWorkerResponse } from "@/lib/grids/gridGeometryWorkerProtocol.ts";
import type {
  TProjectionCenter,
  TProjectionType,
} from "@/lib/projection/projectionUtils.ts";

export type TGaussianReducedWorkerRequest = {
  requestId: number;
  type: "build";
  latitudes: Float64Array;
  longitudes: Float64Array;
  data: Float32Array;
  batchSize: number;
  epsilon: number;
  projectionType: TProjectionType;
  projectionCenter: TProjectionCenter;
};

export type TGaussianReducedWorkerMetadata = {
  totalBatches: number;
};

export type TGaussianReducedWorkerResponse =
  TGridGeometryWorkerResponse<TGaussianReducedWorkerMetadata>;
