/// <reference lib="webworker" />

import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import {
  RegularGridDataWorkerMessageType,
  type TRegularGridDataWorkerRequest,
  type TRegularGridDataWorkerResponse,
} from "@/lib/grids/regularGridDataWorkerProtocol.ts";

const workerScope = self as unknown as DedicatedWorkerGlobalScope;

workerScope.onmessage = async (
  event: MessageEvent<TRegularGridDataWorkerRequest>
) => {
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
    const response: TRegularGridDataWorkerResponse = {
      requestId,
      type: RegularGridDataWorkerMessageType.RESULT,
      data: chunk.data,
    };
    const transfer =
      ArrayBuffer.isView(chunk.data) && chunk.data.buffer instanceof ArrayBuffer
        ? [chunk.data.buffer]
        : [];
    workerScope.postMessage(response, transfer);
  } catch (error) {
    const response: TRegularGridDataWorkerResponse = {
      requestId,
      type: RegularGridDataWorkerMessageType.ERROR,
      message: error instanceof Error ? error.message : String(error),
    };
    workerScope.postMessage(response);
  }
};
