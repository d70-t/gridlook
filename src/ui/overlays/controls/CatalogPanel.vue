<script lang="ts" setup>
import { computed, ref } from "vue";

import type { TCatalogEntry } from "@/utils/catalog.ts";

const props = defineProps<{
  title?: string;
  datasets: TCatalogEntry[];
}>();

const emit = defineEmits<{
  select: [entry: TCatalogEntry];
}>();

const searchQuery = ref("");

type SortKey = "default" | "title" | "tag";
const sortKey = ref<SortKey>("default");

const filteredAndSortedDatasets = computed(() => {
  const q = searchQuery.value.trim().toLowerCase();

  let list = [...props.datasets];
  if (q) {
    list = props.datasets.filter((entry) => {
      const haystack = [
        entry.title ?? "",
        entry.url,
        entry.tag ?? "",
        entry.description ?? "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  }

  if (sortKey.value === "title") {
    list.sort((a, b) => (a.title ?? a.url).localeCompare(b.title ?? b.url));
  } else if (sortKey.value === "tag") {
    list.sort((a, b) => (a.tag ?? "").localeCompare(b.tag ?? ""));
  }

  return list;
});

function displayTitle(entry: TCatalogEntry): string {
  return entry.title ?? entry.url;
}

function select(entry: TCatalogEntry) {
  emit("select", entry);
}
</script>

<template>
  <nav class="catalog-panel mt-4 pt-2">
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
                <option value="default">Default</option>
                <option value="title">Title</option>
                <option value="tag">Tag</option>
              </select>
            </div>
          </div>
        </div>
      </div>
    </div>

    <div class="catalog-entries">
      <p
        v-if="filteredAndSortedDatasets.length === 0"
        class="has-text-grey is-size-7"
      >
        No datasets match your search.
      </p>
      <button
        v-for="(entry, i) in filteredAndSortedDatasets"
        :key="entry.url + '-' + i"
        class="catalog-entry panel-block"
        type="button"
        @click="select(entry)"
      >
        <div class="catalog-entry-content">
          <div class="catalog-entry-header">
            <div class="catalog-entry-main">
              <span class="icon is-small has-text-link">
                <i class="fa-solid fa-database"></i>
              </span>
              <strong class="catalog-entry-title" :title="displayTitle(entry)">
                {{ displayTitle(entry) }}
              </strong>
            </div>
            <span v-if="entry.tag" class="tag is-link is-light is-small">
              {{ entry.tag }}
            </span>
          </div>
          <p v-if="entry.description" class="help has-text-grey mt-1 mb-0">
            {{ entry.description }}
          </p>
          <p
            v-if="entry.title"
            class="help has-text-grey-light mt-1 mb-0 catalog-entry-url"
            :title="entry.url"
          >
            {{ entry.url }}
          </p>
        </div>
      </button>
    </div>
  </nav>
</template>

<style lang="scss" scoped>
.catalog-title {
  color: var(--bulma-label-color);
  display: block;
  font-size: var(--bulma-size-normal);
  font-weight: var(--bulma-weight-semibold);
}
.catalog-panel {
  margin-top: 1rem;
  max-height: 400px;
}

.catalog-entries {
  max-height: 45vh;
  overflow-y: auto;
  scrollbar-width: thin;
}

.catalog-entry {
  display: block !important;
  width: 100%;
  text-align: left;
  background: none;
  border: none;
  cursor: pointer;
  font: inherit;
  color: inherit;
  &:hover {
    background-color: var(--bulma-link-light) !important;
  }
  border-bottom: 1px solid var(--bulma-border) !important;
  &:last-child {
    border-bottom: none !important;
  }
}

.catalog-entry-content {
  width: 100%;
  min-width: 0;
}

.catalog-entry-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  min-width: 0;
}

.catalog-entry-main {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex: 1 1 auto;
  min-width: 0;
}

.catalog-entry-header .tag {
  flex-shrink: 0;
}

.catalog-entry-title {
  display: block;
  flex: 1 1 auto;
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
  min-width: 0;
}

.catalog-entry-url {
  overflow: hidden;
  white-space: nowrap;
  text-overflow: ellipsis;
}
</style>
