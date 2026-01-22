<script lang="ts" setup>
import { ref, watch } from "vue";

const props = defineProps<{ currentSource: string }>();

const visible = ref(false);
const dataPath = ref("");

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

function open() {
  syncPath();
  visible.value = true;
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
  <Teleport to="body">
    <div v-if="visible" class="modal is-active">
      <div class="modal-background" @click.self="close"></div>
      <div class="modal-card">
        <header class="modal-card-head">
          <p class="modal-card-title">Load dataset</p>
          <button
            type="button"
            class="delete"
            aria-label="close"
            @click="close"
          ></button>
        </header>
        <section class="modal-card-body">
          <form id="load-dataset" @submit.prevent="setLocationHash">
            <div class="field">
              <label class="label" for="dataset-url">Dataset URL</label>
              <div class="control has-icons-left">
                <input
                  id="dataset-url"
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
        </section>
        <footer class="modal-card-foot">
          <div class="buttons">
            <button type="button" class="button" @click="close">Cancel</button>
            <button type="submit" form="load-dataset" class="button is-success">
              Load
            </button>
          </div>
        </footer>
      </div>
    </div>
  </Teleport>

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
