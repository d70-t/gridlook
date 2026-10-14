import {
  computed,
  onScopeDispose,
  reactive,
  ref,
  watch,
  type InjectionKey,
} from "vue";

import {
  extendPathlineEstimate,
  planPathlinePreparation,
  samePathlineGrid,
  type TPathlinePreparation,
} from "./pathlinePreparation.ts";
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
import type { usePathlineLayer } from "./usePathlineLayer.ts";
import type { useScalarFrames } from "./useScalarFrames.ts";

import {
  samplePathlineTime,
  type TPathlineField,
} from "@/lib/data/pathlineField.ts";
import {
  planPathlineTrajectories,
  pathlinePositionAt,
  type TPathlineTrajectories,
  type TPathlineConfig,
} from "@/lib/data/pathlineTrajectories.ts";
import {
  integratePathlinesInWorkers,
  pathlineWorkerCount,
  pathlineWorkerLimit,
} from "@/lib/data/pathlineWorkers.ts";
import { pathlineWorkerGrid } from "@/lib/data/pathlineWorkerTask.ts";
import { isTimeCoordinate, timeUnitSeconds } from "@/lib/data/timeHandling.ts";
import { resolveVectorVariablePair } from "@/lib/data/vectorField.ts";
import type { TVectorMagnitudeData } from "@/lib/data/vectorMagnitude.ts";
import {
  PATHLINE_DISPLAY,
  type TPathlineDisplay,
} from "@/lib/layers/pathlinePreview.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";
import {
  estimateVolumeFrames,
  validateVolumeFrameTimes,
} from "@/lib/volume/volumeFrame.ts";
import {
  createVolumeInterpolation,
  type TVolumeInterpolation,
  type TVolumePresentation,
} from "@/lib/volume/volumeInterpolation.ts";
import {
  BUILTIN_LAYER_IDS,
  LAYER_OPACITY,
  useGlobeControlStore,
} from "@/store/store.ts";
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
export type TScalarBakeHandle = ReturnType<typeof useScalarFrames> & {
  pathlineDisplay?: ReturnType<typeof usePathlineLayer>;
};

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
  const includeVelocity = ref(false);
  let volumes: TVolumeInterpolation | undefined;
  const hasVolumes = ref(false);
  let velocity: TPathlinePreparation | undefined;
  const velocityFields: TPathlineField[] = [];
  let trajectories: TPathlineTrajectories | undefined;
  const trajectoryProgress = ref(0);
  const hasPathlines = ref(false);
  const fadeSeconds = ref(1);
  const particleSize = ref(4);
  const particleDisplayMode = ref<TPathlineDisplay>(PATHLINE_DISPLAY.PREVIEW);
  const particleOpacity = computed({
    get: () =>
      store.layerStack.find(
        (layer) => layer.id === BUILTIN_LAYER_IDS.STREAMLINES
      )?.opacity ?? LAYER_OPACITY.MAX,
    set: (opacity: number) =>
      store.updateLayerOpacity(BUILTIN_LAYER_IDS.STREAMLINES, opacity),
  });
  let displayedSeconds = 0;
  const pathlinePlaybackError = computed(() => {
    if (!hasPathlines.value) {
      return "";
    }
    if (!Number.isFinite(fadeSeconds.value) || fadeSeconds.value <= 0) {
      return "Enter a positive fade duration.";
    }
    if (!Number.isFinite(particleSize.value) || particleSize.value <= 0) {
      return "Enter a positive particle size.";
    }
    return "";
  });
  const pathlinesEnabled = computed(() => store.isStreamlineLayerEnabled());
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
        prepareVolume: boolean;
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
    if (store.isVolumeLayerEnabled()) {
      if (!store.volumeAvailable) {
        return "This renderer does not support volumes. Turn off the volume layer to prepare animation.";
      }
      if (!store.volumeSelections.length) {
        return "Choose a volume variable before preparing animation.";
      }
    }
    if (pathlinesEnabled.value && !getHandle()?.pathlineDisplay) {
      return "This renderer does not support prepared pathlines.";
    }
    return "";
  });
  const selectionKey = computed(() =>
    JSON.stringify({
      inputRevision: store.animationInputRevision,
      variable: store.varnameSelector,
      dimensions: store.varinfo?.dimRanges.map(
        (range) => range && [range.name, range.minBound, range.maxBound]
      ),
      indices: store.dimSlidersValues.filter(
        (_, index) => index !== time.value?.index
      ),
      projection: store.projectionMode,
      // Particle/volume opacity is display-only; visibility and order still
      // belong to the captured preparation settings.
      layers: store.layerStack.map((layer) =>
        layer.id === BUILTIN_LAYER_IDS.STREAMLINES ||
        layer.id === BUILTIN_LAYER_IDS.VOLUME
          ? { ...layer, opacity: undefined }
          : layer
      ),
      live: store.live,
      volumeVariables: store.isVolumeLayerEnabled()
        ? store.volumeSelections.map((selection) => selection.variable)
        : undefined,
      velocitySelection: includeVelocity.value
        ? [
            store.streamlineSelection,
            store.streamlineLevelIndex,
            store.streamlineMagnitudeRequested,
          ]
        : undefined,
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
    job?.handle.pathlineDisplay?.clear();
    if (store.pathlineAnimationActive) {
      store.streamlineMagnitudeDisplayed =
        store.streamlineMagnitudeRequested &&
        store.streamlineMagnitudeDerivable;
      store.pathlineAnimationActive = false;
    }
    hasPathlines.value = false;
    frames.length = 0;
    volumes = undefined;
    hasVolumes.value = false;
    velocity = undefined;
    velocityFields.length = 0;
    trajectories = undefined;
    trajectoryProgress.value = 0;
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
    if (job.prepareVolume) {
      if (!frame.volume) {
        throw new Error("An enabled volume could not be prepared.");
      }
      // Validate as frames arrive; fix normalization across the full range before playback.
      if (frames.length) {
        createVolumeInterpolation([frames[0].volume!, frame.volume]);
      }
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
  async function prepare(
    index: number,
    token: number,
    magnitude?: TVectorMagnitudeData,
    prepareVolume = job!.prepareVolume
  ) {
    const active = job!;
    const frame = await active.handle.prepareScalarFrame({
      dimensionIndices: { ...active.selection, [active.timeName]: index },
      signal: controller!.signal,
      isCurrent: () => isCurrent(token),
      geometryCache: geometry,
      chunkConcurrency: active.chunkConcurrency,
      magnitude,
      prepareVolume,
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
  function attachVelocity(
    frame: TPreparedScalarFrame,
    prepared: Awaited<ReturnType<TPathlinePreparation["prepare"]>>
  ) {
    const active = velocity!;
    if (!samePathlineGrid(active.context, frame.pathlineGrid)) {
      throw new Error(
        "The grid changes between velocity keyframes; prepare a fixed grid."
      );
    }
    const first = velocityFields.length === 0;
    const memory = frame.memory!;
    frame.memory = {
      buffers: [
        ...new Set([
          ...memory.buffers,
          ...active.sharedMemory.buffers,
          ...prepared.memory.buffers,
        ]),
      ],
      extraBytes:
        memory.extraBytes +
        prepared.memory.extraBytes +
        (first ? active.sharedMemory.extraBytes : 0),
      gpuBytes: memory.gpuBytes,
    };
    velocityFields.push(prepared.field);
    return prepared;
  }
  function sampleVelocity(
    latitude: number,
    longitude: number,
    seconds: number
  ) {
    if (
      phase.value !== SCALAR_BAKE_PHASE.READY ||
      !velocity ||
      !isCurrent(generation)
    ) {
      return;
    }
    return samplePathlineTime(
      velocity.times,
      velocityFields,
      latitude,
      longitude,
      seconds
    );
  }
  function trajectoryInputs() {
    const active = velocity!;
    return {
      sourceTimes: active.times,
      sample: (lat: number, lon: number, time: number) =>
        samplePathlineTime(active.times, velocityFields, lat, lon, time),
      seedPosition: active.seedPosition,
      surface: active.surface,
    };
  }
  // eslint-disable-next-line max-lines-per-function
  async function estimateTrajectories(token: number) {
    const config = job!.config.pathlines;
    if (!config) {
      return;
    }
    const inputs = trajectoryInputs();
    const planned = planPathlineTrajectories(inputs.sourceTimes, config);
    estimate.value!.trajectoryBytes = planned.bytes;
    const display = job!.handle.pathlineDisplay?.estimate(
      inputs.sourceTimes,
      config
    );
    estimate.value!.pathlineDisplayBytes = display?.cpuBytes ?? 0;
    estimate.value!.pathlinePreviewBytes = display?.preview?.bytes ?? 0;
    if (!display?.preview) {
      particleDisplayMode.value = PATHLINE_DISPLAY.TRAJECTORY;
    }
    estimate.value!.retainedBytes += planned.bytes + (display?.cpuBytes ?? 0);
    estimate.value!.gpuBytes += display?.gpuBytes ?? 0;
    const workers = pathlineWorkerCount(config);
    // Each worker clones all source fields and rebuilds the same native index.
    // During merging, the final arrays coexist with transferred worker results.
    let geometryBytes = velocity!.sharedMemory.extraBytes;
    for (const buffer of new Set(velocity!.sharedMemory.buffers)) {
      geometryBytes += buffer.byteLength;
    }
    const values = velocityFields[0].values;
    const fieldBytes = values.u.buffer.byteLength + values.v.buffer.byteLength;
    const workerBytes =
      workers * (geometryBytes + fieldBytes * inputs.sourceTimes.length);
    estimate.value!.pathlineWorkerBytes = workerBytes;
    estimate.value!.workingBytes +=
      (display?.workingBytes ?? 0) +
      workerBytes +
      (workers > 1 ? planned.bytes : 0);
    estimate.value!.peakBytes =
      (estimate.value!.retainedBytes + estimate.value!.workingBytes) * 1.25;
    const sampleCount = Math.min(config.particleCount, 256);
    const duration = Math.min(
      config.sampleSeconds * 4,
      inputs.sourceTimes[1] - inputs.sourceTimes[0]
    );
    const started = performance.now();
    let computeMs = 0;
    // Use the same worker solver as preparation. Scale only measured integration
    // time, excluding imports, index construction, warmup and main-thread yields.
    const first = velocityFields[0].values;
    await integratePathlinesInWorkers(
      {
        grid: pathlineWorkerGrid(velocity!.context.grid),
        times: [0, duration],
        fields: [first, first],
      },
      { ...config, particleCount: sampleCount, workerCount: 1 },
      {
        signal: controller!.signal,
        isCurrent: () => isCurrent(token),
        warmup: true,
        onTiming: (ms) => {
          computeMs = ms;
        },
      }
    );
    if (!isCurrent(token)) {
      return;
    }
    const ms =
      (((Math.max(1, computeMs) * config.particleCount) / sampleCount) *
        planned.duration) /
      duration;
    // Approximate parallel efficiency; progress replaces this calibration during
    // integration. Index construction/startup and memory bandwidth still cost time.
    const speedup = 1 + (workers - 1) * 0.7;
    const setupMs = Math.max(0, performance.now() - started - computeMs);
    estimate.value!.secondsLow += ms / speedup / 2000 + setupMs / 1000;
    estimate.value!.secondsHigh += ms / speedup / 500 + setupMs / 500;
  }
  async function prepareTrajectories(token: number) {
    const config = job!.config.pathlines;
    if (!config) {
      return;
    }
    const started = performance.now();
    retainedBytes += estimate.value!.trajectoryBytes!;
    estimate.value!.retainedBytes = Math.max(
      estimate.value!.retainedBytes,
      retainedBytes
    );
    const prepared = await integratePathlinesInWorkers(
      {
        grid: pathlineWorkerGrid(velocity!.context.grid),
        times: velocity!.times,
        fields: velocityFields.map((field) => field.values),
      },
      config,
      {
        signal: controller!.signal,
        isCurrent: () => isCurrent(token),
        onProgress: (done, total) => {
          if (isCurrent(token)) {
            trajectoryProgress.value = done / total;
            if (done) {
              remainingSeconds.value =
                ((performance.now() - started) / 1000 / done) * (total - done);
            }
          }
        },
      }
    );
    if (isCurrent(token)) {
      trajectories = prepared;
      await job!.handle.pathlineDisplay?.install(
        prepared,
        config,
        () => isCurrent(token),
        velocity!.times
      );
      if (!isCurrent(token)) {
        return;
      }
      retainedBytes += estimate.value!.pathlineDisplayBytes ?? 0;
      estimate.value!.retainedBytes = Math.max(
        estimate.value!.retainedBytes,
        retainedBytes
      );
    }
  }
  function refreshPathlines() {
    if (pathlinePlaybackError.value) {
      pause();
      return;
    }
    if (
      phase.value === SCALAR_BAKE_PHASE.READY &&
      isCurrent(generation) &&
      trajectories
    ) {
      job!.handle.pathlineDisplay?.seek(
        displayedSeconds,
        fadeSeconds.value,
        particleSize.value,
        exporting.value
          ? PATHLINE_DISPLAY.TRAJECTORY
          : particleDisplayMode.value
      );
    }
  }
  function defaultPathlineConfig(start: number, end: number): TPathlineConfig {
    const coordinate = store.varinfo?.dimInfo[time.value?.index ?? -1];
    let gap = Infinity;
    if (coordinate && "values" in coordinate) {
      const unit = timeUnitSeconds(coordinate.attrs?.units);
      if (unit) {
        for (let i = start; i < end && i + 1 < coordinate.values.length; i++) {
          const dt =
            (Number(coordinate.values[i + 1]) - Number(coordinate.values[i])) *
            unit;
          if (dt > 0 && Number.isFinite(dt)) {
            gap = Math.min(gap, dt);
          }
        }
      }
    }
    const sampleSeconds = Number.isFinite(gap) ? gap / 10 : 3600;
    return {
      particleCount: 4096,
      workerCount: Math.min(4, Math.max(1, pathlineWorkerLimit() - 1)),
      randomSeed: 42,
      sampleSeconds,
      maxStepSeconds: Math.min(sampleSeconds, 3600),
      maxStepMetres: 10000,
      errorToleranceMetres: 50,
    };
  }
  function pathlinePosition(particle: number, seconds: number) {
    return phase.value === SCALAR_BAKE_PHASE.READY &&
      trajectories &&
      isCurrent(generation)
      ? pathlinePositionAt(trajectories, particle, seconds)
      : undefined;
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
    config = {
      ...config,
      pathlines: config.pathlines
        ? { ...config.pathlines }
        : pathlinesEnabled.value
          ? defaultPathlineConfig(config.start, config.end)
          : undefined,
    };
    includeVelocity.value = !!(config.prepareVelocity || config.pathlines);
    const token = generation;
    try {
      if (unavailable.value) {
        throw new Error(unavailable.value);
      }
      if (config.pathlines) {
        pathlineWorkerCount(config.pathlines);
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
        prepareVolume: store.isVolumeLayerEnabled(),
      };
      hasVolumes.value = job.prepareVolume;
      hasPathlines.value = !!config.pathlines;
      if (config.pathlines) {
        fadeSeconds.value = config.pathlines.sampleSeconds * 4;
        store.pathlineAnimationActive = true;
      }
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
      // A magnitude background needs a second scalar preparation. Defer the
      // volume until then so calibration fetches/builds it only once.
      let frame = await prepare(
        config.start,
        token,
        undefined,
        job.prepareVolume &&
          !(config.pathlines && store.streamlineMagnitudeRequested)
      );
      if (!frame) {
        finishCancelled();
        return;
      }
      let prepared:
        Awaited<ReturnType<TPathlinePreparation["prepare"]>> | undefined;
      if (includeVelocity.value) {
        const pair = resolveVectorVariablePair(
          Object.keys(job.source?.levels[0]?.datasources ?? {}),
          store.varnameSelector,
          store.streamlineSelection,
          pathlinesEnabled.value ? store.streamlinePair : undefined
        );
        if (!pair || !job.source) {
          throw new Error(
            "Choose compatible horizontal velocity components before preparing pathlines."
          );
        }
        velocity = await planPathlinePreparation({
          sources: job.source,
          pair,
          levelIndex: store.streamlineLevelIndex,
          timeName: range.name,
          timeDimension: range.index,
          config,
          frame,
          selection,
          isCurrent: () => isCurrent(token),
        });
        if (!isCurrent(token)) {
          finishCancelled();
          return;
        }
        prepared = await velocity.prepare(
          config.start,
          !!config.pathlines && store.streamlineMagnitudeRequested
        );
        if (!isCurrent(token)) {
          finishCancelled();
          return;
        }
        if (prepared.magnitude) {
          frame = await prepare(config.start, token, prepared.magnitude);
          if (!frame) {
            finishCancelled();
            return;
          }
        }
      }
      if (frame.volume) {
        const axis = frame.info.dimInfo[range.index];
        if (!axis || !("values" in axis) || !axis.values) {
          throw new Error(
            "Scalar timestamps are unavailable for volume animation."
          );
        }
        await validateVolumeFrameTimes(
          frame.volume.plan,
          {
            values: axis.values,
            attrs: axis.attrs ?? {},
            variable: store.varnameSelector,
            dimension: range.name,
          },
          config,
          { isCurrent: () => isCurrent(token) }
        );
        if (!isCurrent(token)) {
          finishCancelled();
          return;
        }
      }
      estimate.value = estimateScalarBake(
        frame,
        geometry,
        source,
        config.end - config.start + 1,
        frame.volume
          ? estimateVolumeFrames(frame.volume, {
              dimension: range.name,
              start: config.start,
              end: config.end,
            })
          : undefined
      );
      if (prepared && velocity) {
        const scalarBuffers = new Set(frame.memory!.buffers);
        attachVelocity(frame, prepared);
        extendPathlineEstimate(
          estimate.value,
          velocity,
          prepared,
          scalarBuffers
        );
        await estimateTrajectories(token);
        if (!isCurrent(token)) {
          finishCancelled();
          return;
        }
      }
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

  // eslint-disable-next-line max-lines-per-function
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
        const prepared = await velocity?.prepare(
          index,
          !!active.config.pathlines && store.streamlineMagnitudeRequested
        );
        if (!isCurrent(token)) {
          finishCancelled();
          return;
        }
        const frame = await prepare(index, token, prepared?.magnitude);
        if (!frame) {
          finishCancelled();
          return;
        }
        if (prepared) {
          attachVelocity(frame, prepared);
        }
        retain(frame);
        elapsedSeconds.value = (performance.now() - start) / 1000;
        remainingSeconds.value =
          (elapsedSeconds.value / (frames.length - 1)) *
          (estimate.value!.count - frames.length);
        estimate.value!.retainedBytes = Math.max(
          estimate.value!.retainedBytes,
          retainedBytes
        );
        // Yield for progress/cancellation even when every source read is cached.
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        if (!isCurrent(token)) {
          finishCancelled();
          return;
        }
      }
      if (active.prepareVolume) {
        volumes = createVolumeInterpolation(
          frames.map((frame) => frame.volume!)
        );
      }
      await prepareTrajectories(token);
      if (!isCurrent(token)) {
        finishCancelled();
        return;
      }
      elapsedSeconds.value = (performance.now() - start) / 1000;
      remainingSeconds.value = 0;
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
    if (pathlinePlaybackError.value) {
      pause();
      return Promise.resolve();
    }
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
  async function displayFrame(index: number, forExport = exporting.value) {
    const token = generation;
    const revision = ++seekRevision;
    seeking = true;
    const start = performance.now();
    try {
      let committed = false;
      const volumePresentation = (
        first: number,
        next: number,
        alpha: number
      ): TVolumePresentation | undefined =>
        volumes
          ? {
              sequence: volumes,
              first,
              next,
              alpha,
              forExport,
            }
          : undefined;
      if (interpolationMode.value !== SCALAR_INTERPOLATION.ORIGINAL) {
        if (interpolationUnavailable.value || !timeline || !frameCount.value) {
          return;
        }
        const { first, next, alpha } = scalarPresentationFrame(
          index,
          frames.length,
          intermediateFrames.value
        );
        const weight = scalarInterpolationWeight(
          alpha,
          interpolationMode.value
        );
        if (velocity) {
          displayedSeconds =
            velocity.times[first] * (1 - alpha) + velocity.times[next] * alpha;
        }
        store.scalarAnimationBounds ??= { ...store.selection };
        committed =
          isCurrent(token) &&
          (await job!.handle.commitScalarFrame(
            frames[first],
            {
              next: frames[next],
              alpha: weight,
              timeIndex: time.value!.index,
              label: timeline.label(first, alpha),
            },
            volumePresentation(first, next, weight)
          ));
      } else {
        if (velocity) {
          displayedSeconds = velocity.times[index];
        }
        store.scalarAnimationBounds = undefined;
        committed =
          isCurrent(token) &&
          (await job!.handle.commitScalarFrame(
            frames[index],
            undefined,
            volumePresentation(index, index, 0)
          ));
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
        refreshPathlines();
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
    if (pathlinePlaybackError.value) {
      return;
    }
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
    if (pathlinePlaybackError.value) {
      throw new Error(pathlinePlaybackError.value);
    }
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
    const fade = fadeSeconds.value;
    const size = particleSize.value;
    const opacity = particleOpacity.value;
    const volumeAppearance = () =>
      JSON.stringify([
        store.volumeSelections,
        store.layerStack.find((layer) => layer.id === BUILTIN_LAYER_IDS.VOLUME)
          ?.opacity,
      ]);
    const appearance = volumeAppearance();
    const sessionController = new AbortController();
    exportController = sessionController;
    exporting.value = true;
    const validate = () => {
      sessionController.signal.throwIfAborted();
      if (
        !isCurrent(token) ||
        mode !== interpolationMode.value ||
        steps !== intermediateFrames.value ||
        fade !== fadeSeconds.value ||
        size !== particleSize.value ||
        opacity !== particleOpacity.value ||
        (hasVolumes.value && appearance !== volumeAppearance())
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
        if (
          isCurrent(token) &&
          phase.value === SCALAR_BAKE_PHASE.READY &&
          previous < frameCount.value
        ) {
          // Restore preview quality while the export still owns the frame sequence.
          pendingSeek = displayFrame(previous, false);
          await pendingSeek;
        }
      } finally {
        exporting.value = false;
        exportController = undefined;
        refreshPathlines();
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
    sampleVelocity,
    pathlinePosition,
    trajectoryProgress,
    pathlinesEnabled,
    hasPathlines,
    hasVolumes,
    fadeSeconds,
    particleSize,
    particleDisplayMode,
    particleOpacity,
    pathlinePlaybackError,
    defaultPathlineConfig,
    refreshPathlines,
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
