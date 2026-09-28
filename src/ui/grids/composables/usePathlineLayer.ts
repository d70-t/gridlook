import type * as THREE from "three";
import { onScopeDispose, type ComputedRef } from "vue";

import { getLayerRenderOrder } from "./useGridOverlays.ts";

import type {
  TPathlineConfig,
  TPathlineTrajectories,
} from "@/lib/data/pathlineTrajectories.ts";
import {
  PathlineParticleLayer,
  pathlineRenderLayout,
} from "@/lib/layers/pathlineParticles.ts";
import {
  PATHLINE_DISPLAY,
  type TPathlineDisplay,
} from "@/lib/layers/pathlinePreview.ts";
import type { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  BUILTIN_LAYER_IDS,
  LAYER_OPACITY,
  useGlobeControlStore,
} from "@/store/store.ts";

type TOptions = {
  getScene: () => THREE.Scene | undefined;
  getRenderer: () => THREE.WebGLRenderer | undefined;
  redraw: () => void;
  projectionHelper: ComputedRef<ProjectionHelper>;
};

// eslint-disable-next-line max-lines-per-function
export function usePathlineLayer(options: TOptions) {
  const store = useGlobeControlStore();
  let layer: PathlineParticleLayer | undefined;
  let revision = 0;
  const textureLimit = () =>
    options.getRenderer()?.capabilities.maxTextureSize ?? 2048;
  function clear() {
    revision++;
    if (layer) {
      layer.object.removeFromParent();
      layer.dispose();
      layer = undefined;
      options.redraw();
    }
  }
  function updateAppearance() {
    if (!layer) {
      return;
    }
    const entry = store.layerStack.find(
      (item) => item.id === BUILTIN_LAYER_IDS.STREAMLINES
    );
    layer.object.visible = !!entry?.visible;
    layer.object.renderOrder = getLayerRenderOrder(
      store.layerStack,
      BUILTIN_LAYER_IDS.STREAMLINES
    );
    layer.object.material.transparent = layer.object.renderOrder > 0;
    layer.object.material.uniforms.opacity.value =
      entry?.opacity ?? LAYER_OPACITY.MAX;
    options.redraw();
  }
  async function install(
    data: TPathlineTrajectories,
    config: TPathlineConfig,
    isCurrent: () => boolean,
    times: readonly number[] = [data.start, data.end]
  ) {
    clear();
    const token = revision;
    const scene = options.getScene();
    if (!scene) {
      throw new Error("The globe is not ready to display pathlines.");
    }
    const prepared = await PathlineParticleLayer.create(
      data,
      config,
      options.projectionHelper.value,
      textureLimit(),
      () => token === revision && isCurrent(),
      times
    );
    if (token !== revision || !isCurrent()) {
      prepared.dispose();
      return;
    }
    layer = prepared;
    scene.add(layer.object);
    updateAppearance();
  }
  function seek(
    seconds: number,
    fadeSeconds: number,
    particleSize: number,
    mode: TPathlineDisplay = PATHLINE_DISPLAY.PREVIEW
  ) {
    layer?.seek(seconds, fadeSeconds, particleSize, mode);
    options.redraw();
  }
  function updateProjection() {
    layer?.updateProjection(options.projectionHelper.value);
    options.redraw();
  }
  onScopeDispose(clear);
  return {
    estimate: (times: readonly number[], config: TPathlineConfig) =>
      pathlineRenderLayout(times, config, textureLimit()),
    install,
    seek,
    clear,
    updateAppearance,
    updateProjection,
  };
}
