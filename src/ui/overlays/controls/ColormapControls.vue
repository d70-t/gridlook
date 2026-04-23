<script lang="ts" setup>
import { storeToRefs } from "pinia";
import Select from "primevue/select";
import { ref, watch } from "vue";

import ColorBar from "./ColorBar.vue";
import { roundToDataPrecision } from "./colorbarUtils.ts";

import type { TColorMap } from "@/lib/shaders/colormapShaders.ts";
import type { TBounds, TModelInfo } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const props = defineProps<{
  modelInfo: TModelInfo;
  dataBounds?: TBounds;
}>();

const emit = defineEmits<{
  forceUserBounds: [];
  colormapUserSelected: [];
}>();

const store = useGlobeControlStore();
const {
  colormap,
  invertColormap,
  posterizeLevels,
  hideLowerBound,
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
  store.updateLowUserBound(
    roundToDataPrecision(value, props.dataBounds?.low, props.dataBounds?.high)
  );
  emit("forceUserBounds");
}

function handleBoundsHighUpdate(value: number) {
  // Pin opposite bound if not yet defined
  if (store.userBoundsLow === undefined) {
    store.updateLowUserBound(selection.value.low);
  }
  store.updateHighUserBound(
    roundToDataPrecision(value, props.dataBounds?.low, props.dataBounds?.high)
  );
  emit("forceUserBounds");
}

// ---------------------------------------------------------------------------
// Colormap gradient swatches - pre-generated static WebP files
// ---------------------------------------------------------------------------

function swatchSrc(cm: TColorMap): string {
  return `/static/colormaps/${cm}.webp`;
}

// ---------------------------------------------------------------------------
// Hover-preview: temporarily apply a colormap while browsing the dropdown
// ---------------------------------------------------------------------------

const originalColormap = ref<TColorMap | null>(null);
const selectionMade = ref(false);

function handleDropdownShow() {
  originalColormap.value = colormap.value;
  selectionMade.value = false;
}

function handleDropdownHide() {
  if (!selectionMade.value && originalColormap.value !== null) {
    colormap.value = originalColormap.value;
  }
  originalColormap.value = null;
  selectionMade.value = false;
}

function handleDropdownChange() {
  selectionMade.value = true;
  emit("colormapUserSelected");
}

function handleOptionHover(option: TColorMap) {
  colormap.value = option;
}
</script>

<template>
  <div class="column">
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
    <div class="columns is-mobile is-vcentered compact-row mt-2 mb-4 px-1">
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
    <div class="columns is-mobile is-vcentered compact-row px-1">
      <div class="column colormap-column">
        <Select
          v-model="colormap"
          :options="modelInfo.colormaps"
          class="colormap-select"
          @show="handleDropdownShow"
          @hide="handleDropdownHide"
          @change="handleDropdownChange"
        >
          <template #value="{ value }">
            <div class="cm-option">
              <img
                :src="swatchSrc(value as TColorMap)"
                class="cm-swatch"
                alt=""
              />
              <span class="cm-name">{{ value }}</span>
            </div>
          </template>
          <template #option="{ option }">
            <div
              class="cm-option"
              @mouseenter="handleOptionHover(option as TColorMap)"
            >
              <img
                :src="swatchSrc(option as TColorMap)"
                class="cm-swatch"
                alt=""
              />
              <span class="cm-name">{{ option }}</span>
            </div>
          </template>
        </Select>
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
        <label
          class="checkbox"
          title="Hide values at or below the lower bound (useful with globe mask, e.g. for precipitation)"
        >
          <input
            id="hide_lower_bound"
            v-model="hideLowerBound"
            type="checkbox"
          />
          hide min
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

.colormap-column {
  min-width: 0;
  overflow: hidden;
}

.colormap-select {
  width: 100%;
  font-size: 1rem;
  font-family: inherit;
}

:deep(.p-select) {
  width: 100%;
  height: 2.5em;
  border: 1px solid var(--bulma-border, #dbdbdb);
  border-radius: 4px;
  background-color: var(--bulma-scheme-main, #fff);
  padding: 0 0.625em;
  font-size: 1rem;
  color: var(--bulma-text, #363636);
  cursor: pointer;
  transition: border-color 0.15s ease;

  &:hover {
    border-color: var(--bulma-border-hover, #b5b5b5) !important;
  }

  &.p-focus {
    border-color: rgb(66, 88, 255) !important;
    box-shadow: rgba(66, 88, 255, 0.25) 0px 0px 0px 3px !important;
  }
}

:deep(.p-select-label) {
  padding: 0;
  line-height: 1;
  display: flex;
  align-items: center;
  height: 100%;
  overflow: hidden;
}

:deep(.p-select-dropdown) {
  width: 1.75em;
  color: var(--bulma-link);
}

.cm-option {
  display: flex;
  align-items: center;
  gap: 0.5em;
  min-width: 0;
}

.cm-swatch {
  flex-shrink: 0;
  width: 80px;
  height: 22px;
  border-radius: 2px;
  display: block;
}

.cm-name {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
</style>
