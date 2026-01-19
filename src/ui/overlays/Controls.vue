<script lang="ts" setup>
import { useEventListener } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, onBeforeMount, onMounted, ref, watch, type Ref } from "vue";

import ActionControls from "./controls/ActionControls.vue";
import BoundsControls from "./controls/BoundsControls.vue";
import ColormapControls from "./controls/ColormapControls.vue";
import DataInput from "./controls/DataInput.vue";
import DimensionControl from "./controls/DimensionControl.vue";
import DimensionSliders from "./controls/DimensionSliders.vue";
import MaskControls from "./controls/MaskControls.vue";
import ProjectionControls from "./controls/ProjectionControls.vue";
import TimeControls from "./controls/TimeControls.vue";
import VariableSelector from "./controls/VariableSelector.vue";

// Import control components
import { clamp, type TProjectionType } from "@/lib/projection/projectionUtils";
import type { TBounds, TModelInfo } from "@/lib/types/GlobeTypes";
import { useUrlParameterStore } from "@/store/paramStore";
import { useGlobeControlStore } from "@/store/store";
import { MOBILE_BREAKPOINT } from "@/ui/common/viewConstants";

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
  <div class="header-container">
    <div class="header-content">
      <div v-if="modelInfo" class="mobile-title">
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
  </div>
  <Transition name="slide">
    <nav
      v-if="modelInfo && !isHidden"
      id="main_controls"
      class="panel gl_controls"
    >
      <div class="full-panel">
        <DataInput />
        <VariableSelector v-model="varnameSelector" :model-info="modelInfo" />
        <DimensionControl />
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
    </nav>
  </Transition>
</template>

<style lang="scss">
@use "bulma/sass/utilities" as bulmaUt;

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
  background: var(--bulma-scheme-main);
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
}

@media (prefers-color-scheme: dark) {
  .header-container {
    background: var(--bulma-scheme-main);
  }
}

.gl_controls {
  margin-top: 56px;
  width: 24rem;
  min-width: 0;
  overflow-y: auto;
  flex-shrink: 0;
  z-index: 10;

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

  @media only screen and (max-width: bulmaUt.$tablet) {
    width: 100%;
    position: fixed;
    height: 95%;
    border-radius: 0 !important;

    &.panel {
      border-radius: 0 !important;
    }

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
