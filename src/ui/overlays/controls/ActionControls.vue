<script lang="ts" setup>
import { storeToRefs } from "pinia";

import ShareButton from "./ShareButton.vue";

import { PROJECTION_TYPES } from "@/lib/projection/projectionUtils";
import { useGlobeControlStore } from "@/store/store";

defineEmits<{
  onSnapshot: [];
  onRotate: [];
}>();

const { projectionMode } = storeToRefs(useGlobeControlStore());
</script>

<template>
  <div class="panel-block">
    <div
      class="w-100 is-flex is-justify-content-space-between is-flex-wrap-wrap action-buttons"
    >
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
      <ShareButton />
    </div>
  </div>
</template>

<style lang="scss" scoped>
.action-buttons {
  gap: 0.5rem;
}
</style>
