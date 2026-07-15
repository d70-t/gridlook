import type * as zarr from "zarrita";

import {
  GridDataWorkerMessageType,
  type TGridDataWorkerRequest,
  type TGridDataWorkerResponse,
} from "./gridDataWorkerProtocol.ts";

import type { TDataSource, TZarrFormat } from "@/lib/types/GlobeTypes.ts";

export type TGridDataRequest = {
  source: Pick<TDataSource, "store" | "dataset">;
  variable: string;
  format: TZarrFormat;
  selection: (number | null | zarr.Slice)[];
};

type TPendingRequest = {
  resolve: (data: zarr.TypedArray<zarr.DataType>) => void;
  reject: (reason?: unknown) => void;
};

let worker: Worker | null = null;
let nextRequestId = 0;
const pendingRequests = new Map<number, TPendingRequest>();

function rejectPendingRequests(error: Error) {
  for (const pending of pendingRequests.values()) {
    pending.reject(error);
  }
  pendingRequests.clear();
}

function handleWorkerMessage(message: TGridDataWorkerResponse) {
  const pending = pendingRequests.get(message.requestId);
  if (!pending) {
    return;
  }
  pendingRequests.delete(message.requestId);
  if (message.type === GridDataWorkerMessageType.ERROR) {
    pending.reject(new Error(message.message));
    return;
  }
  pending.resolve(message.data);
}

function getWorker() {
  if (worker) {
    return worker;
  }
  worker = new Worker(new URL("./gridData.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (event: MessageEvent<TGridDataWorkerResponse>) => {
    handleWorkerMessage(event.data);
  };
  worker.onerror = (event) => {
    rejectPendingRequests(new Error(event.message));
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function getGridVariableData(request: TGridDataRequest) {
  const requestId = ++nextRequestId;
  const message: TGridDataWorkerRequest = {
    requestId,
    type: GridDataWorkerMessageType.GET_DATA,
    source: {
      store: request.source.store,
      dataset: request.source.dataset,
    },
    variable: request.variable,
    format: request.format,
    selection: request.selection.map((selection) =>
      typeof selection === "object" && selection !== null
        ? { ...selection }
        : selection
    ),
  };

  return new Promise<zarr.TypedArray<zarr.DataType>>((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    getWorker().postMessage(message);
  });
}

export function terminateGridDataWorker() {
  worker?.terminate();
  worker = null;
  rejectPendingRequests(new Error("Grid data worker terminated."));
}
