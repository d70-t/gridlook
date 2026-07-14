import type * as zarr from "zarrita";

import type { TDataSource, TZarrFormat } from "@/lib/types/GlobeTypes.ts";

export const RegularGridDataWorkerMessageType = {
  GET_DATA: "getData",
  RESULT: "result",
  ERROR: "error",
} as const;

type TRegularGridDataWorkerMessageType =
  (typeof RegularGridDataWorkerMessageType)[keyof typeof RegularGridDataWorkerMessageType];

export type TRegularGridDataWorkerRequest = {
  requestId: number;
  type: typeof RegularGridDataWorkerMessageType.GET_DATA;
  source: Pick<TDataSource, "store" | "dataset">;
  variable: string;
  format: TZarrFormat;
  selection: (number | null | zarr.Slice)[];
};

type TRegularGridDataWorkerResponseBase = {
  requestId: number;
  type: TRegularGridDataWorkerMessageType;
};

export type TRegularGridDataWorkerResponse =
  | (TRegularGridDataWorkerResponseBase & {
      type: typeof RegularGridDataWorkerMessageType.RESULT;
      data: zarr.TypedArray<zarr.DataType>;
    })
  | (TRegularGridDataWorkerResponseBase & {
      type: typeof RegularGridDataWorkerMessageType.ERROR;
      message: string;
    });
