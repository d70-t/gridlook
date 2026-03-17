<script lang="ts" setup>
import { storeToRefs } from "pinia";

import ShareButton from "./ShareButton.vue";
import SnapshotButton from "./SnapshotButton.vue";

import { PROJECTION_TYPES } from "@/lib/projection/projectionUtils";
import type { TSnapshotOptions } from "@/lib/types/GlobeTypes";
import { useGlobeControlStore } from "@/store/store";

defineEmits<{
  onSnapshot: [options: TSnapshotOptions];
  onRotate: [];
}>();

const { projectionMode, isRotating } = storeToRefs(useGlobeControlStore());
</script>

<template>
  <div class="column">
    <div
      class="is-flex is-justify-content-space-between is-flex-wrap-wrap action-buttons"
    >
      <SnapshotButton @on-snapshot="(opts) => $emit('onSnapshot', opts)" />
      <button
        class="button"
        :class="{ 'is-info': isRotating }"
        type="button"
        :title="
          projectionMode !== PROJECTION_TYPES.NEARSIDE_PERSPECTIVE
            ? 'Rotate the projection around longitude'
            : 'Rotate the globe'
        "
        @click="() => $emit('onRotate')"
      >
        <span class="icon">
          <i class="fas fa-rotate"></i>
        </span>
        <span> Rotate </span>
      </button>
      <ShareButton />
    </div>
  </div>
</template>

<style lang="scss" scoped></style>
