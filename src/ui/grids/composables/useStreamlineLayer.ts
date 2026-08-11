import type * as THREE from "three";
import { onScopeDispose, watch, type ComputedRef } from "vue";

import type {
  TStreamlineVectorField,
  TVectorVariablePair,
} from "@/lib/data/vectorField.ts";
import { StreamlineParticleLayer } from "@/lib/layers/streamlineParticles.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  BUILTIN_LAYER_IDS,
  LAYER_OPACITY,
  useGlobeControlStore,
} from "@/store/store.ts";

type TOptions = {
  getScene: () => THREE.Scene | undefined;
  redraw: () => void;
  projectionHelper: ComputedRef<ProjectionHelper>;
  onProjectionChange: (callback: () => void) => void;
  registerAnimationCallback: (
    callback: (deltaSeconds: number) => void
  ) => () => void;
};

type TStore = ReturnType<typeof useGlobeControlStore>;

function findLayerEntry(store: TStore) {
  return store.layerStack.find(
    (entry) => entry.id === BUILTIN_LAYER_IDS.STREAMLINES
  );
}

function getRenderOrder(store: TStore) {
  const gridIndex = store.layerStack.findIndex(
    (entry) => entry.id === BUILTIN_LAYER_IDS.GRID
  );
  const flowIndex = store.layerStack.findIndex(
    (entry) => entry.id === BUILTIN_LAYER_IDS.STREAMLINES
  );
  const delta = gridIndex - flowIndex;
  return delta > 0 ? 10 + delta : Math.max(delta, -9);
}

function syncAnimation(
  options: TOptions,
  layer: StreamlineParticleLayer,
  visible: boolean,
  stopAnimation?: () => void
) {
  if (visible && !stopAnimation) {
    return options.registerAnimationCallback((deltaSeconds) => {
      layer.update(deltaSeconds);
    });
  }
  if (!visible && stopAnimation) {
    stopAnimation();
    return undefined;
  }
  return stopAnimation;
}

// eslint-disable-next-line max-lines-per-function
export function useStreamlineLayer(options: TOptions) {
  const store = useGlobeControlStore();
  let layer: StreamlineParticleLayer | undefined;
  let stopAnimation: (() => void) | undefined;
  let disposed = false;
  let buildRevision = 0;

  function updateAppearance() {
    if (!layer) {
      return;
    }
    const entry = findLayerEntry(store);
    layer.setRenderOrder(getRenderOrder(store));
    layer.setOpacity(entry?.opacity ?? LAYER_OPACITY.MAX);
    const visible = Boolean(entry?.visible && store.streamlineAvailable);
    layer.object.visible = visible;
    stopAnimation = syncAnimation(options, layer, visible, stopAnimation);
    options.redraw();
  }

  function removeLayerObject() {
    stopAnimation?.();
    stopAnimation = undefined;
    if (layer) {
      options.getScene()?.remove(layer.object);
      layer.dispose();
      layer = undefined;
    }
  }

  function disposeObject() {
    buildRevision++;
    store.streamlineLoading = false;
    removeLayerObject();
  }

  function installLayer(nextLayer: StreamlineParticleLayer) {
    nextLayer.updateProjection(options.projectionHelper.value);
    removeLayerObject();
    layer = nextLayer;
    options.getScene()?.add(layer.object);
    updateAppearance();
  }

  function clear() {
    disposeObject();
    store.setStreamlinePair(undefined);
  }

  function setAvailablePair(pair: TVectorVariablePair) {
    if (disposed) {
      return;
    }
    disposeObject();
    store.setStreamlinePair(pair);
  }

  async function setField(
    field: TStreamlineVectorField,
    pair: TVectorVariablePair
  ) {
    if (disposed) {
      return false;
    }
    disposeObject();
    const revision = buildRevision;
    store.setStreamlinePair(pair);
    store.streamlineLoading = true;
    try {
      const isCancelled = () =>
        disposed ||
        revision !== buildRevision ||
        !store.isStreamlineLayerEnabled();
      const nextLayer = await StreamlineParticleLayer.create(
        field,
        options.projectionHelper.value,
        isCancelled
      );
      if (!nextLayer || isCancelled()) {
        nextLayer?.dispose();
        return false;
      }
      installLayer(nextLayer);
      return true;
    } finally {
      if (revision === buildRevision) {
        store.streamlineLoading = false;
      }
    }
  }

  function showCached() {
    if (!layer) {
      return false;
    }
    updateAppearance();
    return true;
  }

  options.onProjectionChange(() => {
    layer?.updateProjection(options.projectionHelper.value);
    options.redraw();
  });
  watch(() => store.layerStack, updateAppearance, { deep: true });
  onScopeDispose(() => {
    disposed = true;
    // Scalar-variable changes remount the grid renderer. Dispose its GPU
    // objects without clearing the independently selected streamline pair;
    // the replacement renderer will rebuild the layer from that pair.
    disposeObject();
  });

  return { clear, setAvailablePair, setField, showCached };
}
