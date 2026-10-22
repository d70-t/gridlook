import type { TCurvilinearHoverIndexData } from "./curvilinearCalculations.ts";
import type {
  TGridGeometryWorkerMetadata,
  TGridGeometryWorkerResponse,
} from "./gridGeometryWorkerProtocol.ts";
import type { TGridGeometryBatch } from "./gridWorkerTypes.ts";

export type TCurvilinearWorkerRequest = {
  requestId: number;
  type: "build";
  latitudes: Float32Array;
  longitudes: Float32Array;
};

export type TCurvilinearWorkerResponse = TGridGeometryWorkerResponse<
  TGridGeometryWorkerMetadata,
  TGridGeometryBatch,
  TCurvilinearHoverIndexData
>;
