<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed } from "vue";

import type { TModelInfo } from "@/lib/types/GlobeTypes.js";
import { useGlobeControlStore } from "@/store/store.ts";

const model = defineModel<string>({ required: true });

const props = defineProps<{
  modelInfo: TModelInfo;
}>();

const store = useGlobeControlStore();
const { loading, varinfo } = storeToRefs(store);

const DISPLAYED_MAGNITUDE_VALUE = "__displayed_vector_magnitude__";

const streamlinesEnabled = computed(() => store.isStreamlineLayerEnabled());
const magnitudeOptionAvailable = computed(
  () => streamlinesEnabled.value && store.streamlineMagnitudeDerivable
);
const hasDisplayedScalarOverride = computed(
  () => magnitudeOptionAvailable.value && store.streamlineMagnitudeDisplayed
);

const displayedScalarUnits = computed(() => varinfo.value?.attrs?.units ?? "-");

const displayedVariableValue = computed(() =>
  hasDisplayedScalarOverride.value
    ? DISPLAYED_MAGNITUDE_VALUE
    : selectedBasename.value
);

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

const selectedGroup = computed({
  get: () => {
    const group =
      model.value.lastIndexOf("/") > 0
        ? model.value.substring(0, model.value.lastIndexOf("/"))
        : "/";

    return groups.value[group] ? group : (groupNames.value[0] ?? "/");
  },
  set: (newGroup: string) => {
    const vars = groups.value[newGroup];
    if (vars && vars.length > 0) {
      updateModel(vars[0], newGroup);
    }
  },
});

const selectedBasename = computed(() => {
  return model.value.substring(model.value.lastIndexOf("/") + 1);
});

const groupVariables = computed(() => {
  return groups.value[selectedGroup.value] ?? [];
});

function onGroupChange(event: Event) {
  selectedGroup.value = (event.target as HTMLSelectElement).value;
}

function updateModel(basename: string, group = selectedGroup.value) {
  if (basename === DISPLAYED_MAGNITUDE_VALUE) {
    store.setStreamlineMagnitudeDisplayed(true, true);
    return;
  }
  const variable = group === "/" ? basename : `${group}/${basename}`;
  const needsReload = store.varnameSelector === variable;
  store.setStreamlineMagnitudeDisplayed(false, needsReload);
  store.selectVariable(variable);
}

const currentVar = computed(() => props.modelInfo.vars[model.value]);

const currentVarAttrs = computed(() => currentVar.value?.attrs);

const currentVarUnits = computed(() => {
  return hasDisplayedScalarOverride.value
    ? displayedScalarUnits.value
    : (currentVarAttrs.value?.units ?? "-");
});

const currentVarLabel = computed(() => {
  if (hasDisplayedScalarOverride.value) {
    return (
      varinfo.value?.attrs?.long_name ??
      varinfo.value?.attrs?.standard_name ??
      store.streamlineMagnitudeInfo?.longName ??
      "Vector magnitude"
    );
  }
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
          :value="selectedGroup"
          class="form-control"
          @change="onGroupChange"
        >
          <option v-for="group in groupNames" :key="group" :value="group">
            {{ group }}
          </option>
        </select>
      </div>
      <div v-if="hasMultipleGroups" class="is-size-7 has-text-grey">
        Variable
      </div>
      <div class="select is-fullwidth mb-2" :class="{ 'is-loading': loading }">
        <select
          :value="displayedVariableValue"
          class="form-control"
          @change="updateModel(($event.target as HTMLSelectElement).value)"
        >
          <option
            v-if="magnitudeOptionAvailable"
            :value="DISPLAYED_MAGNITUDE_VALUE"
          >
            {{
              store.streamlineMagnitudeInfo?.standardName ?? "vector_magnitude"
            }}
            -
            {{ store.streamlineMagnitudeInfo?.longName }} (derived)
          </option>
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
