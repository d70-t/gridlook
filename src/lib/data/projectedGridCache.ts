import type { TProjectedGridCoordinates } from "./crsInverse.ts";

import { createBoundedPromiseCache } from "@/utils/boundedPromiseCache.ts";

/**
 * The lon/lat of the cell centres of projected levels, kept across level
 * switches, time steps and variable changes. A level's grid is fixed, so its
 * projection is keyed by the level's identity (store, group, axes, CRS) and
 * computed once; the entries of the previous dataset are dropped when a new
 * one is opened, and the total held is bounded.
 */

// Float32 lon and lat: 8 bytes a cell, about 256 MB at this bound; the
// newest entry is kept even when it exceeds it alone.
export const MAX_CACHED_PROJECTED_CELLS = 32 * 2 ** 20;

const cache = createBoundedPromiseCache<string, TProjectedGridCoordinates>(
  MAX_CACHED_PROJECTED_CELLS
);
let owner: unknown = undefined;

/**
 * The projection stored under `key` for `datasetIdentity` (an object that
 * stays the same while a dataset is open, e.g. its level list), computed with
 * `project` on a miss and shared while in flight. A failed projection is
 * dropped so the next request retries. Opening another dataset empties the
 * cache.
 */
export function getProjectedGrid(
  datasetIdentity: unknown,
  key: string,
  cellCount: number,
  project: () => Promise<TProjectedGridCoordinates>
): Promise<TProjectedGridCoordinates> {
  if (owner !== datasetIdentity) {
    cache.clear();
    owner = datasetIdentity;
  }
  return cache.get(key, cellCount, project);
}

export function clearProjectedGridCache() {
  cache.clear();
  owner = undefined;
}

/** The cached keys, most recent last (for tests). */
export const cachedProjectedGridKeys = cache.keys;

/** Lowers or restores the cell bound (for tests). */
export const setMaxCachedProjectedCells = cache.setMaxWeight;
