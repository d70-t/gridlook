<script lang="ts" setup>
import { nextTick, onMounted, ref, watch } from "vue";

import CatalogPanel from "./CatalogPanel.vue";

import { useGlobeControlStore } from "@/store/store";
import Modal from "@/ui/common/Modal.vue";
import { fetchCatalog, type TCatalogEntry } from "@/utils/catalog";

const props = defineProps<{ currentSource: string }>();

const store = useGlobeControlStore();

const visible = ref(false);
const checking = ref(false);
const dataPath = ref("");
const datasetInput = ref<HTMLInputElement | null>(null);

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
  datasetInput.value?.focus();
  datasetInput.value?.select();
}

function close() {
  visible.value = false;
}

async function setLocationHash() {
  console.log("set location hash?", dataPath.value);
  const next = dataPath.value.trim();
  if (!next) {
    return;
  }

  checking.value = true;
  try {
    const data = await fetchCatalog(next);
    if (data) {
      store.catalogUrl = next;
      store.catalogData = data;
      dataPath.value = "";
      return;
    }
  } catch {
    /* fetch failed or timed out, proceed with normal loading */
  } finally {
    checking.value = false;
  }

  location.hash = "#" + next;
  close();
}

function onCatalogSelect(entry: TCatalogEntry) {
  const catUrl = store.catalogUrl;
  location.hash =
    "#" + entry.url + (catUrl ? "::catalog=" + encodeURIComponent(catUrl) : "");
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
    footer-class="is-justify-content-flex-end"
  >
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
            <i class="fa-solid fa-folder-open"></i>
          </span>
        </div>
      </div>
    </form>

    <CatalogPanel
      v-if="store.catalogData"
      :title="store.catalogData.title"
      :datasets="store.catalogData.datasets"
      @select="onCatalogSelect"
    />

    <template #footer>
      <div class="buttons">
        <button
          type="button"
          class="button"
          :disabled="checking"
          @click="close"
        >
          Cancel
        </button>
        <button
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
