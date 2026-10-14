import type * as THREE from "three";
import {
  onMounted,
  onScopeDispose,
  watch,
  type ComputedRef,
  type Ref,
} from "vue";

import {
  getMax3DTextureSize,
  VolumeLayer,
  VOLUME_RENDER_QUALITY,
  type TVolumeRenderQuality,
} from "@/lib/layers/volumeLayer.ts";
import type { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { assertVolumeCurrent } from "@/lib/volume/volumeData.ts";
import {
  planVolumeFrame,
  prepareVolumeFrame,
  type TVolumeContext,
  type TVolumeFrameOptions,
  type TPreparedVolumeFrame,
} from "@/lib/volume/volumeFrame.ts";
import {
  createVolumeInterpolation,
  type TVolumeInterpolation,
} from "@/lib/volume/volumeInterpolation.ts";
import { terminateVolumeTextureWorker } from "@/lib/volume/volumeTextureWorkerClient.ts";
import {
  BUILTIN_LAYER_IDS,
  LAYER_OPACITY,
  useGlobeControlStore,
} from "@/store/store.ts";
import { useLog } from "@/ui/common/useLog.ts";

export type { TVolumeContext } from "@/lib/volume/volumeFrame.ts";

type TOptions = {
  getDatasources: () => TSources | undefined;
  getScene: () => THREE.Scene | undefined;
  getRenderer: () => THREE.WebGLRenderer | undefined;
  redraw: () => void;
  projectionHelper: ComputedRef<ProjectionHelper>;
  isSceneInMotion: Ref<boolean>;
  onProjectionChange: (callback: () => void) => void;
  onMotionStateChange: (callback: () => void) => void;
};

function renderOrder(store: ReturnType<typeof useGlobeControlStore>) {
  const gridIndex = store.layerStack.findIndex(
    (entry) => entry.id === BUILTIN_LAYER_IDS.GRID
  );
  const volumeIndex = store.layerStack.findIndex(
    (entry) => entry.id === BUILTIN_LAYER_IDS.VOLUME
  );
  const delta = gridIndex - volumeIndex;
  return delta > 0 ? 10 + delta : Math.max(delta, -9);
}

// eslint-disable-next-line max-lines-per-function
export function useVolume(options: TOptions) {
  const store = useGlobeControlStore();
  store.volumeAvailable = true;
  const { logError } = useLog();
  let context: TVolumeContext | undefined;
  let layer: VolumeLayer | undefined;
  let cachedKey: string | undefined;
  let hasData = false;
  let animationQuality: TVolumeRenderQuality | undefined;
  let requestRevision = 0;
  let disposed = false;

  function reportProgress(revision: number, progress: number) {
    if (revision !== requestRevision || disposed) {
      return;
    }
    const rounded = Math.max(0, Math.min(100, Math.round(progress)));
    store.volumeProgress = Math.max(store.volumeProgress ?? 0, rounded);
  }

  function ensureLayer() {
    if (!layer) {
      layer = new VolumeLayer();
      options.getScene()?.add(layer.object);
    }
    return layer;
  }

  function updateQuality() {
    layer?.setQuality(
      animationQuality ??
        (options.isSceneInMotion.value
          ? VOLUME_RENDER_QUALITY.INTERACTIVE
          : VOLUME_RENDER_QUALITY.FULL)
    );
  }

  function updateAppearance() {
    if (!layer) {
      return;
    }
    const entry = store.layerStack.find(
      (candidate) => candidate.id === BUILTIN_LAYER_IDS.VOLUME
    );
    updateQuality();
    layer.setOpacity(entry?.opacity ?? LAYER_OPACITY.MAX);
    layer.setRenderOrder(renderOrder(store));
    layer.setProjection(options.projectionHelper.value);
    layer.object.visible = Boolean(hasData && entry?.visible);
    options.redraw();
  }

  function preparationOptions(input: TVolumeFrameOptions) {
    const datasources = options.getDatasources();
    const variables = store.volumeSelections.map(
      (selection) => selection.variable
    );
    return {
      ...input,
      isCurrent: () =>
        !disposed &&
        !input.signal?.aborted &&
        (input.isCurrent?.() ?? true) &&
        datasources === options.getDatasources() &&
        store.isVolumeLayerEnabled() &&
        variables.join("\0") ===
          store.volumeSelections
            .map((selection) => selection.variable)
            .join("\0"),
    };
  }

  async function planFrame(
    nextContext: TVolumeContext,
    input: TVolumeFrameOptions
  ) {
    assertVolumeCurrent(input);
    const renderer = options.getRenderer();
    const datasources = options.getDatasources();
    if (!renderer || !datasources) {
      throw new Error(
        "Volume preparation requires a loaded dataset and renderer."
      );
    }
    return planVolumeFrame(
      datasources,
      store.volumeSelections.map((selection) => selection.variable),
      nextContext,
      getMax3DTextureSize(renderer),
      input
    );
  }

  async function prepareFrame(
    nextContext: TVolumeContext,
    input: TVolumeFrameOptions = {}
  ) {
    const guarded = preparationOptions({ interpolatable: true, ...input });
    const plan = await planFrame(nextContext, guarded);
    return prepareVolumeFrame(plan, guarded);
  }

  function canCommit(frame: TPreparedVolumeFrame) {
    return !(
      disposed ||
      !store.isVolumeLayerEnabled() ||
      !frame.isCurrent() ||
      frame.plan.datasources !== options.getDatasources() ||
      frame.plan.variables.join("\0") !==
        store.volumeSelections.map((selection) => selection.variable).join("\0")
    );
  }

  function commitFrame(frame: TPreparedVolumeFrame) {
    if (!canCommit(frame)) {
      return false;
    }
    requestRevision++;
    animationQuality = undefined;
    context = frame.plan.context;
    if (cachedKey !== frame.plan.key || !hasData) {
      if (frame.physical) {
        ensureLayer().setInterpolation(
          createVolumeInterpolation([frame]),
          0,
          0,
          0
        );
        layer!.setAppearance(
          store.volumeSelections.map((selection) => selection.color),
          store.volumeSelections.map((selection) => selection.opacity)
        );
      } else {
        ensureLayer().setData(
          frame.data,
          frame.dimensions,
          frame.channelCount,
          frame.storageChannelCount,
          store.volumeSelections.map((selection) => selection.color),
          store.volumeSelections.map((selection) => selection.opacity),
          frame.bounds
        );
      }
    }
    cachedKey = frame.plan.key;
    hasData = true;
    store.volumeLoading = false;
    store.volumeProgress = undefined;
    updateAppearance();
    return true;
  }

  function commitInterpolation(
    sequence: TVolumeInterpolation,
    firstIndex: number,
    nextIndex: number,
    alpha: number,
    forExport = false
  ) {
    const first = sequence.frames[firstIndex],
      next = sequence.frames[nextIndex];
    if (!first || !next || !canCommit(first) || !canCommit(next)) {
      return false;
    }
    ensureLayer().setInterpolation(sequence, firstIndex, nextIndex, alpha);
    // ponytail: fixed preview sampling trades fine detail for speed. Large views
    // may still need a reduced-resolution volume pass; export keeps full quality.
    animationQuality = forExport
      ? VOLUME_RENDER_QUALITY.FULL
      : VOLUME_RENDER_QUALITY.PREVIEW;
    layer!.setAppearance(
      store.volumeSelections.map((selection) => selection.color),
      store.volumeSelections.map((selection) => selection.opacity)
    );
    requestRevision++;
    context = first.plan.context;
    cachedKey = undefined;
    hasData = true;
    store.volumeLoading = false;
    store.volumeProgress = undefined;
    updateAppearance();
    return true;
  }

  // eslint-disable-next-line max-lines-per-function
  async function loadVolume(isCurrent: () => boolean = () => true) {
    const revision = ++requestRevision;
    const requestContext = context;
    if (
      disposed ||
      !requestContext ||
      !store.volumeSelections.length ||
      !options.getRenderer() ||
      !options.getDatasources() ||
      !store.isVolumeLayerEnabled()
    ) {
      store.volumeLoading = false;
      store.volumeProgress = undefined;
      updateAppearance();
      return;
    }
    store.volumeLoading = true;
    store.volumeProgress = 0;
    const input = preparationOptions({
      isCurrent: () => revision === requestRevision && isCurrent(),
      onProgress: (fraction) => reportProgress(revision, 5 + fraction * 95),
    });
    try {
      const plan = await planFrame(requestContext, input);
      assertVolumeCurrent(input);
      if (plan.key === cachedKey && hasData) {
        layer?.setAppearance(
          store.volumeSelections.map((selection) => selection.color),
          store.volumeSelections.map((selection) => selection.opacity)
        );
        updateAppearance();
        return;
      }
      const frame = await prepareVolumeFrame(plan, input);
      assertVolumeCurrent(input);
      commitFrame(frame);
    } catch (error) {
      if (
        revision === requestRevision &&
        !disposed &&
        !(error instanceof DOMException && error.name === "AbortError")
      ) {
        hasData = false;
        updateAppearance();
        logError(error, "Could not render the volume");
      }
    } finally {
      if (revision === requestRevision) {
        store.volumeLoading = false;
        store.volumeProgress = undefined;
      }
    }
  }

  async function setContext(
    nextContext?: TVolumeContext,
    frame?: TPreparedVolumeFrame,
    isCurrent?: () => boolean
  ) {
    if (frame) {
      if (isCurrent?.() === false || !commitFrame(frame)) {
        throw new DOMException(
          "Volume frame is no longer current",
          "AbortError"
        );
      }
      return;
    }
    context = nextContext;
    if (!nextContext) {
      hasData = false;
    }
    await loadVolume(isCurrent);
  }

  function refresh() {
    return loadVolume();
  }

  watch(
    () =>
      `${store.isVolumeLayerEnabled()}:${store.volumeSelections
        .map((selection) => selection.variable)
        .join("\u0000")}`,
    () => {
      updateAppearance();
      void loadVolume();
    }
  );
  watch(
    () =>
      store.volumeSelections
        .map((selection) => `${selection.color}:${selection.opacity}`)
        .join(),
    () => {
      layer?.setAppearance(
        store.volumeSelections.map((selection) => selection.color),
        store.volumeSelections.map((selection) => selection.opacity)
      );
      options.redraw();
    }
  );
  watch(() => store.layerStack, updateAppearance, { deep: true });
  options.onProjectionChange(() => {
    updateAppearance();
    if (!hasData) {
      void loadVolume();
    }
  });
  options.onMotionStateChange(() => {
    updateQuality();
    options.redraw();
  });
  onMounted(() => void loadVolume());
  onScopeDispose(() => {
    disposed = true;
    requestRevision++;
    store.volumeLoading = false;
    store.volumeProgress = undefined;
    store.volumeAvailable = false;
    terminateVolumeTextureWorker();
    if (layer) {
      options.getScene()?.remove(layer.object);
      layer.dispose();
      layer = undefined;
    }
  });

  return {
    setContext,
    refresh,
    prepareFrame,
    commitFrame,
    commitInterpolation,
  };
}
