<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, watch } from "vue";

import PopupDialog from "./PopupDialog.vue";

import type { TModelInfo } from "@/lib/types/GlobeTypes.ts";
import {
  getHealpixVolumeVariablesForGroup,
  preferredVolumeVariable,
  volumeVariableColor,
  volumeVariableOpacity,
  volumeVariablesAreCompatible,
} from "@/lib/volume/volumeVariables.ts";
import { LAYER_OPACITY, useGlobeControlStore } from "@/store/store.ts";

const props = defineProps<{ modelInfo?: TModelInfo }>();

const store = useGlobeControlStore();
const { volumeSelections, varnameSelector } = storeToRefs(store);

const COLOR_PALETTE = [
  "#ffffff",
  "#b8e1ff",
  "#72b7ff",
  "#4ddbd3",
  "#8de5a1",
  "#ffcc80",
  "#ff8fab",
  "#c4a7ff",
  "#ff6b6b",
  "#ffd43b",
  "#74c0fc",
  "#adb5bd",
];

const variables = computed(() =>
  getHealpixVolumeVariablesForGroup(props.modelInfo, varnameSelector.value)
);

function ensureSelection() {
  const current = volumeSelections.value.filter((selection) =>
    variables.value.includes(selection.variable)
  );
  if (current.length > 0) {
    store.setVolumeSelections(current);
    return;
  }
  const variable = preferredVolumeVariable(variables.value);
  store.setVolumeSelections(
    variable
      ? [
          {
            variable,
            color: volumeVariableColor(variable),
            opacity: volumeVariableOpacity(),
          },
        ]
      : []
  );
}

watch(variables, ensureSelection, { immediate: true });

function compatibleVariables(reference?: string) {
  const referenceSource = reference
    ? props.modelInfo?.vars[reference]
    : undefined;
  if (!referenceSource) {
    return variables.value;
  }
  return variables.value.filter((name) => {
    const source = props.modelInfo?.vars[name];
    return source && volumeVariablesAreCompatible(referenceSource, source);
  });
}

function options(index: number) {
  const current = volumeSelections.value[index]?.variable;
  const used = new Set(
    volumeSelections.value
      .filter((_, selectionIndex) => selectionIndex !== index)
      .map((selection) => selection.variable)
  );
  const reference =
    index === 0 ? undefined : volumeSelections.value[0]?.variable;
  return compatibleVariables(reference).filter(
    (name) => name === current || !used.has(name)
  );
}

function updateVariable(index: number, variable: string) {
  const selections = volumeSelections.value.map((selection) => ({
    ...selection,
  }));
  selections[index] = {
    variable,
    color: volumeVariableColor(variable, index),
    opacity: volumeVariableOpacity(),
  };
  if (index !== 0) {
    store.setVolumeSelections(selections);
    return;
  }
  const source = props.modelInfo?.vars[variable];
  store.setVolumeSelections(
    selections.filter((selection, selectionIndex) => {
      if (selectionIndex === 0 || !source) {
        return true;
      }
      const candidate = props.modelInfo?.vars[selection.variable];
      return candidate && volumeVariablesAreCompatible(source, candidate);
    })
  );
}

function updateColor(index: number, color: string) {
  store.setVolumeSelections(
    volumeSelections.value.map((selection, selectionIndex) =>
      selectionIndex === index ? { ...selection, color } : selection
    )
  );
}

function selectColor(index: number, color: string, close: () => void) {
  updateColor(index, color);
  close();
}

function updateOpacity(index: number, event: Event) {
  const opacity = (event.target as HTMLInputElement).valueAsNumber;
  store.setVolumeSelections(
    volumeSelections.value.map((selection, selectionIndex) =>
      selectionIndex === index ? { ...selection, opacity } : selection
    )
  );
}

function formatOpacity(opacity: number) {
  return `${(opacity * 100).toFixed(0)}%`;
}

function addSelection() {
  const used = new Set(
    volumeSelections.value.map((selection) => selection.variable)
  );
  const available = compatibleVariables(
    volumeSelections.value[0]?.variable
  ).filter((name) => !used.has(name));
  const variable = preferredVolumeVariable(available);
  if (!variable || volumeSelections.value.length >= 4) {
    return;
  }
  const index = volumeSelections.value.length;
  store.setVolumeSelections([
    ...volumeSelections.value,
    {
      variable,
      color: volumeVariableColor(variable, index),
      opacity: volumeVariableOpacity(),
    },
  ]);
}

function removeSelection(index: number) {
  if (volumeSelections.value.length <= 1) {
    return;
  }
  store.setVolumeSelections(
    volumeSelections.value.filter(
      (_, selectionIndex) => selectionIndex !== index
    )
  );
}

const canAdd = computed(() => {
  if (volumeSelections.value.length >= 4) {
    return false;
  }
  const used = new Set(
    volumeSelections.value.map((selection) => selection.variable)
  );
  return compatibleVariables(volumeSelections.value[0]?.variable).some(
    (name) => !used.has(name)
  );
});

function label(name: string) {
  const basename = name.slice(name.lastIndexOf("/") + 1);
  const source = props.modelInfo?.vars[name];
  const description = source?.attrs?.long_name ?? source?.attrs?.standard_name;
  return description ? `${basename} - ${description}` : basename;
}
</script>

<template>
  <div class="volume-controls">
    <div
      v-for="(selection, index) in volumeSelections"
      :key="selection.variable"
      class="volume-row"
    >
      <span class="select is-small">
        <select
          :value="selection.variable"
          :aria-label="`Volume variable ${index + 1}`"
          @change="
            updateVariable(index, ($event.target as HTMLSelectElement).value)
          "
        >
          <option v-for="name in options(index)" :key="name" :value="name">
            {{ label(name) }}
          </option>
        </select>
      </span>
      <PopupDialog dialog-class="volume-color-popover">
        <template #trigger="{ toggle, open }">
          <button
            class="button is-small volume-color"
            :class="{ 'is-info': open }"
            type="button"
            :title="`${selection.variable} color: ${selection.color}`"
            :aria-expanded="open"
            :aria-label="`${selection.variable} color`"
            @click.stop="toggle"
            @mousedown.stop
            @touchstart.stop
          >
            <span
              class="volume-color-swatch"
              :style="{ backgroundColor: selection.color }"
            ></span>
          </button>
        </template>
        <template #default="{ close }">
          <div class="dialog-section-label">Volume color</div>
          <div
            class="volume-color-palette"
            role="radiogroup"
            :aria-label="`${selection.variable} color`"
          >
            <button
              v-for="color in COLOR_PALETTE"
              :key="color"
              class="volume-color-option"
              :class="{ 'is-selected': selection.color === color }"
              :style="{ backgroundColor: color }"
              type="button"
              role="radio"
              :aria-label="color"
              :aria-checked="selection.color === color"
              @click="selectColor(index, color, close)"
            >
              <i v-if="selection.color === color" class="fa-solid fa-check"></i>
            </button>
          </div>
        </template>
      </PopupDialog>
      <PopupDialog dialog-class="layer-opacity-popover">
        <template #trigger="{ toggle, open }">
          <button
            class="button is-small is-light"
            :class="{
              'is-info': open || selection.opacity < LAYER_OPACITY.MAX,
            }"
            type="button"
            :title="`${selection.variable} opacity: ${formatOpacity(selection.opacity)}`"
            :aria-expanded="open"
            :aria-label="`${selection.variable} opacity`"
            @click.stop="toggle"
            @mousedown.stop
            @touchstart.stop
          >
            <span class="icon is-small">
              <i class="fa-solid fa-circle-half-stroke"></i>
            </span>
          </button>
        </template>
        <template #default>
          <label class="layer-opacity-control">
            <span class="layer-opacity-header">
              <span>Variable opacity</span>
              <span class="tag is-light layer-opacity-value">
                {{ formatOpacity(selection.opacity) }}
              </span>
            </span>
            <input
              class="layer-opacity"
              type="range"
              :min="LAYER_OPACITY.MIN"
              :max="LAYER_OPACITY.MAX"
              :step="LAYER_OPACITY.STEP"
              :value="selection.opacity"
              :aria-label="`${selection.variable} opacity`"
              @input="updateOpacity(index, $event)"
            />
          </label>
        </template>
      </PopupDialog>
      <button
        class="button is-small is-light"
        type="button"
        title="Remove volume"
        :disabled="volumeSelections.length <= 1"
        @click="removeSelection(index)"
      >
        <span class="icon is-small"><i class="fa-solid fa-xmark"></i></span>
      </button>
    </div>
    <button
      v-if="canAdd"
      class="button is-small is-light volume-add"
      type="button"
      @click="addSelection"
    >
      <span class="icon is-small"><i class="fa-solid fa-plus"></i></span>
      <span>Add volume</span>
    </button>
  </div>
</template>

<style lang="scss" scoped>
.volume-controls {
  display: grid;
  gap: 0.35rem;
  width: 100%;

  .select,
  select {
    width: 100%;
  }
}

.volume-row {
  display: grid;
  grid-template-columns: minmax(0, 1fr) auto auto auto;
  align-items: center;
  gap: 0.35rem;
}

.volume-color {
  width: 2rem;
  height: 1.8rem;
  padding: 0.2rem;
}

.volume-color-swatch {
  width: 100%;
  height: 100%;
  border: 1px solid rgba(0, 0, 0, 0.25);
  border-radius: 3px;
}

.volume-color-palette {
  display: grid;
  grid-template-columns: repeat(4, 2.5rem);
  gap: 0.45rem;
}

.volume-color-option {
  display: grid;
  width: 2.5rem;
  height: 2.5rem;
  padding: 0;
  place-items: center;
  border: 1px solid rgba(0, 0, 0, 0.3);
  border-radius: 6px;
  cursor: pointer;

  &.is-selected {
    outline: 3px solid var(--bulma-link);
    outline-offset: 1px;
  }

  i {
    color: #111;
    text-shadow:
      -1px -1px 0 #fff,
      1px -1px 0 #fff,
      -1px 1px 0 #fff,
      1px 1px 0 #fff;
  }
}

.volume-add {
  justify-self: start;
}

.layer-opacity-control {
  display: block;
  min-width: 11rem;
}

.layer-opacity-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.4rem;
  font-size: 0.75rem;
  font-weight: 700;
}

.layer-opacity {
  width: 100%;
}

.layer-opacity-value {
  min-width: 2.5rem;
  justify-content: center;
}

@media (max-width: 480px) {
  .volume-row {
    gap: 0.25rem;
  }

  .volume-color-palette {
    grid-template-columns: repeat(4, minmax(2.75rem, 1fr));
  }

  .volume-color-option {
    width: 100%;
    min-width: 2.75rem;
    height: 2.75rem;
  }
}
</style>
