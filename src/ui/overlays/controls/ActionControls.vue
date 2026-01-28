<script lang="ts" setup>
import { useToast } from "primevue/usetoast";
import { storeToRefs } from "pinia";

import { PROJECTION_TYPES } from "@/lib/projection/projectionUtils";
import { useGlobeControlStore } from "@/store/store";

defineEmits<{
  onSnapshot: [];
  onRotate: [];
}>();

const { projectionMode } = storeToRefs(useGlobeControlStore());
const toast = useToast();

async function shareUrl() {
  const url = window.location.href;

  // Try native share API first (mobile devices)
  if (navigator.share) {
    try {
      await navigator.share({
        title: document.title,
        url: url,
      });
      return;
    } catch (err) {
      // User cancelled or share failed, fall back to clipboard
      if ((err as Error).name === "AbortError") {
        return; // User cancelled, don't show any message
      }
    }
  }

  // Fall back to clipboard
  try {
    await navigator.clipboard.writeText(url);
    toast.add({
      summary: "Link copied",
      detail: "The URL has been copied to your clipboard",
      severity: "success",
      life: 3000,
    });
  } catch (err) {
    toast.add({
      summary: "Failed to copy",
      detail: "Could not copy the URL to clipboard",
      severity: "error",
      life: 4000,
    });
  }
}
</script>

<template>
  <div class="panel-block">
    <div class="w-100 is-flex is-justify-content-space-between is-flex-wrap-wrap action-buttons">
      <button class="button" type="button" @click="() => $emit('onSnapshot')">
        <span class="icon"><i class="fa-solid fa-image"></i></span>
        <span> Snapshot</span>
      </button>
      <button
        class="button"
        type="button"
        :disabled="projectionMode !== PROJECTION_TYPES.NEARSIDE_PERSPECTIVE"
        :title="
          projectionMode !== PROJECTION_TYPES.NEARSIDE_PERSPECTIVE
            ? 'Rotate is only available for nearside perspective projection'
            : 'Rotate the globe'
        "
        @click="() => $emit('onRotate')"
      >
        <span class="icon">
          <i class="fas fa-rotate"></i>
        </span>
        <span> Rotate </span>
      </button>
      <button
        class="button"
        type="button"
        title="Share the current view URL"
        @click="shareUrl"
      >
        <span class="icon">
          <i class="fa-solid fa-share-nodes"></i>
        </span>
        <span> Share </span>
      </button>
    </div>
  </div>
</template>

<style lang="scss" scoped>
.action-buttons {
  gap: 0.5rem;
}
</style>
