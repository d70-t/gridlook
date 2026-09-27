import {
  computed,
  onScopeDispose,
  reactive,
  ref,
  watch,
  type InjectionKey,
} from "vue";

import {
  SCALAR_BAKE_LIMITS,
  estimateScalarBake,
  scalarSourceCost,
  validateScalarBakeConfig,
  type TScalarBakeConfig,
  type TScalarBakeEstimate,
} from "./scalarBakePlan.ts";
import type { TPreparedScalarFrame } from "./scalarFrame.ts";
import type { TScalarGeometryCache } from "./scalarFrameMemory.ts";
import { compatibleScalarFrames } from "./scalarInterpolation.ts";
import {
  SCALAR_INTERPOLATION,
  createScalarTimeline,
  scalarInterpolationWeight,
  scalarPresentationCount,
  scalarPresentationFrame,
  type TScalarInterpolation,
} from "./scalarTimeline.ts";
import type { useScalarFrames } from "./useScalarFrames.ts";

import { isTimeCoordinate } from "@/lib/data/timeHandling.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { stopAnimation } from "@/ui/overlays/controls/useTimeAnimation.ts";

export const SCALAR_BAKE_PHASE = {
  EMPTY: "empty",
  ESTIMATING: "estimating",
  PLANNED: "planned",
  BAKING: "baking",
  READY: "ready",
  CANCELLING: "cancelling",
  ERROR: "error",
} as const;
type TScalarBakePhase =
  (typeof SCALAR_BAKE_PHASE)[keyof typeof SCALAR_BAKE_PHASE];
export type TPreparedAnimation = {
  frameCount: number;
  fps: number;
  signal: AbortSignal;
  seek: (index: number) => Promise<void>;
};
export type TScalarBakeHandle = ReturnType<typeof useScalarFrames>;

// eslint-disable-next-line max-lines-per-function
export function useScalarBake(
  getHandle: () => TScalarBakeHandle | null,
  getSource: () => TSources | undefined = () => undefined
) {
  const store = useGlobeControlStore();
  const phase = ref<TScalarBakePhase>(SCALAR_BAKE_PHASE.EMPTY);
  const message = ref("");
  const estimate = ref<TScalarBakeEstimate>();
  const completed = ref(0);
  const bounds = ref<{ low: number; high: number }>();
  const current = ref(0);
  const playing = ref(false);
  const exporting = ref(false);
  let exportController: AbortController | undefined;
  const fps = ref<number>(SCALAR_BAKE_LIMITS.DEFAULT_FPS);
  const elapsedSeconds = ref(0);
  const remainingSeconds = ref(0);
  const commitMs = ref(0);
  const interpolationMode = ref<TScalarInterpolation>(
    SCALAR_INTERPOLATION.ORIGINAL
  );
  const intermediateFrames = ref(4);
  const interpolationUnavailable = ref(
    "Estimate the animation to check interpolation support."
  );
  const unequalTimeGaps = ref(false);
  let timeline: ReturnType<typeof createScalarTimeline> | undefined;
  const frameCount = computed(() =>
    interpolationMode.value !== SCALAR_INTERPOLATION.ORIGINAL
      ? scalarPresentationCount(completed.value, intermediateFrames.value)
      : completed.value
  );
  const busy = computed(() =>
    [
      SCALAR_BAKE_PHASE.ESTIMATING,
      SCALAR_BAKE_PHASE.BAKING,
      SCALAR_BAKE_PHASE.CANCELLING,
    ].some((value) => value === phase.value)
  );
  const frames: TPreparedScalarFrame[] = [];
  const geometry: TScalarGeometryCache = new Map();
  const allocations = new Set<ArrayBufferLike>();
  let retainedBytes = 0;
  let controller: AbortController | undefined;
  let animationFrame: number | undefined;
  let nextFrameAt = 0;
  let playbackRevision = 0;
  let generation = 0;
  let seeking = false;
  let pendingSeek: Promise<void> | undefined;
  let seekRevision = 0;
  let job:
    | {
        config: TScalarBakeConfig;
        key: string;
        source: TSources | undefined;
        handle: TScalarBakeHandle;
        timeName: string;
        chunkConcurrency?: number;
        selection: Record<string, number>;
      }
    | undefined;

  const time = computed(() => {
    const index =
      store.varinfo?.dimRanges.findIndex((range, i) => {
        const info = store.varinfo?.dimInfo[i];
        return (
          range &&
          isTimeCoordinate(
            range.name,
            info && "attrs" in info ? info.attrs : {}
          )
        );
      }) ?? -1;
    const range = store.varinfo?.dimRanges[index];
    return range
      ? {
          ...range,
          index,
          selectedIndex: store.dimSlidersValues[index] ?? range.minBound,
        }
      : undefined;
  });
  const unavailable = computed(() => {
    if (
      !getHandle() ||
      !time.value ||
      time.value.maxBound <= time.value.minBound
    ) {
      return "Select a scalar variable with at least two timesteps.";
    }
    if (store.live) {
      return "Turn off Live mode before preparing a fixed time range.";
    }
    if (store.isStreamlineLayerEnabled() || store.isVolumeLayerEnabled()) {
      return "Turn off streamlines and volumes to prepare scalar animation. Static layers are included.";
    }
    return "";
  });
  const selectionKey = computed(() =>
    JSON.stringify({
      variable: store.varnameSelector,
      dimensions: store.varinfo?.dimRanges.map(
        (range) => range && [range.name, range.minBound, range.maxBound]
      ),
      indices: store.dimSlidersValues.filter(
        (_, index) => index !== time.value?.index
      ),
      projection: store.projectionMode,
      layers: store.layerStack,
      live: store.live,
    })
  );

  function pause() {
    playing.value = false;
    playbackRevision++;
    if (animationFrame !== undefined) {
      cancelAnimationFrame(animationFrame);
      animationFrame = undefined;
    }
  }
  function release() {
    frames.length = 0;
    timeline = undefined;
    unequalTimeGaps.value = false;
    interpolationUnavailable.value =
      "Estimate the animation to check interpolation support.";
    geometry.clear();
    allocations.clear();
    retainedBytes = 0;
    completed.value = 0;
    bounds.value = undefined;
    current.value = 0;
    elapsedSeconds.value = 0;
    remainingSeconds.value = 0;
    estimate.value = undefined;
    job = undefined;
  }
  function clear(reason = "") {
    pause();
    generation++;
    exportController?.abort();
    controller?.abort();
    release();
    message.value = reason;
    phase.value = busy.value
      ? SCALAR_BAKE_PHASE.CANCELLING
      : SCALAR_BAKE_PHASE.EMPTY;
  }
  function isCurrent(token: number) {
    return (
      generation === token &&
      !controller?.signal.aborted &&
      !!job &&
      job.handle === getHandle() &&
      job.source === getSource() &&
      job.key === selectionKey.value
    );
  }
  function retain(frame: TPreparedScalarFrame) {
    if (!frame.memory || !job) {
      throw new Error("Prepared frame memory is unavailable.");
    }
    let added = frame.memory.extraBytes;
    for (const buffer of frame.memory.buffers) {
      if (!allocations.has(buffer)) {
        added += buffer.byteLength;
      }
    }
    frame.memory.buffers.forEach((buffer) => allocations.add(buffer));
    retainedBytes += added;
    if (estimate.value) {
      estimate.value.peakBytes = Math.max(
        estimate.value.peakBytes,
        (retainedBytes + estimate.value.workingBytes) * 1.25
      );
    }
    if (
      frames.length &&
      !compatibleScalarFrames(frames[frames.length - 1], frame)
    ) {
      interpolationUnavailable.value =
        "The grid geometry changes between keyframes. Use original timesteps.";
    }
    // Each renderer computes decoded finite bounds while preparing the field.
    const { low, high } = frame.info.bounds;
    if (
      low !== undefined &&
      high !== undefined &&
      Number.isFinite(low) &&
      Number.isFinite(high) &&
      low <= high
    ) {
      bounds.value = {
        low: bounds.value ? Math.min(bounds.value.low, low) : low,
        high: bounds.value ? Math.max(bounds.value.high, high) : high,
      };
    }
    frames.push(frame);
    completed.value = frames.length;
  }
  async function prepare(index: number, token: number) {
    const active = job!;
    const frame = await active.handle.prepareScalarFrame({
      dimensionIndices: { ...active.selection, [active.timeName]: index },
      signal: controller!.signal,
      isCurrent: () => isCurrent(token),
      geometryCache: geometry,
      chunkConcurrency: active.chunkConcurrency,
    });
    if (!isCurrent(token)) {
      return;
    }
    if (!frame) {
      throw new Error(
        "The source changed or a timestep could not be prepared."
      );
    }
    return frame;
  }
  function finishCancelled() {
    if (phase.value === SCALAR_BAKE_PHASE.CANCELLING) {
      release();
      phase.value = SCALAR_BAKE_PHASE.EMPTY;
    }
  }
  function fail(error: unknown, token: number) {
    if (generation !== token || controller?.signal.aborted) {
      finishCancelled();
      return;
    }
    clear(error instanceof Error ? error.message : String(error));
    phase.value = SCALAR_BAKE_PHASE.ERROR;
  }

  // eslint-disable-next-line max-lines-per-function
  async function plan(config: TScalarBakeConfig) {
    if (busy.value || exporting.value) {
      return;
    }
    clear();
    const token = generation;
    try {
      if (unavailable.value) {
        throw new Error(unavailable.value);
      }
      if (store.loading) {
        throw new Error("Wait for the current timestep to finish loading.");
      }
      const range = time.value!;
      validateScalarBakeConfig(config, range.minBound, range.maxBound);
      stopAnimation();
      const selection: Record<string, number> = {};
      store.varinfo!.dimRanges.forEach((dim, index) => {
        if (dim && index !== range.index) {
          selection[dim.name] = store.dimSlidersValues[index] ?? 0;
        }
      });
      job = {
        config: { ...config },
        key: selectionKey.value,
        source: getSource(),
        handle: getHandle()!,
        timeName: range.name,
        selection,
      };
      controller = new AbortController();
      phase.value = SCALAR_BAKE_PHASE.ESTIMATING;
      const layout = await job.handle.getScalarFrameLayout();
      if (!isCurrent(token)) {
        finishCancelled();
        return;
      }
      if (!layout) {
        throw new Error("Source metadata is unavailable.");
      }
      const source = scalarSourceCost(
        layout,
        store.varinfo!.dimRanges.map((dim) => dim === null),
        range.index,
        config,
        job.source?.zarr_format !== ZARR_FORMAT.NETCDF
      );
      job.chunkConcurrency = source.chunkConcurrency;
      const frame = await prepare(config.start, token);
      if (!frame) {
        finishCancelled();
        return;
      }
      estimate.value = estimateScalarBake(
        frame,
        geometry,
        source,
        config.end - config.start + 1
      );
      retain(frame);
      try {
        timeline = createScalarTimeline(
          frame,
          range.index,
          config.start,
          config.end
        );
        unequalTimeGaps.value = timeline.unequalGaps;
        interpolationUnavailable.value = frame.interpolation
          ? ""
          : "This renderer does not provide interpolatable scalar frames.";
      } catch (error) {
        interpolationUnavailable.value =
          error instanceof Error ? error.message : String(error);
      }
      phase.value = SCALAR_BAKE_PHASE.PLANNED;
    } catch (error) {
      fail(error, token);
    }
  }

  async function bake() {
    if (phase.value !== SCALAR_BAKE_PHASE.PLANNED || !job || !estimate.value) {
      return;
    }
    const token = generation;
    const active = job;
    phase.value = SCALAR_BAKE_PHASE.BAKING;
    const start = performance.now();
    try {
      for (
        let index = active.config.start + 1;
        index <= active.config.end;
        index++
      ) {
        const frame = await prepare(index, token);
        if (!frame) {
          finishCancelled();
          return;
        }
        retain(frame);
        elapsedSeconds.value = (performance.now() - start) / 1000;
        remainingSeconds.value =
          (elapsedSeconds.value / (frames.length - 1)) *
          (estimate.value!.count - frames.length);
        estimate.value!.retainedBytes = retainedBytes;
        // Yield for progress/cancellation even when every source read is cached.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (!isCurrent(token)) {
          finishCancelled();
          return;
        }
      }
      phase.value = SCALAR_BAKE_PHASE.READY;
      if (interpolationUnavailable.value) {
        interpolationMode.value = SCALAR_INTERPOLATION.ORIGINAL;
      }
      await seek(0);
    } catch (error) {
      fail(error, token);
    }
  }

  function seek(index: number, forExport = false) {
    if (
      phase.value !== SCALAR_BAKE_PHASE.READY ||
      (exporting.value && !forExport) ||
      !Number.isInteger(index) ||
      index < 0 ||
      index >= frameCount.value
    ) {
      return Promise.resolve();
    }
    pendingSeek = displayFrame(index);
    return pendingSeek;
  }
  // eslint-disable-next-line max-lines-per-function
  async function displayFrame(index: number) {
    const token = generation;
    const revision = ++seekRevision;
    seeking = true;
    const start = performance.now();
    try {
      let committed = false;
      if (interpolationMode.value !== SCALAR_INTERPOLATION.ORIGINAL) {
        if (interpolationUnavailable.value || !timeline || !frameCount.value) {
          return;
        }
        const { first, next, alpha } = scalarPresentationFrame(
          index,
          frames.length,
          intermediateFrames.value
        );
        store.scalarAnimationBounds ??= { ...store.selection };
        committed =
          isCurrent(token) &&
          (await job!.handle.commitScalarFrame(frames[first], {
            next: frames[next],
            alpha: scalarInterpolationWeight(alpha, interpolationMode.value),
            timeIndex: time.value!.index,
            // Ease scalar values, while the timestamp advances through source time.
            label: timeline.label(first, alpha),
          }));
      } else {
        store.scalarAnimationBounds = undefined;
        committed =
          isCurrent(token) &&
          (await job!.handle.commitScalarFrame(frames[index]));
      }
      if (revision !== seekRevision || generation !== token) {
        return;
      }
      if (!committed) {
        if (generation === token) {
          clear("Settings changed; estimate the animation again.");
        }
        return;
      }
      if (isCurrent(token)) {
        current.value = index;
        commitMs.value = performance.now() - start;
      }
    } catch (error) {
      if (revision === seekRevision && generation === token) {
        fail(error, token);
      }
    } finally {
      if (revision === seekRevision) {
        seeking = false;
      }
    }
  }
  async function tick(timestamp: number) {
    animationFrame = undefined;
    if (!playing.value) {
      return;
    }
    if (current.value + 1 >= frameCount.value) {
      pause();
      return;
    }
    if (
      !Number.isFinite(fps.value) ||
      fps.value < 1 ||
      fps.value > SCALAR_BAKE_LIMITS.MAX_FPS
    ) {
      pause();
      return;
    }
    if (timestamp >= nextFrameAt) {
      const revision = playbackRevision;
      const token = generation;
      await seek(current.value + 1);
      if (
        !playing.value ||
        generation !== token ||
        playbackRevision !== revision
      ) {
        return;
      }
      if (current.value + 1 >= frameCount.value) {
        pause();
        return;
      }
      // Keep the cadence tied to display time, rather than adding commit time.
      // ponytail: Slow frames stretch playback; never burst through missed frames.
      nextFrameAt = Math.max(nextFrameAt + 1000 / fps.value, performance.now());
    }
    animationFrame = requestAnimationFrame(tick);
  }
  async function play() {
    if (
      phase.value !== SCALAR_BAKE_PHASE.READY ||
      seeking ||
      exporting.value ||
      frameCount.value < 2 ||
      (interpolationMode.value !== SCALAR_INTERPOLATION.ORIGINAL &&
        interpolationUnavailable.value)
    ) {
      return;
    }
    if (
      !Number.isFinite(fps.value) ||
      fps.value < 1 ||
      fps.value > SCALAR_BAKE_LIMITS.MAX_FPS
    ) {
      return;
    }
    const token = generation;
    pause();
    stopAnimation();
    if (current.value >= frameCount.value - 1) {
      await seek(0);
    }
    if (phase.value !== SCALAR_BAKE_PHASE.READY || generation !== token) {
      return;
    }
    playing.value = true;
    nextFrameAt = performance.now() + 1000 / fps.value;
    animationFrame = requestAnimationFrame(tick);
  }
  // Own the frame sequence for the duration of an export, including cancellation.
  // eslint-disable-next-line max-lines-per-function
  async function withPreparedFrames<T>(
    run: (session: TPreparedAnimation) => Promise<T>
  ) {
    if (
      phase.value !== SCALAR_BAKE_PHASE.READY ||
      exporting.value ||
      !frameCount.value
    ) {
      throw new Error("Wait for a prepared animation before exporting.");
    }
    pause();
    stopAnimation();
    const token = generation;
    let previous = current.value;
    const mode = interpolationMode.value;
    const steps = intermediateFrames.value;
    const sessionController = new AbortController();
    exportController = sessionController;
    exporting.value = true;
    const validate = () => {
      sessionController.signal.throwIfAborted();
      if (
        !isCurrent(token) ||
        mode !== interpolationMode.value ||
        steps !== intermediateFrames.value
      ) {
        throw new Error("Animation settings changed during export.");
      }
    };
    try {
      await pendingSeek;
      validate();
      previous = current.value;
      const result = await run({
        frameCount: frameCount.value,
        fps: fps.value,
        signal: sessionController.signal,
        seek: async (index) => {
          validate();
          await seek(index, true);
          validate();
          if (current.value !== index) {
            throw new Error("The animation frame could not be displayed.");
          }
        },
      });
      validate();
      return result;
    } finally {
      try {
        if (isCurrent(token) && phase.value === SCALAR_BAKE_PHASE.READY) {
          await seek(previous, true);
        }
      } finally {
        exporting.value = false;
        exportController = undefined;
      }
    }
  }
  function cancelExport() {
    exportController?.abort();
  }
  async function resetPlayback() {
    pause();
    await seek(0);
  }
  // One lifecycle watcher for the captured bake settings; camera/colormap changes remain interactive.
  watch(
    [getHandle, getSource, selectionKey],
    () => {
      if (job) {
        clear("Dataset or settings changed; estimate the animation again.");
      }
    },
    { flush: "sync" }
  );
  onScopeDispose(() => clear());
  return reactive({
    phase,
    message,
    estimate,
    completed,
    bounds,
    current,
    playing,
    fps,
    busy,
    time,
    unavailable,
    elapsedSeconds,
    remainingSeconds,
    commitMs,
    interpolationMode,
    intermediateFrames,
    interpolationUnavailable,
    unequalTimeGaps,
    frameCount,
    exporting,
    withPreparedFrames,
    cancelExport,
    resetPlayback,
    plan,
    bake,
    seek,
    play,
    pause,
    clear,
  });
}

export const SCALAR_BAKE_KEY: InjectionKey<ReturnType<typeof useScalarBake>> =
  Symbol("scalarBake");
