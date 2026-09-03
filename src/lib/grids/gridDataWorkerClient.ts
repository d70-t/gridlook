import type * as zarr from "zarrita";

import {
  GridDataWorkerMessageType,
  type TGridDataWorkerRequest,
  type TGridDataWorkerResponse,
  type TGridDataWorkerResult,
} from "./gridDataWorkerProtocol.ts";
import { serializeGridDataChunk } from "./gridDataWorkerUtils.ts";

import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  ZARR_FORMAT,
  type TDatasetSource,
  type TZarrFormat,
} from "@/lib/types/GlobeTypes.ts";

export type TGridDataRequest = {
  source: TDatasetSource;
  variable: string;
  format: TZarrFormat;
  selection: (number | null | zarr.Slice)[];
};

type TPendingRequest = {
  resolve: (result: TGridDataWorkerResult) => void;
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

function toError(error: unknown) {
  return error instanceof Error ? error : new Error(String(error));
}

function handleWorkerMessage(message: unknown) {
  if (typeof message !== "object" || message === null) {
    throw new Error("Grid data worker returned an invalid response.");
  }
  const response = message as TGridDataWorkerResponse;
  if (
    response.type !== GridDataWorkerMessageType.RESULT &&
    response.type !== GridDataWorkerMessageType.ERROR
  ) {
    throw new Error(
      `Unknown grid data worker message: ${String(
        (message as { type?: unknown }).type
      )}`
    );
  }
  if (typeof response.requestId !== "number") {
    throw new Error("Grid data worker response has no request ID.");
  }
  const pending = pendingRequests.get(response.requestId);
  if (!pending) {
    return;
  }
  pendingRequests.delete(response.requestId);
  if (response.type === GridDataWorkerMessageType.ERROR) {
    pending.reject(new Error(response.message));
    return;
  }
  pending.resolve({ data: response.data, shape: response.shape });
}

function failWorker(activeWorker: Worker, error: Error) {
  if (worker !== activeWorker) {
    return;
  }
  rejectPendingRequests(error);
  activeWorker.terminate();
  worker = null;
}

function getWorker() {
  if (worker) {
    return worker;
  }
  const activeWorker = new Worker(
    new URL("./gridData.worker.ts", import.meta.url),
    {
      type: "module",
    }
  );
  worker = activeWorker;
  activeWorker.onmessage = (event: MessageEvent<unknown>) => {
    if (worker !== activeWorker) {
      return;
    }
    try {
      handleWorkerMessage(event.data);
    } catch (error) {
      failWorker(activeWorker, toError(error));
    }
  };
  activeWorker.onerror = (event) => {
    failWorker(activeWorker, new Error(event.message));
  };
  activeWorker.onmessageerror = () => {
    failWorker(
      activeWorker,
      new Error("Could not deserialize a grid data worker message.")
    );
  };
  return activeWorker;
}

async function getNetCDFVariableChunk(request: TGridDataRequest) {
  const array = await ZarrDataManager.getVariableInfo(
    request.source,
    request.variable,
    request.format
  );
  return serializeGridDataChunk(
    await ZarrDataManager.getVariableDataFromArray(array, request.selection)
  );
}

export function getGridVariableChunk(request: TGridDataRequest) {
  if (request.format === ZARR_FORMAT.NETCDF) {
    return getNetCDFVariableChunk(request);
  }

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
    selection: request.selection.map((selection) => {
      if (typeof selection !== "object" || selection === null) {
        return selection;
      }
      return {
        start: selection.start,
        stop: selection.stop,
        step: selection.step,
      };
    }),
  };

  return new Promise<TGridDataWorkerResult>((resolve, reject) => {
    pendingRequests.set(requestId, { resolve, reject });
    try {
      getWorker().postMessage(message);
    } catch (error) {
      if (worker) {
        failWorker(worker, toError(error));
      } else {
        pendingRequests.delete(requestId);
        reject(toError(error));
      }
    }
  });
}

export async function getGridVariableData(request: TGridDataRequest) {
  const { data } = await getGridVariableChunk(request);
  return data;
}

export function terminateGridDataWorker() {
  worker?.terminate();
  worker = null;
  rejectPendingRequests(new Error("Grid data worker terminated."));
}
