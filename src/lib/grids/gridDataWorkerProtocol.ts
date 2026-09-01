import type * as zarr from "zarrita";

import type { TDataSource, TZarrFormat } from "@/lib/types/GlobeTypes.ts";

export const GridDataWorkerMessageType = {
  GET_DATA: "getData",
  PROGRESS: "progress",
  RESULT: "result",
  ERROR: "error",
} as const;

type TGridDataWorkerMessageType =
  (typeof GridDataWorkerMessageType)[keyof typeof GridDataWorkerMessageType];

export type TGridDataWorkerRequest = {
  requestId: number;
  type: typeof GridDataWorkerMessageType.GET_DATA;
  source: Pick<TDataSource, "store" | "dataset">;
  variable: string;
  format: TZarrFormat;
  selection: (number | null | zarr.Slice)[];
  reportProgress?: boolean;
};

type TGridDataWorkerResponseBase = {
  requestId: number;
  type: TGridDataWorkerMessageType;
};

export type TGridDataWorkerResponse =
  | (TGridDataWorkerResponseBase & {
      type: typeof GridDataWorkerMessageType.PROGRESS;
      completed: number;
      total: number;
    })
  | (TGridDataWorkerResponseBase & {
      type: typeof GridDataWorkerMessageType.RESULT;
      data: zarr.TypedArray<zarr.DataType>;
    })
  | (TGridDataWorkerResponseBase & {
      type: typeof GridDataWorkerMessageType.ERROR;
      message: string;
    });
