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
const { loading, varinfo } = storeToRefs(store);

const variableOptions = computed(() => {
  return Object.keys(props.modelInfo.vars);
});

const currentVarUnits = computed(() => {
  return varinfo.value?.attrs?.units ?? "-";
});

const currentVarLongname = computed(() => {
  return varinfo.value?.attrs?.long_name ?? "-";
});
</script>

<template>
  <div class="panel-block">
    <div class="control">
      <div class="select is-fullwidth mb-2" :class="{ 'is-loading': loading }">
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
    </div>
  </div>
</template>
