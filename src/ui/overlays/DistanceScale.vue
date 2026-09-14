<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed } from "vue";

import { useGlobeControlStore } from "@/store/store.ts";

const { distanceScale, showDistanceScale } = storeToRefs(
  useGlobeControlStore()
);
const label = computed(() => {
  const meters = distanceScale.value?.distanceMeters ?? 0;
  const value = meters >= 1000 ? meters / 1000 : meters;
  return `${Number(value.toPrecision(3))} ${meters >= 1000 ? "km" : "m"}`;
});
</script>

<template>
  <div
    v-if="showDistanceScale && distanceScale"
    class="distance-scale has-text-white is-size-6"
    role="img"
    :aria-label="`Local horizontal distance scale at cursor: ${label}`"
  >
    <div>{{ label }}</div>
    <div
      class="distance-scale-bar"
      :style="{ width: `${distanceScale.widthPx}px` }"
    />
  </div>
  <div v-else />
</template>

<style scoped>
.distance-scale {
  position: absolute;
  left: 18px;
  bottom: 18px;
  pointer-events: none;
  padding: 0.5rem 0.75rem;
  border-radius: 4px;
  background: rgba(17, 24, 39, 0.85);
  font-variant-numeric: tabular-nums;
}

.distance-scale-bar {
  height: 8px;
  border: solid currentColor;
  border-width: 0 1px 2px;
  margin-top: 4px;
}
</style>
