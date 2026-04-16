<script lang="ts" setup>
import { ref } from "vue";

import PopupDialog from "./PopupDialog.vue";

import {
  DEFAULT_SNAPSHOT_OPTIONS,
  type TSnapshotBackground,
  type TSnapshotOptions,
  type TSnapshotResolutionScale,
} from "@/lib/types/GlobeTypes.ts";

const emit = defineEmits<{
  onSnapshot: [options: TSnapshotOptions];
}>();

const dialogOpen = ref(false);
const options = ref<TSnapshotOptions>({ ...DEFAULT_SNAPSHOT_OPTIONS });

const BG_LABELS: { value: TSnapshotBackground; label: string }[] = [
  { value: "black", label: "Black" },
  { value: "white", label: "White" },
  { value: "transparent", label: "Transparent" },
];

const RESOLUTION_LABELS: {
  value: TSnapshotResolutionScale;
  label: string;
}[] = [
  { value: 1, label: "1x" },
  { value: 2, label: "2x" },
  { value: 4, label: "4x" },
];

function close() {
  dialogOpen.value = false;
}

function takeSnapshot() {
  dialogOpen.value = false;
  emit("onSnapshot", { ...options.value });
}
</script>

<template>
  <PopupDialog v-model:open="dialogOpen" dialog-class="snapshot-dialog">
    <template #trigger="{ toggle }">
      <button class="button w-100" type="button" @click.stop="toggle">
        <span class="icon"><i class="fa-solid fa-image"></i></span>
        <span>Snapshot</span>
      </button>
    </template>

    <template #default>
      <p class="dialog-section-label">RESOLUTION</p>
      <div class="buttons mb-3">
        <button
          v-for="resolution in RESOLUTION_LABELS"
          :key="resolution.value"
          class="button is-small"
          :class="{
            'is-primary': options.resolutionScale === resolution.value,
          }"
          type="button"
          @click="options.resolutionScale = resolution.value"
        >
          {{ resolution.label }}
        </button>
      </div>

      <p class="dialog-section-label">BACKGROUND</p>
      <div class="buttons mb-3">
        <button
          v-for="bg in BG_LABELS"
          :key="bg.value"
          class="button is-small"
          :class="{ 'is-primary': options.background === bg.value }"
          type="button"
          @click="options.background = bg.value"
        >
          {{ bg.label }}
        </button>
      </div>

      <p class="dialog-section-label">OVERLAYS</p>
      <label class="checkbox is-block mb-2">
        <input v-model="options.showDatasetInfo" type="checkbox" />
        Dataset information
      </label>
      <label class="checkbox is-block mb-3">
        <input v-model="options.showColormap" type="checkbox" />
        Colormap bar
      </label>

      <hr class="my-2" />
      <div class="is-flex is-justify-content-space-between">
        <button class="button is-small" type="button" @click="close">
          Cancel
        </button>
        <button
          class="button is-small is-primary"
          type="button"
          @click="takeSnapshot"
        >
          <span class="icon"><i class="fa-solid fa-download"></i></span>
          <span>Take Snapshot</span>
        </button>
      </div>
    </template>
  </PopupDialog>
</template>

<style lang="scss" scoped>
.snapshot-dialog {
  min-width: 230px;
}
</style>
