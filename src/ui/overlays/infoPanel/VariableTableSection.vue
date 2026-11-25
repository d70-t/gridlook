<script lang="ts" setup>
import { useVirtualizer } from "@tanstack/vue-virtual";
import { computed, nextTick, onMounted, ref, shallowRef } from "vue";

import type {
  TVariableGroupInfo,
  TVariableSample,
  TVariableTableRow,
} from "./types";
import VariableGroupHeader from "./VariableGroupHeader.vue";
import type { TVariableSearchResult } from "./variableSearch";
import VariableTableRow from "./VariableTableRow.vue";

import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";

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
    // the matches of the search, null when not searching
    searchResult?: TVariableSearchResult | null;
    // the groups that are levels of the dataset, by group name
    groupInfo?: Record<string, TVariableGroupInfo>;
    // the loaded samples by variable name; without it, no sample button
    samples?: Record<string, TVariableSample>;
  }>(),
  {
    selectedVariable: null,
    showVisualize: false,
    searchResult: null,
    groupInfo: () => ({}),
    samples: undefined,
  }
);

const emit = defineEmits<{
  toggleAttributes: [varName: string];
  visualize: [varName: string];
  goToVariable: [varName: string];
  toggleSample: [varName: string];
}>();

const ROOT_GROUP_NAME = "/";
const VariableSection = {
  DATA: "Data Variables",
  COORDINATES: "Coordinates",
} as const;

type TVariableSection = (typeof VariableSection)[keyof typeof VariableSection];

const SearchItemKind = {
  GROUP: "group",
  SECTION: "section",
  ROW: "row",
} as const;

/** An entry of the flat list of search results. */
type TSearchItem =
  | {
      kind: typeof SearchItemKind.GROUP;
      key: string;
      name: string;
      count: number;
      open: boolean;
    }
  | {
      kind: typeof SearchItemKind.SECTION;
      key: string;
      title: TVariableSection;
      count: number;
    }
  | {
      kind: typeof SearchItemKind.ROW;
      key: string;
      row: TVariableTableDisplayRow;
    };

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

const isSearching = computed(() => props.searchResult !== null);

/** The rows by group, the group of the variable shown first. */
function groupRows(rows: TVariableTableRow[]): TGroupedVariableRows[] {
  const groups: Record<string, TVariableTableDisplayRow[]> = {};

  for (const row of rows) {
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
    .map(([name, groupRows]) => ({ name, rows: groupRows }));
}

const groupedRows = computed(() => groupRows(props.rows));

const hasGroups = computed(
  () =>
    !isSearching.value &&
    groupedRows.value.some((group) => group.name !== ROOT_GROUP_NAME)
);

const variableNames = computed(
  () => new Set(props.rows.map((row) => row.name))
);

function resolveDimensionVariable(rowName: string, dim: string): string | null {
  const candidate = ZarrDataManager.resolveVariablePath(rowName, dim);
  return variableNames.value.has(candidate) ? candidate : null;
}

// groups the user collapsed in the search results
const collapsedSearchGroups = ref<Set<string>>(new Set());

function toggleSearchGroup(groupName: string) {
  const next = new Set(collapsedSearchGroups.value);
  if (!next.delete(groupName)) {
    next.add(groupName);
  }
  collapsedSearchGroups.value = next;
}

/**
 * The search results as one flat list (per group a header, then its data
 * variables and coordinates), so that only the rows in view are rendered: a
 * search can match tens of thousands of variables.
 */
const searchItems = computed<TSearchItem[]>(() => {
  const items: TSearchItem[] = [];
  const groups = groupRows(props.searchResult?.rows ?? []);
  const showGroups = groups.some((group) => group.name !== ROOT_GROUP_NAME);
  for (const group of groups) {
    const open = !collapsedSearchGroups.value.has(group.name);
    if (showGroups) {
      items.push({
        kind: SearchItemKind.GROUP,
        key: `group:${group.name}`,
        name: group.name,
        count: group.rows.length,
        open,
      });
      if (!open) {
        continue;
      }
    }
    for (const [title, rows] of [
      [VariableSection.DATA, group.rows.filter((row) => !row.hidden)],
      [VariableSection.COORDINATES, group.rows.filter((row) => row.hidden)],
    ] as const) {
      if (rows.length === 0) {
        continue;
      }
      items.push({
        kind: SearchItemKind.SECTION,
        key: `section:${group.name}:${title}`,
        title,
        count: rows.length,
      });
      for (const row of rows) {
        items.push({
          kind: SearchItemKind.ROW,
          key: `row:${row.name}`,
          row: showGroups ? row : { ...row, displayName: row.name },
        });
      }
    }
  }
  return items;
});

const rootEl = ref<HTMLElement | null>(null);
const scrollElement = shallowRef<HTMLElement | null>(null);

function findScrollParent(el: HTMLElement | null) {
  for (let node = el?.parentElement; node; node = node.parentElement) {
    if (/(auto|scroll)/.test(getComputedStyle(node).overflowY)) {
      return node;
    }
  }
  return null;
}

/**
 * Where the results start in the scrolled panel. Read when a search starts
 * (the tab is visible then); the controls above the results do not change
 * height while searching.
 */
function resultsOffset() {
  const root = rootEl.value;
  const scroll = scrollElement.value;
  if (!root || !scroll) {
    return 0;
  }
  return (
    root.getBoundingClientRect().top -
    scroll.getBoundingClientRect().top +
    scroll.scrollTop
  );
}

const virtualizer = useVirtualizer(
  computed(() => ({
    count: searchItems.value.length,
    getScrollElement: () => scrollElement.value,
    estimateSize: () => 33,
    getItemKey: (index: number) => searchItems.value[index].key,
    scrollMargin: isSearching.value ? resultsOffset() : 0,
    overscan: 10,
    // rows to render before the panel is measured (and when rendered without
    // a browser)
    initialRect: { width: 0, height: 1000 },
  }))
);

const visibleSearchItems = computed(() =>
  virtualizer.value.getVirtualItems().map((virtualItem) => {
    const item = searchItems.value[virtualItem.index];
    return {
      virtualItem,
      item,
      highlight:
        item.kind === SearchItemKind.ROW
          ? props.searchResult?.highlight(
              item.row,
              item.row.name.length - item.row.displayName.length
            )
          : undefined,
    };
  })
);

const paddingTop = computed(() => {
  const first = visibleSearchItems.value[0]?.virtualItem;
  return first ? first.start - virtualizer.value.options.scrollMargin : 0;
});

const paddingBottom = computed(() => {
  const last = visibleSearchItems.value.at(-1)?.virtualItem;
  return last
    ? virtualizer.value.getTotalSize() -
        (last.end - virtualizer.value.options.scrollMargin)
    : 0;
});

function measureSearchItem(el: unknown) {
  if (el instanceof Element) {
    virtualizer.value.measureElement(el);
  }
}

onMounted(() => {
  scrollElement.value = findScrollParent(rootEl.value);
});

async function goToDimensionCoordinate(rowName: string, dim: string) {
  const target = resolveDimensionVariable(rowName, dim);
  if (!target) {
    return;
  }
  const group = getVariableGroup(target);
  openGroups.value = new Set(openGroups.value).add(group);
  const nextClosedGroups = new Set(closedGroups.value);
  nextClosedGroups.delete(group);
  closedGroups.value = nextClosedGroups;
  emit("goToVariable", target);
  await nextTick();
  // Scroll to the details row when present so its attributes are visible too,
  // not just the name row above it.
  const name = CSS.escape(target);
  (
    rootEl.value?.querySelector(`[data-variable-details="${name}"]`) ??
    rootEl.value?.querySelector(`[data-variable-row="${name}"]`)
  )?.scrollIntoView({
    behavior: "smooth",
    block: "nearest",
  });
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
  <div ref="rootEl" class="dataset-table-section">
    <div v-if="searchItems.length > 0" class="table-container">
      <table
        class="table is-narrow is-fullwidth is-size-7 dataset-table search-results"
        aria-label="Search results"
      >
        <thead>
          <tr>
            <th>Name</th>
            <th>Dimensions</th>
            <th class="dtype-column">dtype</th>
            <th class="actions-column">
              <span class="is-sr-only">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody v-if="paddingTop > 0" aria-hidden="true">
          <tr>
            <td
              colspan="4"
              class="p-0"
              :style="{ height: `${paddingTop}px` }"
            ></td>
          </tr>
        </tbody>
        <tbody
          v-for="{ virtualItem, item, highlight } in visibleSearchItems"
          :key="virtualItem.key as string"
          :ref="measureSearchItem"
          :data-index="virtualItem.index"
        >
          <tr v-if="item.kind === SearchItemKind.GROUP">
            <td colspan="4" class="px-0 pt-3">
              <VariableGroupHeader
                :name="item.name"
                :count="item.count"
                :open="item.open"
                :info="groupInfo[item.name]"
                @toggle="toggleSearchGroup(item.name)"
              />
            </td>
          </tr>
          <tr v-else-if="item.kind === SearchItemKind.SECTION">
            <th colspan="4" class="pt-3">
              {{ item.title }}
              <span class="has-text-grey">({{ item.count }})</span>
            </th>
          </tr>
          <VariableTableRow
            v-else
            :row="item.row"
            :display-name="item.row.displayName"
            :highlight="highlight"
            :selected-attributes-variable="selectedAttributesVariable"
            :selected-variable="selectedVariable"
            :show-visualize="showVisualize"
            :show-sample="!!samples"
            :sample="samples?.[item.row.name]"
            :resolve-dimension-variable="resolveDimensionVariable"
            @toggle-attributes="emit('toggleAttributes', $event)"
            @toggle-sample="emit('toggleSample', $event)"
            @visualize="emit('visualize', $event)"
            @go-to-dimension="goToDimensionCoordinate"
          />
        </tbody>
        <tbody v-if="paddingBottom > 0" aria-hidden="true">
          <tr>
            <td
              colspan="4"
              class="p-0"
              :style="{ height: `${paddingBottom}px` }"
            ></td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-else-if="!isSearching && rows.length > 0">
      <div
        v-for="group in groupedRows"
        :key="group.name"
        :class="{ box: hasGroups }"
        class="p-0 mb-3"
      >
        <VariableGroupHeader
          v-if="hasGroups"
          :name="group.name"
          :count="group.rows.length"
          :open="isGroupOpen(group.name)"
          :info="groupInfo[group.name]"
          @toggle="toggleGroup(group.name)"
        />
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
                  <VariableTableRow
                    v-for="row in table.rows"
                    :key="row.name"
                    :row="row"
                    :display-name="hasGroups ? row.displayName : row.name"
                    :selected-attributes-variable="selectedAttributesVariable"
                    :selected-variable="selectedVariable"
                    :show-visualize="showVisualize"
                    :show-sample="!!samples"
                    :sample="samples?.[row.name]"
                    :resolve-dimension-variable="resolveDimensionVariable"
                    @toggle-attributes="emit('toggleAttributes', $event)"
                    @toggle-sample="emit('toggleSample', $event)"
                    @visualize="emit('visualize', $event)"
                    @go-to-dimension="goToDimensionCoordinate"
                  />
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
  // the rows are rendered by VariableTableRow
  :deep(th),
  :deep(td) {
    vertical-align: middle;
  }

  th {
    white-space: nowrap;
  }
}

.search-results {
  // with automatic layout the columns would change width as rows scroll in
  // and out of view
  table-layout: fixed;

  .dtype-column {
    width: 5rem;
  }

  // fits the three action buttons of a row
  .actions-column {
    width: 6.5rem;
  }

  // every result is its own tbody: keep the row separator Bulma removes from
  // the last row of a tbody
  tbody tr:last-child :deep(td) {
    border-bottom-width: 1px;
  }
}
</style>
