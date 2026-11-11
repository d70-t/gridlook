import type { TCurvilinearHoverIndexData } from "./curvilinearCalculations.ts";
import {
  CurvilinearWorkerRequestType,
  type TCurvilinearWorkerRequest,
} from "./curvilinearWorkerProtocol.ts";
import {
  copyGridWorkerArray,
  createGridGeometryWorkerClient,
} from "./gridGeometryWorkerClient.ts";
import type { TGridGeometryWorkerMetadata } from "./gridGeometryWorkerProtocol.ts";
import type { TGridGeometryBatch } from "./gridWorkerTypes.ts";

import type { TProjectedGridCoordinates } from "@/lib/data/crsInverse.ts";

function createClient<TResult>() {
  return createGridGeometryWorkerClient<
    TCurvilinearWorkerRequest,
    TGridGeometryWorkerMetadata,
    TGridGeometryBatch,
    TResult
  >(
    () =>
      new Worker(new URL("./curvilinear.worker.ts", import.meta.url), {
        type: "module",
      })
  );
}

// A geometry client runs one build at a time and cancels the previous one
// when a new build starts. The hover index of a level and the projection of
// the next level must not cancel each other, so each has its own worker.
const hoverIndexClient = createClient<TCurvilinearHoverIndexData>();
const projectionClient = createClient<TProjectedGridCoordinates>();

type THoverIndexBuild = {
  latitudes: Float32Array;
  longitudes: Float32Array;
  hoverIndex: Promise<TCurvilinearHoverIndexData>;
};

// The index of the coordinates built last. Projected coordinates are cached
// per level, so a variable change on the same level (which remounts the
// grid) passes the same arrays again and gets the index without a rebuild.
let lastHoverIndexBuild: THoverIndexBuild | undefined;

function requestHoverIndex(latitudes: Float32Array, longitudes: Float32Array) {
  return hoverIndexClient.build(
    (requestId) => {
      const latitudesCopy = copyGridWorkerArray(latitudes);
      const longitudesCopy = copyGridWorkerArray(longitudes);
      return {
        message: {
          requestId,
          type: CurvilinearWorkerRequestType.HOVER_INDEX,
          latitudes: latitudesCopy,
          longitudes: longitudesCopy,
        },
        transfer: [latitudesCopy.buffer, longitudesCopy.buffer],
      };
    },
    { onMetadata: () => {}, onBatch: () => {} }
  );
}

export function buildCurvilinearHoverIndex(
  latitudes: Float32Array,
  longitudes: Float32Array
) {
  const last = lastHoverIndexBuild;
  if (last?.latitudes === latitudes && last.longitudes === longitudes) {
    return last.hoverIndex;
  }
  const hoverIndex = requestHoverIndex(latitudes, longitudes).then(
    (result) => result.hoverIndexData
  );
  const build = { latitudes, longitudes, hoverIndex };
  lastHoverIndexBuild = build;
  hoverIndex.catch(() => {
    if (lastHoverIndexBuild === build) {
      lastHoverIndexBuild = undefined;
    }
  });
  return hoverIndex;
}

/**
 * The lon/lat of every (y[j], x[i]) cell centre of a grid in `crs`, projected
 * in the worker. A new request cancels one still in flight.
 */
export async function projectCurvilinearGrid(
  x: Float32Array,
  y: Float32Array,
  crs: string | null
) {
  const result = await projectionClient.build(
    (requestId) => {
      const xCopy = copyGridWorkerArray(x);
      const yCopy = copyGridWorkerArray(y);
      return {
        message: {
          requestId,
          type: CurvilinearWorkerRequestType.PROJECT,
          x: xCopy,
          y: yCopy,
          crs,
        },
        transfer: [xCopy.buffer, yCopy.buffer],
      };
    },
    { onMetadata: () => {}, onBatch: () => {} }
  );
  return result.hoverIndexData;
}

export function terminateCurvilinearWorker() {
  hoverIndexClient.terminate();
  projectionClient.terminate();
}
