import type { GridOptions } from "healpix-geo";
import type { Attributes } from "zarrita";

import type { TGridGeometryWorkerResponse } from "./gridGeometryWorkerProtocol.ts";
import type {
  buildHealpixGeometry,
  buildHealpixTexture,
} from "./healpixCalculations.ts";

import type {
  TProjectionCenter,
  TProjectionType,
} from "@/lib/projection/projectionUtils.ts";

export type THealpixBuildRequest = {
  grid: GridOptions;
  data: Float32Array;
  cells?: number[];
  attributes: Attributes;
  missingValue: number;
  fillValue: number;
  projectionType: TProjectionType;
  projectionCenter: TProjectionCenter;
};

export type THealpixWorkerRequest = THealpixBuildRequest & {
  requestId: number;
};
export type THealpixWorkerMetadata = { totalBatches: number };
export type THealpixBatch = { batchIndex: number } & ReturnType<
  typeof buildHealpixGeometry
> &
  ReturnType<typeof buildHealpixTexture>;
export type THealpixWorkerResponse = TGridGeometryWorkerResponse<
  THealpixWorkerMetadata,
  THealpixBatch,
  Float32Array
>;
