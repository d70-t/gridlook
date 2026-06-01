<script lang="ts" setup>
import { storeToRefs } from "pinia";
import { computed, ref, watch } from "vue";

import {
  HOVERED_GRID_POINT_STATUS,
  useGlobeControlStore,
} from "@/store/store.ts";
import { formatValue } from "@/utils/formatValue";

const store = useGlobeControlStore();
const { hoveredGridPoint, colormap, invertColormap, selection } =
  storeToRefs(store);

const OFFSET_Y = 12;
const COLORMAP_WIDTH = 256;

const tooltipStyle = computed(() => {
  if (!hoveredGridPoint.value) {
    return {};
  }
  return {
    left: `${hoveredGridPoint.value.screenX}px`,
    top: `${hoveredGridPoint.value.screenY - OFFSET_Y}px`,
  };
});

// Offscreen canvas for sampling colormap colors
const colormapCanvas = document.createElement("canvas");
colormapCanvas.width = COLORMAP_WIDTH;
colormapCanvas.height = 1;
const colormapCtx = colormapCanvas.getContext("2d", {
  willReadFrequently: true,
})!;
let loadedColormapName = "";

function loadColormapImage(name: string): Promise<void> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      colormapCtx.drawImage(img, 0, 0, COLORMAP_WIDTH, 1);
      loadedColormapName = name;
      resolve();
    };
    img.onerror = () => resolve();
    img.src = `/static/colormaps/${name}.webp`;
  });
}

const swatchColor = ref<string | null>(null);

watch(
  [hoveredGridPoint, colormap, invertColormap, selection],
  async ([point, cm]) => {
    if (
      !point ||
      point.status === HOVERED_GRID_POINT_STATUS.MISSING ||
      point.value === undefined ||
      point.value === null
    ) {
      swatchColor.value = null;
      return;
    }

    if (loadedColormapName !== cm) {
      await loadColormapImage(cm);
    }

    const range = selection.value.high - selection.value.low;
    if (range === 0) {
      swatchColor.value = null;
      return;
    }

    let t = (point.value - selection.value.low) / range;
    t = Math.max(0, Math.min(1, t));
    if (invertColormap.value) {
      t = 1 - t;
    }

    const x = Math.round(t * (COLORMAP_WIDTH - 1));
    const pixel = colormapCtx.getImageData(x, 0, 1, 1).data;
    swatchColor.value = `rgb(${pixel[0]}, ${pixel[1]}, ${pixel[2]})`;
  },
  { immediate: true }
);

function formatCoordinate(value: number) {
  return `${value.toFixed(2)}°`;
}
</script>

<template>
  <div v-if="hoveredGridPoint" class="grid-hover-readout" :style="tooltipStyle">
    <span class="grid-hover-label">Lat</span>
    <span class="grid-hover-value">{{
      formatCoordinate(hoveredGridPoint.lat)
    }}</span>
    <span class="grid-hover-separator">&bull;</span>
    <span class="grid-hover-label">Lon</span>
    <span class="grid-hover-value">{{
      formatCoordinate(hoveredGridPoint.lon)
    }}</span>
    <span class="grid-hover-separator">&bull;</span>
    <span class="grid-hover-label">Value</span>
    <span
      v-if="swatchColor"
      class="grid-hover-swatch"
      :style="{ background: swatchColor }"
    />
    <span class="grid-hover-value">{{
      hoveredGridPoint.status === HOVERED_GRID_POINT_STATUS.MISSING ||
      hoveredGridPoint.value === undefined ||
      hoveredGridPoint.value === null
        ? "No data"
        : formatValue(hoveredGridPoint.value)
    }}</span>
    <span class="grid-hover-arrow" />
  </div>
  <div v-else />
</template>

<style lang="scss" scoped>
.grid-hover-readout {
  position: fixed;
  transform: translate(-50%, -100%);
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

.grid-hover-arrow {
  position: absolute;
  left: 50%;
  bottom: -6px;
  transform: translateX(-50%);
  width: 0;
  height: 0;
  border-left: 6px solid transparent;
  border-right: 6px solid transparent;
  border-top: 6px solid rgba(17, 24, 39, 0.92);
}

.grid-hover-swatch {
  width: 12px;
  height: 12px;
  border-radius: 3px;
  border: 1px solid rgba(255, 255, 255, 0.3);
  flex-shrink: 0;
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
