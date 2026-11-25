<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";

import type {
  TVariableGroupInfo,
  TVariableMetadata,
  TVariableSample,
} from "./types";
import { loadVariableSample } from "./variableSample.ts";
import {
  SearchField,
  searchFieldLabels,
  searchVariables,
  type TSearchField,
  variableHaystack,
} from "./variableSearch";
import VariableTableSection from "./VariableTableSection.vue";

import {
  currentLevel,
  formatResolution,
  levelOfVariable,
} from "@/lib/data/levels.ts";
import type { TDataSource, TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { getErrorMessage } from "@/utils/errorHandling.ts";

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
const searchField = ref<TSearchField>(SearchField.ALL);
const samples = ref<Record<string, TVariableSample>>({});
// discards samples still loading for a dataset no longer shown
let sampleGeneration = 0;

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
    shape: source.shape,
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
  samples.value = {};
  sampleGeneration++;
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

const haystack = computed(() =>
  variableHaystack(allVariables.value, searchField.value)
);

const searchResult = computed(() => {
  const query = searchQuery.value.trim();
  return query
    ? searchVariables(
        allVariables.value,
        haystack.value,
        query,
        searchField.value
      )
    : null;
});

const variableCount = computed(() => {
  const total = allVariables.value.length;
  return searchResult.value
    ? `${searchResult.value.rows.length} / ${total}`
    : total;
});

function toggleVariableAttributes(varName: string) {
  selectedAttributesVariableName.value =
    selectedAttributesVariableName.value === varName ? null : varName;
}

async function toggleSample(varName: string) {
  if (varName in samples.value) {
    delete samples.value[varName];
    return;
  }
  const source = datasourceEntries.value.find(
    ([name]) => name === varName
  )?.[1];
  if (!source) {
    return;
  }
  const generation = sampleGeneration;
  samples.value[varName] = { values: null, error: null };
  let sample: TVariableSample;
  try {
    sample = {
      values: await loadVariableSample(
        source,
        varName,
        props.datasources?.zarr_format
      ),
      error: null,
    };
  } catch (err) {
    sample = { values: null, error: getErrorMessage(err) };
  }
  // the sample may have been closed meanwhile
  if (generation === sampleGeneration && varName in samples.value) {
    samples.value[varName] = sample;
  }
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
      <div class="field has-addons mb-2">
        <div class="control">
          <div class="select is-small">
            <select v-model="searchField" aria-label="Search in">
              <option
                v-for="(label, field) in searchFieldLabels"
                :key="field"
                :value="field"
              >
                {{ label }}
              </option>
            </select>
          </div>
        </div>
        <div class="control has-icons-left is-expanded">
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
      </div>
      <VariableTableSection
        :rows="allVariables"
        empty-label="No variables or coordinates found"
        :selected-attributes-variable="selectedAttributesVariableName"
        :selected-variable="displayedDataVariable"
        :search-result="searchResult"
        :group-info="levelGroups"
        show-visualize
        :samples="samples"
        @toggle-sample="toggleSample"
        @toggle-attributes="toggleVariableAttributes"
        @visualize="selectVariable"
        @go-to-variable="goToVariable"
      />
    </section>
  </div>
</template>
