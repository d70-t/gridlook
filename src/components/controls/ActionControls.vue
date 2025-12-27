<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { useGlobeControlStore } from "../store/store";
import { PROJECTION_TYPES } from "../utils/projectionUtils";

defineEmits<{
  onSnapshot: [];
  onRotate: [];
}>();

const { projectionMode } = storeToRefs(useGlobeControlStore());
</script>

<template>
  <div class="panel-block">
    <div class="w-100 is-flex is-justify-content-space-between">
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
    </div>
  </div>
</template>
