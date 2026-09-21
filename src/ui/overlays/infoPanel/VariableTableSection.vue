<script lang="ts" setup>
import { computed, ref } from "vue";
import VueJsonPretty from "vue-json-pretty";
import * as zarr from "zarrita";

import type { TVariableTableRow } from "./types";

type TVariableTableDisplayRow = TVariableTableRow & {
  displayName: string;
};

type TGroupedVariableRows = {
  name: string;
  rows: TVariableTableDisplayRow[];
};

const props = withDefaults(
  defineProps<{
    rows: TVariableTableRow[];
    emptyLabel: string;
    selectedAttributesVariable: string | null;
    selectedVariable?: string | null;
    showVisualize?: boolean;
    searchQuery?: string;
  }>(),
  {
    selectedVariable: null,
    showVisualize: false,
    searchQuery: "",
  }
);

const emit = defineEmits<{
  toggleAttributes: [varName: string];
  visualize: [varName: string];
}>();

const ROOT_GROUP_NAME = "/";
const VariableSection = {
  DATA: "Data Variables",
  COORDINATES: "Coordinates",
} as const;

const groupNameCollator = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});

const openGroups = ref<Set<string>>(new Set());
const closedGroups = ref<Set<string>>(new Set());

function getVariableGroup(varName: string) {
  const groupSeparatorIndex = varName.lastIndexOf("/");
  return groupSeparatorIndex > 0
    ? varName.substring(0, groupSeparatorIndex)
    : ROOT_GROUP_NAME;
}

function getVariableDisplayName(varName: string) {
  const groupSeparatorIndex = varName.lastIndexOf("/");
  return groupSeparatorIndex > 0
    ? varName.substring(groupSeparatorIndex + 1)
    : varName;
}

const trimmedSearchQuery = computed(() =>
  props.searchQuery.trim().toLowerCase()
);
const isSearching = computed(() => trimmedSearchQuery.value.length > 0);

const filteredRows = computed(() =>
  isSearching.value
    ? props.rows.filter((row) =>
        row.name.toLowerCase().includes(trimmedSearchQuery.value)
      )
    : props.rows
);

const groupedRows = computed<TGroupedVariableRows[]>(() => {
  if (isSearching.value) {
    return [
      {
        name: ROOT_GROUP_NAME,
        rows: filteredRows.value.map((row) => ({
          ...row,
          displayName: row.name,
        })),
      },
    ];
  }

  const groups: Record<string, TVariableTableDisplayRow[]> = {};

  for (const row of props.rows) {
    const group = getVariableGroup(row.name);
    if (!groups[group]) {
      groups[group] = [];
    }
    groups[group].push({
      ...row,
      displayName: getVariableDisplayName(row.name),
    });
  }

  return Object.entries(groups)
    .sort(
      ([nameA], [nameB]) =>
        Number(isVariableInGroup(props.selectedVariable, nameB)) -
          Number(isVariableInGroup(props.selectedVariable, nameA)) ||
        groupNameCollator.compare(nameA, nameB)
    )
    .map(([name, rows]) => ({ name, rows }));
});

const hasGroups = computed(
  () =>
    !isSearching.value &&
    groupedRows.value.some((group) => group.name !== ROOT_GROUP_NAME)
);

function formatDimensions(dimensions: string[]) {
  return `(${dimensions.join(", ")})`;
}

function hasAttributes(attrs: zarr.Attributes | null) {
  return attrs ? Object.keys(attrs).length > 0 : false;
}

function isVariableInGroup(
  varName: string | null | undefined,
  groupName: string
) {
  return varName ? getVariableGroup(varName) === groupName : false;
}

function isGroupOpen(groupName: string) {
  return (
    !closedGroups.value.has(groupName) &&
    (openGroups.value.has(groupName) ||
      isVariableInGroup(props.selectedAttributesVariable, groupName) ||
      isVariableInGroup(props.selectedVariable, groupName))
  );
}

function toggleGroup(groupName: string) {
  const nextOpenGroups = new Set(openGroups.value);
  const nextClosedGroups = new Set(closedGroups.value);
  if (isGroupOpen(groupName)) {
    nextOpenGroups.delete(groupName);
    nextClosedGroups.add(groupName);
  } else {
    nextOpenGroups.add(groupName);
    nextClosedGroups.delete(groupName);
  }
  openGroups.value = nextOpenGroups;
  closedGroups.value = nextClosedGroups;
}
</script>

<template>
  <div class="dataset-table-section">
    <div v-if="filteredRows.length > 0">
      <div
        v-for="group in groupedRows"
        :key="group.name"
        :class="{ box: hasGroups }"
        class="p-0 mb-3"
      >
        <button
          v-if="hasGroups"
          type="button"
          class="button is-light is-fullwidth is-justify-content-space-between variable-group-toggle"
          :aria-expanded="isGroupOpen(group.name)"
          @click="toggleGroup(group.name)"
        >
          <span class="is-flex is-align-items-center">
            <span class="icon is-small mr-2" aria-hidden="true">
              <i
                class="fa-solid"
                :class="
                  isGroupOpen(group.name) ? 'fa-angle-down' : 'fa-angle-right'
                "
              ></i>
            </span>
            <span class="group-name">{{ group.name }}</span>
          </span>
          <span class="tag is-rounded ml-2">{{ group.rows.length }}</span>
        </button>
        <div
          v-if="!hasGroups || isGroupOpen(group.name)"
          :class="{ 'px-3 pb-3': hasGroups }"
        >
          <div
            v-for="table in [
              {
                title: VariableSection.DATA,
                rows: group.rows.filter((row) => !row.hidden),
              },
              {
                title: VariableSection.COORDINATES,
                rows: group.rows.filter((row) => row.hidden),
              },
            ]"
            :key="table.title"
          >
            <h5 class="is-size-7 has-text-weight-semibold mt-3 mb-1">
              {{ table.title }}
              <span class="has-text-grey">({{ table.rows.length }})</span>
            </h5>
            <div v-if="table.rows.length" class="table-container">
              <table
                class="table is-narrow is-fullwidth is-size-7 dataset-table"
                :aria-label="`${group.name} ${table.title}`"
              >
                <thead>
                  <tr>
                    <th>Name</th>
                    <th>Dimensions</th>
                    <th>dtype</th>
                    <th><span class="is-sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody>
                  <template v-for="row in table.rows" :key="row.name">
                    <tr
                      class="variable-row"
                      :class="{
                        'is-selected-variable': row.name === selectedVariable,
                      }"
                    >
                      <td class="variable-name">
                        <code :title="row.name">
                          {{ hasGroups ? row.displayName : row.name }}
                        </code>
                      </td>
                      <td class="variable-dimensions">
                        <span
                          v-if="row.error"
                          class="has-text-danger"
                          :title="row.error"
                        >
                          Unavailable
                        </span>
                        <code v-else>{{
                          formatDimensions(row.dimensions)
                        }}</code>
                      </td>
                      <td>
                        <span
                          v-if="row.error || !row.dtype"
                          class="has-text-grey-light"
                        >
                          -
                        </span>
                        <code v-else-if="row.dtype">{{ row.dtype }}</code>
                      </td>
                      <td class="variable-actions has-text-right">
                        <button
                          class="button is-small"
                          :class="
                            row.name === selectedAttributesVariable
                              ? 'is-info'
                              : 'is-light'
                          "
                          :aria-label="'View attributes for ' + row.name"
                          :aria-pressed="
                            row.name === selectedAttributesVariable
                          "
                          :title="'View attributes for ' + row.name"
                          type="button"
                          @click="emit('toggleAttributes', row.name)"
                        >
                          <span class="icon is-small">
                            <i class="fa-solid fa-circle-info"></i>
                          </span>
                        </button>
                        <button
                          v-if="showVisualize && !row.hidden"
                          class="button is-small ml-1"
                          :class="
                            row.name === selectedVariable
                              ? 'is-info'
                              : 'is-light'
                          "
                          :aria-label="'Visualize ' + row.name"
                          :title="'Visualize ' + row.name"
                          type="button"
                          :disabled="!!row.error"
                          @click="emit('visualize', row.name)"
                        >
                          <span class="icon is-small">
                            <i class="fa-solid fa-globe"></i>
                          </span>
                        </button>
                      </td>
                    </tr>
                    <tr
                      v-if="row.name === selectedAttributesVariable"
                      class="variable-attributes-row"
                    >
                      <td colspan="4">
                        <div class="variable-attributes">
                          <div
                            v-if="row.error"
                            class="notification is-danger is-light is-size-7"
                          >
                            {{ row.error }}
                          </div>
                          <div
                            v-else-if="hasAttributes(row.attrs)"
                            class="info-pre"
                          >
                            <VueJsonPretty :data="row.attrs" />
                          </div>
                          <p v-else class="has-text-grey-light">
                            No variable attributes
                          </p>
                        </div>
                      </td>
                    </tr>
                  </template>
                </tbody>
              </table>
            </div>
            <p v-else class="is-size-7 has-text-grey">
              No {{ table.title.toLowerCase() }}
            </p>
          </div>
        </div>
      </div>
    </div>

    <p v-else-if="isSearching" class="has-text-grey-light is-size-7">
      No matches
    </p>
    <p v-else class="has-text-grey-light is-size-7">{{ emptyLabel }}</p>
  </div>
</template>

<style lang="scss" scoped>
.dataset-table-section {
  margin-top: 0.75rem;
}

.dataset-table {
  th,
  td {
    vertical-align: middle;
  }

  th {
    white-space: nowrap;
  }
}

.variable-group-toggle {
  height: auto;
  padding: 0.75rem;
  text-align: left;

  .group-name {
    white-space: normal;
    word-break: break-word;
  }
}

.variable-row.is-selected-variable {
  background: color-mix(in srgb, var(--bulma-info) 14%, transparent);

  .variable-name code {
    background: color-mix(in srgb, var(--bulma-info) 20%, transparent);
    color: var(--bulma-info-dark);
    font-weight: 700;
  }
}

.variable-name {
  word-break: break-word;
}

.variable-dimensions {
  min-width: 7rem;

  code {
    white-space: normal;
  }
}

.variable-actions {
  white-space: nowrap;
  width: 1%;

  .button {
    height: 1.65rem;
    width: 1.65rem;
    padding-left: 0;
    padding-right: 0;
  }
}

.variable-attributes-row {
  td {
    border-top: 0;
    padding-top: 0;
  }
}

.variable-attributes {
  border-left: 3px solid var(--bulma-info);
  padding: 0.5rem 0.5rem 0.5rem 0.75rem;
  background: color-mix(in srgb, var(--bulma-info) 6%, transparent);
}
</style>
