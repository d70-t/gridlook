<script lang="ts" setup>
import { useEventListener } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, onMounted, ref, watch, type Ref } from "vue";

import type {
  TModelInfo,
  TSnapshotOptions,
  TSources,
} from "../lib/types/GlobeTypes";

import {
  getGridType,
  GRID_TYPES,
  type T_GRID_TYPES,
} from "@/lib/data/gridTypeDetector";
import { indexFromIndex, indexFromZarr } from "@/lib/data/sourceIndexing";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager";
import { PROJECTION_TYPES, clamp } from "@/lib/projection/projectionUtils";
import {
  availableColormaps,
  type TColorMap,
} from "@/lib/shaders/colormapShaders";
import { PresenterRole } from "@/lib/types/presenterSync";
import { useUrlParameterStore } from "@/store/paramStore";
import { useGlobeControlStore } from "@/store/store";
import {
  usePresenterSync,
  isDisplayMode,
  isPresenterActive,
} from "@/store/usePresenterSync";
import { useUrlSync } from "@/store/useUrlSync";
import Toast from "@/ui/common/Toast.vue";
import { isMobileDevice } from "@/ui/common/viewConstants";
import type { TCameraState } from "@/ui/grids/composables/useGridCameraState";
import GridCurvilinear from "@/ui/grids/Curvilinear.vue";
import GridGaussianReduced from "@/ui/grids/GaussianReduced.vue";
import GridHealpix from "@/ui/grids/Healpix.vue";
import GridIrregular from "@/ui/grids/Irregular.vue";
import GridIrregularDelaunay from "@/ui/grids/IrregularDelaunay.vue";
import GridRegular from "@/ui/grids/Regular.vue";
import GridTriangular from "@/ui/grids/Triangular.vue";
import AboutView from "@/ui/overlays/AboutModal.vue";
import GlobeControls from "@/ui/overlays/Controls.vue";
import HoverReadout from "@/ui/overlays/HoverReadout.vue";
import InfoPanel from "@/ui/overlays/InfoPanel.vue";
import { useLog } from "@/utils/logging";

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
  if (
    urlParameterStore.paramProjectionCenterLat ||
    urlParameterStore.paramProjectionCenterLon
  ) {
    const lat = parseFloat(urlParameterStore.paramProjectionCenterLat ?? "0");
    const lon = parseFloat(urlParameterStore.paramProjectionCenterLon ?? "0");
    store.projectionCenter = {
      lat: clamp(lat, -90, 90),
      lon: clamp(lon, -180, 180),
    };
  }
}

const { varnameSelector, loading, colormap, invertColormap } =
  storeToRefs(store);

const { paramVarname, paramGridType } = storeToRefs(urlParameterStore);

type TGlobeHandle = {
  makeSnapshot: (options: TSnapshotOptions) => void;
  toggleRotate: () => void;
  applyCameraPreset: (state: TCameraState) => void;
};

const HYPERGLOBE_CAMERA_PRESET: TCameraState = {
  position: [0, 0, 33],
  quaternion: [0, 0, 0, 1],
  fov: 7.5,
  aspect: 1,
  near: 0.1,
  far: 1000,
};

const globe: Ref<TGlobeHandle | null> = ref(null);
const distractionFree = ref(false);
const hyperglobeModeActive = ref(false);
const panelVisibleBeforeDistractionFree = ref(true);
const globeKey = ref(0);
const globeControlKey = ref(0);
const isInitialized = ref(false);
const sourceValid = ref(false);
const datasources: Ref<TSources | undefined> = ref(undefined);
const detectedGridType: Ref<T_GRID_TYPES | undefined> = ref(undefined);
const infoPanelOpen = ref(false);

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

async function setGridType() {
  if (!isInitialized.value) {
    return;
  }
  const localGridType = await getGridType(
    sourceValid.value,
    varnameSelector.value,
    datasources.value,
    logError
  );
  detectedGridType.value = localGridType;
  if (localGridType === GRID_TYPES.ERROR) {
    store.stopLoading();
  }
}

watch(
  () => props.src,
  async () => {
    // Rerender controls and globe and reset store
    // if new data is provided
    detectedGridType.value = undefined;
    globeKey.value += 1;
    globeControlKey.value += 1;
    if (isDisplayMode.value || isPresenterActive.value) {
      // In display/presenter mode we want to preserve some state across source changes
      store.resetExcept(["projectionMode", "projectionCenter"]);
    } else {
      store.$reset();
    }
    // stop loading is handled in the grid components after data load
    store.startLoading();
    await updateSrc();
  }
);

watch(
  () => varnameSelector.value,
  async () => {
    if (!varnameSelector.value || varnameSelector.value === "-") {
      return;
    }
    await setGridType();
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
    paramVarname.value ?? modelInfo.value!.defaultVar ?? validVars[0];

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

const updateSrc = async () => {
  const src = props.src;
  ZarrDataManager.invalidateCache();
  // FIXME: Trying zarr and json-index in parallel and picking the first that
  // works. If both fail, we log the last error which is from the json-index.
  // This leads to confusing error messages if the zarr source is supposed to
  // work but fails for some reason.
  const indices = await Promise.allSettled([
    indexFromZarr(src),
    indexFromIndex(src),
  ]);
  let lastError = null;
  store.isInitializingVariable = true;
  sourceValid.value = false;
  for (const index of indices) {
    if (index.status === "fulfilled") {
      sourceValid.value = true;
      prepareDefaults(src, index.value);
      break;
    } else {
      lastError = index.reason;
    }
  }
  if (!sourceValid.value && lastError) {
    store.stopLoading();
    logError(lastError, "Failed to fetch data");
    setGridType();
  }
};

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
  // stop loading is handled in the grid components after data load
  store.startLoading();
  await updateSrc();
  isInitialized.value = true;
  await setGridType();
});

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
  if (key === "r") {
    toggleRotate();
  } else if (key === "d") {
    toggleDistractionFree();
  } else if (key === "g") {
    applyHyperglobePreset();
  } else if (key === "h" && !isMobileDevice()) {
    applyHyperglobePresenter();
  }
});
</script>

<template>
  <main>
    <Toast />
    <div v-show="!distractionFree && !isDisplayMode">
      <GlobeControls
        :key="globeControlKey"
        :model-info="modelInfo"
        :current-source="props.src"
        @on-snapshot="makeSnapshot"
        @on-rotate="toggleRotate"
        @toggle-display="toggleDisplayWindow"
      />
    </div>

    <div v-if="loading" class="top-right-loader loader" />
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
    <div v-else-if="detectedGridType !== undefined" class="grid-canvas-wrapper">
      <currentGlobeComponent
        ref="globe"
        :key="globeKey"
        :datasources="datasources"
        :is-rotated="detectedGridType === GRID_TYPES.REGULAR_ROTATED"
      />
      <HoverReadout />
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
        @toggle="toggleInfoPanel"
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
