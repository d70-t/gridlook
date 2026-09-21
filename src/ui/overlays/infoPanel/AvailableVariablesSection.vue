<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";

import type { TVariableMetadata } from "./types";
import VariableTableSection from "./VariableTableSection.vue";

import type { TDataSource, TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

const props = defineProps<{
  datasources?: TSources;
}>();

const store = useGlobeControlStore();
const { varnameDisplay, varinfo } = storeToRefs(store);
const displayedDataVariable = computed(() =>
  varinfo.value?.derivedFrom ? null : varnameDisplay.value
);

const metadataByName = ref<Record<string, TVariableMetadata>>({});
const selectedAttributesVariableName = ref<string | null>(null);
const searchQuery = ref("");

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
  const variableName = displayedDataVariable.value;
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

const variableCount = computed(() => {
  const query = searchQuery.value.trim().toLowerCase();
  const total = allVariables.value.length;
  return query
    ? `${allVariables.value.filter((row) => row.name.toLowerCase().includes(query)).length} / ${total}`
    : total;
});

function toggleVariableAttributes(varName: string) {
  selectedAttributesVariableName.value =
    selectedAttributesVariableName.value === varName ? null : varName;
}

function selectVariable(varName: string) {
  selectedAttributesVariableName.value = varName;
  store.setStreamlineMagnitudeDisplayed(
    false,
    varName === store.varnameSelector
  );
  store.selectVariable(varName);
}

watch(
  () => props.datasources,
  (datasources) => {
    void loadAllVariableMetadata(datasources);
  },
  { immediate: true }
);

watch(displayedDataVariable, () => {
  selectedAttributesVariableName.value = getDefaultAttributesVariableName(
    props.datasources
  );
});
</script>

<template>
  <div>
    <section v-if="allVariables.length > 0" class="info-section">
      <h4 class="title is-6">
        Variables <span class="has-text-grey-light">({{ variableCount }})</span>
      </h4>
      <div class="control has-icons-left mb-2">
        <input
          v-model="searchQuery"
          class="input is-small"
          type="text"
          placeholder="Search variables and coordinates…"
        />
        <span class="icon is-left is-small">
          <i class="fa-solid fa-magnifying-glass"></i>
        </span>
      </div>
      <VariableTableSection
        :rows="allVariables"
        empty-label="No variables or coordinates found"
        :selected-attributes-variable="selectedAttributesVariableName"
        :selected-variable="displayedDataVariable"
        :search-query="searchQuery"
        show-visualize
        @toggle-attributes="toggleVariableAttributes"
        @visualize="selectVariable"
      />
    </section>
  </div>
</template>
