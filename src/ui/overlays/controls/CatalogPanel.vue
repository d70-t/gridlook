<script lang="ts" setup>
import { computed } from "vue";

import CatalogEntryList from "./CatalogEntryList.vue";

import {
  CatalogSort,
  TAG_SORT_PREFIX,
  tagLabel,
  type TCatalogEntry,
} from "@/utils/catalog.ts";

// Owned by the parent, so the filters survive closing the modal.
const searchQuery = defineModel<string>("search", { required: true });

const sortKey = defineModel<string>("sort", { required: true });

const tagFilters = defineModel<Record<string, string>>("tagFilters", {
  required: true,
});

const props = defineProps<{
  title?: string;
  datasets: TCatalogEntry[];
  currentSource: string;
}>();

const emit = defineEmits<{
  select: [entry: TCatalogEntry];
}>();

const tagKeys = computed(() => {
  const keys = new Set<string>();
  for (const entry of props.datasets) {
    for (const key of Object.keys(entry.tags ?? {})) {
      keys.add(key);
    }
  }
  return [...keys];
});

const searchedDatasets = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();
  return props.datasets.filter((entry) => {
    const haystack = [
      entry.title ?? "",
      entry.url,
      ...Object.values(entry.tags ?? {}),
      entry.description ?? "",
    ]
      .join(" ")
      .toLowerCase();
    return haystack.includes(q);
  });
});

function matchesTagFilters(entry: TCatalogEntry, ignoredKey?: string) {
  return Object.entries(tagFilters.value).every(
    ([key, value]) =>
      key === ignoredKey || !value || entry.tags?.[key] === value
  );
}

// Each count reflects the search and all *other* tag filters, so it tells how
// many datasets remain when picking that value.
const tagOptions = computed(() =>
  tagKeys.value.map((key) => {
    const counts = new Map<string, number>();
    for (const entry of props.datasets) {
      const value = entry.tags?.[key];
      if (value !== undefined) {
        counts.set(value, 0);
      }
    }
    for (const entry of searchedDatasets.value) {
      const value = entry.tags?.[key];
      if (value !== undefined && matchesTagFilters(entry, key)) {
        counts.set(value, counts.get(value)! + 1);
      }
    }
    return {
      key,
      values: [...counts].sort(([a], [b]) => a.localeCompare(b)),
    };
  })
);

const filteredAndSortedDatasets = computed(() => {
  const list = searchedDatasets.value.filter((entry) =>
    matchesTagFilters(entry)
  );

  if (sortKey.value === CatalogSort.TITLE) {
    list.sort((a, b) => (a.title ?? a.url).localeCompare(b.title ?? b.url));
  } else if (sortKey.value.startsWith(TAG_SORT_PREFIX)) {
    const key = sortKey.value.substring(TAG_SORT_PREFIX.length);
    list.sort((a, b) =>
      (a.tags?.[key] ?? "").localeCompare(b.tags?.[key] ?? "")
    );
  }

  return list;
});

function setTagFilter(key: string, value: string) {
  tagFilters.value = { ...tagFilters.value, [key]: value };
}

function toggleTagFilter(key: string, value: string) {
  setTagFilter(key, tagFilters.value[key] === value ? "" : value);
}
</script>

<template>
  <nav>
    <h2 class="catalog-title">
      {{ title ?? "Dataset Catalog" }}
    </h2>
    <div class="is-flex-direction-column my-3 w-100">
      <div class="control has-icons-left mb-2">
        <input
          v-model="searchQuery"
          class="input is-small"
          type="text"
          placeholder="Search datasets…"
        />
        <span class="icon is-left is-small">
          <i class="fa-solid fa-magnifying-glass"></i>
        </span>
      </div>
      <div
        v-if="tagOptions.length > 0"
        class="field is-grouped is-grouped-multiline mb-2"
      >
        <div v-for="option in tagOptions" :key="option.key" class="control">
          <div class="select is-small">
            <select
              :aria-label="tagLabel(option.key)"
              :value="tagFilters[option.key] ?? ''"
              @change="
                setTagFilter(
                  option.key,
                  ($event.target as HTMLSelectElement).value
                )
              "
            >
              <option value="">{{ tagLabel(option.key) }}: All</option>
              <option
                v-for="[value, count] in option.values"
                :key="value"
                :value="value"
              >
                {{ value }} ({{ count }})
              </option>
            </select>
          </div>
        </div>
      </div>
      <div
        class="is-flex is-align-items-center is-justify-content-space-between w-100"
      >
        <span class="is-size-7 has-text-grey">
          {{ filteredAndSortedDatasets.length }} /
          {{ datasets.length }}
          dataset{{ datasets.length !== 1 ? "s" : "" }}
        </span>
        <div class="field is-grouped is-align-items-center mb-0">
          <label class="label is-small mr-2 mb-0">Sort</label>
          <div class="control">
            <div class="select is-small">
              <select v-model="sortKey">
                <option :value="CatalogSort.DEFAULT">Default</option>
                <option :value="CatalogSort.TITLE">Title</option>
                <option
                  v-for="key in tagKeys"
                  :key="key"
                  :value="TAG_SORT_PREFIX + key"
                >
                  {{ tagLabel(key) }}
                </option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>

    <CatalogEntryList
      :entries="filteredAndSortedDatasets"
      :current-source="currentSource"
      :tag-keys="tagKeys"
      @select="emit('select', $event)"
      @tag-click="toggleTagFilter"
    >
      <p class="has-text-grey is-size-7">No datasets match your search.</p>
    </CatalogEntryList>
  </nav>
</template>

<style lang="scss" scoped>
.catalog-title {
  color: var(--bulma-label-color);
  display: block;
  font-size: var(--bulma-size-normal);
  font-weight: var(--bulma-weight-semibold);
}
</style>
