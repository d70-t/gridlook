<script lang="ts" setup>
import { onBeforeUnmount, ref } from "vue";

import {
  DEFAULT_SNAPSHOT_OPTIONS,
  type TSnapshotBackground,
  type TSnapshotOptions,
} from "@/lib/types/GlobeTypes";

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

function closeOnOutsideClick() {
  dialogOpen.value = false;
  document.removeEventListener("click", closeOnOutsideClick);
}

function openDialog() {
  dialogOpen.value = true;
  // Defer so the current click-event is not immediately caught
  setTimeout(() => {
    document.addEventListener("click", closeOnOutsideClick);
  }, 0);
}

function cancel() {
  dialogOpen.value = false;
  document.removeEventListener("click", closeOnOutsideClick);
}

function takeSnapshot() {
  dialogOpen.value = false;
  document.removeEventListener("click", closeOnOutsideClick);
  emit("onSnapshot", { ...options.value });
}

onBeforeUnmount(() => {
  document.removeEventListener("click", closeOnOutsideClick);
});
</script>

<template>
  <div class="snapshot-wrapper cell">
    <button class="button w-100" type="button" @click.stop="openDialog">
      <span class="icon"><i class="fa-solid fa-image"></i></span>
      <span>Snapshot</span>
    </button>

    <Transition name="popup">
      <div v-if="dialogOpen" class="snapshot-dialog box" @click.stop>
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
          <button class="button is-small" type="button" @click="cancel">
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
      </div>
    </Transition>
  </div>
</template>

<style lang="scss" scoped>
.snapshot-wrapper {
  position: relative;
  display: inline-block;
}

.snapshot-dialog {
  position: absolute;
  bottom: calc(100% + 8px);
  left: 0;
  z-index: 200;
  min-width: 230px;
  padding: 0.75rem;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.3);
}

.dialog-section-label {
  font-size: 0.7rem;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--bulma-grey);
  margin-bottom: 0.4rem;
}

.popup-enter-active,
.popup-leave-active {
  transition:
    opacity 0.15s,
    transform 0.15s;
}

.popup-enter-from,
.popup-leave-to {
  opacity: 0;
  transform: translateY(6px);
}
</style>
