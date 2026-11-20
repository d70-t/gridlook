import { afterEach, expect, it, vi } from "vitest";

import type { TProjectedGridCoordinates } from "@/lib/data/crsInverse.ts";
import {
  cachedProjectedGridKeys,
  clearProjectedGridCache,
  getProjectedGrid,
  setMaxCachedProjectedCells,
} from "@/lib/data/projectedGridCache.ts";

function coordinates(cells: number): TProjectedGridCoordinates {
  return {
    latitudes: new Float32Array(cells),
    longitudes: new Float32Array(cells),
  };
}

afterEach(() => {
  clearProjectedGridCache();
  setMaxCachedProjectedCells();
});

it("projects a level once and shares the result across requests", async () => {
  const dataset = {};
  const project = vi.fn(async () => coordinates(4));
  const first = getProjectedGrid(dataset, "2000m", 4, project);
  const second = getProjectedGrid(dataset, "2000m", 4, project);
  expect(second).toBe(first);
  expect(await second).toBe(await first);
  expect(project).toHaveBeenCalledTimes(1);

  const other = vi.fn(async () => coordinates(2));
  await getProjectedGrid(dataset, "8000m", 2, other);
  expect(other).toHaveBeenCalledTimes(1);
  expect(cachedProjectedGridKeys()).toEqual(["2000m", "8000m"]);
});

it("drops every entry when another dataset is opened", async () => {
  const project = vi.fn(async () => coordinates(1));
  await getProjectedGrid({}, "level", 1, project);
  await getProjectedGrid({}, "level", 1, project);
  expect(project).toHaveBeenCalledTimes(2);
  expect(cachedProjectedGridKeys()).toEqual(["level"]);
});

it("evicts the least recently used levels past the cell bound, keeping the newest", async () => {
  const dataset = {};
  setMaxCachedProjectedCells(10);
  const project = (cells: number) => async () => coordinates(cells);
  await getProjectedGrid(dataset, "a", 4, project(4));
  await getProjectedGrid(dataset, "b", 4, project(4));
  // a hit on "a" makes "b" the least recent
  await getProjectedGrid(dataset, "a", 4, project(4));
  await getProjectedGrid(dataset, "c", 4, project(4));
  expect(cachedProjectedGridKeys()).toEqual(["a", "c"]);

  await getProjectedGrid(dataset, "huge", 50, project(50));
  expect(cachedProjectedGridKeys()).toEqual(["huge"]);
});

it("forgets a failed projection so the next request retries", async () => {
  const dataset = {};
  const failing = getProjectedGrid(dataset, "level", 1, () =>
    Promise.reject(new Error("terminated"))
  );
  await expect(failing).rejects.toThrow("terminated");
  expect(cachedProjectedGridKeys()).toEqual([]);
  const project = vi.fn(async () => coordinates(1));
  await getProjectedGrid(dataset, "level", 1, project);
  expect(project).toHaveBeenCalledTimes(1);
});
