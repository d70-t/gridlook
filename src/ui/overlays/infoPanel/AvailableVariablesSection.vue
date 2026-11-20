<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";

import type { TVariableGroupInfo, TVariableMetadata } from "./types";
import VariableTableSection from "./VariableTableSection.vue";

import {
  currentLevel,
  formatResolution,
  levelOfVariable,
} from "@/lib/data/levels.ts";
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

const cellCountFormat = new Intl.NumberFormat(undefined, {
  notation: "compact",
  maximumSignificantDigits: 3,
});

/**
 * The variables of every level, the level shown first: a variable outside
 * the level groups is in every level's list and is taken from the level
 * shown; the variables of the other levels follow under their own groups.
 */
function allLevelEntries(datasources: TSources) {
  const current = datasources.selectedLevel ?? 0;
  const levels = [
    currentLevel(datasources),
    ...datasources.levels.filter((_, index) => index !== current),
  ];
  const entries = new Map<string, TDataSource>();
  for (const level of levels) {
    for (const [name, source] of Object.entries(level.datasources)) {
      if (!entries.has(name)) {
        entries.set(name, source);
      }
    }
  }
  return [...entries];
}

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

  const source = currentLevel(datasources).datasources[variableName];
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

  const entries = allLevelEntries(datasources);
  metadataByName.value = Object.fromEntries(
    entries.map(([name, source]) => [name, loadVariableMetadata(name, source)])
  );
}

const datasourceEntries = computed(() =>
  props.datasources ? allLevelEntries(props.datasources) : []
);

const levelLabel = (index: number) =>
  props.datasources?.levels[index].name ?? String(index);

/**
 * A variable of a level other than the one shown is listed but cannot be
 * visualised from here: the level is picked in the Variable card (or from
 * the zoom), and the variable shown follows it.
 */
function visualizeDisabled(name: string) {
  const levels = props.datasources?.levels ?? [];
  const level = levelOfVariable(levels, name);
  if (
    level === undefined ||
    level === (props.datasources?.selectedLevel ?? 0)
  ) {
    return undefined;
  }
  return `Switch to level ${levelLabel(level)} to show it`;
}

const allVariables = computed(() =>
  datasourceEntries.value.map(([name, source]) => {
    const metadata = metadataByName.value[name];
    return {
      name,
      hidden: source.hidden ?? false,
      visualizeDisabled: visualizeDisabled(name),
      ...metadata,
    };
  })
);

/** The level groups: their resolution and cell count, and which is shown. */
const levelGroups = computed(() => {
  const info: Record<string, TVariableGroupInfo> = {};
  const levels = props.datasources?.levels ?? [];
  const current = props.datasources?.selectedLevel ?? 0;
  for (const [index, level] of levels.entries()) {
    if (level.path === undefined || levels.length < 2) {
      continue;
    }
    const detail = [
      level.name !== level.path.split("/").pop() ? level.name : undefined,
      formatResolution(level.resolution),
      level.cellCount === undefined
        ? undefined
        : `${cellCountFormat.format(level.cellCount)} cells`,
    ]
      .filter((part) => part !== undefined)
      .join(" · ");
    info[level.path] = {
      detail: detail || undefined,
      current: index === current,
    };
  }
  return info;
});

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

function goToVariable(varName: string) {
  searchQuery.value = "";
  selectedAttributesVariableName.value = varName;
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
        :group-info="levelGroups"
        show-visualize
        @toggle-attributes="toggleVariableAttributes"
        @visualize="selectVariable"
        @go-to-variable="goToVariable"
      />
    </section>
  </div>
</template>
