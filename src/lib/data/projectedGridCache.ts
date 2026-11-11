import type { TProjectedGridCoordinates } from "./crsInverse.ts";

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

type TEntry = {
  promise: Promise<TProjectedGridCoordinates>;
  cellCount: number;
};

// Insertion order is the recency order: a hit re-inserts its entry.
const entries = new Map<string, TEntry>();
let owner: unknown = undefined;
let maxCells = MAX_CACHED_PROJECTED_CELLS;

function cachedCells() {
  let total = 0;
  for (const entry of entries.values()) {
    total += entry.cellCount;
  }
  return total;
}

function evictLeastRecent() {
  while (entries.size > 1 && cachedCells() > maxCells) {
    const oldest = entries.keys().next().value;
    if (oldest === undefined) {
      return;
    }
    entries.delete(oldest);
  }
}

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
    entries.clear();
    owner = datasetIdentity;
  }
  const hit = entries.get(key);
  if (hit) {
    entries.delete(key);
    entries.set(key, hit);
    return hit.promise;
  }
  const promise = project();
  entries.set(key, { promise, cellCount });
  promise.catch(() => {
    if (entries.get(key)?.promise === promise) {
      entries.delete(key);
    }
  });
  evictLeastRecent();
  return promise;
}

export function clearProjectedGridCache() {
  entries.clear();
  owner = undefined;
}

/** The cached keys, most recent last (for tests). */
export function cachedProjectedGridKeys() {
  return [...entries.keys()];
}

/** Lowers or restores the cell bound (for tests). */
export function setMaxCachedProjectedCells(cells = MAX_CACHED_PROJECTED_CELLS) {
  maxCells = cells;
  evictLeastRecent();
}
