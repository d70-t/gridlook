/// <reference lib="webworker" />

import { flattenErrorMessage } from "@/lib/data/codecErrors.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  GridDataWorkerMessageType,
  type TGridDataWorkerRequest,
  type TGridDataWorkerResponse,
} from "@/lib/grids/gridDataWorkerProtocol.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (event: MessageEvent<TGridDataWorkerRequest>) => {
  const { requestId, source, variable, format, selection } = event.data;
  try {
    const array = await ZarrDataManager.getVariableInfo(
      source,
      variable,
      format
    );
    const chunk = await ZarrDataManager.getVariableDataFromArray(
      array,
      selection
    );
    const response: TGridDataWorkerResponse = {
      requestId,
      type: GridDataWorkerMessageType.RESULT,
      data: chunk.data,
    };
    const transfer =
      ArrayBuffer.isView(chunk.data) && chunk.data.buffer instanceof ArrayBuffer
        ? [chunk.data.buffer]
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
