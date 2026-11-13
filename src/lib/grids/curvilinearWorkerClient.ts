import type { TCurvilinearHoverIndexData } from "./curvilinearCalculations.ts";
import {
  CurvilinearWorkerRequestType,
  type TCurvilinearWorkerRequest,
} from "./curvilinearWorkerProtocol.ts";
import {
  copyGridWorkerArray,
  createGridGeometryWorkerClient,
  GridGeometryWorkerCancelled,
} from "./gridGeometryWorkerClient.ts";
import type { TGridGeometryWorkerMetadata } from "./gridGeometryWorkerProtocol.ts";
import type { TGridGeometryBatch } from "./gridWorkerTypes.ts";

import {
  projectGridToLonLat,
  type TProjectedGridCoordinates,
} from "@/lib/data/crsInverse.ts";
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
// arrays. Only coordinates the projection cache hands out are admitted
// (registerReusableCoordinates): those come back as the same arrays when a
// level is visited again or the grid is remounted for another variable,
// whereas lat/lon read from the store are fresh arrays every time and could
// never hit. The cache survives the grid's unmount and is emptied when
// another dataset is opened. The weight counts the index (about 40 bytes a
// sample) and the key arrays it pins (8 bytes a cell); the newest entry is
// always kept, so the finest level shown stays available on its own.
const MAX_CACHED_HOVER_BYTES = 512 * 2 ** 20;
const HOVER_INDEX_BYTES_PER_SAMPLE = 40;
const COORDINATE_BYTES_PER_CELL = 2 * Float32Array.BYTES_PER_ELEMENT;

const hoverIndexes = createBoundedPromiseCache<
  Float32Array,
  TCurvilinearHoverIndexData
>(MAX_CACHED_HOVER_BYTES);
const reusableLongitudes = new WeakMap<Float32Array, Float32Array>();
let reusableDataset: unknown = undefined;

/**
 * Marks coordinates that will be passed again as the same arrays, so that
 * their hover index is kept; `datasetIdentity` is the object that stays the
 * same while a dataset is open, and another one empties the cache.
 */
export function registerReusableCoordinates(
  datasetIdentity: unknown,
  latitudes: Float32Array,
  longitudes: Float32Array
) {
  if (reusableDataset !== datasetIdentity) {
    hoverIndexes.clear();
    reusableDataset = datasetIdentity;
  }
  reusableLongitudes.set(latitudes, longitudes);
}

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
  if (reusableLongitudes.get(latitudes) !== longitudes) {
    return requestHoverIndex(latitudes, longitudes);
  }
  return hoverIndexes.get(
    latitudes,
    latitudes.length *
      (HOVER_INDEX_BYTES_PER_SAMPLE + COORDINATE_BYTES_PER_CELL),
    () => requestHoverIndex(latitudes, longitudes)
  );
}

/** Empties the hover index cache (for tests). */
export function clearCurvilinearHoverIndexes() {
  hoverIndexes.clear();
  reusableDataset = undefined;
}

/** Lowers or restores the byte bound (for tests). */
export const setMaxCachedHoverBytes = hoverIndexes.setMaxWeight;

function requestProjection(
  x: Float32Array,
  y: Float32Array,
  crs: string | null
) {
  return projectionClient.build(
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
}

/**
 * The lon/lat of every (y[j], x[i]) cell centre of a grid in `crs`, projected
 * in the worker; on this thread where there are no workers, or when the
 * worker cannot be started or fails. A new request cancels one still in
 * flight, and the cancelled request rejects.
 */
export async function projectCurvilinearGrid(
  x: Float32Array,
  y: Float32Array,
  crs: string | null
) {
  if (typeof Worker === "undefined") {
    return projectGridToLonLat(x, y, crs);
  }
  try {
    return (await requestProjection(x, y, crs)).hoverIndexData;
  } catch (error) {
    if (error instanceof GridGeometryWorkerCancelled) {
      throw error;
    }
    console.warn("Projecting on the main thread:", error);
    return projectGridToLonLat(x, y, crs);
  }
}

export function terminateCurvilinearWorker() {
  hoverIndexClient.terminate();
  projectionClient.terminate();
}
