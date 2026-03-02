<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { ref, watch } from "vue";

import ColorBar from "./ColorBar.vue";

import type { TBounds, TModelInfo } from "@/lib/types/GlobeTypes.js";
import { useGlobeControlStore } from "@/store/store";

const props = defineProps<{
  modelInfo: TModelInfo;
  autoColormap: boolean;
  dataBounds?: TBounds;
}>();

const emit = defineEmits<{
  "update:autoColormap": [value: boolean];
  forceUserBounds: [];
}>();

const store = useGlobeControlStore();
const {
  colormap,
  invertColormap,
  posterizeLevels,
  selection,
  histogram,
  fullHistogram,
} = storeToRefs(store);

const previousValue = ref(posterizeLevels.value);

watch(posterizeLevels, (newVal) => {
  if (newVal !== 1) {
    previousValue.value = newVal;
  }
});

function handlePosterizeLevelsInput(event: Event) {
  const value = Number((event.target as HTMLInputElement).value);
  // Skip value 1 as it doesn't make sense for posterization
  if (value === 1) {
    posterizeLevels.value = previousValue.value >= 2 ? 0 : 2;
  } else {
    posterizeLevels.value = value;
  }
}

// --- Handle drag events from ColorBar ---

function handleBoundsLowUpdate(value: number) {
  // Pin opposite bound if not yet defined
  if (store.userBoundsHigh === undefined) {
    store.updateHighUserBound(selection.value.high);
  }
  store.updateLowUserBound(value);
  emit("forceUserBounds");
}

function handleBoundsHighUpdate(value: number) {
  // Pin opposite bound if not yet defined
  if (store.userBoundsLow === undefined) {
    store.updateLowUserBound(selection.value.low);
  }
  store.updateHighUserBound(value);
  emit("forceUserBounds");
}
</script>

<template>
  <div class="panel-block is-block w-100">
    <ColorBar
      :colormap="colormap"
      :invert-colormap="invertColormap"
      :posterize-levels="posterizeLevels"
      :bounds-low="selection.low"
      :bounds-high="selection.high"
      :data-bounds-low="props.dataBounds?.low"
      :data-bounds-high="props.dataBounds?.high"
      :full-histogram="fullHistogram"
      :histogram="histogram"
      @update:bounds-low="handleBoundsLowUpdate"
      @update:bounds-high="handleBoundsHighUpdate"
    />

    <!-- Posterize control -->
    <div class="columns is-mobile is-vcentered compact-row mt-2 mb-4">
      <div class="column is-one-third">
        <label for="posterize_levels" class="label is-small">Posterize</label>
      </div>
      <div class="column slider-column">
        <input
          id="posterize_levels"
          :value="posterizeLevels"
          type="range"
          min="0"
          max="32"
          step="1"
          class="slider w-100"
          @input="handlePosterizeLevelsInput"
        />
      </div>
      <div class="column is-narrow">
        <span class="tag posterize-tag">{{
          posterizeLevels === 0 ? "off" : posterizeLevels
        }}</span>
      </div>
    </div>

    <!-- Row: Colormap selector + options -->
    <div class="columns is-mobile is-vcentered compact-row">
      <div class="column">
        <div class="select is-fullwidth">
          <select v-model="colormap">
            <option v-for="cm in modelInfo.colormaps" :key="cm" :value="cm">
              {{ cm }}
            </option>
          </select>
        </div>
      </div>
      <div class="column is-narrow">
        <label class="checkbox">
          <input
            id="invert_colormap"
            v-model="invertColormap"
            type="checkbox"
          />
          invert
        </label>
      </div>
      <div class="column is-narrow">
        <label class="checkbox">
          <input
            id="auto_colormap"
            :checked="autoColormap"
            type="checkbox"
            @change="
              emit(
                'update:autoColormap',
                ($event.target as HTMLInputElement).checked
              )
            "
          />
          auto
        </label>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use "bulma/sass/utilities" as bulmaUt;

.posterize-tag {
  min-width: 3em;
  text-align: center;
}

.slider-column {
  display: flex;
  align-items: center;
}
</style>
