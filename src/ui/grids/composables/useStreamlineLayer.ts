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

const PROJECTION_SETTLE_MS = 100;

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
  let projectionSettleTimer: ReturnType<typeof setTimeout> | undefined;
  let projectionChanging = false;
  let disposed = false;

  function updateAppearance() {
    if (!layer) {
      return;
    }
    const entry = findLayerEntry(store);
    layer.setRenderOrder(getRenderOrder(store));
    layer.setOpacity(entry?.opacity ?? LAYER_OPACITY.MAX);
    const visible = Boolean(entry?.visible && store.streamlineAvailable);
    layer.object.visible = visible && !projectionChanging;
    stopAnimation = syncAnimation(options, layer, visible, stopAnimation);
    options.redraw();
  }

  function disposeObject() {
    clearTimeout(projectionSettleTimer);
    projectionSettleTimer = undefined;
    projectionChanging = false;
    stopAnimation?.();
    stopAnimation = undefined;
    if (layer) {
      options.getScene()?.remove(layer.object);
      layer.dispose();
      layer = undefined;
    }
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

  function setField(field: TStreamlineVectorField, pair: TVectorVariablePair) {
    if (disposed) {
      return;
    }
    disposeObject();
    store.setStreamlinePair(pair);
    layer = new StreamlineParticleLayer(field, options.projectionHelper.value);
    options.getScene()?.add(layer.object);
    updateAppearance();
  }

  options.onProjectionChange(() => {
    layer?.updateProjection(options.projectionHelper.value);
    if (!layer) {
      return;
    }
    projectionChanging = true;
    clearTimeout(projectionSettleTimer);
    updateAppearance();
    projectionSettleTimer = setTimeout(() => {
      projectionChanging = false;
      projectionSettleTimer = undefined;
      updateAppearance();
    }, PROJECTION_SETTLE_MS);
  });
  watch(() => store.layerStack, updateAppearance, { deep: true });
  onScopeDispose(() => {
    disposed = true;
    clear();
  });

  return { clear, setAvailablePair, setField };
}
