<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, ref } from "vue";

import HiddenVariablesSection from "./HiddenVariablesSection.vue";

import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const props = defineProps<{
  datasources?: TSources;
}>();

const store = useGlobeControlStore();
const { varnameSelector } = storeToRefs(store);
const hiddenVariableMetadataResetKey = ref(0);

const allVariables = computed(() => {
  if (!props.datasources) {
    return [];
  }
  return Object.entries(props.datasources.levels[0].datasources).map(
    ([name, source]) => ({
      name,
      longName: source.attrs?.long_name ?? source.attrs?.standard_name,
      hidden: source.hidden ?? false,
    })
  );
});

const availableVariables = computed(() =>
  allVariables.value.filter((v) => !v.hidden)
);

function selectVariable(varName: string) {
  hiddenVariableMetadataResetKey.value++;
  varnameSelector.value = varName;
}
</script>

<template>
  <div>
    <section v-if="allVariables.length > 0" class="info-section">
      <h4 class="title is-6">
        Available Variables
        <span class="has-text-grey-light is-size-7 has-text-weight-normal ml-1"
          >({{ availableVariables.length }})</span
        >
      </h4>
      <div class="tags">
        <button
          v-for="v in availableVariables"
          :key="v.name"
          class="tag is-family-monospace is-clickable"
          :class="v.name === varnameSelector ? 'is-info' : 'is-light is-info'"
          :title="
            'Select ' + v.name + (v.longName ? ' (' + v.longName + ')' : '')
          "
          type="button"
          @click="selectVariable(v.name)"
        >
          {{ v.name }}
        </button>
      </div>
      <HiddenVariablesSection
        :datasources="datasources"
        :metadata-reset-key="hiddenVariableMetadataResetKey"
      />
    </section>
  </div>
</template>
