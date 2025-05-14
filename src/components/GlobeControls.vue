<script lang="ts" setup>
import ColorBar from "@/components/ColorBar.vue";
import { computed, onMounted, onUnmounted, ref, watch, type Ref } from "vue";
import { useGlobeControlStore } from "./store/store.ts";
import { storeToRefs } from "pinia";
import type {
  TColorMap,
  TModelInfo,
  TBounds,
  TVarInfo,
  TSelection,
} from "../types/GlobeTypes.js";

const props = defineProps<{ varinfo?: TVarInfo; modelInfo?: TModelInfo }>();

const emit = defineEmits<{
  selection: [TSelection];
  onSnapshot: [];
  onExample: [];
  onRotate: [];
}>();

const store = useGlobeControlStore();
const { timeIndexSlider, varnameSelector } = storeToRefs(store);
const menuCollapsed: Ref<boolean> = ref(false);
const mobileMenuCollapsed: Ref<boolean> = ref(true);
const colormap: Ref<TColorMap> = ref("turbo");
const isMobileView: Ref<boolean> = ref(false);
const invertColormap: Ref<boolean> = ref(true);
const autoColormap: Ref<boolean> = ref(true);
const defaultBounds: Ref<TBounds> = ref({});
const userBoundsLow: Ref<number | undefined> = ref(undefined);
const userBoundsHigh: Ref<number | undefined> = ref(undefined);
const pickedBounds = ref("auto");

const activeBounds = computed(() => {
  if (pickedBounds.value === "auto") {
    if (
      defaultBounds.value.low !== undefined &&
      defaultBounds.value.high !== undefined
    ) {
      return "default";
    } else {
      return "data";
    }
  } else {
    return pickedBounds.value;
  }
});

const dataBounds = computed(() => {
  return props.varinfo?.bounds ?? {};
});

const bounds = computed(() => {
  if (activeBounds.value === "data") {
    return dataBounds;
  } else if (activeBounds.value === "default") {
    return defaultBounds;
  } else if (activeBounds.value === "user") {
    return { low: userBoundsLow.value, high: userBoundsHigh.value };
  }
  return undefined;
});

const timeRange = computed(() => {
  return props.varinfo?.timeRange ?? { start: 0, end: 1 };
});

const currentTimeValue = computed(() => {
  return props.varinfo?.timeinfo?.current;
});

const currentVarName = computed(() => {
  return store.varname ?? "-";
});

const currentVarLongname = computed(() => {
  return props.varinfo?.attrs?.long_name ?? "-";
});

const currentVarUnits = computed(() => {
  return props.varinfo?.attrs?.units ?? "-";
});

const isHidden = computed(() => {
  return (
    (isMobileView.value && mobileMenuCollapsed.value) || menuCollapsed.value
  );
});

watch(
  () => varnameSelector.value,
  () => {
    const varinfo = props.modelInfo!.vars[varnameSelector.value];
    defaultBounds.value = varinfo.default_range ?? {};
    setDefaultColormap();
    publish();
  }
);

watch(
  () => colormap.value,
  () => publish()
);

watch(
  () => invertColormap.value,
  () => publish()
);

watch(
  () => bounds.value,
  () => publish()
);

watch(
  () => autoColormap,
  () => setDefaultColormap()
);

function toggleMenu() {
  menuCollapsed.value = !menuCollapsed.value;
}

function toggleMobileMenu() {
  mobileMenuCollapsed.value = !mobileMenuCollapsed.value;
}

const publish = () => {
  emit("selection", {
    bounds: bounds.value as TBounds,
    colormap: colormap.value,
    invertColormap: invertColormap.value,
  });
};

const setDefaultColormap = () => {
  const defaultColormap =
    props.modelInfo?.vars[varnameSelector.value].default_colormap;
  if (autoColormap.value && defaultColormap !== undefined) {
    invertColormap.value = defaultColormap.inverted || false;
    colormap.value = defaultColormap.name;
  }
};

onMounted(() => {
  isMobileView.value = window.innerWidth < 769;
  window.addEventListener("resize", () => {
    isMobileView.value = window.innerWidth < 769;
  });
});

onUnmounted(() => {
  window.removeEventListener("resize", () => {
    isMobileView.value = window.innerWidth < 769;
  });
});

publish(); // ensure initial settings are published
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
        class="button is-primary is-hidden-tablet"
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
              min="1"
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
            {{ currentVarName }} @ {{ store.timeIndex }}
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
          :class="{ active: activeBounds === 'data' }"
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
          :class="{ active: activeBounds === 'default' }"
        >
          <div class="column">
            <input
              id="default_bounds"
              v-model="pickedBounds"
              type="radio"
              class="mr-1"
              value="default"
            />
            <label for="default_bounds">default</label>
          </div>
          <div class="column">
            {{ Number(defaultBounds.low).toPrecision(2) }}
          </div>
          <div class="column has-text-right">
            {{ Number(defaultBounds.high).toPrecision(2) }}
          </div>
        </div>

        <!-- User Bounds -->
        <div
          class="columns is-mobile active-row compact-row"
          :class="{ active: activeBounds === 'user' }"
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
            <input v-model.number="userBoundsLow" size="10" class="input" />
          </div>
          <div class="column has-text-right">
            <input v-model.number="userBoundsHigh" size="10" class="input" />
          </div>
        </div>

        <!-- Auto Bounds -->
        <div
          class="columns is-mobile active-row compact-row"
          :class="{ active: activeBounds === 'auto' }"
        >
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
  top: 0;
  position: fixed;
  overflow-x: hidden;
  width: 25rem;
  border-radius: 0 0 bulmaUt.$radius bulmaUt.$radius !important;
  bottom: 0;

  @media only screen and (max-width: bulmaUt.$tablet) {
    width: 100%;
    position: fixed;
    z-index: 10000;
    top: 0;
    left: 0;
    right: 0;
    bottom: 80%;
    overflow-x: hidden;
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

    .panel-heading {
      .mobile-title {
        float: right;
      }
    }
  }
  .panel-block {
    background-color: white;
  }

  input {
    margin-right: 3px;
  }

  &.mobile-visible {
    @media only screen and (max-width: bulmaUt.$tablet) {
      height: 100%;
      background-color: white;

      bottom: 0;
    }
  }

  .panel-heading {
    border-radius: 0;
  }

  @media (prefers-color-scheme: dark) {
    .panel-block {
      background-color: rgb(15, 15, 15, 0.8);
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
