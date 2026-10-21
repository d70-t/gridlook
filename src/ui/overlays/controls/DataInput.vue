<script lang="ts" setup>
import { nextTick, onMounted, ref, watch } from "vue";

import CatalogEntryList from "./CatalogEntryList.vue";
import CatalogPanel from "./CatalogPanel.vue";

import { isNetCDFFile, registerLocalNetCDF } from "@/lib/data/localNetCDF.ts";
import { registerLocalZarr } from "@/lib/data/localZarr.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import Modal from "@/ui/common/Modal.vue";
import { ToastType, useToast } from "@/ui/common/useToast.ts";
import { isMobileDevice } from "@/ui/common/viewConstants.ts";
import {
  CatalogSort,
  fetchCatalog,
  hashParams,
  parseCatalog,
  type TCatalog,
  type TCatalogEntry,
} from "@/utils/catalog.ts";
import {
  addRecentDataset,
  clearRecentDatasets,
  recentDatasets,
} from "@/utils/recentDatasets.ts";
import { URL_PARAMETERS, type TURLParameterValues } from "@/utils/urlParams.ts";

const props = defineProps<{ currentSource: string }>();

const KEEP_SETTINGS_PARAMETERS: TURLParameterValues[] = [
  URL_PARAMETERS.LAYERS,
  URL_PARAMETERS.CAMERA_PX,
  URL_PARAMETERS.CAMERA_PY,
  URL_PARAMETERS.CAMERA_ALT,
  URL_PARAMETERS.PROJECTION,
  URL_PARAMETERS.LAT,
  URL_PARAMETERS.LON,
  URL_PARAMETERS.COLORMAP,
  URL_PARAMETERS.INVERT_COLORMAP,
  URL_PARAMETERS.POSTERIZE_LEVELS,
  URL_PARAMETERS.HIDE_LOWER_BOUND,
  URL_PARAMETERS.HIDE_UPPER_BOUND,
];

const DataInputTab = {
  OPEN: "open",
  CATALOG: "catalog",
} as const;

type TDataInputTab = (typeof DataInputTab)[keyof typeof DataInputTab];

const TABS = [
  { id: DataInputTab.OPEN, label: "Open", icon: "fa-folder-open" },
  { id: DataInputTab.CATALOG, label: "Catalog", icon: "fa-book" },
];

const store = useGlobeControlStore();
const { addToast } = useToast();

const visible = ref(false);
const checking = ref(false);
const keepSettings = ref(false);
const dataPath = ref("");
const datasetInput = ref<HTMLInputElement | null>(null);
const localFileInput = ref<HTMLInputElement | null>(null);
const localZarrInput = ref<HTMLInputElement | null>(null);
const localCatalogInput = ref<HTMLInputElement | null>(null);

// Lives here and not in the modal content, so it survives closing the modal.
const activeTab = ref<TDataInputTab>(DataInputTab.OPEN);
const searchQuery = ref("");
const sortKey = ref<string>(CatalogSort.DEFAULT);
const tagFilters = ref<Record<string, string>>({});

const syncPath = () => {
  dataPath.value = props.currentSource?.trim() ?? "";
};

watch(
  () => props.currentSource,
  () => {
    syncPath();
  },
  { immediate: true }
);

async function open() {
  syncPath();
  visible.value = true;
  await nextTick();
  // setting focus on mobile devices opens the keyboard, which obscures the modal, so we skip it there.
  if (!isMobileDevice()) {
    datasetInput.value?.focus();
    datasetInput.value?.select();
  }
}

function close() {
  visible.value = false;
}

// Copies parameters verbatim from the current hash, so their encoding survives.
function carriedParams() {
  const carried: string[] = [
    URL_PARAMETERS.BASEMAP_CATALOG,
    ...(keepSettings.value ? KEEP_SETTINGS_PARAMETERS : []),
  ];
  return location.hash
    .substring(1)
    .split("::")
    .slice(1)
    .filter((entry) => carried.includes(entry.split("=")[0]))
    .map((entry) => "::" + entry)
    .join("");
}

async function setLocationHash() {
  const next = dataPath.value.trim();
  if (!next) {
    return;
  }
  const filenameToCheck = next.endsWith("/") ? next.slice(0, -1) : next;
  // Catalogs are expected to be JSON files, so if the input ends with .json, we
  // can try to fetch it as a catalog before setting the location hash
  const isMaybeCatalog = filenameToCheck.endsWith(".json");

  if (isMaybeCatalog) {
    checking.value = true;
    try {
      const data = await fetchCatalog(next);
      if (data) {
        setCatalog(next, data);
        dataPath.value = "";
        return;
      }
    } catch {
      /* fetch failed or timed out, proceed with normal loading */
    } finally {
      checking.value = false;
    }
  }

  openDataset({ url: next });
}

function setCatalog(url: string | undefined, data: TCatalog) {
  store.catalogUrl = url;
  store.catalogData = data;
  searchQuery.value = "";
  sortKey.value = CatalogSort.DEFAULT;
  tagFilters.value = {};
  activeTab.value = DataInputTab.CATALOG;
}

// Entry params come first, so carried settings win when both set a parameter.
function openDataset(entry: TCatalogEntry) {
  addRecentDataset(entry);
  const catUrl = store.catalogUrl;
  location.hash =
    "#" +
    entry.url +
    hashParams(entry.params) +
    (catUrl ? "::catalog=" + encodeURIComponent(catUrl) : "") +
    carriedParams();
  close();
}

function selectLocalCatalog() {
  localCatalogInput.value?.click();
}

async function onLocalCatalogSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file) {
    return;
  }
  let data: TCatalog | null = null;
  try {
    data = parseCatalog(JSON.parse(await file.text()));
  } catch {
    /* invalid JSON, reported below */
  }
  if (!data) {
    addToast("Invalid catalog", {
      detail: `${file.name} is not a Gridlook catalog`,
      duration: 4000,
      type: ToastType.DANGER,
    });
    return;
  }
  // A local file has no URL that could be shared via the hash.
  setCatalog(undefined, data);
}

function selectLocalNetCDF() {
  localFileInput.value?.click();
}

function onLocalFileSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || !isNetCDFFile(file)) {
    return;
  }
  location.hash = `#${registerLocalNetCDF(file)}${carriedParams()}`;
  close();
}

function selectLocalZarr() {
  localZarrInput.value?.click();
}

function onLocalZarrSelected(event: Event) {
  const input = event.target as HTMLInputElement;
  // input.files is a live FileList, so snapshot it into an array before
  // resetting input.value clears it out from under us.
  const files = input.files ? Array.from(input.files) : [];
  input.value = "";
  if (files.length === 0) {
    return;
  }
  location.hash = `#${registerLocalZarr(files)}${carriedParams()}`;
  close();
}

onMounted(async () => {
  if (store.catalogUrl && !store.catalogData) {
    try {
      const data = await fetchCatalog(store.catalogUrl);
      if (data) {
        store.catalogData = data;
        return;
      }
    } catch {
      /* fetch failed or timed out, proceed with normal loading */
    } finally {
      checking.value = false;
    }
  }
});
</script>

<template>
  <Modal
    v-model="visible"
    title="Open dataset"
    footer-class="is-flex-wrap-wrap is-justify-content-flex-end is-gap-1"
    fixed-height
  >
    <div class="tabs is-fullwidth mb-4">
      <ul>
        <li
          v-for="tab in TABS"
          :key="tab.id"
          :class="{ 'is-active': activeTab === tab.id }"
        >
          <a href="#" @click.prevent="activeTab = tab.id">
            <span class="icon is-small">
              <i class="fa-solid" :class="tab.icon" aria-hidden="true"></i>
            </span>
            <span>{{ tab.label }}</span>
          </a>
        </li>
      </ul>
    </div>

    <template v-if="activeTab === DataInputTab.OPEN">
      <form id="load-dataset" @submit.prevent="setLocationHash">
        <div class="field">
          <label class="label" for="dataset-url">Dataset / Catalog URL</label>
          <div class="control has-icons-left">
            <input
              id="dataset-url"
              ref="datasetInput"
              v-model="dataPath"
              class="input"
              type="url"
              placeholder="Zarr URI or catalog URL"
            />
            <span class="icon is-left">
              <i class="fa-solid fa-link"></i>
            </span>
          </div>
        </div>
      </form>

      <div class="buttons mt-3">
        <input
          ref="localFileInput"
          class="is-hidden"
          type="file"
          accept=".nc,.nc4,.cdf,application/x-netcdf"
          @change="onLocalFileSelected"
        />
        <button
          type="button"
          class="button is-small"
          @click="selectLocalNetCDF"
        >
          <span class="icon"><i class="fa-solid fa-file"></i></span>
          <span>Local NetCDF</span>
        </button>
        <input
          ref="localZarrInput"
          class="is-hidden"
          type="file"
          webkitdirectory
          @change="onLocalZarrSelected"
        />
        <button type="button" class="button is-small" @click="selectLocalZarr">
          <span class="icon"><i class="fa-solid fa-folder"></i></span>
          <span>Local Zarr</span>
        </button>
        <input
          ref="localCatalogInput"
          class="is-hidden"
          type="file"
          accept=".json,application/json"
          @change="onLocalCatalogSelected"
        />
        <button
          type="button"
          class="button is-small"
          @click="selectLocalCatalog"
        >
          <span class="icon"><i class="fa-solid fa-book"></i></span>
          <span>Local Catalog</span>
        </button>
      </div>

      <div
        class="is-flex is-align-items-center is-justify-content-space-between mt-4 mb-2"
      >
        <h2 class="label mb-0">
          <span class="icon is-small mr-1">
            <i class="fa-solid fa-clock-rotate-left" aria-hidden="true"></i>
          </span>
          Recently opened
        </h2>
        <button
          v-if="recentDatasets.length > 0"
          type="button"
          class="button is-small is-text"
          @click="clearRecentDatasets"
        >
          Clear
        </button>
      </div>
      <CatalogEntryList
        :entries="recentDatasets"
        :current-source="currentSource"
        @select="openDataset"
      >
        <p class="has-text-grey is-size-7">No recently opened datasets.</p>
      </CatalogEntryList>
    </template>

    <template v-else>
      <CatalogPanel
        v-if="store.catalogData"
        v-model:search="searchQuery"
        v-model:sort="sortKey"
        v-model:tag-filters="tagFilters"
        :title="store.catalogData.title"
        :datasets="store.catalogData.datasets"
        :current-source="currentSource"
        @select="openDataset"
      />
      <p v-else class="has-text-grey is-size-7">No catalog loaded.</p>
    </template>

    <template #footer>
      <label class="checkbox">
        <input v-model="keepSettings" type="checkbox" />
        Keep view settings
      </label>
      <div class="buttons ml-auto">
        <button
          type="button"
          class="button"
          :disabled="checking"
          @click="close"
        >
          Cancel
        </button>
        <button
          v-if="activeTab === DataInputTab.OPEN"
          type="submit"
          form="load-dataset"
          class="button is-success"
          :class="{ 'is-loading': checking }"
          :disabled="checking"
        >
          Load
        </button>
      </div>
    </template>
  </Modal>

  <button
    type="button"
    class="button is-light data-input-trigger"
    title="Load dataset"
    @click="open"
  >
    <span class="icon">
      <i class="fa-solid fa-folder-open"></i>
    </span>
  </button>
</template>
