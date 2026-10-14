<script lang="ts" setup>
import { useEventListener } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, nextTick, onMounted, ref, watch, type Ref } from "vue";

import type {
  TModelInfo,
  TSnapshotOptions,
  TSources,
} from "../lib/types/GlobeTypes.ts";

import { getCameraDistanceForVerticalSpan } from "@/lib/camera/cameraSettings.ts";
import {
  getGridType,
  GRID_TYPES,
  type T_GRID_TYPES,
} from "@/lib/data/gridTypeDetector.ts";
import { isIcechunkStorePath } from "@/lib/data/icechunkStore.ts";
import {
  fetchCurrentTimestep,
  liveStoreBaseUrl,
} from "@/lib/data/liveTimestep.ts";
import { getLocalNetCDF, isLocalNetCDFSource } from "@/lib/data/localNetCDF.ts";
import {
  indexFromIndex,
  indexFromNetCDF,
  indexFromZarr,
} from "@/lib/data/sourceIndexing.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { loadTextures } from "@/lib/layers/textureStore.ts";
import { PROJECTION_TYPES, clamp } from "@/lib/projection/projectionUtils.ts";
import {
  availableColormaps,
  type TColorMap,
} from "@/lib/shaders/colormapShaders.ts";
import { PresenterRole } from "@/lib/types/presenterSync.ts";
import {
  parseLayersParam,
  type TLayerUrlEntry,
} from "@/store/layerUrlState.ts";
import { useUrlParameterStore } from "@/store/paramStore.ts";
import {
  createBuiltinLayer,
  LAYER_KINDS,
  LAYER_OPACITY,
  useGlobeControlStore,
} from "@/store/store.ts";
import { useLiveTimestep } from "@/store/useLiveTimestep.ts";
import {
  usePresenterSync,
  isDisplayMode,
  isPresenterActive,
} from "@/store/usePresenterSync.ts";
import { useUrlSync } from "@/store/useUrlSync.ts";
import Toast from "@/ui/common/Toast.vue";
import { useLog } from "@/ui/common/useLog.ts";
import { isMobileDevice } from "@/ui/common/viewConstants.ts";
import type { TCameraState } from "@/ui/grids/composables/useGridCameraState.ts";
import GridCurvilinear from "@/ui/grids/Curvilinear.vue";
import GridGaussianReduced from "@/ui/grids/GaussianReduced.vue";
import GridHealpix from "@/ui/grids/Healpix.vue";
import GridIrregular from "@/ui/grids/Irregular.vue";
import GridIrregularDelaunay from "@/ui/grids/IrregularDelaunay.vue";
import GridRegular from "@/ui/grids/Regular.vue";
import GridTriangular from "@/ui/grids/Triangular.vue";
import AboutView from "@/ui/overlays/AboutModal.vue";
import BasemapAttribution from "@/ui/overlays/BasemapAttribution.vue";
import {
  isAnimationPlaying,
  stopAnimation,
  toggleTimeAnimation,
} from "@/ui/overlays/controls/useTimeAnimation.ts";
import GlobeControls from "@/ui/overlays/Controls.vue";
import DistanceScale from "@/ui/overlays/DistanceScale.vue";
import HoverReadout from "@/ui/overlays/HoverReadout.vue";
import InfoPanel from "@/ui/overlays/InfoPanel.vue";
import { withXsrfToken } from "@/utils/xsrfToken.ts";

const props = defineProps<{ src: string }>();

useUrlSync();
const { logError } = useLog();
const store = useGlobeControlStore();
const urlParameterStore = useUrlParameterStore();

// ── Presenter Mode ──────────────────────────────────────────────────────
const { openDisplayWindow, toggleDisplayWindow, enterDisplayMode } =
  usePresenterSync();

// Detect ?mode=display in the URL and activate display mode
const urlParams = new URLSearchParams(window.location.search);
if (urlParams.get("mode") === PresenterRole.DISPLAY) {
  enterDisplayMode();
  store.setControlPanelVisible(false);

  // In display mode, Controls.vue is not rendered, so we must initialise
  // projection settings from URL params here (Controls normally does this).
  const proj = urlParameterStore.paramProjection;
  if (
    proj &&
    Object.values(PROJECTION_TYPES).includes(
      proj as typeof store.projectionMode
    )
  ) {
    store.projectionMode = proj as typeof store.projectionMode;
  }
  if (urlParameterStore.paramLat || urlParameterStore.paramLon) {
    const lat = parseFloat(urlParameterStore.paramLat ?? "0");
    const lon = parseFloat(urlParameterStore.paramLon ?? "0");
    store.projectionCenter = {
      lat: clamp(lat, -90, 90),
      lon: clamp(lon, -180, 180),
    };
  }
}

const { varnameSelector, loading, colormap, invertColormap } =
  storeToRefs(store);

const {
  paramVarname,
  paramGridType,
  paramDistractionFree,
  paramLive,
  paramLayers,
} = storeToRefs(urlParameterStore);

type TGlobeHandle = {
  makeSnapshot: (options: TSnapshotOptions) => void;
  toggleRotate: () => void;
  applyCameraPreset: (state: TCameraState) => void;
};

type TControlsHandle = {
  initForDataset: () => void;
};

const HYPERGLOBE_CAMERA_PRESET: TCameraState = {
  // Preserve the preset's established framing for the app's default vertical FOV.
  position: [0, 0, getCameraDistanceForVerticalSpan(4.33)],
  quaternion: [0, 0, 0, 1],
};

const globe: Ref<TGlobeHandle | null> = ref(null);
const controls: Ref<TControlsHandle | null> = ref(null);
const distractionFree = ref(false);
const hyperglobeModeActive = ref(false);
const panelVisibleBeforeDistractionFree = ref(true);
const globeKey = ref(0);
const isInitialized = ref(false);
const sourceValid = ref(false);
const datasources: Ref<TSources | undefined> = ref(undefined);
const detectedGridType: Ref<T_GRID_TYPES | undefined> = ref(undefined);
const infoPanelOpen = ref(false);

// Auto-follow the newest timestep of a live dataset (see useLiveTimestep).
useLiveTimestep(datasources);

const distractionFreeFromUrl = paramDistractionFree.value === "true";

if (distractionFreeFromUrl && !isDisplayMode.value) {
  distractionFree.value = true;
  store.setControlPanelVisible(false);
}

const activeGridType = computed(() => {
  const detected = detectedGridType.value;
  if (!detected) {
    return undefined;
  }
  if (paramGridType.value) {
    return paramGridType.value as T_GRID_TYPES;
  } else {
    return detected;
  }
});

const modelInfo = computed(() => {
  if (datasources.value === undefined) {
    return undefined;
  } else {
    return {
      title: datasources.value.name,
      vars: datasources.value.levels[0].datasources,
      defaultVar: datasources.value.default_var,
      colormaps: Object.keys(availableColormaps) as TColorMap[],
    } as TModelInfo;
  }
});

const currentGlobeComponent = computed(() => {
  const gridMapping = {
    [GRID_TYPES.HEALPIX]: GridHealpix,
    [GRID_TYPES.REGULAR]: GridRegular,
    [GRID_TYPES.REGULAR_ROTATED]: GridRegular,
    [GRID_TYPES.TRIANGULAR]: GridTriangular,
    [GRID_TYPES.GAUSSIAN_REDUCED]: GridGaussianReduced,
    [GRID_TYPES.IRREGULAR]: GridIrregular,
    [GRID_TYPES.IRREGULAR_DELAUNAY]: GridIrregularDelaunay,
    [GRID_TYPES.CURVILINEAR]: GridCurvilinear,
  };

  return gridMapping[activeGridType.value as keyof typeof gridMapping];
});

let gridTypeUpdateId = 0;
let sourceUpdateId = 0;

async function setGridType(forceRerender = false) {
  const updateId = ++gridTypeUpdateId;
  const previousGridType = detectedGridType.value;
  const localGridType = await getGridType(
    sourceValid.value,
    varnameSelector.value,
    datasources.value,
    logError
  );
  if (updateId !== gridTypeUpdateId) {
    return;
  }
  detectedGridType.value = localGridType;
  if (localGridType === GRID_TYPES.ERROR) {
    store.stopLoading();
  }
  if (forceRerender || localGridType !== previousGridType) {
    globeKey.value += 1;
  }
}

watch(
  () => props.src,
  async () => {
    await loadCurrentSource();
  }
);

watch(
  () => varnameSelector.value,
  async (varname, oldVarname) => {
    if (
      !isInitialized.value ||
      !varname ||
      varname === "-" ||
      varname === oldVarname
    ) {
      return;
    }
    store.startLoading();
    detectedGridType.value = undefined;
    await setGridType(true);
  }
);

function prepareDefaults(src: string, index: TSources) {
  if (src === props.src) {
    datasources.value = index;
    // Store dataset title for snapshot overlay
    store.datasetTitle = index.name ?? "";
  }
  const validVars = Object.keys(modelInfo.value!.vars).filter((varname) => {
    const varinfo = modelInfo.value!.vars[varname];
    return !varinfo.hidden;
  });
  varnameSelector.value =
    paramVarname.value ?? modelInfo.value!.defaultVar ?? validVars[0] ?? "-";

  if (
    datasources.value &&
    varnameSelector.value in datasources.value.levels[0].datasources
  ) {
    const variableDefaults =
      datasources.value.levels[0].datasources[varnameSelector.value];
    if (variableDefaults.default_colormap) {
      colormap.value = variableDefaults.default_colormap.name;
      if (Object.hasOwn(variableDefaults.default_colormap, "inverted")) {
        invertColormap.value = variableDefaults.default_colormap.inverted;
      }
    }
    if (variableDefaults.default_range) {
      store.updateBounds(variableDefaults.default_range);
    }
  }
}

function resetForSourceChange(resetStore: boolean) {
  isInitialized.value = false;
  gridTypeUpdateId += 1;
  detectedGridType.value = undefined;
  datasources.value = undefined;

  if (resetStore) {
    if (isDisplayMode.value || isPresenterActive.value) {
      // In display/presenter mode we want to preserve some state across source changes
      store.resetExcept([
        "projectionMode",
        "projectionCenter",
        "catalogData",
        "catalogUrl",
        "basemaps",
        "basemapCatalogUrl",
        "selectedBasemap",
        "controlPanelVisible",
        "layerStack",
      ]);
    } else {
      store.resetExcept([
        "catalogData",
        "catalogUrl",
        "basemaps",
        "basemapCatalogUrl",
        "controlPanelVisible",
      ]);
    }
  }

  // stop loading is handled in the grid components after data load
  store.startLoading();
}

async function initControlsFromSource() {
  await nextTick();
  controls.value?.initForDataset();
}

function findLayerParam<K extends TLayerUrlEntry["kind"]>(
  entries: TLayerUrlEntry[],
  kind: K
) {
  return entries.find((entry) => entry.kind === kind) as
    Extract<TLayerUrlEntry, { kind: K }> | undefined;
}

// Built-in layers come from the `layers` parameter; texture layers already in
// the stack stay on top.
function initLayersFromParams() {
  const entries = parseLayersParam(paramLayers.value);
  store.layerStack = [
    ...store.layerStack.filter((layer) => layer.kind === LAYER_KINDS.TEXTURE),
    ...entries.map((entry) => ({
      ...createBuiltinLayer(entry.kind),
      visible: entry.visible,
      opacity: "opacity" in entry ? entry.opacity : LAYER_OPACITY.MAX,
    })),
  ];

  const coastlines = findLayerParam(entries, LAYER_KINDS.COASTLINES);
  store.showCoastLines = coastlines?.visible ?? false;
  if (coastlines) {
    store.coastlineResolution = coastlines.resolution;
  }

  const graticules = findLayerParam(entries, LAYER_KINDS.GRATICULES);
  store.showGraticules = graticules?.visible ?? false;
  if (graticules) {
    store.graticuleSpacing = graticules.spacing;
  }

  const basemap = findLayerParam(entries, LAYER_KINDS.BASEMAP);
  if (basemap) {
    store.selectedBasemap = basemap.provider;
    store.basemapOptions = basemap.options;
  }
  initDatasetLayersFromParams(entries);
}

// Variables unknown to this dataset fall back to the automatic pair or are
// dropped from the volume.
function initDatasetLayersFromParams(entries: TLayerUrlEntry[]) {
  const vars = modelInfo.value?.vars ?? {};
  const streamlines = findLayerParam(entries, LAYER_KINDS.STREAMLINES);
  if (streamlines) {
    if (
      streamlines.u &&
      streamlines.v &&
      streamlines.u in vars &&
      streamlines.v in vars
    ) {
      store.setStreamlineSelection({
        automatic: false,
        u: streamlines.u,
        v: streamlines.v,
      });
    }
    store.setStreamlineMagnitudeDisplayed(
      streamlines.visible && streamlines.magnitude
    );
  }

  const volume = findLayerParam(entries, LAYER_KINDS.VOLUME);
  if (volume) {
    store.setVolumeSelections(
      volume.selections.filter((selection) => selection.variable in vars)
    );
  }
}

// Stored texture layers are added on top of the stack, hidden.
async function restoreStoredTextureLayers() {
  try {
    const stored = await loadTextures();
    for (const texture of stored) {
      if (!store.layerStack.some((layer) => layer.id === texture.id)) {
        store.addTextureLayer(texture.id, texture.name, false);
      }
    }
  } catch (error) {
    logError(error, "Couldn't load stored texture layers");
  }
}

function hasDisplayableVariable() {
  return Object.values(modelInfo.value?.vars ?? {}).some(
    (varinfo) => !varinfo.hidden
  );
}

async function loadCurrentSource(resetStore = true) {
  const updateId = ++sourceUpdateId;
  resetForSourceChange(resetStore);
  await updateSrc(updateId);
  if (updateId !== sourceUpdateId) {
    return;
  }
  if (sourceValid.value && !hasDisplayableVariable()) {
    // Grid detection and the grid components need a selectable variable.
    logError(
      "The dataset only contains coordinates or variables without a spatial dimension.",
      "No displayable variables"
    );
    detectedGridType.value = GRID_TYPES.ERROR;
    store.stopLoading();
    return;
  }
  initLayersFromParams();
  void restoreStoredTextureLayers();
  await initControlsFromSource();
  isInitialized.value = true;
  await setGridType(true);
}

async function updateSrc(updateId: number) {
  const src = props.src;
  ZarrDataManager.invalidateCache();
  sourceValid.value = false;
  store.isInitializingVariable = true;
  let indexPromises: Promise<TSources>[];
  if (isLocalNetCDFSource(src)) {
    const file = getLocalNetCDF(src);
    indexPromises = file
      ? [indexFromNetCDF(file, src)]
      : [
          Promise.reject(
            new Error("Please select the local NetCDF file again.")
          ),
        ];
  } else {
    // FIXME: Trying zarr and json-index in parallel and picking the first that
    // works. If both fail, we log the last error which is from the json-index.
    // This leads to confusing error messages if the zarr source is supposed to
    // work but fails for some reason.
    // On JupyterHub, same-origin stores need Jupyter's XSRF token; it is added
    // here, not to `src`, so the hash and the data-path input stay clean.
    // ponytail: only the index URL is tokenized. Same-origin stores named
    // inside a JSON index don't get it, and icechunk and live mode are left
    // untokenized because they join paths onto the store URL, after the query;
    // each would need its own join to be query-aware.
    const fetchSrc =
      isIcechunkStorePath(src) || paramLive.value === "true"
        ? src
        : withXsrfToken(src, document.cookie, location.href);
    indexPromises = [indexFromZarr(fetchSrc), indexFromIndex(fetchSrc)];
  }
  const indices = await Promise.allSettled(indexPromises);
  let lastError = null;
  if (updateId !== sourceUpdateId || src !== props.src) {
    return;
  }
  for (const index of indices) {
    if (index.status === "fulfilled") {
      sourceValid.value = true;
      prepareDefaults(src, index.value);
      break;
    } else {
      lastError = index.reason;
    }
  }
  store.setLive(paramLive.value === "true");
  if (store.live && sourceValid.value && datasources.value) {
    await seedLiveTimestep(datasources.value, updateId);
  }
  store.signifyDatasetChange();
  if (!sourceValid.value && lastError) {
    logError(lastError, "Failed to fetch data");
  }
}

/**
 * Fetch the currently-available timestep of a live dataset and use it as the
 * initial time index, so the first render requests a chunk that actually
 * exists. Best-effort: on failure the live controller will still recover by
 * retrying once it starts. Bounded by a timeout so a stuck endpoint cannot
 * block the whole dataset from loading.
 */
async function seedLiveTimestep(sources: TSources, updateId: number) {
  const baseUrl = liveStoreBaseUrl(sources);
  if (!baseUrl) {
    return;
  }
  const abortController = new AbortController();
  const timeout = setTimeout(() => abortController.abort(), 10000);
  try {
    const current = await fetchCurrentTimestep(baseUrl, abortController.signal);
    if (updateId !== sourceUpdateId) {
      return;
    }
    urlParameterStore.paramDimIndices["time"] = String(current);
    store.setLiveTimestep(current);
  } catch (error) {
    logError(
      error,
      `Live dataset: could not reach ${baseUrl}/current-timestep ` +
        `(check the endpoint is served next to the store and CORS-enabled)`
    );
  } finally {
    clearTimeout(timeout);
  }
}

const makeSnapshot = (options: TSnapshotOptions) => {
  if (globe.value) {
    globe.value.makeSnapshot(options);
  }
};

const toggleRotate = () => {
  if (globe.value) {
    globe.value.toggleRotate();
  }
};

const selectGridType = (gridType: T_GRID_TYPES) => {
  const detected = detectedGridType.value;
  if (!detected) {
    return;
  }
  // If selecting the detected type, clear the param override
  paramGridType.value = gridType === detected ? undefined : gridType;
};

const toggleInfoPanel = () => {
  infoPanelOpen.value = !infoPanelOpen.value;
};

const enterDistractionFree = () => {
  panelVisibleBeforeDistractionFree.value = store.controlPanelVisible;
  distractionFree.value = true;
  store.setControlPanelVisible(false);
  if (!document.fullscreenElement) {
    document.documentElement.requestFullscreen().catch(() => {});
  }
};

const exitDistractionFree = (forceShowPanel = false) => {
  distractionFree.value = false;
  store.setControlPanelVisible(
    forceShowPanel ? true : panelVisibleBeforeDistractionFree.value
  );
  if (document.fullscreenElement) {
    document.exitFullscreen().catch(() => {});
  }
};

const toggleDistractionFree = () => {
  hyperglobeModeActive.value = false;
  if (distractionFree.value) {
    exitDistractionFree();
  } else {
    enterDistractionFree();
  }
};

const applyHyperglobePreset = () => {
  if (hyperglobeModeActive.value) {
    hyperglobeModeActive.value = false;
    exitDistractionFree(true);
    return;
  }

  hyperglobeModeActive.value = true;
  store.projectionMode = PROJECTION_TYPES.AZIMUTHAL_HYBRID;
  store.projectionCenter = { lat: -90, lon: -90 };

  enterDistractionFree();
  globe.value?.applyCameraPreset(HYPERGLOBE_CAMERA_PRESET);
};

const applyHyperglobePresenter = () => {
  store.projectionMode = PROJECTION_TYPES.AZIMUTHAL_HYBRID;
  store.projectionCenter = { lat: -90, lon: -90 };
  globe.value?.applyCameraPreset(HYPERGLOBE_CAMERA_PRESET);
  // Defer long enough for useUrlSync's debounced projection center (200ms)
  // to flush into the URL hash before the popup reads it.
  setTimeout(() => openDisplayWindow(), 300);
};

onMounted(async () => {
  await loadCurrentSource(false);
});

// Prevent the long-press context menu on touch-enabled devices (e.g. touchscreen
// laptops) while still allowing right-click context menus from a regular mouse.
let lastPointerType = "mouse";
useEventListener(window, "pointerdown", (e: PointerEvent) => {
  lastPointerType = e.pointerType;
});
useEventListener(
  window,
  "contextmenu",
  (e: MouseEvent) => {
    if (lastPointerType === "touch") {
      e.preventDefault();
    }
  },
  { capture: true }
);

useEventListener(window, "keydown", (e: KeyboardEvent) => {
  if (isDisplayMode.value) {
    // Disable shortcuts in display/presenter mode to avoid interfering with presenter controls
    return;
  }
  const tag = (e.target as HTMLElement)?.tagName?.toLowerCase();
  if (tag === "input" || tag === "textarea" || tag === "select") {
    return;
  }
  const key = e.key.toLowerCase();
  if (key === " " && tag === "button") {
    return;
  }
  if (key === "r") {
    toggleRotate();
  } else if (key === "d") {
    toggleDistractionFree();
  } else if (key === "g") {
    applyHyperglobePreset();
  } else if (key === "h" && !isMobileDevice()) {
    applyHyperglobePresenter();
  } else if (key === " ") {
    e.preventDefault();
    toggleTimeAnimation();
  }
});
</script>

<template>
  <main>
    <Toast />
    <div v-show="!distractionFree && !isDisplayMode">
      <GlobeControls
        ref="controls"
        :model-info="modelInfo"
        :grid-type="activeGridType"
        :current-source="props.src"
        :info-panel-open="infoPanelOpen"
        @on-snapshot="makeSnapshot"
        @on-rotate="toggleRotate"
        @toggle-display="toggleDisplayWindow"
        @toggle-info-panel="toggleInfoPanel"
      />
    </div>

    <div v-if="isAnimationPlaying" class="top-right-loader">
      <button
        type="button"
        class="button is-ghost has-text-white is-fullwidth p-0 is-size-2"
        title="Animation playing — click to stop"
        aria-label="Stop animation"
        @click="stopAnimation"
      >
        <span class="icon">
          <i class="fa-solid fa-play fa-beat-fade" aria-hidden="true"></i>
        </span>
      </button>
    </div>
    <div v-else-if="loading" class="top-right-loader loader" />
    <section
      v-if="detectedGridType === GRID_TYPES.ERROR"
      class="hero is-fullheight w-100"
      style="background: linear-gradient(135deg, #f8fafc 60%, #ffe5e5 100%)"
    >
      <div class="hero-body">
        <div class="container has-text-centered">
          <p class="title pb-4">Error</p>
          <p class="subtitle" style="color: #333">
            Sorry, we couldn't load your data. Please check the source and try
            again.
          </p>
        </div>
      </div>
    </section>
    <div v-else class="grid-canvas-wrapper">
      <currentGlobeComponent
        v-if="detectedGridType !== undefined"
        ref="globe"
        :key="globeKey"
        :datasources="datasources"
        :is-rotated="detectedGridType === GRID_TYPES.REGULAR_ROTATED"
      />
      <HoverReadout v-if="detectedGridType !== undefined" />
      <DistanceScale v-if="detectedGridType !== undefined" />
      <BasemapAttribution v-if="detectedGridType !== undefined" />
    </div>
    <div
      v-if="!isDisplayMode"
      v-show="!distractionFree"
      class="buttons about-corner-link"
    >
      <InfoPanel
        :datasources="datasources"
        :grid-type="detectedGridType"
        :is-open="infoPanelOpen"
        @close="infoPanelOpen = false"
        @select-grid-type="selectGridType"
      />
      <AboutView />
    </div>
  </main>
</template>

<style lang="scss">
@use "bulma/sass/utilities" as bulmaUt;

main {
  overflow: hidden;
  display: flex;
  @media only screen and (max-width: bulmaUt.$tablet) {
    flex-direction: column;
  }
}

div.top-right-loader {
  position: absolute;
  top: 10px;
  right: 10px;
  height: 40px;
  width: 40px;
  z-index: 1000;
}

.about-corner-link {
  position: absolute;
  bottom: 18px;
  right: 18px;
}

.grid-canvas-wrapper {
  position: relative;
  flex: 1;
  min-width: 0;
  min-height: 0;
}
</style>
