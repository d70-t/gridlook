<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, watch } from "vue";

import PopupDialog from "./PopupDialog.vue";

import type { TModelInfo } from "@/lib/types/GlobeTypes.ts";
import {
  DEFAULT_VOLUME_COLOR,
  getVolumeVariablesForGroup,
  preferredVolumeVariable,
  volumeVariableOpacity,
  volumeVariablesAreCompatible,
} from "@/lib/volume/volumeVariables.ts";
import { LAYER_OPACITY, useGlobeControlStore } from "@/store/store.ts";

const props = defineProps<{ modelInfo?: TModelInfo }>();

const store = useGlobeControlStore();
const { volumeSelections, varnameSelector } = storeToRefs(store);

const variables = computed(() =>
  getVolumeVariablesForGroup(props.modelInfo, varnameSelector.value)
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
            color: DEFAULT_VOLUME_COLOR,
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
    color: DEFAULT_VOLUME_COLOR,
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
  store.setVolumeSelections([
    ...volumeSelections.value,
    {
      variable,
      color: DEFAULT_VOLUME_COLOR,
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
      <input
        class="input is-small volume-color"
        type="color"
        :value="selection.color"
        :title="`${selection.variable} color: ${selection.color}`"
        :aria-label="`${selection.variable} color`"
        @input="updateColor(index, ($event.target as HTMLInputElement).value)"
        @click.stop
        @mousedown.stop
        @touchstart.stop
      />
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
}
</style>
