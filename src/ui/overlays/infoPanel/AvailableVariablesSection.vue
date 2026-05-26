<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";

import type { TVariableMetadata } from "./types";
import VariableTableSection from "./VariableTableSection.vue";

import type { TDataSource, TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const props = defineProps<{
  datasources?: TSources;
  varname?: string | null;
}>();

const store = useGlobeControlStore();
const { varnameSelector } = storeToRefs(store);

const metadataByName = ref<Record<string, TVariableMetadata>>({});
const selectedAttributesVariableName = ref<string | null>(null);

function normalizeDimensionNames(
  dimensionNames: unknown,
  shape?: readonly number[]
) {
  if (Array.isArray(dimensionNames)) {
    return dimensionNames.map(String);
  }
  if (shape) {
    return shape.map((_, idx) => `dim_${idx}`);
  }
  return [];
}

function getDefaultAttributesVariableName(datasources?: TSources) {
  const variableName = varnameSelector.value;
  if (!datasources || !variableName || variableName === "-") {
    return null;
  }

  const source = datasources.levels[0].datasources[variableName];
  if (!source || source.hidden) {
    return null;
  }
  return variableName;
}

function loadVariableMetadata(
  name: string,
  source: TDataSource
): TVariableMetadata {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { _ARRAY_DIMENSIONS, dimensionNames, ...attributsWithoutDims } =
    (source.attrs ?? {}) as {
      _ARRAY_DIMENSIONS?: string[];
      dimensionNames?: string[];
      [key: string]: unknown;
    };
  return {
    attrs: attributsWithoutDims,
    dimensions: normalizeDimensionNames(dimensionNames, source.shape),
    dtype: String(source.dtype),
    error:
      !source.dtype && !dimensionNames
        ? `Could not load variable ${name}`
        : null,
  };
}

async function loadAllVariableMetadata(datasources?: TSources) {
  selectedAttributesVariableName.value =
    getDefaultAttributesVariableName(datasources);
  if (!datasources) {
    metadataByName.value = {};
    return;
  }

  const entries = Object.entries(datasources.levels[0].datasources);
  metadataByName.value = Object.fromEntries(
    entries.map(([name, source]) => [name, loadVariableMetadata(name, source)])
  );
}

const datasourceEntries = computed(() => {
  if (!props.datasources) {
    return [];
  }
  return Object.entries(props.datasources.levels[0].datasources);
});

const allVariables = computed(() =>
  datasourceEntries.value.map(([name, source]) => {
    const metadata = metadataByName.value[name];
    return {
      name,
      hidden: source.hidden ?? false,
      ...metadata,
    };
  })
);

const coordinateVariables = computed(() =>
  allVariables.value.filter((variable) => variable.hidden)
);

const dataVariables = computed(() =>
  allVariables.value.filter((variable) => !variable.hidden)
);

const isTimeFromAnotherFile = computed(() => {
  if (!props.datasources) {
    return true;
  }
  const time = props.datasources.levels[0].time;
  const currentVariable =
    props.datasources.levels[0].datasources[props.varname ?? ""] ?? null;
  if (!time || !currentVariable) {
    // We only show the warning if there is a time variable and a selected
    // variable, otherwise it can be confusing
    return true;
  }
  return (
    time?.dataset + "/" + time?.store !==
    currentVariable?.dataset + "/" + currentVariable?.store
  );
});

const isGridFromAnotherFile = computed(() => {
  if (!props.datasources) {
    return true;
  }
  const grid = props.datasources.levels[0].grid;
  const currentVariable =
    props.datasources.levels[0].datasources[props.varname ?? ""] ?? null;
  if (!grid || !currentVariable) {
    // We only show the warning if there is a grid and a selected
    // variable, otherwise it can be confusing
    return true;
  }
  return (
    grid?.dataset + "/" + grid?.store !==
    currentVariable?.dataset + "/" + currentVariable?.store
  );
});

function toggleVariableAttributes(varName: string) {
  selectedAttributesVariableName.value =
    selectedAttributesVariableName.value === varName ? null : varName;
}

function selectVariable(varName: string) {
  selectedAttributesVariableName.value = varName;
  varnameSelector.value = varName;
}

watch(
  () => props.datasources,
  (datasources) => {
    void loadAllVariableMetadata(datasources);
  },
  { immediate: true }
);

watch(
  () => varnameSelector.value,
  () => {
    const defaultVariable = getDefaultAttributesVariableName(props.datasources);
    if (defaultVariable) {
      selectedAttributesVariableName.value = defaultVariable;
    }
  }
);
</script>

<template>
  <div>
    <section v-if="allVariables.length > 0" class="info-section">
      <h4 class="title is-6">Variables</h4>
      <p v-if="isTimeFromAnotherFile" class="is-size-7 has-text-danger">
        Time variable is from a different file and may not be correctly
        recognized.
      </p>
      <p v-if="isGridFromAnotherFile" class="is-size-7 has-text-danger">
        Grid related dimensions are from a different file and may not be
        correctly recognized.
      </p>
      <VariableTableSection
        title="Coordinates"
        :rows="coordinateVariables"
        empty-label="No coordinates found"
        :selected-attributes-variable="selectedAttributesVariableName"
        @toggle-attributes="toggleVariableAttributes"
      />
      <VariableTableSection
        title="Data Variables"
        :rows="dataVariables"
        empty-label="No data variables found"
        :selected-attributes-variable="selectedAttributesVariableName"
        :selected-variable="varnameSelector"
        show-visualize
        @toggle-attributes="toggleVariableAttributes"
        @visualize="selectVariable"
      />
    </section>
  </div>
</template>
