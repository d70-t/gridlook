import type { TCurvilinearHoverIndexData } from "./curvilinearCalculations.ts";
import type {
  TGridGeometryWorkerMetadata,
  TGridGeometryWorkerResponse,
} from "./gridGeometryWorkerProtocol.ts";
import type { TGridGeometryBatch } from "./gridWorkerTypes.ts";

import type { TProjectedGridCoordinates } from "@/lib/data/crsInverse.ts";

export const CurvilinearWorkerRequestType = {
  HOVER_INDEX: "build",
  PROJECT: "project",
} as const;

export type TCurvilinearHoverIndexRequest = {
  requestId: number;
  type: typeof CurvilinearWorkerRequestType.HOVER_INDEX;
  latitudes: Float32Array;
  longitudes: Float32Array;
};

// The lon/lat of every (y, x) cell centre of a projected grid.
export type TCurvilinearProjectionRequest = {
  requestId: number;
  type: typeof CurvilinearWorkerRequestType.PROJECT;
  x: Float32Array;
  y: Float32Array;
  crs: string | null;
};

export type TCurvilinearWorkerRequest =
  TCurvilinearHoverIndexRequest | TCurvilinearProjectionRequest;

// Each request has one result, delivered in the geometry protocol's hover
// index message.
export type TCurvilinearWorkerResult =
  TCurvilinearHoverIndexData | TProjectedGridCoordinates;

export type TCurvilinearWorkerResponse = TGridGeometryWorkerResponse<
  TGridGeometryWorkerMetadata,
  TGridGeometryBatch,
  TCurvilinearWorkerResult
>;
