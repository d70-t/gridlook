/// <reference lib="webworker" />

import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  GridDataWorkerMessageType,
  type TGridDataWorkerRequest,
  type TGridDataWorkerResponse,
} from "@/lib/grids/gridDataWorkerProtocol.ts";
import { serializeGridDataChunk } from "@/lib/grids/gridDataWorkerUtils.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (event: MessageEvent<TGridDataWorkerRequest>) => {
  const { requestId, source, variable, format, selection } = event.data;
  try {
    const array = await ZarrDataManager.getVariableInfo(
      source,
      variable,
      format
    );
    const { data, shape } = serializeGridDataChunk(
      await ZarrDataManager.getVariableDataFromArray(array, selection)
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
      message: error instanceof Error ? error.message : String(error),
    };
    workerScope.postMessage(response);
  }
};
