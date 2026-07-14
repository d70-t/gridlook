import type * as zarr from "zarrita";

import {
  RegularGridDataWorkerMessageType,
  type TRegularGridDataWorkerRequest,
  type TRegularGridDataWorkerResponse,
} from "./regularGridDataWorkerProtocol.ts";

import type { TDataSource, TZarrFormat } from "@/lib/types/GlobeTypes.ts";

type TRegularGridDataRequest = {
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

function handleWorkerMessage(message: TRegularGridDataWorkerResponse) {
  const pending = pendingRequests.get(message.requestId);
  if (!pending) {
    return;
  }
  pendingRequests.delete(message.requestId);
  if (message.type === RegularGridDataWorkerMessageType.ERROR) {
    pending.reject(new Error(message.message));
    return;
  }
  pending.resolve(message.data);
}

function getWorker() {
  if (worker) {
    return worker;
  }
  worker = new Worker(new URL("./regularGridData.worker.ts", import.meta.url), {
    type: "module",
  });
  worker.onmessage = (event: MessageEvent<TRegularGridDataWorkerResponse>) => {
    handleWorkerMessage(event.data);
  };
  worker.onerror = (event) => {
    rejectPendingRequests(new Error(event.message));
    worker?.terminate();
    worker = null;
  };
  return worker;
}

export function getRegularGridVariableData(request: TRegularGridDataRequest) {
  const requestId = ++nextRequestId;
  const message: TRegularGridDataWorkerRequest = {
    requestId,
    type: RegularGridDataWorkerMessageType.GET_DATA,
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

export function terminateRegularGridDataWorker() {
  worker?.terminate();
  worker = null;
  rejectPendingRequests(new Error("Regular grid data worker terminated."));
}
