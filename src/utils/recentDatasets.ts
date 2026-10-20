import { useLocalStorage } from "@vueuse/core";
import { computed } from "vue";

import type { TCatalogEntry } from "./catalog.ts";

const MAX_RECENT_DATASETS = 20;

const stored = useLocalStorage<TCatalogEntry[]>("gridlook-recent-datasets", []);

// The stored value is user-editable, so guard against foreign shapes.
export const recentDatasets = computed(() =>
  Array.isArray(stored.value)
    ? stored.value.filter((entry) => typeof entry?.url === "string")
    : []
);

export function addRecentDataset(entry: TCatalogEntry) {
  // Tags only make sense together with their catalog, so they are dropped.
  const { url, title, description, params } = entry;
  stored.value = [
    { url, title, description, params },
    ...recentDatasets.value.filter((e) => e.url !== url),
  ].slice(0, MAX_RECENT_DATASETS);
}

export function clearRecentDatasets() {
  stored.value = [];
}
