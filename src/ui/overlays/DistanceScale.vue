<script lang="ts" setup>
import { useEventListener, useResizeObserver } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { computed, onMounted, ref } from "vue";

import { useGlobeControlStore } from "@/store/store.ts";
import {
  CONTROL_PANEL_WIDTH,
  TITLE_BAR_HEIGHT,
} from "@/ui/common/viewConstants.ts";

const { distanceScale, showDistanceScale } = storeToRefs(
  useGlobeControlStore()
);
const label = computed(() => {
  const meters = distanceScale.value?.distanceMeters ?? 0;
  const value = meters >= 1000 ? meters / 1000 : meters;
  return `${Number(value.toPrecision(3))} ${meters >= 1000 ? "km" : "m"}`;
});

// The scale has a corner of its own, the map's upper left, below the
// dataset title where that floats over the map (sidebar collapsed). It is
// placed when the map is laid out or resized, never by pointer motion, and
// nothing else is placed around it.
const anchor = ref<HTMLElement>();
const top = ref(12);
function place() {
  const map = anchor.value?.parentElement?.getBoundingClientRect();
  if (!map) {
    return;
  }
  const under =
    map.left < CONTROL_PANEL_WIDTH
      ? Math.max(0, TITLE_BAR_HEIGHT - map.top)
      : 0;
  top.value = 12 + under;
}
onMounted(place);
useEventListener(window, "resize", place);
useResizeObserver(() => anchor.value?.parentElement, place);
</script>

<template>
  <div
    ref="anchor"
    class="distance-scale-anchor"
    :style="{ top: `calc(${top}px + env(safe-area-inset-top, 0px))` }"
  >
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
  </div>
</template>

<style scoped>
.distance-scale-anchor {
  position: absolute;
  left: max(12px, env(safe-area-inset-left, 0px));
  pointer-events: none;
  z-index: 5;
}

.distance-scale {
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

<style>
/* A narrow map whose corner a plot picker or sheet covers: the scale waits
   (the Scale setting is kept) and returns with the map. */
@media (max-width: 768px) {
  :has(> .distance-scale-anchor):has(
      .analysis-plots-menu,
      .orbit-dial.open,
      .analysis-title.sheet
    )
    > .distance-scale-anchor {
    visibility: hidden;
  }
}
</style>
