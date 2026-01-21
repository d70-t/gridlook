<script lang="ts" setup>
import { computed } from "vue";

import type { TModelInfo } from "@/lib/types/GlobeTypes.js";
import { useGlobeControlStore } from "@/store/store";
import { storeToRefs } from "pinia";

const store = useGlobeControlStore();

const { loading } = storeToRefs(store);

const model = defineModel<string>({ required: true });

const props = defineProps<{
  modelInfo: TModelInfo;
}>();

const variableOptions = computed(() => {
  return Object.keys(props.modelInfo.vars);
});
</script>

<template>
  <div class="panel-block">
    <div class="select is-fullwidth" :class="{ 'is-loading': loading }">
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
  </div>
</template>
