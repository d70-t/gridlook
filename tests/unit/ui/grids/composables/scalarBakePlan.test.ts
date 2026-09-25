import { expect, it } from "vitest";

import {
  estimateScalarBake,
  scalarBakeMemoryUsage,
  scalarSourceCost,
  validateScalarBakeConfig,
} from "@/ui/grids/composables/scalarBakePlan.ts";
import type { TPreparedScalarFrame } from "@/ui/grids/composables/scalarFrame.ts";
import {
  scalarFrameMemory,
  scalarMemoryBytes,
  shareScalarGeometry,
  shareScalarBuffers,
} from "@/ui/grids/composables/scalarFrameMemory.ts";

it("counts backing allocations once and shares only equal geometry", () => {
  const cache = new Map();
  const first = shareScalarGeometry(
    {
      batchIndex: 0,
      positionValues: new Float32Array([1, 2, 3]),
      dataValues: new Float32Array([5]),
    },
    cache
  );
  const second = shareScalarGeometry(
    {
      batchIndex: 0,
      positionValues: new Float32Array([1, 2, 3]),
      dataValues: new Float32Array([6]),
    },
    cache
  );
  expect(first.positionValues).toBe(second.positionValues);
  expect(first.dataValues).not.toBe(second.dataValues);
  const changed = shareScalarGeometry(
    { batchIndex: 0, positionValues: new Float32Array([1, 2, 4]) },
    cache
  );
  expect(changed.positionValues).not.toBe(first.positionValues);
  expect(
    scalarMemoryBytes(
      scalarFrameMemory(first, first.positionValues.subarray(1), [3, 4])
    )
  ).toBe(32);
});

it("estimates unique source chunks shared by multiple timesteps", () => {
  const cost = scalarSourceCost(
    { shape: [12, 2, 4], chunks: [3, 2, 2], bytesPerValue: 4 },
    [false, true, true],
    0,
    { start: 1, end: 5 }
  );
  expect(cost.uniqueChunks).toBe(4);
  expect(cost.decodedBytes).toBe(192);
  expect(cost.fetchMultiplier).toBe(2);
  const geometry = new Map();
  const batch = shareScalarGeometry(
    {
      batchIndex: 0,
      positionValues: new Float32Array(3),
      dataValues: new Float32Array(4),
    },
    geometry
  );
  const frame = {
    memory: scalarFrameMemory(batch),
    timing: { totalMs: 100, fetchMs: 80 },
  } as TPreparedScalarFrame;
  const estimate = estimateScalarBake(frame, geometry, cost, 5);
  expect(estimate.retainedBytes).toBe(12 + 16 * 5);
  expect(estimate.secondsLow).toBeCloseTo(0.13);
  expect(estimate.peakBytes).toBeGreaterThan(estimate.retainedBytes);
});

it.each([
  { start: -1, end: 2 },
  { start: 0, end: 4 },
  { start: 1, end: 1 },
  { start: 0.5, end: 2 },
])("rejects invalid bake inputs %j", (config) => {
  expect(() => validateScalarBakeConfig(config, 0, 3)).toThrow();
});

it("shares spatial hover buffers while preserving each timestep's values", () => {
  const cache = new Map();
  const first = shareScalarBuffers(
    "hover",
    {
      indexData: new Uint32Array([1, 2]).buffer,
      latitudes: new Float64Array([5, 6]),
      values: new Float32Array([10, 20]),
    },
    cache
  );
  const next = shareScalarBuffers(
    "hover",
    {
      indexData: new Uint32Array([1, 2]).buffer,
      latitudes: new Float64Array([5, 6]),
      values: new Float32Array([30, 40]),
    },
    cache
  );
  expect(next.indexData).toBe(first.indexData);
  expect(next.latitudes).toBe(first.latitudes);
  expect(next.values).not.toBe(first.values);
  const frame = {
    memory: scalarFrameMemory(undefined, first),
    timing: { fetchMs: 1, totalMs: 2 },
  } as TPreparedScalarFrame;
  const source = scalarSourceCost(
    { shape: [3, 2], chunks: [1, 2], bytesPerValue: 4 },
    [false, true],
    0,
    { start: 0, end: 2 }
  );
  expect(estimateScalarBake(frame, cache, source, 3).retainedBytes).toBe(
    24 + 8 * 3
  );
});

it("reserves one active DANRA chunk instead of six simultaneous decodes", () => {
  const source = scalarSourceCost(
    {
      shape: [96768, 14, 589, 789],
      chunks: [256, 1, 295, 263],
      bytesPerValue: 8,
    },
    [false, false, true, true],
    0,
    { start: 0, end: 59 }
  );
  const chunkBytes = 256 * 295 * 263 * 8;
  expect(source.uniqueChunks).toBe(6);
  expect(source.chunkConcurrency).toBe(1);
  expect(source.decodedBytes).toBe(chunkBytes * 6);
  expect(source.workingBytes).toBe(
    chunkBytes * 4 + 589 * 789 * 8 + chunkBytes * 6
  );
  expect(source.workingBytes).toBeLessThan(1600 * 1024 * 1024);
});

it("keeps the full decoding allowance for readers without the chunk queue", () => {
  const source = scalarSourceCost(
    { shape: [4, 6], chunks: [1, 2], bytesPerValue: 4 },
    [false, true],
    0,
    { start: 0, end: 2 },
    false
  );
  expect(source.chunkConcurrency).toBeUndefined();
  expect(source.workingBytes).toBe(24 * 4 + 6 * 8 + 9 * 8);
});

it("compares peak memory with the editable budget without clamping at 100%", () => {
  const gib = 1024 ** 3;
  expect(scalarBakeMemoryUsage(4 * gib, 8)).toBe(50);
  expect(scalarBakeMemoryUsage(16 * gib, 8)).toBe(200);
  expect(scalarBakeMemoryUsage(16 * gib, 128)).toBe(12.5);
  expect(scalarBakeMemoryUsage(0.25 * gib, 0.5)).toBe(50);
});

it.each([undefined, "", "128", NaN, Infinity, Number.MAX_VALUE, 0, -1])(
  "omits the comparison for a missing or invalid budget %j",
  (budget) => {
    expect(scalarBakeMemoryUsage(200 * 1024 ** 3, budget)).toBeUndefined();
  }
);
