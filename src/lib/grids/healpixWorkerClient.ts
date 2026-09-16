import { createGridGeometryWorkerClient } from "./gridGeometryWorkerClient.ts";
import type {
  THealpixBatch,
  THealpixBuildRequest,
  THealpixWorkerMetadata,
  THealpixWorkerRequest,
} from "./healpixWorkerProtocol.ts";

const client = createGridGeometryWorkerClient<
  THealpixWorkerRequest,
  THealpixWorkerMetadata,
  Omit<THealpixBatch, "dataValues">,
  Float32Array<ArrayBuffer>
>(
  () =>
    new Worker(new URL("./healpix.worker.ts", import.meta.url), {
      type: "module",
    }),
  true
);

export async function buildHealpixFace(
  request: THealpixBuildRequest
): Promise<THealpixBatch> {
  let batch!: Omit<THealpixBatch, "dataValues">;
  const { hoverIndexData } = await client.build(
    (requestId) => ({
      message: { ...request, requestId },
      // The freshly fetched face is owned by this build; transfer without copying it.
      transfer: [request.data.buffer],
    }),
    {
      onMetadata: () => {},
      onBatch: (result) => {
        batch = result;
      },
    }
  );
  return {
    ...batch,
    batchIndex: request.faceIndex,
    dataValues: hoverIndexData,
  };
}

export const terminateHealpixWorker = client.terminate;
