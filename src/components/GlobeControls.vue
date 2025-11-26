<script lang="ts" setup>
import { computed, onMounted, ref, watch, type Ref } from "vue";
import { useGlobeControlStore } from "./store/store.ts";
import { storeToRefs } from "pinia";
import type { TModelInfo, TBounds } from "../types/GlobeTypes.js";
import { useUrlParameterStore } from "./store/paramStore.ts";
import { useEventListener } from "@vueuse/core";

// Import new components
import VariableSelector from "./controls/VariableSelector.vue";
import TimeControls from "./controls/TimeControls.vue";
import DimensionSliders from "./controls/DimensionSliders.vue";
import BoundsControls from "./controls/BoundsControls.vue";
import ColormapControls from "./controls/ColormapControls.vue";
import MaskControls from "./controls/MaskControls.vue";
import ActionControls from "./controls/ActionControls.vue";

defineProps<{ modelInfo?: TModelInfo }>();

defineEmits<{
  onSnapshot: [];
  onRotate: [];
}>();

const store = useGlobeControlStore();
const {
  colormap,
  invertColormap,
  varnameSelector,
  landSeaMaskChoice,
  landSeaMaskUseTexture,
} = storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const {
  paramColormap,
  paramInvertColormap,
  paramMaskMode,
  paramMaskingUseTexture,
} = storeToRefs(urlParameterStore);

const menuCollapsed: Ref<boolean> = ref(false);
const mobileMenuCollapsed: Ref<boolean> = ref(true);
const isMobileView: Ref<boolean> = ref(false);

// Component refs
const boundsControlsRef = ref<InstanceType<typeof BoundsControls>>();
const colormapControlsRef = ref<InstanceType<typeof ColormapControls>>();

const isHidden = computed(() => {
  return (
    (isMobileView.value && mobileMenuCollapsed.value) || menuCollapsed.value
  );
});

watch(
  () => varnameSelector.value,
  () => {
    boundsControlsRef.value?.setDefaultBounds();
    colormapControlsRef.value?.setDefaultColormap();
    store.updateBounds(boundsControlsRef.value?.bounds as TBounds);
  }
);

watch(
  () => boundsControlsRef.value?.bounds,
  () => {
    store.updateBounds(boundsControlsRef.value?.bounds as TBounds);
  }
);

function toggleMenu() {
  menuCollapsed.value = !menuCollapsed.value;
}

function toggleMobileMenu() {
  mobileMenuCollapsed.value = !mobileMenuCollapsed.value;
}

const MOBILE_VIEW_THRESHOLD = 769; // px

onMounted(() => {
  isMobileView.value = window.innerWidth < MOBILE_VIEW_THRESHOLD;
  useEventListener(window, "resize", () => {
    isMobileView.value = window.innerWidth < MOBILE_VIEW_THRESHOLD;
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

// Initialize bounds and colormap when component mounts
onMounted(() => {
  boundsControlsRef.value?.setDefaultBounds();
  store.updateBounds(boundsControlsRef.value?.bounds as TBounds);

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
});
</script>

<template>
  <nav
    id="main_controls"
    class="panel gl_controls"
    :class="{ 'mobile-visible': !isHidden }"
  >
    <div
      class="panel-heading"
      style="display: flex; justify-content: space-between"
    >
      <button
        type="button"
        class="button is-primary is-hidden-tablet mr-1"
        @click="toggleMobileMenu"
      >
        <i class="fa-solid fa-bars"></i>
      </button>
      <div v-if="modelInfo" class="mobile-title text-wrap">
        {{ modelInfo.title }}
      </div>
      <div v-else>no data available</div>
      <button type="button" class="is-hidden-mobile">
        <i
          class="fa-solid"
          :class="{
            'fa-angle-down': menuCollapsed,
            'fa-angle-up': !menuCollapsed,
          }"
          @click="toggleMenu"
        ></i>
      </button>
    </div>

    <!-- Variable Selector -->
    <VariableSelector
      v-if="modelInfo && !isHidden"
      v-model="varnameSelector"
      :model-info="modelInfo"
    />

    <!-- Time Controls -->
    <TimeControls v-if="modelInfo && !isHidden" />

    <!-- Dimension Sliders -->
    <DimensionSliders v-if="modelInfo && !isHidden" />

    <!-- Bounds Controls -->
    <BoundsControls
      v-if="modelInfo && !isHidden"
      ref="boundsControlsRef"
      :model-info="modelInfo"
    />

    <!-- Colormap Controls -->
    <ColormapControls
      v-if="modelInfo && !isHidden"
      ref="colormapControlsRef"
      :model-info="modelInfo"
    />

    <!-- Mask Controls -->
    <MaskControls
      v-if="modelInfo && !isHidden"
      @on-rotate="() => $emit('onRotate')"
    />

    <!-- Action Controls -->
    <ActionControls
      v-if="modelInfo && !isHidden"
      @on-snapshot="() => $emit('onSnapshot')"
    />
  </nav>
</template>

<style lang="scss">
@use "bulma/sass/utilities" as bulmaUt;

.gl_controls {
  position: fixed;
  top: 0;
  left: 0;
  width: 25rem;
  max-height: 100vh; // Full screen height limit
  overflow-y: auto;
  overflow-x: hidden;
  border-radius: 0 0 bulmaUt.$radius bulmaUt.$radius !important;
  // background-color: white;
  z-index: 9;

  .panel-block {
    background-color: white;
  }

  input {
    margin-right: 3px;
  }

  .panel-heading {
    border-radius: 0;
  }

  @media only screen and (max-width: bulmaUt.$tablet) {
    width: 100%;
    height: auto;
    right: 0;
    border-radius: 0 !important;
    animation: 0.45s ease-out 0s 1 slideInFromTop;

    @keyframes slideInFromTop {
      from {
        transform: translateY(-100%);
      }

      to {
        transform: translateY(0);
      }
    }

    &.panel {
      border-radius: 0 !important;
    }

    .panel-heading .mobile-title {
      float: right;
    }

    &.mobile-visible {
      max-height: 100vh;
      height: 100vh;
    }
  }

  @media (prefers-color-scheme: dark) {
    .panel-block {
      background-color: rgba(15, 15, 15, 0.8);
    }

    .panel-heading {
      background-color: rgb(15, 15, 15);
      color: white;
    }
  }
}
</style>
