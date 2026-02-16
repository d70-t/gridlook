<script setup lang="ts">
import * as THREE from "three";
import { ref, computed, onMounted, watch, onBeforeUnmount } from "vue";
import type { Ref } from "vue";

import {
  availableColormaps,
  type TColorMap,
} from "@/lib/shaders/colormapShaders";
import { makeColormapLutMaterial } from "@/lib/shaders/gridShaders";

const props = withDefaults(
  defineProps<{
    colormap?: TColorMap;
    invertColormap?: boolean;
    posterizeLevels?: number;
    boundsLow?: number;
    boundsHigh?: number;
    dataBoundsLow?: number;
    dataBoundsHigh?: number;
    histogram?: number[];
  }>(),
  {
    colormap: "turbo",
    invertColormap: false,
    posterizeLevels: 0,
    boundsLow: undefined,
    boundsHigh: undefined,
    dataBoundsLow: undefined,
    dataBoundsHigh: undefined,
    histogram: undefined,
  }
);

const box: Ref<HTMLDivElement | undefined> = ref(undefined);
const canvas: Ref<HTMLCanvasElement | undefined> = ref(undefined);
const histogramCanvas: Ref<HTMLCanvasElement | undefined> = ref(undefined);
const tooltip: Ref<HTMLDivElement | undefined> = ref(undefined);

const hoveredBin = ref<number | null>(null);
const tooltipPosition = ref({ x: 0, y: 0 });

let width: number | undefined;
let height: number | undefined;
let frameId: number = 0;

let lutMesh: THREE.Mesh | undefined;
let resizeObserver: ResizeObserver | undefined;
let scene: THREE.Scene | undefined;
let renderer: THREE.WebGLRenderer | undefined;
let camera: THREE.PerspectiveCamera | undefined;

const addOffset = computed(() => {
  if (props.invertColormap) {
    return 1.0;
  } else {
    return 0.0;
  }
});

const scaleFactor = computed(() => {
  if (props.invertColormap) {
    return -1.0;
  } else {
    return 1.0;
  }
});

const lutMaterial = computed(() => {
  return makeColormapLutMaterial(
    props.colormap,
    addOffset.value,
    scaleFactor.value
  );
});

const lowLabel = computed(() => {
  if (props.boundsLow === undefined || props.boundsHigh === undefined) {
    return "low";
  }
  // Always show actual data bounds - don't swap on invert
  return formatValue(props.boundsLow);
});

const highLabel = computed(() => {
  if (props.boundsLow === undefined || props.boundsHigh === undefined) {
    return "high";
  }
  // Always show actual data bounds - don't swap on invert
  return formatValue(props.boundsHigh);
});

const showMidLabels = computed(() => {
  return (
    props.posterizeLevels >= 4 &&
    props.posterizeLevels <= 10 &&
    props.boundsLow !== undefined &&
    props.boundsHigh !== undefined
  );
});

const midLabelsArray = computed(() => {
  if (!showMidLabels.value) {
    return [];
  }
  const labels = [];
  const low = props.boundsLow!;
  const high = props.boundsHigh!;
  const numSteps = props.posterizeLevels - 1;

  for (let i = 1; i < props.posterizeLevels - 1; i++) {
    const fraction = i / numSteps;
    const value = low + fraction * (high - low);
    labels.push(formatValue(value));
  }

  return labels;
});

function formatValue(value: number): string {
  // Format with appropriate precision
  const absValue = Math.abs(value);
  if (absValue === 0) {
    return "0";
  } else if (absValue >= 1000 || absValue < 0.01) {
    return value.toExponential(1);
  } else if (absValue >= 100) {
    return value.toFixed(0);
  } else if (absValue >= 10) {
    return value.toFixed(1);
  } else {
    return value.toFixed(2);
  }
}

function drawHistogram() {
  if (!histogramCanvas.value || width === undefined || height === undefined) {
    return;
  }
  const context = histogramCanvas.value.getContext("2d");
  if (!context) {
    return;
  }

  const bins = props.histogram;
  context.clearRect(0, 0, width, height);
  if (!bins || bins.length === 0) {
    return;
  }

  const maxCount = Math.max(...bins);
  if (maxCount <= 0) {
    return;
  }

  const barWidth = width / bins.length;
  const gap = Math.min(1, barWidth * 0.2);
  const drawWidth = Math.max(0.5, barWidth - gap);

  for (let i = 0; i < bins.length; i++) {
    const barHeight = (bins[i] / maxCount) * height;
    if (barHeight <= 0) {
      continue;
    }
    const x = i * barWidth + gap / 2;
    const y = height - barHeight;

    // Highlight hovered bin
    if (hoveredBin.value === i && props.posterizeLevels > 0) {
      context.fillStyle = "rgba(255, 255, 255, 0.85)";
    } else {
      context.fillStyle = "rgba(255, 255, 255, 0.45)";
    }
    context.fillRect(x, y, drawWidth, barHeight);
  }
}

function handleHistogramMouseMove(event: MouseEvent) {
  if (
    !histogramCanvas.value ||
    !props.histogram ||
    props.posterizeLevels === 0
  ) {
    return;
  }

  const rect = histogramCanvas.value.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const numBins = props.histogram.length;
  const barWidth = rect.width / numBins;
  const binIndex = Math.floor(x / barWidth);

  if (binIndex >= 0 && binIndex < numBins) {
    hoveredBin.value = binIndex;
    tooltipPosition.value = { x: event.clientX, y: event.clientY };
    drawHistogram();
  }
}

function handleHistogramMouseLeave() {
  hoveredBin.value = null;
  drawHistogram();
}

const tooltipContent = computed(() => {
  if (
    hoveredBin.value === null ||
    props.posterizeLevels === 0 ||
    props.boundsLow === undefined ||
    props.boundsHigh === undefined ||
    !props.histogram
  ) {
    return null;
  }

  const numBins = props.posterizeLevels;
  const range = props.boundsHigh - props.boundsLow;
  const binSize = range / numBins;
  const binLow = props.boundsLow + hoveredBin.value * binSize;
  const binHigh = props.boundsLow + (hoveredBin.value + 1) * binSize;

  // Calculate relative frequency
  const binCount = props.histogram[hoveredBin.value];
  const totalCount = props.histogram.reduce((sum, count) => sum + count, 0);
  const percentage =
    totalCount > 0 ? ((binCount / totalCount) * 100).toFixed(2) : "0.00";

  // Show clear value range with inequality notation
  // Last bin includes upper bound (≤), others exclude it (<)
  const isFirstBin = hoveredBin.value === 0;
  const isLastBin = hoveredBin.value === numBins - 1;
  const upperOperator = isLastBin ? "≤" : "<";

  // Check if data extends beyond user-selected bounds (clamping)
  const hasLowerClamping =
    isFirstBin &&
    props.dataBoundsLow !== undefined &&
    props.dataBoundsLow < props.boundsLow;
  const hasUpperClamping =
    isLastBin &&
    props.dataBoundsHigh !== undefined &&
    props.dataBoundsHigh > props.boundsHigh;

  let rangeText = `${formatValue(binLow)} ≤ value ${upperOperator} ${formatValue(binHigh)}`;
  let clampingNote: string | null = null;

  if (hasLowerClamping) {
    clampingNote = `Includes all values below ${formatValue(props.boundsLow)}`;
  } else if (hasUpperClamping) {
    clampingNote = `Includes all values above ${formatValue(props.boundsHigh)}`;
  }

  return {
    range: rangeText,
    percentage: `${percentage}%`,
    clamping: clampingNote,
  };
});

watch(
  () => props.colormap,
  () => {
    updateColormap();
  }
);

watch(
  () => props.invertColormap,
  () => {
    updateColormap();
  }
);

watch(
  () => props.posterizeLevels,
  () => {
    updateColormap();
  }
);

watch(
  () => props.histogram,
  () => {
    drawHistogram();
  },
  { deep: true }
);

onMounted(() => {
  init();
  resizeObserver = new ResizeObserver(onCanvasResize);
  resizeObserver.observe(box.value as Element);
  onCanvasResize();

  // Apply initial colormap settings (including posterizeLevels from URL params)
  // Defer this to the next animation frame to ensure init() has completed its setup.
  requestAnimationFrame(() => {
    updateColormap();
  });
  // Add hover listeners for histogram
  if (histogramCanvas.value) {
    histogramCanvas.value.addEventListener(
      "mousemove",
      handleHistogramMouseMove
    );
    histogramCanvas.value.addEventListener(
      "mouseleave",
      handleHistogramMouseLeave
    );
  }
});

onBeforeUnmount(() => {
  if (box.value) {
    resizeObserver?.unobserve(box.value as Element);
  }
  resizeObserver?.disconnect();

  // Remove hover listeners
  if (histogramCanvas.value) {
    histogramCanvas.value.removeEventListener(
      "mousemove",
      handleHistogramMouseMove
    );
    histogramCanvas.value.removeEventListener(
      "mouseleave",
      handleHistogramMouseLeave
    );
  }

  lutMesh?.geometry.dispose();
  scene?.clear();
  camera?.clear();
  renderer?.dispose();
  scene = undefined;
  camera = undefined;
  renderer = undefined;
  lutMesh = undefined;
});

function init() {
  const lutGeometry = new THREE.PlaneGeometry(2, 2);
  lutGeometry.setAttribute(
    "data_value",
    new THREE.BufferAttribute(Float32Array.from([0, 1, 0, 1]), 1)
  );
  lutMesh = new THREE.Mesh(lutGeometry, lutMaterial.value);
  // from: https://stackoverflow.com/a/65732553
  scene = new THREE.Scene();
  renderer = new THREE.WebGLRenderer({
    canvas: canvas.value as HTMLCanvasElement,
  });
  scene.add(lutMesh);

  camera = new THREE.PerspectiveCamera(
    7.5,
    window.innerWidth / window.innerHeight,
    0.1,
    1000
  );
  scene.add(camera!);
}

function render() {
  if (width !== undefined && height !== undefined) {
    renderer?.setSize(width, height);
  }
  renderer?.render(scene!, camera!);
  drawHistogram();
  if (box.value) {
    resizeObserver?.observe(box.value as Element);
  }
}

function redraw() {
  cancelAnimationFrame(frameId);
  frameId = requestAnimationFrame(render);
}

function onCanvasResize(/*entries*/) {
  if (!box.value) {
    return;
  }
  const rect = box.value.getBoundingClientRect();
  const boxWidth = Math.round(rect.width);
  const boxHeight = Math.round(rect.height);
  if (boxWidth !== width || boxHeight !== height) {
    resizeObserver?.unobserve(box.value);
    const aspect = boxWidth / boxHeight;
    camera!.aspect = aspect;
    camera?.updateProjectionMatrix();
    width = boxWidth;
    height = boxHeight;
    // Resize histogram canvas
    if (histogramCanvas.value) {
      histogramCanvas.value.width = boxWidth;
      histogramCanvas.value.height = boxHeight;
    }
    redraw();
  }
}

function updateColormap() {
  let shaderMaterial = lutMesh?.material as THREE.ShaderMaterial;
  shaderMaterial.uniforms.colormap.value = availableColormaps[props.colormap];
  shaderMaterial.uniforms.addOffset.value = addOffset.value;
  shaderMaterial.uniforms.scaleFactor.value = scaleFactor.value;
  if (shaderMaterial.uniforms.posterizeLevels) {
    shaderMaterial.uniforms.posterizeLevels.value = props.posterizeLevels;
  }
  redraw();
}
</script>

<template>
  <div ref="box" class="colorbar-container">
    <canvas ref="canvas"></canvas>
    <canvas
      ref="histogramCanvas"
      class="histogram-overlay"
      :style="{ cursor: posterizeLevels > 0 ? 'pointer' : 'default' }"
    >
    </canvas>
    <div
      v-if="tooltipContent"
      ref="tooltip"
      class="histogram-tooltip box"
      :style="{
        left: `${tooltipPosition.x}px`,
        top: `${tooltipPosition.y - (tooltipContent.clamping ? 70 : 55)}px`,
      }"
    >
      <p><strong>Range:</strong> {{ tooltipContent.range }}</p>
      <p><strong>Frequency:</strong> {{ tooltipContent.percentage }}</p>
      <p v-if="tooltipContent.clamping" class="has-text-warning-dark">
        <em>{{ tooltipContent.clamping }}</em>
      </p>
    </div>
    <div class="colorbar-labels">
      <span class="colorbar-label-low">{{ lowLabel }}</span>
      <span v-if="showMidLabels" class="colorbar-label-mid">
        <span v-for="(label, idx) in midLabelsArray" :key="idx">{{
          label
        }}</span>
      </span>
      <span class="colorbar-label-high">{{ highLabel }}</span>
    </div>
  </div>
</template>

<style scoped>
.colorbar-container {
  position: relative;
  width: 100%;
  height: 100%;
}

.histogram-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  pointer-events: auto;
  z-index: 1;
}

.colorbar-labels {
  position: absolute;
  top: 0;
  left: 0;
  right: 0;
  bottom: 0;
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 0 0.25rem;
  pointer-events: none;
  font-size: 0.65rem;
  font-weight: 600;
  color: white;
  text-shadow:
    -1px -1px 0 #000,
    1px -1px 0 #000,
    -1px 1px 0 #000,
    1px 1px 0 #000;
  z-index: 2;
}

.colorbar-label-low,
.colorbar-label-high {
  z-index: 1;
}

.colorbar-label-mid {
  display: flex;
  gap: 0.5rem;
  flex: 1;
  justify-content: space-evenly;
  padding: 0 0.5rem;
}

.histogram-tooltip {
  position: fixed;
  padding: 0.5rem 0.75rem;
  font-size: 0.75rem;
  pointer-events: none;
  z-index: 1000;
  white-space: nowrap;
  transform: translateX(-50%);

  /* Ensure readable text in both light and dark mode */
  background-color: #fff;
  color: #363636;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.2);
}

@media (prefers-color-scheme: dark) {
  .histogram-tooltip {
    background-color: #363636;
    color: #f5f5f5;
  }
}

.histogram-tooltip p {
  margin: 0;
  line-height: 1.4;
}

.histogram-tooltip p + p {
  margin-top: 0.2rem;
}
</style>
