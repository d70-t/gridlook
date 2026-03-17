<script lang="ts" setup>
import { useEventListener } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, onBeforeMount, onMounted, ref, watch, type Ref } from "vue";

import ActionControls from "./controls/ActionControls.vue";
import BoundsControls from "./controls/BoundsControls.vue";
import ColormapControls from "./controls/ColormapControls.vue";
import DataInput from "./controls/DataInput.vue";
import DimensionControl from "./controls/DimensionControl.vue";
import MaskControls from "./controls/MaskControls.vue";
import ProjectionControls from "./controls/ProjectionControls.vue";
import VariableSelector from "./controls/VariableSelector.vue";

// Import control components
import { clamp, type TProjectionType } from "@/lib/projection/projectionUtils";
import type {
  TBounds,
  TModelInfo,
  TSnapshotOptions,
} from "@/lib/types/GlobeTypes";
import { useUrlParameterStore } from "@/store/paramStore";
import { useGlobeControlStore } from "@/store/store";
import { MOBILE_BREAKPOINT } from "@/ui/common/viewConstants";

const props = defineProps<{ modelInfo?: TModelInfo; currentSource: string }>();

defineEmits<{
  onSnapshot: [options: TSnapshotOptions];
  onRotate: [];
}>();

// Bounds management types
const BOUND_MODES = {
  DATA: "data",
  USER: "user",
} as const;

type TBoundModes = (typeof BOUND_MODES)[keyof typeof BOUND_MODES];

const store = useGlobeControlStore();
const {
  colormap,
  invertColormap,
  posterizeLevels,
  varnameSelector,
  landSeaMaskChoice,
  landSeaMaskUseTexture,
  varinfo,
  userBoundsLow,
  userBoundsHigh,
  projectionCenter,
} = storeToRefs(store);

// Bounds logic state
const pickedBoundsMode = ref<TBoundModes>(BOUND_MODES.DATA);
const defaultBounds = ref<TBounds>({});
// True until the varnameSelector watcher fires for the first time.
// Used to preserve URL-provided bounds on first load.
const isInitialVarLoad = ref(true);

// Colormap logic state
const autoColormap = ref<boolean>(true);

const urlParameterStore = useUrlParameterStore();
const {
  paramColormap,
  paramInvertColormap,
  paramPosterizeLevels,
  paramMaskMode,
  paramMaskingUseTexture,
  paramProjection,
  paramProjectionCenterLat,
  paramProjectionCenterLon,
} = storeToRefs(urlParameterStore);

const menuCollapsed: Ref<boolean> = ref(false);
const mobileMenuCollapsed: Ref<boolean> = ref(true);
const isMobileView: Ref<boolean> = ref(false);

const dataBounds = computed(() => {
  return varinfo.value?.bounds ?? {};
});

const currentBounds = computed(() => {
  if (pickedBoundsMode.value === BOUND_MODES.DATA) {
    return dataBounds.value;
  } else if (pickedBoundsMode.value === BOUND_MODES.USER) {
    const lowEmpty =
      userBoundsLow.value === undefined ||
      (userBoundsLow.value as unknown as string) === "";
    const highEmpty =
      userBoundsHigh.value === undefined ||
      (userBoundsHigh.value as unknown as string) === "";
    const lo = (
      lowEmpty ? dataBounds.value.low : userBoundsLow.value
    ) as number;
    const hi = (
      highEmpty ? dataBounds.value.high : userBoundsHigh.value
    ) as number;
    // Always deliver a normalised (non-inverted) range downstream so that
    // nothing breaks when the user types high < low.  The BoundsControls
    // component shows a visual indicator when the values are swapped.
    return {
      low: lo <= hi ? lo : hi,
      high: lo <= hi ? hi : lo,
    };
  }
  return undefined;
});

const setDefaultBounds = () => {
  const defaultConfig = props.modelInfo?.vars[varnameSelector.value];
  if (defaultConfig?.default_range) {
    userBoundsLow.value = defaultConfig.default_range.low;
    userBoundsHigh.value = defaultConfig.default_range.high;
    return;
  }
};

const setDefaultColormap = () => {
  const defaultColormap =
    props.modelInfo?.vars[varnameSelector.value]?.default_colormap;
  if (autoColormap.value && defaultColormap !== undefined) {
    invertColormap.value = defaultColormap.inverted || false;
    colormap.value = defaultColormap.name;
  }
};

const isHidden = computed(() => {
  return (
    (isMobileView.value && mobileMenuCollapsed.value) || menuCollapsed.value
  );
});

watch(
  () => varnameSelector.value,
  () => {
    // On the very first variable load, URL-provided bounds (already written to
    // the store by HashGlobeView) must not be overwritten by the variable's
    // default_range config.  On subsequent variable changes we always want to
    // reset to the new variable's defaults.
    const preserveUrlBounds =
      isInitialVarLoad.value &&
      userBoundsLow.value !== undefined &&
      userBoundsHigh.value !== undefined;
    isInitialVarLoad.value = false;

    if (!preserveUrlBounds) {
      store.resetUserBounds();
      setDefaultBounds();
    }
    if (
      userBoundsHigh.value === undefined ||
      userBoundsLow.value === undefined
    ) {
      pickedBoundsMode.value = BOUND_MODES.DATA;
    } else {
      pickedBoundsMode.value = BOUND_MODES.USER;
    }
    setDefaultColormap();
    store.updateBounds(currentBounds.value as TBounds);
  }
);

watch(
  () => currentBounds.value,
  () => {
    store.updateBounds(currentBounds.value as TBounds);
  },
  { deep: true }
);

watch(
  () => autoColormap.value,
  () => {
    setDefaultColormap();
  }
);

function onPickedBoundsModeChange(newMode: TBoundModes) {
  if (newMode === BOUND_MODES.USER) {
    const lowEmpty =
      userBoundsLow.value === undefined ||
      (userBoundsLow.value as unknown as string) === "";
    const highEmpty =
      userBoundsHigh.value === undefined ||
      (userBoundsHigh.value as unknown as string) === "";
    if (lowEmpty) {
      userBoundsLow.value = dataBounds.value.low as number;
    }
    if (highEmpty) {
      userBoundsHigh.value = dataBounds.value.high as number;
    }
  }
  pickedBoundsMode.value = newMode;
}

function toggleMenu() {
  menuCollapsed.value = !menuCollapsed.value;
  store.setControlPanelVisible(!menuCollapsed.value);
}

function toggleMobileMenu() {
  mobileMenuCollapsed.value = !mobileMenuCollapsed.value;
  store.setControlPanelVisible(!mobileMenuCollapsed.value);
}

onBeforeMount(() => {
  isMobileView.value = window.innerWidth < MOBILE_BREAKPOINT;
  useEventListener(window, "resize", () => {
    isMobileView.value = window.innerWidth < MOBILE_BREAKPOINT;
  });
});

// INITIALIZATION
if (paramMaskingUseTexture.value) {
  if (paramMaskingUseTexture.value === "false") {
    landSeaMaskUseTexture.value = false;
  } else if (paramMaskingUseTexture.value === "true") {
    landSeaMaskUseTexture.value = true;
  }
}

if (paramMaskMode.value) {
  landSeaMaskChoice.value =
    paramMaskMode.value as typeof landSeaMaskChoice.value;
}

if (paramProjection.value) {
  store.projectionMode = paramProjection.value as TProjectionType;
}

if (paramProjectionCenterLat.value || paramProjectionCenterLon.value) {
  const lat = parseFloat(paramProjectionCenterLat.value ?? "0");
  const lon = parseFloat(paramProjectionCenterLon.value ?? "0");
  projectionCenter.value = {
    lat: clamp(lat, -90, 90),
    lon: clamp(lon, -180, 180),
  };
}

// Initialize bounds and colormap when component mounts
onMounted(() => {
  setDefaultBounds();
  store.updateBounds(currentBounds.value as TBounds);

  if (paramColormap.value) {
    colormap.value = paramColormap.value;
  }

  if (paramInvertColormap.value) {
    // explicitely check for string values "true" and "false"
    if (paramInvertColormap.value === "false") {
      invertColormap.value = false;
    } else if (paramInvertColormap.value === "true") {
      invertColormap.value = true;
    }
  }

  if (paramPosterizeLevels.value) {
    const levels = Number(paramPosterizeLevels.value);
    if (!isNaN(levels) && levels >= 0 && levels <= 32) {
      posterizeLevels.value = levels;
    }
  }

  // Initialize control panel visibility
  const initiallyVisible = isMobileView.value
    ? !mobileMenuCollapsed.value
    : !menuCollapsed.value;
  store.setControlPanelVisible(initiallyVisible);
});
</script>

<template>
  <div class="header-container">
    <div class="header-content">
      <div v-if="modelInfo" class="title-bar mobile-title">
        <button
          type="button"
          class="button is-primary is-hidden-tablet p-3 mr-3"
          @click="toggleMobileMenu"
        >
          <i class="fa-solid fa-bars"></i>
        </button>
        <span class="ellipsis" :title="modelInfo.title">
          {{ modelInfo.title }}
        </span>
      </div>
      <div v-else class="title-bar">No data available</div>
      <DataInput :current-source="currentSource" />
      <button
        type="button"
        class="is-hidden-mobile panel-toggle"
        @click="toggleMenu"
      >
        <i
          class="fa-solid"
          :class="{
            'fa-angle-right': menuCollapsed,
            'fa-angle-left': !menuCollapsed,
          }"
        ></i>
      </button>
    </div>
  </div>

  <template v-if="modelInfo">
    <Transition name="slide">
      <nav v-show="!isHidden" id="main_controls" class="gl_controls">
        <div class="full-panel">
          <div class="box m-2 p-2">
            <div class="section-title">Variable</div>
            <VariableSelector
              v-model="varnameSelector"
              :model-info="modelInfo"
            />
            <DimensionControl />
          </div>
          <div class="box m-2 p-2">
            <div class="section-title">Bounds & Colormap</div>
            <BoundsControls
              :picked-bounds-mode="pickedBoundsMode"
              :data-bounds="dataBounds"
              :default-bounds="defaultBounds"
              :current-bounds="currentBounds"
              :bound-modes="BOUND_MODES"
              @update:picked-bounds-mode="
                onPickedBoundsModeChange($event as TBoundModes)
              "
            />
            <ColormapControls
              :model-info="modelInfo"
              :auto-colormap="autoColormap"
              :data-bounds="dataBounds"
              @update:auto-colormap="autoColormap = $event"
              @force-user-bounds="pickedBoundsMode = BOUND_MODES.USER"
            />
            <div class="section-title mt-2">Projections</div>
            <ProjectionControls />
            <div class="section-title">Masks</div>
            <MaskControls />
          </div>
          <div class="box m-2 p-2">
            <div class="section-title">Actions</div>
            <ActionControls
              @on-snapshot="(opts) => $emit('onSnapshot', opts)"
              @on-rotate="() => $emit('onRotate')"
            />
          </div>
        </div>
      </nav>
    </Transition>
  </template>
</template>

<style lang="scss">
@use "bulma/sass/utilities" as bulmaUt;

.header-content .data-input-trigger {
  order: 0;
}

.title-bar {
  order: 1;
}

.panel-toggle {
  order: 2;
}

.section-title {
  font-weight: 700 !important;
  text-transform: uppercase !important;
  font-size: 0.75rem !important;
  padding-right: 0.5rem !important;
  padding-left: 0.5rem !important;
  padding-top: 0.5rem !important;
  color: var(--bulma-grey) !important;
}

.header-container {
  flex-wrap: nowrap;
  overflow: visible;
  border-radius: 0;
  font-size: 1.1rem;
  position: fixed;

  width: 24rem;
  z-index: 10;
  height: 56px;
  display: flex;
  align-items: center;
  background-color: var(--bulma-body-color);
  color: white;
  font-weight: bold;
  padding: 0 16px;
  @media only screen and (max-width: bulmaUt.$tablet) {
    width: 100%;
  }
}

.header-content {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  justify-content: space-between;
  width: 100%;
}

.header-content > button {
  flex-shrink: 0;
}

.mobile-title {
  display: flex;
  align-items: center;
  flex: 1 1 0;
  min-width: 0;
  overflow: hidden;
}

.mobile-title > button {
  flex-shrink: 0;
}

.ellipsis {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  min-width: 0;
  flex: 1 1 auto;
}

@media only screen and (max-width: bulmaUt.$tablet) {
  .header-content .mobile-title {
    flex: 1;
    min-width: 0;
    overflow: auto;
  }

  .header-content .data-input-trigger {
    order: 2;
    margin-left: auto;
  }
}

@media (prefers-color-scheme: dark) {
  .header-container {
    background: var(--bulma-scheme-main);
  }
  .gl_controls {
    background-color: var(--bulma-scheme-main) !important;
    .box {
      color: rgb(235, 236, 240) !important;
    }
  }
}

.gl_controls {
  scrollbar-width: thin;
  margin-top: 56px;
  width: 24rem;
  min-width: 0;
  overflow-y: auto;
  flex-shrink: 0;
  z-index: 10;
  background-color: #ddd;
  color: black;

  .panel-block {
    padding: 0.75em 0.8em;
  }

  .column {
    padding: 0.5em;
  }

  input {
    margin-right: 3px;
  }

  @media only screen and (max-width: bulmaUt.$tablet) {
    width: 100%;
    position: fixed;
    height: 95%;
    border-radius: 0 !important;

    &.mobile-visible {
      max-height: 100vh;
    }
  }

  &.slide-enter-active,
  &.slide-leave-active {
    transition: width 0.3s ease-out;
  }

  &.slide-enter-from,
  &.slide-leave-to {
    width: 0;
  }

  @media only screen and (max-width: bulmaUt.$tablet) {
    &.slide-enter-active,
    &.slide-leave-active {
      transition: height 0.3s ease-in;
    }

    &.slide-enter-from,
    &.slide-leave-to {
      width: 100%;
      height: 0;
    }
  }
}
</style>
