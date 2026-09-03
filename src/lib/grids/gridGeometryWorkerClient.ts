import {
  GridGeometryWorkerMessageType,
  type TGridGeometryWorkerMetadata,
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

type TBuildResult<TMetadata extends TGridGeometryWorkerMetadata> = {
  metadata: TMetadata;
  hoverIndexData: TSerializedGeoSampleIndexData;
};

type TActiveBuild<TMetadata extends TGridGeometryWorkerMetadata, TBatch> = {
  requestId: number;
  worker: Worker;
  callbacks: TGridGeometryBuildCallbacks<TMetadata, TBatch>;
  metadata: TMetadata | null;
  receivedBatchIndexes: Set<number>;
  hoverIndexData: TSerializedGeoSampleIndexData | null;
  resolve: (value: TBuildResult<TMetadata>) => void;
  reject: (reason?: unknown) => void;
};

export function copyGridWorkerArray<
  TArray extends Int32Array | Float32Array | Float64Array,
>(array: TArray): TArray {
  return array.slice() as TArray;
}

/* eslint-disable-next-line max-lines-per-function */
export function createGridGeometryWorkerClient<
  TRequest,
  TMetadata extends TGridGeometryWorkerMetadata,
  TBatch extends TGridWorkerBatch = TGridGeometryBatch,
>(createWorker: () => Worker, keepWorkerAlive = false) {
  let activeBuild: TActiveBuild<TMetadata, TBatch> | null = null;
  let nextRequestId = 0;
  let worker: Worker | null = null;

  function toError(error: unknown) {
    return error instanceof Error ? error : new Error(String(error));
  }

  function terminate() {
    if (activeBuild) {
      activeBuild.reject(new Error("Grid geometry worker terminated."));
    }
    activeBuild = null;
    worker?.terminate();
    worker = null;
  }

  function fail(activeWorker: Worker, error: Error) {
    if (worker !== activeWorker && activeBuild?.worker !== activeWorker) {
      return;
    }
    const failedBuild =
      activeBuild?.worker === activeWorker ? activeBuild : null;
    if (failedBuild) {
      activeBuild = null;
      failedBuild.reject(error);
    }
    activeWorker.terminate();
    if (worker === activeWorker) {
      worker = null;
    }
  }

  function finish() {
    if (
      !activeBuild ||
      activeBuild.metadata === null ||
      activeBuild.hoverIndexData === null
    ) {
      if (activeBuild) {
        fail(
          activeBuild.worker,
          new Error("Grid geometry worker returned incomplete results.")
        );
      }
      return;
    }
    if (
      activeBuild.receivedBatchIndexes.size !==
      activeBuild.metadata.totalBatches
    ) {
      fail(
        activeBuild.worker,
        new Error(
          `Grid geometry worker returned ${activeBuild.receivedBatchIndexes.size} of ${activeBuild.metadata.totalBatches} batches.`
        )
      );
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
      if (worker === activeWorker) {
        worker = null;
      }
    }
    resolve({ metadata, hoverIndexData });
  }

  function setMetadata(
    activeWorker: Worker,
    build: TActiveBuild<TMetadata, TBatch>,
    metadata: TMetadata
  ) {
    if (
      !Number.isSafeInteger(metadata.totalBatches) ||
      metadata.totalBatches < 0
    ) {
      fail(
        activeWorker,
        new Error("Grid geometry worker returned an invalid batch count.")
      );
      return;
    }
    if (build.metadata !== null) {
      fail(
        activeWorker,
        new Error("Grid geometry worker returned duplicate metadata.")
      );
      return;
    }
    build.metadata = metadata;
    build.callbacks.onMetadata(metadata);
  }

  function handleBatch(
    activeWorker: Worker,
    build: TActiveBuild<TMetadata, TBatch>,
    batch: TBatch
  ) {
    if (build.metadata === null) {
      fail(
        activeWorker,
        new Error("Grid geometry worker returned a batch before metadata.")
      );
      return;
    }
    if (
      !Number.isSafeInteger(batch.batchIndex) ||
      batch.batchIndex < 0 ||
      batch.batchIndex >= build.metadata.totalBatches
    ) {
      fail(
        activeWorker,
        new Error("Grid geometry worker returned an invalid batch index.")
      );
      return;
    }
    if (build.receivedBatchIndexes.has(batch.batchIndex)) {
      fail(
        activeWorker,
        new Error("Grid geometry worker returned a duplicate batch.")
      );
      return;
    }
    build.receivedBatchIndexes.add(batch.batchIndex);
    build.callbacks.onBatch(batch);
  }

  function handleMessage(activeWorker: Worker, message: unknown) {
    if (typeof message !== "object" || message === null) {
      fail(
        activeWorker,
        new Error("Grid geometry worker returned an invalid response.")
      );
      return;
    }
    const response = message as TGridGeometryWorkerResponse<TMetadata, TBatch>;
    if (
      !activeBuild ||
      activeBuild.worker !== activeWorker ||
      activeBuild.requestId !== response.requestId
    ) {
      fail(
        activeWorker,
        new Error("Grid geometry worker returned an unexpected response.")
      );
      return;
    }
    switch (response.type) {
      case GridGeometryWorkerMessageType.METADATA:
        setMetadata(activeWorker, activeBuild, response.metadata);
        break;
      case GridGeometryWorkerMessageType.BATCH:
        handleBatch(activeWorker, activeBuild, response.batch);
        break;
      case GridGeometryWorkerMessageType.HOVER_INDEX:
        activeBuild.hoverIndexData = response.hoverIndexData;
        break;
      case GridGeometryWorkerMessageType.ERROR:
        fail(activeWorker, new Error(response.message));
        break;
      case GridGeometryWorkerMessageType.DONE:
        finish();
        break;
      default:
        fail(
          activeWorker,
          new Error(
            `Unknown grid geometry worker message: ${String(
              (message as { type?: unknown }).type
            )}`
          )
        );
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
    try {
      worker ??= createWorker();
    } catch (error) {
      return Promise.reject(toError(error));
    }
    const activeWorker = worker;
    return new Promise<TBuildResult<TMetadata>>((resolve, reject) => {
      activeBuild = {
        requestId,
        worker: activeWorker,
        callbacks,
        metadata: null,
        receivedBatchIndexes: new Set(),
        hoverIndexData: null,
        resolve,
        reject,
      };
      activeWorker.onmessage = (event: MessageEvent<unknown>) => {
        try {
          handleMessage(activeWorker, event.data);
        } catch (error) {
          fail(activeWorker, toError(error));
        }
      };
      activeWorker.onerror = (event) => {
        fail(activeWorker, new Error(event.message));
      };
      activeWorker.onmessageerror = () => {
        fail(
          activeWorker,
          new Error("Could not deserialize a grid geometry worker message.")
        );
      };
      try {
        const request = createRequest(requestId);
        activeWorker.postMessage(request.message, request.transfer);
      } catch (error) {
        fail(activeWorker, toError(error));
      }
    });
  }

  return { build, terminate };
}
