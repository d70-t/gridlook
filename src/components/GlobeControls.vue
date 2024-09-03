<script lang="ts" setup>
import ColorBar from "@/components/ColorBar.vue";
import { computed, ref, watch, type Ref } from "vue";
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
const colormap: Ref<TColorMap> = ref("turbo");
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

watch(
  () => varnameSelector.value,
  () => {
    const varinfo = props.modelInfo!.vars[varnameSelector.value];
    console.log("varinfo", varinfo, varnameSelector);
    console.log(props.modelInfo!.vars);
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
  () => props.modelInfo,
  () => {
    if (props.modelInfo?.vars[varnameSelector.value] === undefined) {
      varnameSelector.value =
        props.modelInfo?.defaultVar ?? Object.keys(props.modelInfo!.vars)[0];
    }
    setDefaultColormap();
  }
);

watch(
  () => autoColormap,
  () => setDefaultColormap()
);

function toggleMenu() {
  menuCollapsed.value = !menuCollapsed.value;
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
</script>

<template>
  <nav id="main_controls" class="panel gl_controls">
    <div
      class="panel-heading"
      style="display: flex; justify-content: space-between"
    >
      <div v-if="modelInfo" class="text-wrap">
        {{ modelInfo.title }}
      </div>
      <div v-else>no data available</div>
      <div>
        <i
          class="fa-solid"
          :class="{
            'fa-angle-down': menuCollapsed,
            'fa-angle-up': !menuCollapsed,
          }"
          @click="toggleMenu"
        ></i>
      </div>
    </div>

    <div
      v-if="modelInfo"
      class="panel-block"
      :class="{ 'is-hidden': menuCollapsed }"
    >
      <div class="select is-fullwidth">
        <select v-model="varnameSelector" class="form-control">
          <option
            v-for="varname in Object.keys(modelInfo.vars)"
            :key="varname"
            :value="varname"
          >
            {{ varname }}
          </option>
        </select>
      </div>
    </div>
    <div
      v-if="modelInfo"
      class="panel-block"
      :class="{ 'is-hidden': menuCollapsed }"
    >
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
    <div
      v-if="modelInfo"
      class="panel-block"
      :class="{ 'is-hidden': menuCollapsed }"
    >
      <table>
        <tr>
          <th>range</th>
          <th>low</th>
          <th class="right">high</th>
        </tr>
        <tr :class="{ active: activeBounds === 'data' }">
          <td>
            <input
              id="data_bounds"
              v-model="pickedBounds"
              type="radio"
              value="data"
            /><label for="data_bounds">data</label>
          </td>
          <td>{{ Number(dataBounds.low).toPrecision(4) }}</td>
          <td class="right">{{ Number(dataBounds.high).toPrecision(4) }}</td>
        </tr>
        <tr :class="{ active: activeBounds === 'default' }">
          <td>
            <input
              id="default_bounds"
              v-model="pickedBounds"
              type="radio"
              value="default"
            /><label for="default_bounds">default</label>
          </td>
          <td>{{ Number(defaultBounds.low).toPrecision(2) }}</td>
          <td class="right">
            {{ Number(defaultBounds.high).toPrecision(2) }}
          </td>
        </tr>
        <tr :class="{ active: activeBounds === 'user' }">
          <td class="py-2">
            <input
              id="user_bounds"
              v-model="pickedBounds"
              type="radio"
              value="user"
            /><label for="user_bounds">user</label>
          </td>
          <td class="py-1">
            <input v-model.number="userBoundsLow" size="10" class="input" />
          </td>
          <td class="right py-1">
            <input v-model.number="userBoundsHigh" size="10" class="input" />
          </td>
        </tr>
        <tr>
          <td>
            <input
              id="auto_bounds"
              v-model="pickedBounds"
              class="mb-3"
              type="radio"
              value="auto"
            /><label for="auto_bounds">auto</label>
          </td>
          <td></td>
          <td class="right"></td>
        </tr>
        <tr class="py-2">
          <td>
            <div class="select">
              <select v-model="colormap" class="form-control">
                <option v-for="cm in modelInfo.colormaps" :key="cm" :value="cm">
                  {{ cm }}
                </option>
              </select>
            </div>
          </td>
          <td colspan="2" class="py-2">
            <ColorBar
              class="hcolormap"
              :colormap="colormap"
              :invert-colormap="invertColormap"
            />
          </td>
        </tr>
        <tr>
          <td>
            <input
              id="invert_colormap"
              v-model="invertColormap"
              type="checkbox"
            /><label for="invert_colormap">invert</label>
          </td>
          <td></td>
          <td>
            <input
              id="auto_colormap"
              v-model="autoColormap"
              type="checkbox"
            /><label for="auto_colormap">auto</label>
          </td>
        </tr>
      </table>
    </div>
    <div
      v-if="modelInfo"
      class="panel-block"
      :class="{ 'is-hidden': menuCollapsed }"
    >
      <p class="control">
        <input
          id="enable_coastlines"
          type="checkbox"
          :checked="store.showCoastLines"
          @change="store.toggleCoastLines"
        /><label for="enable_coastlines">coastlines</label>
      </p>
      <p class="control">
        <button class="button" type="button" @click="() => $emit('onRotate')">
          <i class="fa-solid fa-rotate mr-1"></i>
          Toggle Rotation
        </button>
      </p>
    </div>
    <div
      v-if="modelInfo"
      class="panel-block"
      :class="{ 'is-hidden': menuCollapsed }"
    >
      <p class="control">
        <button
          class="button mb-2"
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

<style>
table tr td.right,
table tr th.right {
  text-align: right;
}

table tr.active {
  background-color: lightgreen;
}

.hcolormap {
  width: 15em;
  height: 1.5em;
  max-height: 1.5em;
  overflow: hidden;
}
</style>
