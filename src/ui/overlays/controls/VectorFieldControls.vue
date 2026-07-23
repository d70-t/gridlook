<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed } from "vue";

import { detectVectorVariablePair } from "@/lib/data/vectorField.ts";
import type { TModelInfo } from "@/lib/types/GlobeTypes.ts";
import { BUILTIN_LAYER_IDS, useGlobeControlStore } from "@/store/store.ts";

const props = defineProps<{
  modelInfo: TModelInfo;
}>();

const store = useGlobeControlStore();
const { streamlinePair, streamlineSelection, varnameSelector } =
  storeToRefs(store);

const variables = computed(() =>
  Object.keys(props.modelInfo.vars)
    .filter((name) => !props.modelInfo.vars[name].hidden)
    .sort((a, b) => a.localeCompare(b))
);

const streamlinesEnabled = computed(() => store.isStreamlineLayerEnabled());

function toggleStreamlines() {
  store.toggleLayerVisibility(BUILTIN_LAYER_IDS.STREAMLINES);
}

function optionLabel(name: string) {
  const attrs = props.modelInfo.vars[name]?.attrs;
  const description = attrs?.long_name ?? attrs?.standard_name;
  return description ? `${name} — ${description}` : name;
}

function setAutomatic(automatic: boolean) {
  if (automatic) {
    store.setStreamlineSelection({ automatic: true });
    return;
  }
  const detected =
    streamlinePair.value ??
    detectVectorVariablePair(variables.value, varnameSelector.value);
  store.setStreamlineSelection({
    automatic: false,
    u: detected?.u,
    v: detected?.v,
  });
}

function setComponent(component: "u" | "v", value: string) {
  store.setStreamlineSelection({
    ...streamlineSelection.value,
    automatic: false,
    [component]: value || undefined,
  });
}
</script>

<template>
  <div class="column pt-1">
    <button
      class="button is-small mb-3"
      :class="streamlinesEnabled ? 'is-info' : 'is-light'"
      type="button"
      :disabled="!streamlinePair && !streamlinesEnabled"
      :aria-pressed="streamlinesEnabled"
      @click="toggleStreamlines"
    >
      <span class="icon is-small">
        <i class="fa-solid fa-wind"></i>
      </span>
      <span>
        {{ streamlinesEnabled ? "Disable streamlines" : "Enable streamlines" }}
      </span>
    </button>

    <label class="checkbox is-size-7 mb-2">
      <input
        type="checkbox"
        :checked="streamlineSelection.automatic"
        @change="setAutomatic(($event.target as HTMLInputElement).checked)"
      />
      Detect vector components automatically
    </label>

    <template v-if="!streamlineSelection.automatic">
      <label class="is-size-7 has-text-grey" for="flow-u-component">
        Eastward / x component
      </label>
      <div class="select is-small is-fullwidth mb-2">
        <select
          id="flow-u-component"
          :value="streamlineSelection.u ?? ''"
          @change="
            setComponent('u', ($event.target as HTMLSelectElement).value)
          "
        >
          <option value="">Choose a variable…</option>
          <option v-for="name in variables" :key="name" :value="name">
            {{ optionLabel(name) }}
          </option>
        </select>
      </div>

      <label class="is-size-7 has-text-grey" for="flow-v-component">
        Northward / y component
      </label>
      <div class="select is-small is-fullwidth">
        <select
          id="flow-v-component"
          :value="streamlineSelection.v ?? ''"
          @change="
            setComponent('v', ($event.target as HTMLSelectElement).value)
          "
        >
          <option value="">Choose a variable…</option>
          <option v-for="name in variables" :key="name" :value="name">
            {{ optionLabel(name) }}
          </option>
        </select>
      </div>
    </template>

    <p v-if="streamlinePair" class="is-size-7 has-text-grey mt-2 mb-0">
      {{ streamlinesEnabled ? "Active" : "Available" }}:
      <code>{{ streamlinePair.u }}</code> /
      <code>{{ streamlinePair.v }}</code>
    </p>
  </div>
</template>
