<script lang="ts" setup>
import { storeToRefs } from "pinia";

import { useGlobeControlStore } from "@/store/store.ts";

const store = useGlobeControlStore();
const { hoveredGridPoint } = storeToRefs(store);

function formatCoordinate(value: number) {
  return `${value.toFixed(2)}°`;
}
</script>

<template>
  <div v-if="hoveredGridPoint" class="grid-hover-readout">
    <span class="grid-hover-label">Lat</span>
    <span class="grid-hover-value">{{
      formatCoordinate(hoveredGridPoint.lat)
    }}</span>
    <span class="grid-hover-separator">&bull;</span>
    <span class="grid-hover-label">Lon</span>
    <span class="grid-hover-value">{{
      formatCoordinate(hoveredGridPoint.lon)
    }}</span>
  </div>
  <div v-else />
</template>

<style lang="scss" scoped>
.grid-hover-readout {
  position: absolute;
  left: 50%;
  bottom: 18px;
  transform: translateX(-50%);
  z-index: 1050;
  pointer-events: none;
  display: inline-flex;
  align-items: center;
  gap: 0.45rem;
  background: rgba(17, 24, 39, 0.92);
  color: #f8fafc;
  border: 1px solid rgba(148, 163, 184, 0.35);
  box-shadow: 0 16px 36px rgba(15, 23, 42, 0.28);
  padding: 0.55rem 0.85rem;
  border-radius: 999px;
  font-size: 0.9rem;
  white-space: nowrap;
}

.grid-hover-label {
  color: rgba(226, 232, 240, 0.72);
  text-transform: uppercase;
  letter-spacing: 0.04em;
  font-size: 0.74rem;
}

.grid-hover-value {
  font-variant-numeric: tabular-nums;
}

.grid-hover-separator {
  color: rgba(191, 219, 254, 0.65);
}
</style>
