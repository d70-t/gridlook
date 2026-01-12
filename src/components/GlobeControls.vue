<script lang="ts" setup>
import { useEventListener } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, onBeforeMount, onMounted, ref, watch, type Ref } from "vue";

import type { TModelInfo, TBounds } from "../types/GlobeTypes.js";

import ActionControls from "./controls/ActionControls.vue";
import BoundsControls from "./controls/BoundsControls.vue";
import ColormapControls from "./controls/ColormapControls.vue";
import DimensionSliders from "./controls/DimensionSliders.vue";
import MaskControls from "./controls/MaskControls.vue";
import TimeControls from "./controls/TimeControls.vue";
import VariableSelector from "./controls/VariableSelector.vue";
import DataInput from "./controls/DataInput.vue";
import { useUrlParameterStore } from "./store/paramStore.ts";

// Import control components
import { useGlobeControlStore } from "./store/store.ts";
import { MOBILE_BREAKPOINT } from "./utils/viewConstants.ts";
import ProjectionControls from "./controls/ProjectionControls.vue";
import { clamp, type TProjectionType } from "./utils/projectionUtils.ts";

const props = defineProps<{ modelInfo?: TModelInfo }>();

defineEmits<{
  onSnapshot: [];
  onRotate: [];
}>();

// Bounds management types
const BOUND_MODES = {
  AUTO: "auto",
  DATA: "data",
  DEFAULT: "default",
  USER: "user",
} as const;

type TBoundModes = (typeof BOUND_MODES)[keyof typeof BOUND_MODES];

const store = useGlobeControlStore();
const {
  colormap,
  invertColormap,
  varnameSelector,
  landSeaMaskChoice,
  landSeaMaskUseTexture,
  varinfo,
  userBoundsLow,
  userBoundsHigh,
  projectionCenter,
} = storeToRefs(store);

// Bounds logic state
const pickedBoundsMode = ref<TBoundModes>(BOUND_MODES.AUTO);
const defaultBounds = ref<TBounds>({});

// Colormap logic state
const autoColormap = ref<boolean>(true);

const urlParameterStore = useUrlParameterStore();
const {
  paramColormap,
  paramInvertColormap,
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

const activeBoundsMode = computed(() => {
  if (pickedBoundsMode.value === BOUND_MODES.AUTO) {
    if (
      userBoundsLow.value !== undefined &&
      userBoundsHigh.value !== undefined &&
      // if the input-fields are empty, they are interpreted as "" instead of a number
      (userBoundsHigh.value as unknown as string) !== "" &&
      (userBoundsLow.value as unknown as string) !== ""
    ) {
      return BOUND_MODES.USER;
    } else if (
      defaultBounds.value.low !== undefined &&
      defaultBounds.value.high !== undefined
    ) {
      return BOUND_MODES.DEFAULT;
    } else {
      return BOUND_MODES.DATA;
    }
  } else {
    return pickedBoundsMode.value;
  }
});

const currentBounds = computed(() => {
  if (activeBoundsMode.value === BOUND_MODES.DATA) {
    return dataBounds.value;
  } else if (activeBoundsMode.value === BOUND_MODES.USER) {
    return {
      low: userBoundsLow.value,
      high: userBoundsHigh.value,
    };
  } else if (activeBoundsMode.value === BOUND_MODES.DEFAULT) {
    return defaultBounds.value;
  }
  return undefined;
});

const setDefaultBounds = () => {
  const defaultConfig = props.modelInfo?.vars[varnameSelector.value];
  defaultBounds.value = defaultConfig?.default_range ?? {};
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
    setDefaultBounds();
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

  // Initialize control panel visibility
  const initiallyVisible = isMobileView.value
    ? !mobileMenuCollapsed.value
    : !menuCollapsed.value;
  store.setControlPanelVisible(initiallyVisible);
});
</script>

<template>
  <nav
    id="main_controls"
    class="panel gl_controls"
    :class="{ 'mobile-visible': !isHidden }"
  >
    <div class="panel-heading">
      <div
        v-if="modelInfo"
        class="mobile-title text-wrap is-flex is-align-items-center"
        style="display: flex; align-items: center"
      >
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
      <div v-else>No data available</div>
      <button type="button" class="is-hidden-mobile" @click="toggleMenu">
        <i
          class="fa-solid"
          :class="{
            'fa-angle-right': menuCollapsed,
            'fa-angle-left': !menuCollapsed,
          }"
        ></i>
      </button>
    </div>

    <Transition name="slide">
      <div v-if="modelInfo && !isHidden" class="controls-scroll full-panel">
        <DataInput />
        <VariableSelector v-model="varnameSelector" :model-info="modelInfo" />
        <TimeControls />
        <DimensionSliders />
        <BoundsControls
          :picked-bounds-mode="pickedBoundsMode"
          :active-bounds-mode="activeBoundsMode"
          :data-bounds="dataBounds"
          :default-bounds="defaultBounds"
          :current-bounds="currentBounds"
          :bound-modes="BOUND_MODES"
          @update:picked-bounds-mode="pickedBoundsMode = $event as TBoundModes"
        />
        <ColormapControls
          :model-info="modelInfo"
          :auto-colormap="autoColormap"
          @update:auto-colormap="autoColormap = $event"
        />
        <ProjectionControls />
        <MaskControls />
        <ActionControls
          @on-snapshot="() => $emit('onSnapshot')"
          @on-rotate="() => $emit('onRotate')"
        />
      </div>
    </Transition>
  </nav>
</template>

<style lang="scss">
@use "bulma/sass/utilities" as bulmaUt;

.gl_controls {
  position: fixed;
  top: 0;
  left: 0;
  width: 24rem;
  max-height: 100vh; // Full screen height limit
  overflow-y: auto;
  overflow-x: hidden;
  border-radius: 0 0 bulmaUt.$radius bulmaUt.$radius !important;
  z-index: 9;

  .full-panel {
    background: var(--bulma-scheme-main);
  }
  .panel-block {
    padding: 0.75em 0.8em;
  }

  .column {
    padding: 0.5em;
  }

  input {
    margin-right: 3px;
  }

  .panel-heading {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: nowrap;
    overflow: visible;
    padding-left: 16px;
    padding-right: 16px;
    padding-top: 12px;
    padding-bottom: 12px;
    border-radius: 0;
    font-size: 1.1rem;
  }

  .panel-heading .mobile-title {
    flex: 1;
    min-width: 0;
  }

  .ellipsis {
    overflow: hidden;
    word-break: break-word;
    white-space: nowrap;
    text-overflow: ellipsis;
    display: block;
    width: 100%;
  }

  @media only screen and (max-width: bulmaUt.$tablet) {
    width: 100%;
    height: auto;
    right: 0;
    border-radius: 0 !important;

    &.panel {
      border-radius: 0 !important;
    }

    .panel-heading .mobile-title {
      flex: 1;
      min-width: 0;
    }

    &.mobile-visible {
      max-height: 100vh;
    }
  }

  @media (prefers-color-scheme: dark) {
    .panel-heading {
      background: var(--bulma-scheme-main);
    }
  }

  .slide-enter-active,
  .slide-leave-active {
    transition: all 0.3s ease-out;
  }

  .slide-enter-from,
  .slide-leave-to {
    transform: translateX(-400px);
  }

  @media only screen and (max-width: bulmaUt.$tablet) {
    .slide-enter-active,
    .slide-leave-active {
      transition: all 0.3s ease-out;
    }

    .slide-enter-from,
    .slide-leave-to {
      transform: translateY(-400px);
    }
  }
}
</style>
