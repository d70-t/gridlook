import { expect, it, vi } from "vitest";

import { createBoundedPromiseCache } from "@/utils/boundedPromiseCache.ts";

it("shares a promise per key and evicts the least recently used past the bound", async () => {
  const cache = createBoundedPromiseCache<string, number>(10);
  const compute = vi.fn(async () => 1);
  expect(cache.get("a", 4, compute)).toBe(cache.get("a", 4, compute));
  expect(compute).toHaveBeenCalledTimes(1);
  cache.get("b", 4, compute);
  cache.get("a", 4, compute);
  cache.get("c", 4, compute);
  expect(cache.keys()).toEqual(["a", "c"]);
  cache.get("huge", 50, compute);
  expect(cache.keys()).toEqual(["huge"]);
  cache.setMaxWeight(0);
  expect(cache.keys()).toEqual(["huge"]);
});

it("forgets a rejected promise", async () => {
  const cache = createBoundedPromiseCache<string, number>(10);
  const failed = cache.get("a", 1, () => Promise.reject(new Error("no")));
  await expect(failed).rejects.toThrow("no");
  expect(cache.keys()).toEqual([]);
  expect(cache.get("a", 1, async () => 2)).not.toBe(failed);
});
