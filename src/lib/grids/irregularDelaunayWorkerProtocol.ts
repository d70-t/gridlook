import type { TGridGeometryWorkerResponse } from "./gridGeometryWorkerProtocol.ts";
import type {
  TGridDataValueBatch,
  TGridPointBatch,
} from "./gridWorkerTypes.ts";

export type TIrregularDelaunayBatch = TGridPointBatch | TGridDataValueBatch;

export type TIrregularDelaunayWorkerRequest = {
  requestId: number;
  type: "build";
  latitudes: Float32Array;
  longitudes: Float32Array;
  latitudeShape: number[];
  longitudeShape: number[];
  data: Float32Array;
  batchSize: number;
  forceGeometryRebuild: boolean;
};

export type TIrregularDelaunayWorkerMetadata = {
  totalBatches: number;
  rebuildGeometry: boolean;
};

export type TIrregularDelaunayWorkerResponse = TGridGeometryWorkerResponse<
  TIrregularDelaunayWorkerMetadata,
  TIrregularDelaunayBatch
>;
