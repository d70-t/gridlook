import type { Scene } from "three";
import * as THREE from "three";
import { onScopeDispose, watch, type ComputedRef } from "vue";

import { getLayerRenderOrder } from "./useGridOverlays.ts";

import { BasemapLayer } from "@/lib/layers/basemap.ts";
import { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  BUILTIN_LAYER_IDS,
  LAYER_OPACITY,
  useGlobeControlStore,
} from "@/store/store.ts";
import { useLog } from "@/ui/common/useLog.ts";
import { type TBasemapEntry } from "@/utils/basemap.ts";

export type TOptions = {
  projectionHelper: ComputedRef<ProjectionHelper>;
  getScene: () => Scene | undefined;
  getRenderer: () => THREE.WebGLRenderer | undefined;
  redraw: () => void;
  onProjectionChange: (callback: () => void) => void;
  basemaps: TBasemapEntry[] | undefined;
};
type TStore = ReturnType<typeof useGlobeControlStore>;

function findLayerEntry(store: TStore) {
  return store.layerStack.find(
    (entry) => entry.id === BUILTIN_LAYER_IDS.BASEMAP
  );
}

// eslint-disable-next-line max-lines-per-function
export function useBasemapLayer(options: TOptions) {
  const store = useGlobeControlStore();
  store.basemapAvailable = true;

  const { logError } = useLog();

  let layer: BasemapLayer | undefined;

  let disposed = false;

  function removeLayer() {
    if (layer) {
      const map = layer.getBasemap();
      options.getScene()?.remove(map);
      layer.dispose();
      layer = undefined;
    }
  }

  function installLayer(nextLayer: BasemapLayer) {
    nextLayer.setProjection(options.projectionHelper.value);
    removeLayer();
    layer = nextLayer;

    const scene = options.getScene();

    scene?.add(nextLayer.getBasemap());

    updateAppearance();
  }

  function createLayer(basemapId: string) {
    if (disposed) {
      return false;
    }

    let nextLayer: BasemapLayer;
    try {
      if (options.basemaps === undefined) {
        throw new Error("Failed to open basemap catalog.");
      }
      nextLayer = new BasemapLayer(options.basemaps, basemapId);
    } catch (error) {
      logError(error, "Failed to create basemap layer.");
      throw error;
    }
    installLayer(nextLayer);

    return nextLayer;
  }

  function setBasemap(basemapId: string) {
    if (!layer) {
      return;
    }

    layer.setProvider(basemapId);

    updateAppearance();
  }

  function setProjection(projection: ProjectionHelper) {
    if (!layer) {
      return;
    }

    layer.setProjection(projection);

    updateAppearance();
    options.redraw();
  }

  function setOpacity(opacity: number) {
    if (!layer) {
      return;
    }
    layer.setOpacity(opacity);
  }

  function toggleVisibility() {
    if (!layer) {
      return;
    }
    layer.toggleVisibility();
  }

  function updateAppearance() {
    if (!layer) {
      return;
    }

    const entry = findLayerEntry(store);
    layer.setRenderOrder(
      getLayerRenderOrder(store.layerStack, BUILTIN_LAYER_IDS.BASEMAP)
    );
    layer.setOpacity(entry?.opacity ?? LAYER_OPACITY.MAX);

    const visible = Boolean(entry?.visible && store.basemapAvailable);
    
    const map = layer.getBasemap();
    map.visible = visible;

    options.redraw();
  }

  watch(() => store.layerStack, updateAppearance, { deep: true });
  watch(
    () => store.selectedBasemap,
    () => setBasemap(store.selectedBasemap)
  );
  watch(
    () => store.isBasemapLayerEnabled(),
    () => {
      console.log("basemap state change");
      updateAppearance();
    }
  );

  options.onProjectionChange(() => {
    setProjection(options.projectionHelper.value);
  });

  onScopeDispose(() => {
    disposed = true;
    store.basemapAvailable = false;
    if (layer) {
      options.getScene()?.remove(layer.getBasemap());

      layer.dispose();
      layer = undefined;
    }
  });

  return { setBasemap, setOpacity, toggleVisibility, createLayer };
}
