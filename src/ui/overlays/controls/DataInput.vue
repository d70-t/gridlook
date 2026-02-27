<script lang="ts" setup>
import { nextTick, ref, watch } from "vue";

import Modal from "@/ui/common/Modal.vue";

const props = defineProps<{ currentSource: string }>();

const visible = ref(false);
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

function setLocationHash() {
  const next = dataPath.value.trim();
  if (!next) {
    return;
  }
  location.hash = "#" + next;
  close();
}
</script>

<template>
  <Modal
    v-model="visible"
    title="Open dataset"
    footer-class="is-justify-content-flex-end"
  >
    <form id="load-dataset" @submit.prevent="setLocationHash">
      <div class="field">
        <label class="label" for="dataset-url">Dataset URL</label>
        <div class="control has-icons-left">
          <input
            id="dataset-url"
            ref="datasetInput"
            v-model="dataPath"
            class="input"
            type="url"
            placeholder="Zarr URI"
          />
          <span class="icon is-left">
            <i class="fa-solid fa-folder-open"></i>
          </span>
        </div>
      </div>
    </form>
    <template #footer>
      <div class="buttons">
        <button type="button" class="button" @click="close">Cancel</button>
        <button type="submit" form="load-dataset" class="button is-success">
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
