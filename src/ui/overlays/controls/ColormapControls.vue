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

defineEmits<{
  "update:autoColormap": [value: boolean];
}>();

const store = useGlobeControlStore();
const { colormap, invertColormap, posterizeLevels, selection, histogram } =
  storeToRefs(store);

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
    // If coming from 2 or higher, go to 0 (off)
    // If coming from 0, go to 2
    posterizeLevels.value = previousValue.value >= 2 ? 0 : 2;
  } else {
    posterizeLevels.value = value;
  }
}
</script>

<template>
  <div class="panel-block is-block w-100">
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
      <div class="column is-two-thirds">
        <ColorBar
          class="hcolormap"
          :colormap="colormap"
          :invert-colormap="invertColormap"
          :posterize-levels="posterizeLevels"
          :bounds-low="selection.low"
          :bounds-high="selection.high"
          :data-bounds-low="props.dataBounds?.low"
          :data-bounds-high="props.dataBounds?.high"
          :histogram="histogram"
        />
      </div>
    </div>

    <!-- Colormap checkboxes -->
    <div class="columns is-mobile compact-row">
      <div class="column py-2">
        <input id="invert_colormap" v-model="invertColormap" type="checkbox" />
        <label for="invert_colormap">invert</label>
      </div>
      <div class="column has-text-right py-2">
        <input
          id="auto_colormap"
          :checked="autoColormap"
          type="checkbox"
          @change="
            $emit(
              'update:autoColormap',
              ($event.target as HTMLInputElement).checked
            )
          "
        />
        <label for="auto_colormap">auto</label>
      </div>
    </div>

    <!-- Posterize control -->
    <div class="columns is-mobile is-vcentered compact-row">
      <div class="column">
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
          class="slider is-fullwidth"
          @input="handlePosterizeLevelsInput"
        />
      </div>
      <div class="column is-narrow">
        <span class="tag posterize-tag">{{
          posterizeLevels === 0 ? "off" : posterizeLevels
        }}</span>
      </div>
    </div>
  </div>
</template>

<style lang="scss" scoped>
@use "bulma/sass/utilities" as bulmaUt;

.hcolormap {
  height: 2.5em;
  width: 100%;
  overflow: hidden;
  border-radius: bulmaUt.$radius;
}

.posterize-tag {
  min-width: 3em;
  text-align: center;
}

.slider-column {
  display: flex;
  align-items: center;
}

.slider {
  margin: 0;
}
</style>
