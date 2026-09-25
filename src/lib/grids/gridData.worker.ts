/// <reference lib="webworker" />

import { createGridDataQueue } from "./gridDataQueue.ts";

import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  GridDataWorkerMessageType,
  type TGridDataWorkerRequest,
  type TGridDataWorkerResponse,
} from "@/lib/grids/gridDataWorkerProtocol.ts";
import { serializeGridDataChunk } from "@/lib/grids/gridDataWorkerUtils.ts";
import { flattenErrorMessage } from "@/utils/errorHandling.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

function createReadQueue(
  requestId: number,
  reportProgress: boolean,
  concurrency = Number.MAX_SAFE_INTEGER
) {
  let lastPercentage = -1;
  return createGridDataQueue(concurrency, (completed, total) => {
    if (!reportProgress) {
      return;
    }
    const percentage = total > 0 ? Math.floor((completed / total) * 100) : 0;
    if (percentage === lastPercentage && completed !== total) {
      return;
    }
    lastPercentage = percentage;
    const response: TGridDataWorkerResponse = {
      requestId,
      type: GridDataWorkerMessageType.PROGRESS,
      completed,
      total,
    };
    workerScope.postMessage(response);
  });
}

workerScope.onmessage = async (event: MessageEvent<TGridDataWorkerRequest>) => {
  const {
    requestId,
    source,
    variable,
    format,
    selection,
    reportProgress,
    chunkConcurrency,
  } = event.data;
  try {
    const array = await ZarrDataManager.getVariableInfo(
      source,
      variable,
      format
    );
    const { data, shape } = serializeGridDataChunk(
      await ZarrDataManager.getVariableDataFromArray(
        array,
        selection,
        chunkConcurrency || reportProgress
          ? {
              createQueue: () =>
                createReadQueue(requestId, !!reportProgress, chunkConcurrency),
            }
          : undefined
      )
    );
    const response: TGridDataWorkerResponse = {
      requestId,
      type: GridDataWorkerMessageType.RESULT,
      data,
      shape,
    };
    const transfer =
      ArrayBuffer.isView(data) && data.buffer instanceof ArrayBuffer
        ? [data.buffer]
        : [];
    workerScope.postMessage(response, transfer);
  } catch (error) {
    const response: TGridDataWorkerResponse = {
      requestId,
      type: GridDataWorkerMessageType.ERROR,
      message: flattenErrorMessage(error),
    };
    workerScope.postMessage(response);
  }
};
