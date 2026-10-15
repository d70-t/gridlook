import { useDebounceFn } from "@vueuse/core";
import { storeToRefs } from "pinia";
import * as THREE from "three";
import { onScopeDispose, watch, type ComputedRef, type Ref } from "vue";

import { BasemapLayer, sampleViewGeoPoints } from "@/lib/layers/basemap.ts";
import {
  chooseTileWindow,
  getAtlasLayout,
  getTileRequests,
  getViewZoom,
} from "@/lib/layers/basemapTiles.ts";
import {
  applyLayerStackPosition,
  createEquirectLayerMesh,
  createImageLayerTexture,
  updateEquirectLayerProjection,
  type TImageLayerTexture,
  type TLandSeaMaskMode,
} from "@/lib/layers/equirectLayer.ts";
import { geojson2gpuLineSegmentsGeometry } from "@/lib/layers/geojson.ts";
import {
  makeGpuProjectedLineMaterial,
  updateGpuProjectedLineMaterial,
} from "@/lib/layers/gpuProjectedLines.ts";
import { ResourceCache } from "@/lib/layers/ResourceCache.ts";
import { getTexture } from "@/lib/layers/textureStore.ts";
import type { ProjectionHelper } from "@/lib/projection/projectionUtils.ts";
import {
  COASTLINE_RESOLUTIONS,
  GRATICULE_SPACINGS,
  LAYER_KINDS,
  LAYER_OPACITY,
  useGlobeControlStore,
  type TCoastlineResolution,
  type TGraticuleSpacing,
  type TLayerEntry,
} from "@/store/store";
import { useLog } from "@/ui/common/useLog.ts";

type UseGridOverlaysOptions = {
  projectionHelper: ComputedRef<ProjectionHelper>;
  showCoastLines: Ref<boolean>;
  showGraticules: Ref<boolean>;
  getScene: () => THREE.Scene | undefined;
  getCamera: () => THREE.Camera | undefined;
  getRenderer: () => THREE.WebGLRenderer | undefined;
  redraw: () => void;
};

type TOverlayLineStyle = {
  color: string;
  radius: number;
};

const coastStyle: TOverlayLineStyle = {
  color: "#ffffff",
  radius: 1,
} as const;

const graticuleStyle: TOverlayLineStyle = {
  color: "#888888",
  radius: 1,
} as const;

const COASTLINE_GEOJSON_PATHS: Record<TCoastlineResolution, string> = {
  [COASTLINE_RESOLUTIONS.TEN_M]: "static/ne_10m_coastline.geojson",
  [COASTLINE_RESOLUTIONS.FIFTY_M]: "static/ne_50m_coastline.geojson",
};

const GRATICULE_GEOJSON_PATHS: Record<TGraticuleSpacing, string> = {
  [GRATICULE_SPACINGS.FIFTEEN_DEGREES]: "static/ne_50m_graticules_15.geojson",
  [GRATICULE_SPACINGS.THIRTY_DEGREES]: "static/ne_50m_graticules_30.geojson",
};

// Basemap tiles follow the view while it moves, at most every MAX_WAIT ms,
// and once more DELAY ms after the last frame.
const BASEMAP_WINDOW_DELAY_MS = 50;
const BASEMAP_WINDOW_MAX_WAIT_MS = 100;
// A new tile zoom waits until zooming has paused this long, so the levels
// passed on the way are never downloaded.
const BASEMAP_ZOOM_DELAY_MS = 100;

export function getLayerRenderOrder(
  stack: readonly TLayerEntry[],
  layerId: string
) {
  const gridIndex = stack.findIndex((entry) => entry.kind === LAYER_KINDS.GRID);
  const layerIndex = stack.findIndex((entry) => entry.id === layerId);
  const delta = gridIndex - layerIndex;
  return delta > 0 ? 10 + delta : Math.max(delta, -9);
}

/* eslint-disable-next-line max-lines-per-function */
export function useGridOverlays(options: UseGridOverlaysOptions) {
  const store = useGlobeControlStore();
  const {
    coastlineResolution,
    graticuleSpacing,
    showCoastLines,
    showGraticules,
  } = storeToRefs(store);

  const { projectionHelper, getScene, getCamera, getRenderer, redraw } =
    options;
  const { logError } = useLog();

  let coast: THREE.LineSegments | undefined = undefined;
  let graticules: THREE.LineSegments | undefined = undefined;
  let coastlineUpdateId = 0;
  let graticuleUpdateId = 0;
  const textureLayerMeshes = new Map<string, THREE.Mesh>();
  const textureCache = new Map<
    string,
    { maskMode: TLandSeaMaskMode; layerTexture: TImageLayerTexture }
  >();
  let textureLayersUpdating = false;
  let textureLayersDirty = false;
  let textureLayersPendingForceRebuild = false;
  let basemap: BasemapLayer | undefined = undefined;
  let basemapMesh: THREE.Mesh | undefined = undefined;

  watch(
    () => showCoastLines.value,
    () => {
      updateCoastlines();
    }
  );

  watch(
    () => showGraticules.value,
    () => {
      updateGraticules();
    }
  );

  watch(
    () => coastlineResolution.value,
    () => {
      resetCoastlines();
      void updateCoastlines();
    }
  );

  watch(
    () => graticuleSpacing.value,
    () => {
      resetGraticules();
      void updateGraticules();
    }
  );

  function getLineProjectionOptions(style: TOverlayLineStyle) {
    return {
      radius: projectionHelper.value.isFlat ? 1 : style.radius,
      zOffset: 0,
    };
  }

  function updateLineProjection(
    line: THREE.LineSegments | undefined,
    style: TOverlayLineStyle
  ) {
    if (!line) {
      return;
    }

    updateGpuProjectedLineMaterial(
      line.material as THREE.ShaderMaterial,
      projectionHelper.value,
      getLineProjectionOptions(style)
    );
  }

  async function getCoastlines(updateId: number) {
    if (!coast) {
      const selectedResolution = coastlineResolution.value;
      const lineSegments = await createLineSegments(
        COASTLINE_GEOJSON_PATHS[selectedResolution],
        coastStyle,
        "coastlines"
      );
      if (
        updateId !== coastlineUpdateId ||
        selectedResolution !== coastlineResolution.value
      ) {
        disposeLineSegments(lineSegments);
        return undefined;
      }
      coast = lineSegments;
    }
    updateLineProjection(coast, coastStyle);
    return coast;
  }

  async function getGraticulesLayer(updateId: number) {
    if (!graticules) {
      const selectedSpacing = graticuleSpacing.value;
      const lineSegments = await createLineSegments(
        GRATICULE_GEOJSON_PATHS[selectedSpacing],
        graticuleStyle,
        "graticules"
      );
      if (
        updateId !== graticuleUpdateId ||
        selectedSpacing !== graticuleSpacing.value
      ) {
        disposeLineSegments(lineSegments);
        return undefined;
      }
      graticules = lineSegments;
    }
    updateLineProjection(graticules, graticuleStyle);
    return graticules;
  }

  async function createLineSegments(
    geojsonPath: string,
    style: TOverlayLineStyle,
    name: string
  ) {
    const coastlineData = await ResourceCache.loadGeoJSON(geojsonPath);
    const geometry = geojson2gpuLineSegmentsGeometry(
      coastlineData,
      projectionHelper.value,
      getLineProjectionOptions(style)
    );
    const material = makeGpuProjectedLineMaterial({
      color: style.color,
      ...getLineProjectionOptions(style),
    });
    const lineSegments = new THREE.LineSegments(geometry, material);
    lineSegments.name = name;
    lineSegments.renderOrder = 20;
    lineSegments.frustumCulled = false;
    updateLineProjection(lineSegments, style);
    return lineSegments;
  }

  function disposeLineSegments(lineSegments: THREE.LineSegments) {
    lineSegments.geometry.dispose();
    const material = lineSegments.material;
    if (Array.isArray(material)) {
      for (const item of material) {
        item.dispose();
      }
    } else {
      material.dispose();
    }
  }

  function resetCoastlines() {
    if (!coast) {
      return;
    }
    getScene()?.remove(coast);
    disposeLineSegments(coast);
    coast = undefined;
  }

  function resetGraticules() {
    if (!graticules) {
      return;
    }
    getScene()?.remove(graticules);
    disposeLineSegments(graticules);
    graticules = undefined;
  }

  async function updateCoastlines() {
    const updateId = ++coastlineUpdateId;
    const scene = getScene();
    if (!scene) {
      return;
    }
    if (showCoastLines.value === false) {
      if (coast) {
        scene.remove(coast);
      }
    } else {
      store.restoreBuiltinLayer(LAYER_KINDS.COASTLINES);
      const lineSegments = await getCoastlines(updateId);
      if (
        !lineSegments ||
        updateId !== coastlineUpdateId ||
        store.showCoastLines === false
      ) {
        return;
      }
      scene.add(lineSegments);
    }
    applyLayerOrders();
    redraw();
  }

  async function updateGraticules() {
    const updateId = ++graticuleUpdateId;
    const scene = getScene();
    if (!scene) {
      return;
    }
    if (showGraticules.value === false) {
      if (graticules) {
        scene.remove(graticules);
      }
    } else {
      store.restoreBuiltinLayer(LAYER_KINDS.GRATICULES);
      const lineSegments = await getGraticulesLayer(updateId);
      if (
        !lineSegments ||
        updateId !== graticuleUpdateId ||
        store.showGraticules === false
      ) {
        return;
      }
      scene.add(lineSegments);
    }
    applyLayerOrders();
    redraw();
  }

  /**
   * Apply render order and blending to all layer meshes from their position
   * in the layer stack relative to the data grid (renderOrder 0).
   * Layers above the grid land in 11.. (above the flat crop at 5). Layers
   * below the grid get negative orders (above the base surface at -10).
   */
  function applyLayerOrders() {
    const stack = store.layerStack;
    for (const entry of stack) {
      const layer = getLayerObject(entry);
      if (!layer) {
        continue;
      }
      const renderOrder = getLayerRenderOrder(stack, entry.id);
      if (layer instanceof THREE.Mesh) {
        applyLayerStackPosition(
          layer,
          renderOrder,
          entry.opacity ?? LAYER_OPACITY.MAX
        );
      } else if (layer instanceof THREE.LineSegments) {
        applyLineStackPosition(layer, renderOrder);
      }
    }
  }

  function getLayerObject(entry: TLayerEntry) {
    if (entry.kind === LAYER_KINDS.COASTLINES) {
      return coast;
    }
    if (entry.kind === LAYER_KINDS.GRATICULES) {
      return graticules;
    }
    if (entry.kind === LAYER_KINDS.TEXTURE) {
      return textureLayerMeshes.get(entry.id);
    }
    if (entry.kind === LAYER_KINDS.BASEMAP) {
      return basemapMesh;
    }
    return undefined;
  }

  function applyLineStackPosition(
    lineSegments: THREE.LineSegments,
    renderOrder: number
  ) {
    const material = lineSegments.material as THREE.ShaderMaterial;
    lineSegments.renderOrder = renderOrder;
    material.transparent = renderOrder > 0;
    material.needsUpdate = true;
  }

  async function getLayerTexture(entry: TLayerEntry) {
    const cached = textureCache.get(entry.id);
    if (cached && cached.maskMode === entry.maskMode) {
      return cached.layerTexture;
    }
    cached?.layerTexture.texture.dispose();
    textureCache.delete(entry.id);
    const stored = await getTexture(entry.id);
    if (!stored) {
      return undefined;
    }
    const layerTexture = await createImageLayerTexture(
      stored.blob,
      entry.maskMode,
      stored.name
    );
    textureCache.set(entry.id, { maskMode: entry.maskMode, layerTexture });
    return layerTexture;
  }

  // Removes the mesh but keeps the cached texture (disposed separately).
  function removeTextureLayerMesh(id: string) {
    const mesh = textureLayerMeshes.get(id);
    if (!mesh) {
      return;
    }
    getScene()?.remove(mesh);
    mesh.geometry.dispose();
    (mesh.material as THREE.ShaderMaterial).dispose();
    textureLayerMeshes.delete(id);
  }

  /**
   * Sync texture layer meshes with the store's layer stack.
   * Pass `forceRebuild` when the projection mode changed (the geometry type
   * differs between globe and flat projections).
   */
  async function updateTextureLayers(forceRebuild = false) {
    if (textureLayersUpdating) {
      textureLayersDirty = true;
      textureLayersPendingForceRebuild ||= forceRebuild;
      return;
    }
    textureLayersUpdating = true;
    try {
      await syncTextureLayers(forceRebuild);
    } finally {
      textureLayersUpdating = false;
    }
    if (textureLayersDirty) {
      const shouldForceRebuild = textureLayersPendingForceRebuild;
      textureLayersDirty = false;
      textureLayersPendingForceRebuild = false;
      await updateTextureLayers(shouldForceRebuild);
    }
  }

  async function syncTextureLayers(forceRebuild: boolean) {
    const scene = getScene();
    if (!scene) {
      return;
    }
    const entries = store.layerStack.filter(
      (entry) => entry.kind === LAYER_KINDS.TEXTURE
    );
    const wanted = new Set(entries.map((entry) => entry.id));

    for (const id of [...textureLayerMeshes.keys()]) {
      if (!wanted.has(id)) {
        removeTextureLayerMesh(id);
        textureCache.get(id)?.layerTexture.texture.dispose();
        textureCache.delete(id);
      }
    }

    for (const entry of entries) {
      const maskModeChanged =
        textureLayerMeshes.has(entry.id) &&
        textureCache.get(entry.id)?.maskMode !== entry.maskMode;
      if (forceRebuild || maskModeChanged) {
        removeTextureLayerMesh(entry.id);
      }
      let mesh = textureLayerMeshes.get(entry.id);
      if (!mesh && entry.visible) {
        const layerTexture = await getLayerTexture(entry);
        if (!layerTexture) {
          continue;
        }
        mesh = createEquirectLayerMesh(
          layerTexture.texture,
          projectionHelper.value,
          `textureLayer:${entry.id}`,
          layerTexture.bounds
        );
        textureLayerMeshes.set(entry.id, mesh);
        scene.add(mesh);
      }
      if (mesh) {
        mesh.visible = entry.visible;
      }
    }

    applyLayerOrders();
    redraw();
  }

  function updateLayerProjectionUniforms() {
    for (const mesh of textureLayerMeshes.values()) {
      updateEquirectLayerProjection(mesh, projectionHelper.value);
    }
    updateEquirectLayerProjection(basemapMesh, projectionHelper.value);
    redraw();
  }

  function removeBasemapMesh() {
    if (!basemapMesh) {
      return;
    }
    getScene()?.remove(basemapMesh);
    basemapMesh.geometry.dispose();
    (basemapMesh.material as THREE.ShaderMaterial).dispose();
    basemapMesh = undefined;
  }

  /**
   * Sync the basemap with the layer stack and the selected provider.
   * Pass `forceRebuild` when the projection mode changed.
   */
  function updateBasemap(forceRebuild = false) {
    const scene = getScene();
    const entry = store.layerStack.find(
      (layer) => layer.kind === LAYER_KINDS.BASEMAP
    );
    if (!scene || !entry) {
      removeBasemapMesh();
      basemap?.dispose();
      basemap = undefined;
      redraw();
      return;
    }
    basemap ??= new BasemapLayer(redraw, (error) =>
      logError(error, "Couldn't load the basemap tiles")
    );
    if (forceRebuild) {
      removeBasemapMesh();
    }
    if (!basemapMesh) {
      basemapMesh = basemap.createMesh(projectionHelper.value);
      // Every frame that shows the basemap may need other tiles.
      basemapMesh.onBeforeRender = (renderer, _scene, camera) => {
        basemap?.update(renderer, camera, projectionHelper.value);
        void debouncedUpdateBasemapWindow();
      };
      scene.add(basemapMesh);
    }
    basemapMesh.visible = entry.visible;
    applyLayerOrders();
    void basemap.setProvider(
      store.basemaps?.find((item) => item.id === store.selectedBasemap),
      store.basemapOptions
    );
    redraw();
  }

  /**
   * Load the basemap tiles matching the current view. A changed tile zoom is
   * only applied with `applyZoomChange`, once zooming has paused.
   */
  function updateBasemapWindow(applyZoomChange: boolean) {
    const camera = getCamera();
    const renderer = getRenderer();
    if (!basemap || !basemapMesh?.visible || !camera || !renderer) {
      return;
    }
    const { grid, pixelStep } = sampleViewGeoPoints(
      camera,
      projectionHelper.value,
      renderer.domElement.clientWidth,
      renderer.domElement.clientHeight
    );
    const { maxWindowTiles } = getAtlasLayout(
      renderer.capabilities.maxTextureSize
    );
    // Labels follow the zoom right away, also while new tiles wait.
    basemap.setViewZoom(getViewZoom(grid, pixelStep));
    const window = chooseTileWindow(grid, pixelStep, maxWindowTiles);
    if (!applyZoomChange && window?.zoom !== basemap.windowZoom) {
      void debouncedZoomBasemapWindow();
      return;
    }
    basemap.setWindow(
      window,
      window ? getTileRequests(window, grid, pixelStep) : []
    );
  }

  const debouncedUpdateBasemapWindow = useDebounceFn(
    () => updateBasemapWindow(false),
    BASEMAP_WINDOW_DELAY_MS,
    { maxWait: BASEMAP_WINDOW_MAX_WAIT_MS }
  );

  const debouncedZoomBasemapWindow = useDebounceFn(
    () => updateBasemapWindow(true),
    BASEMAP_ZOOM_DELAY_MS
  );

  watch(
    [
      () => store.selectedBasemap,
      () => store.basemaps,
      () => store.basemapOptions,
    ],
    () => updateBasemap(),
    { deep: true }
  );

  onScopeDispose(() => {
    removeBasemapMesh();
    basemap?.dispose();
    basemap = undefined;
  });

  async function updateOverlayProjectionUniforms(forceRebuild = false) {
    if (forceRebuild) {
      await Promise.all([updateCoastlines(), updateGraticules()]);
      return;
    }
    updateLineProjection(coast, coastStyle);
    updateLineProjection(graticules, graticuleStyle);
    redraw();
  }

  return {
    updateCoastlines,
    updateGraticules,
    updateTextureLayers,
    updateLayerProjectionUniforms,
    updateOverlayProjectionUniforms,
    updateBasemap,
  };
}
