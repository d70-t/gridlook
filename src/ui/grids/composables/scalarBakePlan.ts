import type {
  TPreparedScalarFrame,
  TScalarFrameLayout,
} from "./scalarFrame.ts";
import {
  scalarMemoryBytes,
  type TScalarGeometryCache,
} from "./scalarFrameMemory.ts";

import { scalarChunkConcurrency } from "@/lib/grids/gridDataQueue.ts";

export const SCALAR_BAKE_LIMITS = {
  GIB: 1024 ** 3,
  DEFAULT_MEMORY_GIB: 8,
  MAX_FRAMES: 10000,
  DEFAULT_FPS: 30,
  MAX_FPS: 60,
} as const;

export type TScalarBakeConfig = {
  start: number;
  end: number;
  /** P1 preparation API; pathline display is a separate milestone. */
  prepareVelocity?: boolean;
};
export type TScalarBakeEstimate = {
  count: number;
  retainedBytes: number;
  peakBytes: number;
  gpuBytes: number;
  workingBytes: number;
  sourceWorkingBytes: number;
  vectorBytes?: number;
  trajectoryBytes?: number;
  chunkConcurrency?: number;
  uniqueChunks: number;
  decodedBytes: number;
  secondsLow: number;
  secondsHigh: number;
};

export function validateScalarBakeConfig(
  config: TScalarBakeConfig,
  min: number,
  max: number
) {
  const { start, end } = config;
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < min ||
    end > max ||
    end <= start
  ) {
    throw new Error(
      "Choose at least two source timesteps within the available range."
    );
  }
  if (end - start + 1 > SCALAR_BAKE_LIMITS.MAX_FRAMES) {
    throw new Error(
      `Choose at most ${SCALAR_BAKE_LIMITS.MAX_FRAMES} keyframes per animation.`
    );
  }
}

export function scalarBakeMemoryUsage(peakBytes: number, budgetGiB: unknown) {
  if (
    typeof budgetGiB !== "number" ||
    !Number.isFinite(budgetGiB * SCALAR_BAKE_LIMITS.GIB) ||
    budgetGiB <= 0
  ) {
    return undefined;
  }
  return (peakBytes / (budgetGiB * SCALAR_BAKE_LIMITS.GIB)) * 100;
}

export function scalarSourceCost(
  layout: TScalarFrameLayout,
  spatial: boolean[],
  time: number,
  config: TScalarBakeConfig,
  boundedReads = true
) {
  let sliceValues = 1;
  let chunksPerStep = 1;
  let chunkValues = 1;
  for (let i = 0; i < layout.shape.length; i++) {
    const size = layout.shape[i];
    const chunk = layout.chunks[i];
    if (
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      !Number.isSafeInteger(chunk) ||
      chunk <= 0
    ) {
      throw new Error("This source does not provide usable chunk metadata.");
    }
    chunkValues *= chunk;
    if (spatial[i]) {
      sliceValues *= size;
      chunksPerStep *= Math.ceil(size / chunk);
    }
  }
  const timeChunks =
    Math.floor(config.end / layout.chunks[time]) -
    Math.floor(config.start / layout.chunks[time]) +
    1;
  const chunkBytes = chunkValues * layout.bytesPerValue;
  const decodedPerStep = chunksPerStep * chunkBytes;
  const chunkConcurrency = boundedReads
    ? Math.min(chunksPerStep, scalarChunkConcurrency(chunkBytes))
    : undefined;
  // ponytail: reserve whole selected chunks and worker copies, not browser heap readings.
  // Refine this upper estimate with byte-budgeted source caches if measurements warrant it.
  return {
    chunkConcurrency,
    uniqueChunks: chunksPerStep * timeChunks,
    decodedBytes: decodedPerStep * timeChunks,
    fetchMultiplier: timeChunks,
    // The existing source LRU may hold two generations of 512 compressed chunks.
    // Decoded sizes are a conservative proxy; codec overhead/cache hits are unknown.
    workingBytes:
      chunkBytes * (chunkConcurrency ?? chunksPerStep) * 4 +
      sliceValues * 8 +
      Math.min(chunksPerStep * timeChunks, 1024) *
        chunkValues *
        layout.bytesPerValue,
  };
}

export function estimateScalarBake(
  frame: TPreparedScalarFrame,
  geometry: TScalarGeometryCache,
  source: ReturnType<typeof scalarSourceCost>,
  count: number
): TScalarBakeEstimate {
  if (!frame.memory || !frame.timing) {
    throw new Error("This renderer did not report preparation resources.");
  }
  const shared = new Set(
    [...geometry.values()].map((value) =>
      value instanceof ArrayBuffer ? value : value.buffer
    )
  );
  let sharedBytes = 0;
  for (const buffer of frame.memory.buffers) {
    if (shared.has(buffer)) {
      sharedBytes += buffer.byteLength;
    }
  }
  const sampleBytes = scalarMemoryBytes(frame.memory);
  const retainedBytes = sharedBytes + (sampleBytes - sharedBytes) * count;
  const workingBytes =
    source.workingBytes + sampleBytes * 2 + frame.memory.gpuBytes * 2;
  const gpuBytes = frame.memory.gpuBytes * 2;
  const prepareMs = Math.max(0, frame.timing.totalMs - frame.timing.fetchMs);
  const sharedFetchMs = frame.timing.fetchMs * source.fetchMultiplier;
  return {
    count,
    retainedBytes,
    workingBytes,
    sourceWorkingBytes: source.workingBytes,
    chunkConcurrency: source.chunkConcurrency,
    gpuBytes,
    peakBytes: (retainedBytes + workingBytes) * 1.25,
    uniqueChunks: source.uniqueChunks,
    decodedBytes: source.decodedBytes,
    secondsLow: (prepareMs * count + sharedFetchMs) / 2000,
    secondsHigh: (frame.timing.totalMs * count * 2) / 1000,
  };
}
