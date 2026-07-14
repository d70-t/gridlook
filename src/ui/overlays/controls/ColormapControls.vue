<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";
import {
  SelectListbox,
  SelectOption,
  SelectPopover,
  SelectRoot,
  SelectTrailingIcon,
  SelectTrigger,
  SelectValue,
} from "vue3-select-component";
import "vue3-select-component/styles.css";

import ColorBar from "./ColorBar.vue";
import { percentileFromBins, roundToDataPrecision } from "./colorbarUtils.ts";

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
  hideUpperBound,
  selection,
  histogram,
  fullHistogram,
  histogramSummary,
} = storeToRefs(store);

type TColormapOption = {
  label: TColorMap;
  value: TColorMap;
};

const colormapOptions = computed<TColormapOption[]>(() =>
  props.modelInfo.colormaps.map((value) => ({ label: value, value }))
);

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

function handleAutoContrast() {
  if (!histogramSummary.value || !props.dataBounds) {
    return;
  }
  const { bins, min, max } = histogramSummary.value;
  const low = percentileFromBins(bins, min, max, 2);
  const high = percentileFromBins(bins, min, max, 98);
  store.updateLowUserBound(
    roundToDataPrecision(low, props.dataBounds.low, props.dataBounds.high)
  );
  store.updateHighUserBound(
    roundToDataPrecision(high, props.dataBounds.low, props.dataBounds.high)
  );
  emit("forceUserBounds");
}
</script>

<template>
  <div class="column mb-5">
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
        <label for="posterize_levels" class="label is-small"
          >Discrete Colors</label
        >
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
    <SelectRoot
      v-model="colormap"
      :options="colormapOptions"
      class="colormap-select mb-4"
      data-assembled-select
      @menu-opened="handleDropdownShow"
      @menu-closed="handleDropdownHide"
      @option-selected="handleDropdownChange"
    >
      <SelectTrigger>
        <SelectValue>
          <div class="cm-option">
            <img :src="swatchSrc(colormap)" class="cm-swatch" alt="" />
            <span class="cm-name">{{ colormap }}</span>
          </div>
        </SelectValue>
        <SelectTrailingIcon>
          <i class="fa-solid fa-angle-down is-size-5"></i>
        </SelectTrailingIcon>
      </SelectTrigger>

      <SelectPopover>
        <SelectListbox>
          <SelectOption
            v-for="option in colormapOptions"
            :key="option.value"
            :value="option.value"
            :label="option.label"
            @mouseenter="handleOptionHover(option.value)"
          >
            <div class="cm-option w-100">
              <img :src="swatchSrc(option.value)" class="cm-swatch" alt="" />
              <span class="cm-name">{{ option.label }}</span>
            </div>
          </SelectOption>
        </SelectListbox>
      </SelectPopover>
    </SelectRoot>
    <div class="columns is-mobile is-multiline is-vcentered compact-row px-1">
      <div class="column is-half">
        <button
          id="invert_colormap"
          type="button"
          class="button is-small w-100"
          :class="{ 'is-info': invertColormap }"
          :aria-pressed="invertColormap"
          title="Invert colormap"
          @click="invertColormap = !invertColormap"
        >
          <span class="icon">
            <i class="fa-solid fa-arrow-right-arrow-left"></i>
          </span>
          <span>Invert</span>
        </button>
      </div>
      <div class="column is-half">
        <button
          type="button"
          class="button is-small w-100"
          title="Set bounds to the 2nd - 98th percentile of the data"
          :disabled="!histogramSummary || !dataBounds"
          @click="handleAutoContrast"
        >
          <span class="icon">
            <i class="fa-solid fa-circle-half-stroke"></i>
          </span>
          <span> Auto Contrast </span>
        </button>
      </div>
      <div class="column is-half">
        <button
          id="hide_lower_bound"
          type="button"
          class="button is-small w-100"
          :class="{ 'is-info': hideLowerBound }"
          :aria-pressed="hideLowerBound"
          title="Hide values at or below the lower bound (useful with globe mask, e.g. for precipitation)"
          @click="hideLowerBound = !hideLowerBound"
        >
          <span class="icon">
            <i class="fa-solid fa-eye-slash"></i>
          </span>
          <span>Hide low</span>
        </button>
      </div>
      <div class="column is-half">
        <button
          id="hide_upper_bound"
          type="button"
          class="button is-small w-100"
          :class="{ 'is-info': hideUpperBound }"
          :aria-pressed="hideUpperBound"
          title="Hide values at or above the upper bound"
          @click="hideUpperBound = !hideUpperBound"
        >
          <span class="icon">
            <i class="fa-solid fa-eye-slash"></i>
          </span>
          <span>Hide high</span>
        </button>
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

.colormap-select {
  width: 100%;
  font-size: 1rem;
  font-family: inherit;
  --vs-min-height: 2.5em;
  --vs-padding-y: 0;
  --vs-padding-x: 0.625em;
  --vs-border: 1px solid var(--bulma-border, #dbdbdb);
  --vs-border-radius: 4px;
  --vs-background-color: var(--bulma-scheme-main, #fff);
  --vs-text-color: var(--bulma-text, #363636);
  --vs-outline-color: rgb(66, 88, 255);
  --vs-outline-width: 3px;
  --vs-trailing-icon-color: var(--bulma-link);
}

:deep([data-select-trigger][aria-expanded="true"]),
:deep([data-select-trigger]:focus-visible) {
  box-shadow: rgba(66, 88, 255, 0.25) 0 0 0 3px;
}

:deep([data-select-value]) {
  line-height: 1;
  height: 100%;
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

:global([data-select-popover]) {
  --vs-border: 1px solid var(--bulma-border, #dbdbdb);
  --vs-border-radius: 4px;
  --vs-menu-background-color: var(--bulma-scheme-main, #fff);
  --vs-menu-z-index: 1000;
  --vs-option-hover-background-color: var(--bulma-scheme-main-bis, #fafafa);
  --vs-option-focused-background-color: var(--bulma-scheme-main-ter, #f5f5f5);
  --vs-option-selected-background-color: var(--bulma-info-soft, #eef6fc);
}
</style>
