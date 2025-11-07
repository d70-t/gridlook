<script lang="ts" setup>
import ColorBar from "@/components/ColorBar.vue";
import { computed, onMounted, onUnmounted, ref, watch, type Ref } from "vue";
import { useGlobeControlStore } from "./store/store.ts";
import { storeToRefs } from "pinia";
import debounce from "lodash.debounce";
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
  landSeaMaskChoice,
  landSeaMaskUseTexture,
  dimSlidersValues,
  dimSlidersDisplay,
} = storeToRefs(store);

const urlParameterStore = useUrlParameterStore();
const {
  paramColormap,
  paramTimeIndex,
  paramInvertColormap,
  paramMaskMode,
  paramMaskingUseTexture,
} = storeToRefs(urlParameterStore);

const menuCollapsed: Ref<boolean> = ref(false);
const mobileMenuCollapsed: Ref<boolean> = ref(true);
const isMobileView: Ref<boolean> = ref(false);
const autoColormap: Ref<boolean> = ref(true);
const defaultBounds: Ref<TBounds> = ref({});
const pickedBounds: Ref<TBoundModes> = ref(BOUND_MODES.AUTO);

// Local copy of timeIndexSlider to allow debounced updates
const localTimeIndexSlider: Ref<number> = ref(timeIndexSlider.value);
const localSliders = ref<number[]>([]);

const debouncedUpdaters = ref<Array<(value: number) => void>>([]);

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

// const timeRange = computed(() => {
//   return varinfo.value?.timeRange ?? { start: 0, end: 1 };
// });

watch(
  localSliders,
  (newValues) => {
    newValues.forEach((value, index) => {
      // if (value !== oldValues?.[index] && debouncedUpdaters.value[index]) {
      if (value !== undefined && value !== dimSlidersValues.value[index]) {
        console.log(
          "GlobeControls: watch localSliders",
          newValues[index],
          "dimslider",
          dimSlidersValues.value[index]
        );
        debouncedUpdaters.value[index](value);
      }
    });
  },
  { deep: true }
);

watch(
  () => varinfo.value,
  () => {
    console.log("GlobeControls: watch var info");
    const newRanges = varinfo.value?.dimRanges;
    if (newRanges) {
      console.log("GlobeControls: nochmal new ranges", newRanges);
      localSliders.value = newRanges.map(
        (range, index) => dimSlidersValues.value[index] ?? range?.start ?? null
      );

      // Create stable debounced functions
      debouncedUpdaters.value = newRanges.map((_, index) => {
        return debounce((value: number) => {
          console.log(
            "GlobeControls: debouncer",
            dimSlidersValues.value[index]
          );
          if (dimSlidersValues.value[index] !== undefined) {
            console.log(
              "GlobeControls: SET DIMSLIDER",
              index,
              dimSlidersValues.value[index],
              value
            );
            dimSlidersValues.value[index] = value;
          }
        }, 1550);
      });
    }
  },
  { immediate: true }
);

const debouncedUpdateTimeIndexSlider = debounce(() => {
  timeIndexSlider.value = localTimeIndexSlider.value;
}, 350);

watch(localTimeIndexSlider, () => {
  debouncedUpdateTimeIndexSlider();
});

// Helper to get dimension name
const getDimName = (index: number): string => {
  const range = varinfo.value?.dimRanges[index];
  return range?.name ?? `Dimension ${index}`;
};

// Helper to check if a dimension should be shown
const shouldShowDimension = (index: number): boolean => {
  const range = varinfo.value?.dimRanges[index];
  return range !== null && range !== undefined;
};

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

setDefaultBounds();
store.updateBounds(bounds.value as TBounds); // ensure initial settings are published
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

if (paramTimeIndex.value) {
  timeIndexSlider.value = Number(paramTimeIndex.value);
  localTimeIndexSlider.value = Number(paramTimeIndex.value);
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
              v-model.number="localSliders[0]"
              :disabled="varinfo?.dimRanges[0]?.name !== 'time'"
              class="input"
              type="number"
              :min="varinfo?.dimRanges[0]?.start ?? 0"
              :max="varinfo?.dimRanges[0]?.end ?? 0"
              style="width: 8em"
            />
            <div class="my-2">/ {{ varinfo?.dimRanges[0]?.end ?? 0 }}</div>
          </div>
        </div>
        <input
          v-model.number="localSliders[0]"
          class="w-100"
          type="range"
          :disabled="varinfo?.dimRanges[0]?.name !== 'time'"
          :min="varinfo?.dimRanges[0]?.start ?? 0"
          :max="varinfo?.dimRanges[0]?.end ?? 0"
        />
        <div class="w-100 is-flex is-justify-content-space-between">
          <div>
            Currently shown:<span
              :class="{ loader: store.loading === true }"
            ></span>
          </div>
          <div class="has-text-right">
            {{ currentVarName }} @ {{ dimSlidersDisplay[0] }}
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
    <div v-if="varinfo" class="panel-block">
      <!-- Generic dimension sliders -->
      <div class="control">
        <template v-for="(range, index) in varinfo.dimRanges" :key="index">
          <div
            v-if="range && index !== 0"
            class="mb-2 w-100 is-flex is-justify-content-space-between"
          >
            <div class="my-2">
              {{
                String(range.name[0]).toUpperCase() +
                String(range.name).slice(1)
              }}:
            </div>
            <div class="is-flex">
              <input
                v-model.number="localSliders[index]"
                class="input"
                type="number"
                :min="range.start"
                :max="range.end"
                style="width: 8em"
              />
              <div class="my-2">/ {{ range.end }}</div>
            </div>
          </div>
          <input
            v-if="range && index !== 0"
            v-model.number="localSliders[index]"
            class="w-100"
            type="range"
            :min="range.start"
            :max="range.end"
          />
          <span v-if="range && index !== 0">
            display {{ dimSlidersDisplay[index] }}
          </span>
          <span v-if="range && index !== 0">
            value {{ dimSlidersValues[index] }}
          </span>
        </template>
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
        />
        <label for="enable_coastlines">coastlines</label>
      </div>
      <div>
        <button class="button" type="button" @click="() => $emit('onRotate')">
          <i class="fa-solid fa-rotate mr-1"></i>
          Toggle Rotation
        </button>
      </div>
    </div>
    <div
      v-if="modelInfo && !isHidden"
      class="panel-block is-justify-content-space-between"
    >
      <div class="select">
        <select id="land_sea_mask" v-model="landSeaMaskChoice">
          <option value="off">Mask: Off</option>
          <option value="land">Mask: Land</option>
          <option value="sea">Mask: Sea</option>
          <option value="globe">Mask: Globe</option>
        </select>
      </div>
      <div class="columns is-mobile compact-row">
        <div class="column py-2">
          <input
            id="use_texture"
            v-model="landSeaMaskUseTexture"
            :disabled="landSeaMaskChoice === 'off'"
            type="checkbox"
          />
          <label
            for="use_texture"
            :class="{
              'has-text-grey-light': landSeaMaskChoice === 'off',
            }"
            >Use Texture</label
          >
        </div>
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
