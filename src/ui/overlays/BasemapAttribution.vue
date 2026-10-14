<script lang="ts" setup>
import { useGlobeControlStore } from "@/store/store.ts";

const store = useGlobeControlStore();
</script>

<template>
  <div
    v-if="store.basemapAttribution"
    class="basemap-attribution is-size-7 px-1"
  >
    {{ store.basemapAttribution }}
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
