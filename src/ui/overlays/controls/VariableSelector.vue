<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";

import type { TModelInfo } from "@/lib/types/GlobeTypes.js";
import { useGlobeControlStore } from "@/store/store.ts";

const model = defineModel<string>({ required: true });

const props = defineProps<{
  modelInfo: TModelInfo;
}>();

const store = useGlobeControlStore();
const { loading } = storeToRefs(store);

const groups = computed(() => {
  const groups: Record<string, string[]> = {};
  for (const varname in props.modelInfo.vars) {
    if (props.modelInfo.vars[varname].hidden) {
      continue;
    }
    if (varname.lastIndexOf("/") > 0) {
      const group = varname.substring(0, varname.lastIndexOf("/"));
      const basename = varname.substring(varname.lastIndexOf("/") + 1);
      if (!groups[group]) {
        groups[group] = [];
      }
      groups[group].push(basename);
    } else {
      if (!groups["/"]) {
        groups["/"] = [];
      }
      const basename = varname.substring(varname.lastIndexOf("/") + 1);
      groups["/"].push(basename);
    }
  }
  return groups;
});

const groupNames = computed(() => Object.keys(groups.value));
const hasMultipleGroups = computed(() => groupNames.value.length > 1);

const selectedGroup = ref(
  model.value.lastIndexOf("/") > 0
    ? model.value.substring(0, model.value.lastIndexOf("/"))
    : "/"
);

const selectedBasename = computed(() => {
  return model.value.substring(model.value.lastIndexOf("/") + 1);
});

const groupVariables = computed(() => {
  return groups.value[selectedGroup.value] ?? [];
});

watch(
  () => props.modelInfo,
  () => {
    if (!groups.value[selectedGroup.value]) {
      selectedGroup.value = groupNames.value[0] ?? "/";
    }
  }
);

function onGroupChange() {
  const vars = groups.value[selectedGroup.value];
  if (vars && vars.length > 0) {
    updateModel(vars[0]);
  }
}

function updateModel(basename: string) {
  model.value =
    selectedGroup.value === "/"
      ? basename
      : `${selectedGroup.value}/${basename}`;
  store.signifyVariableChange();
}

const currentVar = computed(() => props.modelInfo.vars[model.value]);

const currentVarAttrs = computed(() => currentVar.value?.attrs);

const currentVarUnits = computed(() => {
  return currentVarAttrs.value?.units ?? "-";
});

const currentVarLabel = computed(() => {
  return (
    currentVarAttrs.value?.long_name ??
    currentVarAttrs.value?.standard_name ??
    "-"
  );
});

function getOptionLabel(varname: string): string {
  const fullPath =
    selectedGroup.value === "/" ? varname : `${selectedGroup.value}/${varname}`;
  const v = props.modelInfo.vars[fullPath];
  const label = v?.attrs?.long_name ?? v?.attrs?.standard_name;
  return label ? `${varname} - ${label}` : varname;
}
</script>

<template>
  <div class="column">
    <div class="control">
      <div v-if="hasMultipleGroups" class="is-size-7 has-text-grey">Group</div>
      <div
        v-if="hasMultipleGroups"
        class="select is-fullwidth mb-2"
        :class="{ 'is-loading': loading }"
      >
        <select
          v-model="selectedGroup"
          class="form-control"
          @change="onGroupChange"
        >
          <option v-for="group in groupNames" :key="group" :value="group">
            {{ group }}
          </option>
        </select>
      </div>
      <div class="select is-fullwidth mb-2" :class="{ 'is-loading': loading }">
        <select
          :value="selectedBasename"
          class="form-control"
          @change="updateModel(($event.target as HTMLSelectElement).value)"
        >
          <option
            v-for="varname in groupVariables"
            :key="varname"
            :value="varname"
          >
            {{ getOptionLabel(varname) }}
          </option>
        </select>
      </div>
      <div :key="model" class="has-text-right">
        <span v-word-break>
          {{ currentVarLabel }}
        </span>
        / {{ currentVarUnits }}
      </div>
    </div>
  </div>
</template>
