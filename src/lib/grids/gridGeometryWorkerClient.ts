import {
  GridGeometryWorkerMessageType,
  type TGridGeometryWorkerResponse,
} from "./gridGeometryWorkerProtocol.ts";
import type {
  TGridGeometryBatch,
  TSerializedGeoSampleIndexData,
  TGridWorkerBatch,
} from "./gridWorkerTypes.ts";

type TGridGeometryBuildCallbacks<TMetadata, TBatch> = {
  onMetadata: (metadata: TMetadata) => void;
  onBatch: (batch: TBatch) => void;
};

type TWorkerRequest<TRequest> = {
  message: TRequest;
  transfer: Transferable[];
};

type TBuildResult<TMetadata> = {
  metadata: TMetadata;
  hoverIndexData: TSerializedGeoSampleIndexData;
};

type TActiveBuild<TMetadata, TBatch> = {
  requestId: number;
  worker: Worker;
  callbacks: TGridGeometryBuildCallbacks<TMetadata, TBatch>;
  metadata: TMetadata | null;
  hoverIndexData: TSerializedGeoSampleIndexData | null;
  resolve: (value: TBuildResult<TMetadata>) => void;
  reject: (reason?: unknown) => void;
};

export function copyGridWorkerArray<TArray extends Float32Array | Float64Array>(
  array: TArray
): TArray {
  return array.slice() as TArray;
}

/* eslint-disable-next-line max-lines-per-function */
export function createGridGeometryWorkerClient<
  TRequest,
  TMetadata,
  TBatch extends TGridWorkerBatch = TGridGeometryBatch,
>(createWorker: () => Worker, keepWorkerAlive = false) {
  let activeBuild: TActiveBuild<TMetadata, TBatch> | null = null;
  let nextRequestId = 0;
  let worker: Worker | null = null;

  function terminate() {
    if (activeBuild) {
      activeBuild.reject(new Error("Grid geometry worker terminated."));
    }
    activeBuild = null;
    worker?.terminate();
    worker = null;
  }

  function fail(error: Error) {
    if (!activeBuild) {
      return;
    }
    const { worker: activeWorker, reject } = activeBuild;
    activeBuild = null;
    activeWorker.terminate();
    worker = null;
    reject(error);
  }

  function finish() {
    if (!activeBuild?.metadata || !activeBuild.hoverIndexData) {
      fail(new Error("Grid geometry worker returned incomplete results."));
      return;
    }
    const {
      worker: activeWorker,
      metadata,
      hoverIndexData,
      resolve,
    } = activeBuild;
    activeBuild = null;
    if (!keepWorkerAlive) {
      activeWorker.terminate();
      worker = null;
    }
    resolve({ metadata, hoverIndexData });
  }

  function handleMessage(
    message: TGridGeometryWorkerResponse<TMetadata, TBatch>
  ) {
    if (activeBuild?.requestId !== message.requestId) {
      return;
    }
    if (message.type === GridGeometryWorkerMessageType.METADATA) {
      activeBuild.metadata = message.metadata;
      activeBuild.callbacks.onMetadata(message.metadata);
    } else if (message.type === GridGeometryWorkerMessageType.BATCH) {
      activeBuild.callbacks.onBatch(message.batch);
    } else if (message.type === GridGeometryWorkerMessageType.HOVER_INDEX) {
      activeBuild.hoverIndexData = message.hoverIndexData;
    } else if (message.type === GridGeometryWorkerMessageType.ERROR) {
      fail(new Error(message.message));
    } else {
      finish();
    }
  }

  function build(
    createRequest: (requestId: number) => TWorkerRequest<TRequest>,
    callbacks: TGridGeometryBuildCallbacks<TMetadata, TBatch>
  ) {
    if (activeBuild) {
      terminate();
    }
    const requestId = ++nextRequestId;
    worker ??= createWorker();
    const activeWorker = worker;
    return new Promise<TBuildResult<TMetadata>>((resolve, reject) => {
      activeBuild = {
        requestId,
        worker: activeWorker,
        callbacks,
        metadata: null,
        hoverIndexData: null,
        resolve,
        reject,
      };
      activeWorker.onmessage = (
        event: MessageEvent<TGridGeometryWorkerResponse<TMetadata, TBatch>>
      ) => {
        try {
          handleMessage(event.data);
        } catch (error) {
          fail(error instanceof Error ? error : new Error(String(error)));
        }
      };
      activeWorker.onerror = (event) => {
        if (activeBuild?.requestId === requestId) {
          fail(new Error(event.message));
        }
      };
      const request = createRequest(requestId);
      activeWorker.postMessage(request.message, request.transfer);
    });
  }

  return { build, terminate };
}
