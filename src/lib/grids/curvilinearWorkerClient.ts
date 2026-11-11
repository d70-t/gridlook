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
import { createBoundedPromiseCache } from "@/utils/boundedPromiseCache.ts";

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

// Hover indexes of the coordinates built before, keyed by the coordinate
// arrays: projected coordinates are cached per level, so a level visited
// again, or a variable change on it (which remounts the grid), passes the
// same arrays and gets its index without a rebuild. An index holds about
// 40 bytes a sample, so the bound keeps a few levels (the three coarsest
// of the ISMIP7 Antarctic family together); the newest is always kept.
export const MAX_CACHED_HOVER_SAMPLES = 12 * 2 ** 20;

const hoverIndexes = createBoundedPromiseCache<
  Float32Array,
  TCurvilinearHoverIndexData
>(MAX_CACHED_HOVER_SAMPLES);
const longitudesOfIndex = new WeakMap<Float32Array, Float32Array>();

function requestHoverIndex(latitudes: Float32Array, longitudes: Float32Array) {
  return hoverIndexClient
    .build(
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
    )
    .then((result) => result.hoverIndexData);
}

export function buildCurvilinearHoverIndex(
  latitudes: Float32Array,
  longitudes: Float32Array
) {
  if (longitudesOfIndex.get(latitudes) !== longitudes) {
    hoverIndexes.delete(latitudes);
    longitudesOfIndex.set(latitudes, longitudes);
  }
  return hoverIndexes.get(latitudes, latitudes.length, () =>
    requestHoverIndex(latitudes, longitudes)
  );
}

/** Lowers or restores the sample bound (for tests). */
export const setMaxCachedHoverSamples = hoverIndexes.setMaxWeight;

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
  hoverIndexes.clear();
}
