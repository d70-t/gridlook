<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed } from "vue";

import type { TModelInfo } from "@/lib/types/GlobeTypes.js";
import { useGlobeControlStore } from "@/store/store";

const model = defineModel<string>({ required: true });

const props = defineProps<{
  modelInfo: TModelInfo;
}>();

const store = useGlobeControlStore();
const { loading } = storeToRefs(store);

const variableOptions = computed(() => {
  const visibleVars = Object.keys(props.modelInfo.vars).filter((varname) => {
    const varinfo = props.modelInfo.vars[varname];
    return !varinfo.hidden;
  });
  return visibleVars;
});

const currentVarAttrs = computed(
  () => props.modelInfo.vars[model.value]?.attrs
);

const currentVarUnits = computed(() => {
  return currentVarAttrs.value?.units ?? "-";
});

const currentVarLongname = computed(() => {
  return currentVarAttrs.value?.long_name;
});

const currentVarStandardName = computed(() => {
  return currentVarAttrs.value?.standard_name;
});

function getOptionLabel(varname: string): string {
  const v = props.modelInfo.vars[varname];
  const label = v?.attrs?.long_name ?? v?.attrs?.standard_name;
  return label ? `${varname} - ${label}` : varname;
}
</script>

<template>
  <div class="column">
    <div class="control">
      <div class="select is-fullwidth mb-2" :class="{ 'is-loading': loading }">
        <select v-model="model" class="form-control">
          <option
            v-for="varname in variableOptions"
            :key="varname"
            :value="varname"
          >
            {{ getOptionLabel(varname) }}
          </option>
        </select>
      </div>
      <div class="has-text-right">
        <span v-word-break>
          {{ currentVarLongname || currentVarStandardName || "-" }}
        </span>
        / {{ currentVarUnits }}
      </div>
    </div>
  </div>
</template>
