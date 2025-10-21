<script lang="ts" setup>
import ColorBar from "@/components/ColorBar.vue";
import { computed, onMounted, onUnmounted, ref, watch, type Ref } from "vue";
import { useGlobeControlStore } from "./store/store.ts";
import { storeToRefs } from "pinia";
import type { TModelInfo, TBounds } from "../types/GlobeTypes.js";
import { useUrlParameterStore } from "./store/paramStore.ts";

const props = defineProps<{ modelInfo?: TModelInfo }>();

defineEmits<{
  onSnapshot: [];
  onExample: [];
  onRotate: [];
}>();

const BOUND_MODES = {
  AUTO: "auto",
  DATA: "data",
  DEFAULT: "default",
  USER: "user",
} as const;

type TBoundModes = (typeof BOUND_MODES)[keyof typeof BOUND_MODES];

const store = useGlobeControlStore();
const {
  timeIndexSlider,
  colormap,
  invertColormap,
  varnameSelector,
  varinfo,
  userBoundsLow,
  userBoundsHigh,
} = storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const { paramColormap, paramTimeIndex } = storeToRefs(urlParameterStore);

const menuCollapsed: Ref<boolean> = ref(false);
const mobileMenuCollapsed: Ref<boolean> = ref(true);
const isMobileView: Ref<boolean> = ref(false);
const autoColormap: Ref<boolean> = ref(true);
const defaultBounds: Ref<TBounds> = ref({});
const pickedBounds: Ref<TBoundModes> = ref(BOUND_MODES.AUTO);

const activeBoundsMode = computed(() => {
  if (pickedBounds.value === BOUND_MODES.AUTO) {
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
    return pickedBounds.value;
  }
});

const dataBounds = computed(() => {
  return varinfo.value?.bounds ?? {};
});

const bounds = computed(() => {
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

const timeRange = computed(() => {
  return varinfo.value?.timeRange ?? { start: 0, end: 1 };
});

const currentTimeValue = computed(() => {
  return varinfo.value?.timeinfo?.current;
});

const currentVarName = computed(() => {
  return store.varnameDisplay ?? "-";
});

const currentVarLongname = computed(() => {
  return varinfo.value?.attrs?.long_name ?? "-";
});

const currentVarUnits = computed(() => {
  return varinfo.value?.attrs?.units ?? "-";
});

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
    store.updateBounds(bounds.value as TBounds);
  }
);

watch(
  () => bounds.value,
  () => {
    store.updateBounds(bounds.value as TBounds);
  }
);

watch(
  () => autoColormap,
  () => {
    setDefaultColormap();
  }
);

function setDefaultBounds() {
  const defaultConfig = props.modelInfo?.vars[varnameSelector.value];
  defaultBounds.value = defaultConfig?.default_range ?? {};
}

function toggleMenu() {
  menuCollapsed.value = !menuCollapsed.value;
}

function toggleMobileMenu() {
  mobileMenuCollapsed.value = !mobileMenuCollapsed.value;
}

const setDefaultColormap = () => {
  console.log(props.modelInfo?.vars, varnameSelector.value);
  const defaultColormap =
    props.modelInfo?.vars[varnameSelector.value].default_colormap;
  if (autoColormap.value && defaultColormap !== undefined) {
    invertColormap.value = defaultColormap.inverted || false;
    colormap.value = defaultColormap.name;
  }
};

const MOBILE_VIEW_THRESHOLD = 769; // px

onMounted(() => {
  isMobileView.value = window.innerWidth < MOBILE_VIEW_THRESHOLD;
  window.addEventListener("resize", () => {
    isMobileView.value = window.innerWidth < MOBILE_VIEW_THRESHOLD;
  });
});

onUnmounted(() => {
  window.removeEventListener("resize", () => {
    isMobileView.value = window.innerWidth < MOBILE_VIEW_THRESHOLD;
  });
});

// INITIALIZATION
setDefaultBounds();
store.updateBounds(bounds.value as TBounds); // ensure initial settings are published
if (paramColormap.value) {
  colormap.value = paramColormap.value;
}
if (paramTimeIndex.value) {
  timeIndexSlider.value = Number(paramTimeIndex.value);
}
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

    <div v-if="modelInfo && !isHidden" class="panel-block">
      <div class="select is-fullwidth">
        <select v-model="varnameSelector" class="form-control">
          <option
            v-for="varname in Object.keys(modelInfo.vars)"
            :key="varname"
            :value="varname"
          >
            {{ varname }}
            <span v-if="modelInfo.vars[varname]?.attrs?.standard_name"
              >- {{ modelInfo.vars[varname].attrs.standard_name }}</span
            >
          </option>
        </select>
      </div>
    </div>
    <div v-if="modelInfo && !isHidden" class="panel-block">
      <div class="control">
        <div class="mb-2 w-100 is-flex is-justify-content-space-between">
          <div class="my-2">Time:</div>
          <div class="is-flex">
            <input
              v-model.number="timeIndexSlider"
              class="input"
              type="number"
              :min="timeRange.start"
              :max="timeRange.end"
              style="width: 8em"
            />
            <div class="my-2">/ {{ timeRange.end }}</div>
          </div>
        </div>
        <input
          v-model.number="timeIndexSlider"
          class="w-100"
          type="range"
          :min="timeRange.start"
          :max="timeRange.end"
        />
        <div class="w-100 is-flex is-justify-content-space-between">
          <div>
            Currently shown:<span
              :class="{ loader: store.loading === true }"
            ></span>
          </div>
          <div class="has-text-right">
            {{ currentVarName }} @ {{ store.timeIndexDisplay }}
            <br />
            <span v-if="currentTimeValue">
              {{ currentTimeValue.format() }}
            </span>
            <br />
          </div>
        </div>
        <div class="has-text-right">
          {{ currentVarLongname }} / {{ currentVarUnits }}
        </div>
      </div>
    </div>
    <div v-if="modelInfo && !isHidden" class="panel-block is-block w-100">
      <div>
        <!-- Header -->
        <div class="columns has-text-weight-bold is-mobile compact-row">
          <div class="column">range</div>
          <div class="column">low</div>
          <div class="column has-text-right">high</div>
        </div>

        <!-- Data Bounds -->
        <div
          class="columns is-mobile active-row compact-row"
          :class="{ active: activeBoundsMode === BOUND_MODES.DATA }"
        >
          <div class="column">
            <input
              id="data_bounds"
              v-model="pickedBounds"
              class="mr-1"
              type="radio"
              value="data"
            />
            <label for="data_bounds">data</label>
          </div>
          <div class="column">{{ Number(dataBounds.low).toPrecision(4) }}</div>
          <div class="column has-text-right">
            {{ Number(dataBounds.high).toPrecision(4) }}
          </div>
        </div>

        <!-- Default Bounds -->
        <div
          class="columns is-mobile active-row compact-row"
          :class="{ active: activeBoundsMode === BOUND_MODES.DEFAULT }"
        >
          <div class="column">
            <input
              id="default_bounds"
              v-model="pickedBounds"
              :disabled="
                defaultBounds.low === undefined &&
                defaultBounds.high === undefined
              "
              type="radio"
              class="mr-1"
              value="default"
            />
            <label
              for="default_bounds"
              :class="{
                'has-text-grey-light':
                  defaultBounds.low === undefined &&
                  defaultBounds.high === undefined,
              }"
              >default</label
            >
          </div>
          <div
            class="column"
            :class="{
              'has-text-grey-light':
                defaultBounds.low === undefined &&
                defaultBounds.high === undefined,
            }"
          >
            {{ Number(defaultBounds.low).toPrecision(4) }}
          </div>
          <div
            class="column has-text-right"
            :class="{
              'has-text-grey-light':
                defaultBounds.low === undefined &&
                defaultBounds.high === undefined,
            }"
          >
            {{ Number(defaultBounds.high).toPrecision(4) }}
          </div>
        </div>

        <!-- User Bounds -->
        <div
          class="columns is-mobile active-row compact-row"
          :class="{ active: activeBoundsMode === BOUND_MODES.USER }"
        >
          <div class="column">
            <input
              id="user_bounds"
              v-model="pickedBounds"
              class="mr-1"
              type="radio"
              value="user"
            />
            <label for="user_bounds">user</label>
          </div>
          <div class="column">
            <input
              v-model.number="userBoundsLow"
              size="10"
              class="input"
              type="number"
            />
          </div>
          <div class="column has-text-right">
            <input
              v-model.number="userBoundsHigh"
              size="10"
              class="input"
              type="number"
            />
          </div>
        </div>

        <!-- Auto Bounds -->
        <div class="columns is-mobile active-row compact-row">
          <div class="column">
            <input
              id="auto_bounds"
              v-model="pickedBounds"
              class="mb-3 mr-1"
              type="radio"
              value="auto"
            />
            <label for="auto_bounds">auto</label>
          </div>
          <div class="column"></div>
          <div class="column has-text-right"></div>
        </div>

        <!-- Colormap Select + ColorBar -->
        <div class="columns is-mobile compact-row">
          <div class="column">
            <div class="select is-fullwidth">
              <select v-model="colormap">
                <option v-for="cm in modelInfo.colormaps" :key="cm" :value="cm">
                  {{ cm }}
                </option>
              </select>
            </div>
          </div>
          <div class="column is-three-fifths">
            <ColorBar
              class="hcolormap"
              :colormap="colormap"
              :invert-colormap="invertColormap"
            />
          </div>
        </div>

        <!-- Colormap checkboxes -->
        <div class="columns is-mobile compact-row">
          <div class="column py-2">
            <input
              id="invert_colormap"
              v-model="invertColormap"
              type="checkbox"
            />
            <label for="invert_colormap">invert</label>
          </div>
          <div class="column"></div>
          <div class="column has-text-right py-2">
            <input id="auto_colormap" v-model="autoColormap" type="checkbox" />
            <label for="auto_colormap">auto</label>
          </div>
        </div>
      </div>
    </div>
    <div
      v-if="modelInfo && !isHidden"
      class="panel-block is-justify-content-space-between"
    >
      <div>
        <input
          id="enable_coastlines"
          type="checkbox"
          :checked="store.showCoastLines"
          @change="store.toggleCoastLines"
        /><label for="enable_coastlines">coastlines</label>
      </div>
      <div>
        <button class="button" type="button" @click="() => $emit('onRotate')">
          <i class="fa-solid fa-rotate mr-1"></i>
          Toggle Rotation
        </button>
      </div>
    </div>
    <div v-if="modelInfo && !isHidden" class="panel-block">
      <p class="control">
        <button
          class="button mb-2 mr-1"
          type="button"
          @click="() => $emit('onSnapshot')"
        >
          <i class="fa-solid fa-image mr-1"></i> Snapshot
        </button>
        <button class="button" type="button" @click="() => $emit('onExample')">
          <i class="fa-solid fa-clipboard mr-1"></i>
          Copy Python example to clipboard
        </button>
      </p>
    </div>
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

.compact-row {
  padding-top: 0.1rem;
  padding-bottom: 0.1rem;
  margin-bottom: 0.1rem;

  & > .column {
    padding-top: 0.1rem;
    padding-bottom: 0.1rem;
  }
}

.active-row.active {
  background-color: lightgreen;
  @media (prefers-color-scheme: dark) {
    background-color: #2e7d32;
  }
}

.hcolormap {
  max-height: 2.5em;
  overflow: hidden;
  border-radius: bulmaUt.$radius;
}
</style>
