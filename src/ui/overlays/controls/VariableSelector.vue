<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { Panel } from "primevue";
import { computed } from "vue";

import type { TModelInfo } from "@/lib/types/GlobeTypes.js";
import { useGlobeControlStore } from "@/store/store";

const model = defineModel<string>({ required: true });
const props = defineProps<{
  modelInfo: TModelInfo;
}>();
const store = useGlobeControlStore();

const { varinfo } = storeToRefs(store);
const variableOptions = computed(() => {
  return Object.keys(props.modelInfo.vars);
});

const currentVarLongname = computed(() => {
  return varinfo.value?.attrs?.long_name ?? "-";
});

const currentVarUnits = computed(() => {
  return varinfo.value?.attrs?.units ?? "-";
});
</script>

<template>
  <Panel :header="`Variable: ${model}`" toggleable class="shadow-sm m-2">
    <div class="select is-fullwidth mb-2">
      <select v-model="model" class="form-control">
        <option
          v-for="varname in variableOptions"
          :key="varname"
          :value="varname"
        >
          {{ varname }}
          <span v-if="modelInfo.vars[varname]?.attrs?.standard_name">
            - {{ modelInfo.vars[varname].attrs.standard_name }}
          </span>
        </option>
      </select>
    </div>

    <div class="has-text-right">
      {{ currentVarLongname }} / {{ currentVarUnits }}
    </div>
  </Panel>
</template>
