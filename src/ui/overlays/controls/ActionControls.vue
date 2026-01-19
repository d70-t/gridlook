<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { Button, Panel } from "primevue";

import { PROJECTION_TYPES } from "@/lib/projection/projectionUtils";
import { useGlobeControlStore } from "@/store/store";

defineEmits<{
  onSnapshot: [];
  onRotate: [];
}>();

const { projectionMode } = storeToRefs(useGlobeControlStore());
</script>

<template>
  <Panel header="Actions" toggleable class="shadow-sm m-2">
    <div class="w-100 is-flex is-justify-content-space-between">
      <Button
        icon="fa-solid fa-image"
        label="Snapshot"
        severity="secondary"
        type="button"
        @click="() => $emit('onSnapshot')"
      />
      <Button
        icon="fa-solid fa-rotate"
        label="Rotate"
        type="button"
        severity="secondary"
        :disabled="projectionMode !== PROJECTION_TYPES.NEARSIDE_PERSPECTIVE"
        :title="
          projectionMode !== PROJECTION_TYPES.NEARSIDE_PERSPECTIVE
            ? 'Rotate is only available for nearside perspective projection'
            : 'Rotate the globe'
        "
        @click="() => $emit('onRotate')"
      />
    </div>
  </Panel>
</template>
