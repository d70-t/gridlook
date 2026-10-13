<script lang="ts" setup>
import { computed } from "vue";

import { LAYER_KINDS, useGlobeControlStore } from "@/store/store.ts";

const store = useGlobeControlStore();

// Tile providers require their attribution to be visible on the map.
const attribution = computed(() => {
  const visible = store.layerStack.some(
    (layer) => layer.kind === LAYER_KINDS.BASEMAP && layer.visible
  );
  return visible
    ? store.basemaps?.find((entry) => entry.id === store.selectedBasemap)
        ?.attribution
    : undefined;
});
</script>

<template>
  <div v-if="attribution" class="basemap-attribution is-size-7 px-1">
    {{ attribution }}
  </div>
  <div v-else />
</template>

<style scoped>
.basemap-attribution {
  position: absolute;
  right: 0;
  bottom: 0;
  background: rgba(255, 255, 255, 0.7);
  color: #333;
}
</style>
