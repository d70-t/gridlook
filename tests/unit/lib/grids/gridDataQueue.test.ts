import { expect, it } from "vitest";

import {
  createGridDataQueue,
  scalarChunkConcurrency,
} from "@/lib/grids/gridDataQueue.ts";

it("bounds concurrent chunk decodes and reports completed work", async () => {
  const progress: number[] = [];
  const queue = createGridDataQueue(2, (done) => progress.push(done));
  let active = 0;
  let peak = 0;
  for (let i = 0; i < 6; i++) {
    queue.add(async () => {
      active++;
      peak = Math.max(peak, active);
      await new Promise((resolve) => setTimeout(resolve, 0));
      active--;
    });
  }
  await queue.onIdle();
  expect(peak).toBe(2);
  expect(active).toBe(0);
  expect(progress).toEqual([0, 1, 2, 3, 4, 5, 6]);
  expect(scalarChunkConcurrency(152 * 1024 * 1024)).toBe(1);
  expect(scalarChunkConcurrency(1024 * 1024)).toBe(4);
});

it("waits for running decodes after failure and does not start queued work", async () => {
  const queue = createGridDataQueue(2);
  const started: number[] = [];
  let finished = false;
  queue.add(async () => {
    started.push(0);
    throw new Error("decode failed");
  });
  queue.add(async () => {
    started.push(1);
    await new Promise((resolve) => setTimeout(resolve, 0));
    finished = true;
  });
  queue.add(async () => {
    started.push(2);
  });
  await expect(queue.onIdle()).rejects.toThrow("decode failed");
  expect(started).toEqual([0, 1]);
  expect(finished).toBe(true);
  expect(() => createGridDataQueue(0)).toThrow();
});
