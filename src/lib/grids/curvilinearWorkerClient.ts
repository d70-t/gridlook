import type { TCurvilinearHoverIndexData } from "./curvilinearCalculations.ts";
import type { TCurvilinearWorkerRequest } from "./curvilinearWorkerProtocol.ts";
import {
  copyGridWorkerArray,
  createGridGeometryWorkerClient,
} from "./gridGeometryWorkerClient.ts";
import {
  GridGeometryWorkerMessageType,
  type TGridGeometryWorkerMetadata,
} from "./gridGeometryWorkerProtocol.ts";
import type { TGridGeometryBatch } from "./gridWorkerTypes.ts";

const client = createGridGeometryWorkerClient<
  TCurvilinearWorkerRequest,
  TGridGeometryWorkerMetadata,
  TGridGeometryBatch,
  TCurvilinearHoverIndexData
>(
  () =>
    new Worker(new URL("./curvilinear.worker.ts", import.meta.url), {
      type: "module",
    })
);

export async function buildCurvilinearHoverIndex(
  latitudes: Float32Array,
  longitudes: Float32Array
) {
  const result = await client.build(
    (requestId) => {
      const latitudesCopy = copyGridWorkerArray(latitudes);
      const longitudesCopy = copyGridWorkerArray(longitudes);
      return {
        message: {
          requestId,
          type: GridGeometryWorkerMessageType.BUILD,
          latitudes: latitudesCopy,
          longitudes: longitudesCopy,
        },
        transfer: [latitudesCopy.buffer, longitudesCopy.buffer],
      };
    },
    { onMetadata: () => {}, onBatch: () => {} }
  );
  return result.hoverIndexData;
}

export const terminateCurvilinearWorker = client.terminate;
