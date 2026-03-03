<script setup lang="ts">
import * as THREE from "three";
import {
  ref,
  computed,
  onMounted,
  watch,
  onBeforeUnmount,
  nextTick,
} from "vue";

import {
  formatValue,
  computeBinTooltip,
  type BinTooltip,
} from "./colorbarUtils";

import {
  availableColormaps,
  type TColorMap,
} from "@/lib/shaders/colormapShaders";
import { makeCompressedColormapLutMaterial } from "@/lib/shaders/gridShaders";
import RangeSlider from "@/ui/common/RangeSlider.vue";
import DistributionPlot from "@/ui/overlays/controls/DistributionPlot.vue";

const props = withDefaults(
  defineProps<{
    colormap?: TColorMap;
    invertColormap?: boolean;
    posterizeLevels?: number;
    boundsLow?: number;
    boundsHigh?: number;
    dataBoundsLow?: number;
    dataBoundsHigh?: number;
    fullHistogram?: number[];
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
    fullHistogram: undefined,
    histogram: undefined,
  }
);

const emit = defineEmits<{
  "update:boundsLow": [value: number];
  "update:boundsHigh": [value: number];
}>();

const GRADIENT_HEIGHT = 44;

const widgetRef = ref<HTMLDivElement>();
const gradientCanvasRef = ref<HTMLCanvasElement>();
const selHistCanvasRef = ref<HTMLCanvasElement>();
const sliderRef = ref<InstanceType<typeof RangeSlider>>();

const widgetWidth = ref(0);
const hoveredSelBin = ref<number | null>(null);

const tooltipRef = ref<HTMLElement | null>(null);
const tooltipX = ref(0);
const tooltipY = ref(0);
const tooltipData = ref<BinTooltip | null>(null);

// Three.js state
let scene: THREE.Scene | undefined;
let renderer: THREE.WebGLRenderer | undefined;
let camera: THREE.PerspectiveCamera | undefined;
let lutMesh: THREE.Mesh | undefined;
let resizeObserver: ResizeObserver | undefined;
let frameId = 0;

const dataRange = computed(() => {
  if (props.dataBoundsLow === undefined || props.dataBoundsHigh === undefined) {
    return 0;
  }
  return props.dataBoundsHigh - props.dataBoundsLow;
});

const selLowFraction = computed(() => {
  if (
    dataRange.value <= 0 ||
    props.boundsLow === undefined ||
    props.dataBoundsLow === undefined
  ) {
    return 0;
  }
  return Math.max(
    0,
    Math.min(1, (props.boundsLow - props.dataBoundsLow) / dataRange.value)
  );
});

const selHighFraction = computed(() => {
  if (
    dataRange.value <= 0 ||
    props.boundsHigh === undefined ||
    props.dataBoundsLow === undefined
  ) {
    return 1;
  }
  return Math.max(
    0,
    Math.min(1, (props.boundsHigh - props.dataBoundsLow) / dataRange.value)
  );
});

const addOffset = computed(() => (props.invertColormap ? 1.0 : 0.0));
const scaleFactor = computed(() => (props.invertColormap ? -1.0 : 1.0));

// True when the user has a sub-range selection (not covering the full data extent)
const isPannable = computed(() => {
  return (
    props.boundsLow !== undefined &&
    props.boundsHigh !== undefined &&
    dataRange.value > 0 &&
    (selLowFraction.value > 0.001 || selHighFraction.value < 0.999)
  );
});

// Half-width budget for edge labels (see lowLabelStyle / midLabelsArray).
const LABEL_HALF_WIDTH_PX = 45;

// ---------------------------------------------------------------------------
// Labels
// ---------------------------------------------------------------------------

const lowLabel = computed(() =>
  props.boundsLow !== undefined ? formatValue(props.boundsLow) : ""
);

const highLabel = computed(() =>
  props.boundsHigh !== undefined ? formatValue(props.boundsHigh) : ""
);

const midLabelsArray = computed(() => {
  if (
    props.posterizeLevels < 4 ||
    props.boundsLow === undefined ||
    props.boundsHigh === undefined ||
    props.dataBoundsLow === undefined ||
    props.dataBoundsHigh === undefined
  ) {
    return [];
  }
  const low = props.boundsLow!;
  const high = props.boundsHigh!;
  const numSteps = props.posterizeLevels - 1;

  // Skip labels that would appear closer than MIN_PX_PER_LABEL pixels apart.
  // Use Math.abs for the width so an inverted range (boundsLow > boundsHigh)
  // never produces a negative selWidthPx — which would make pxPerStep negative,
  // causing Math.ceil(MIN_PX_PER_LABEL / pxPerStep) to return 0 or a negative
  // number and the for-loop below to run forever.
  const MIN_PX_PER_LABEL = 30;
  const w = widgetWidth.value;
  const selWidthPx = Math.abs(selHighFraction.value - selLowFraction.value) * w;
  const pxPerStep = selWidthPx / numSteps;
  const stride = Math.max(
    1,
    pxPerStep < MIN_PX_PER_LABEL ? Math.ceil(MIN_PX_PER_LABEL / pxPerStep) : 1
  );

  // Compute the actual pixel extents of the two edge labels so we can keep
  // mid-labels from colliding with them regardless of their anchor mode.
  const lowPx = selLowFraction.value * w;
  const highPx = selHighFraction.value * w;
  // Low label: left-anchored when near left edge (extends rightward), else centered
  const lowLabelRight =
    lowPx < LABEL_HALF_WIDTH_PX
      ? lowPx + LABEL_HALF_WIDTH_PX * 2
      : lowPx + LABEL_HALF_WIDTH_PX;
  // High label: right-anchored when near right edge (extends leftward), else centered
  const highLabelLeft =
    w - highPx < LABEL_HALF_WIDTH_PX
      ? highPx - LABEL_HALF_WIDTH_PX * 2
      : highPx - LABEL_HALF_WIDTH_PX;

  const labels: { text: string; fraction: number }[] = [];
  for (let i = stride; i < props.posterizeLevels - 1; i += stride) {
    const frac = i / numSteps;
    const value = low + frac * (high - low);
    const dataFrac = (value - props.dataBoundsLow!) / dataRange.value;
    const midPx = dataFrac * w;
    // Mid label is centered; its left/right edges are midPx ± LABEL_HALF_WIDTH_PX
    if (
      midPx - LABEL_HALF_WIDTH_PX < lowLabelRight ||
      midPx + LABEL_HALF_WIDTH_PX > highLabelLeft
    ) {
      continue;
    }
    labels.push({ text: formatValue(value), fraction: dataFrac });
  }
  return labels;
});

// ---------------------------------------------------------------------------
// Styles (positioned elements)
// ---------------------------------------------------------------------------

const lowLabelStyle = computed(() => {
  const leftPx = selLowFraction.value * widgetWidth.value;
  return {
    left: `${selLowFraction.value * 100}%`,
    transform:
      leftPx < LABEL_HALF_WIDTH_PX ? "translateX(0)" : "translateX(-50%)",
  };
});

const highLabelStyle = computed(() => {
  const rightPx = (1 - selHighFraction.value) * widgetWidth.value;
  return {
    left: `${selHighFraction.value * 100}%`,
    transform:
      rightPx < LABEL_HALF_WIDTH_PX ? "translateX(-100%)" : "translateX(-50%)",
  };
});

const tooltipStyle = computed(() => ({
  left: `${tooltipX.value}px`,
  top: `${tooltipY.value}px`,
}));

// After tooltip content changes, nudge X/Y so it stays within the viewport.
watch(tooltipData, async (newVal) => {
  if (!newVal) {
    return;
  }
  await nextTick();
  const el = tooltipRef.value;
  if (!el) {
    return;
  }
  const r = el.getBoundingClientRect();
  if (r.right > window.innerWidth - 4) {
    tooltipX.value -= r.right - (window.innerWidth - 4);
  }
  if (r.left < 4) {
    tooltipX.value += 4 - r.left;
  }
  if (r.top < 4) {
    // Flip below the target point
    tooltipY.value += r.height + 8;
  }
});

// ---------------------------------------------------------------------------
// Canvas pan delegation (pointer events forwarded to RangeSlider)
// ---------------------------------------------------------------------------

function onDistributionPanStart(event: PointerEvent, element: HTMLElement) {
  hoveredSelBin.value = null;
  tooltipData.value = null;
  sliderRef.value?.beginPan(event, element);
}

function onDistributionHandleDragStart(
  event: PointerEvent,
  element: HTMLElement,
  which: "low" | "high",
  value: number
) {
  if (which === "low") {
    emit("update:boundsLow", value);
  } else {
    emit("update:boundsHigh", value);
  }
  sliderRef.value?.beginDrag(which, event, element);
}

function onGradientPointerDown(event: PointerEvent) {
  if (
    props.dataBoundsLow === undefined ||
    props.dataBoundsHigh === undefined ||
    props.boundsLow === undefined ||
    props.boundsHigh === undefined ||
    dataRange.value <= 0
  ) {
    return;
  }

  const canvas = event.currentTarget as HTMLElement;
  const rect = canvas.getBoundingClientRect();
  const fraction = (event.clientX - rect.left) / rect.width;
  const lo = selLowFraction.value;
  const hi = selHighFraction.value;
  const value = props.dataBoundsLow + fraction * dataRange.value;

  if (fraction < lo) {
    hoveredSelBin.value = null;
    tooltipData.value = null;
    emit(
      "update:boundsLow",
      Math.max(props.dataBoundsLow, Math.min(props.boundsHigh, value))
    );
    sliderRef.value?.beginDrag("low", event, canvas);
  } else if (fraction > hi) {
    hoveredSelBin.value = null;
    tooltipData.value = null;
    emit(
      "update:boundsHigh",
      Math.min(props.dataBoundsHigh, Math.max(props.boundsLow, value))
    );
    sliderRef.value?.beginDrag("high", event, canvas);
  } else if (isPannable.value) {
    hoveredSelBin.value = null;
    tooltipData.value = null;
    sliderRef.value?.beginPan(event, canvas);
  }
}

// ---------------------------------------------------------------------------
// Canvas 2D helpers (DPI-aware)
// ---------------------------------------------------------------------------

function setupCanvas(
  canvas: HTMLCanvasElement | undefined,
  w: number,
  h: number
): CanvasRenderingContext2D | null {
  if (!canvas || w <= 0 || h <= 0) {
    return null;
  }
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(w * dpr);
  canvas.height = Math.round(h * dpr);
  const ctx = canvas.getContext("2d");
  if (ctx) {
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }
  return ctx;
}

// ---------------------------------------------------------------------------
// Draw: selection-range histogram
// ---------------------------------------------------------------------------

function drawSelectionHistogram() {
  const w = widgetWidth.value;
  if (w <= 0) {
    return;
  }
  const ctx = setupCanvas(selHistCanvasRef.value, w, GRADIENT_HEIGHT);
  if (!ctx) {
    return;
  }
  const h = GRADIENT_HEIGHT;
  ctx.clearRect(0, 0, w, h);

  const bins = props.histogram;
  if (!bins?.length) {
    return;
  }

  const maxCount = Math.max(...bins);
  if (maxCount <= 0) {
    return;
  }
  const pixelStart = selLowFraction.value * w;
  const pixelEnd = selHighFraction.value * w;
  const selWidth = pixelEnd - pixelStart;
  if (selWidth <= 0) {
    return;
  }

  const barWidth = selWidth / bins.length;
  const maxBarHeight = h * 0.88;
  const gap = Math.min(1, barWidth * 0.12);
  const drawWidth = Math.max(0.5, barWidth - gap);

  for (let i = 0; i < bins.length; i++) {
    const barHeight = (bins[i] / maxCount) * maxBarHeight;
    if (barHeight <= 0) {
      continue;
    }
    ctx.fillStyle =
      hoveredSelBin.value === i
        ? "rgba(255, 255, 255, 0.75)"
        : "rgba(255, 255, 255, 0.42)";
    ctx.fillRect(
      pixelStart + i * barWidth + gap / 2,
      h - barHeight,
      drawWidth,
      barHeight
    );
  }
}

// ---------------------------------------------------------------------------
// Three.js gradient
// ---------------------------------------------------------------------------

function initThreeJs() {
  const lutGeometry = new THREE.PlaneGeometry(2, 2);
  lutGeometry.setAttribute(
    "data_value",
    new THREE.BufferAttribute(Float32Array.from([0, 1, 0, 1]), 1)
  );
  const material = makeCompressedColormapLutMaterial(
    props.colormap,
    addOffset.value as 0 | 1,
    scaleFactor.value as 1 | -1
  );
  lutMesh = new THREE.Mesh(lutGeometry, material);

  scene = new THREE.Scene();
  renderer = new THREE.WebGLRenderer({
    canvas: gradientCanvasRef.value as HTMLCanvasElement,
  });

  scene.add(lutMesh);

  camera = new THREE.PerspectiveCamera(7.5, 1, 0.1, 1000);
  scene.add(camera);
}

function updateGradientUniforms() {
  if (!lutMesh) {
    return;
  }
  const mat = lutMesh.material as THREE.ShaderMaterial;
  mat.uniforms.colormap.value = availableColormaps[props.colormap];
  mat.uniforms.addOffset.value = addOffset.value;
  mat.uniforms.scaleFactor.value = scaleFactor.value;
  mat.uniforms.posterizeLevels.value = props.posterizeLevels;
  mat.uniforms.selLow.value = selLowFraction.value;
  mat.uniforms.selHigh.value = selHighFraction.value;
  if (renderer && scene && camera) {
    renderer.render(scene, camera);
  }
}

// ---------------------------------------------------------------------------
// Redraw everything
// ---------------------------------------------------------------------------

function scheduleRedraw() {
  cancelAnimationFrame(frameId);
  frameId = requestAnimationFrame(redrawAll);
}

function redrawAll() {
  updateGradientUniforms();
  drawSelectionHistogram();
}

// ---------------------------------------------------------------------------
// Resize handling
// ---------------------------------------------------------------------------

function onResize() {
  if (!widgetRef.value) {
    return;
  }
  const rect = widgetRef.value.getBoundingClientRect();
  const newWidth = Math.round(rect.width);
  if (newWidth <= 0 || newWidth === widgetWidth.value) {
    return;
  }
  widgetWidth.value = newWidth;

  if (renderer && camera) {
    const dpr = window.devicePixelRatio || 1;
    renderer.setSize(
      Math.round(newWidth * dpr),
      Math.round(GRADIENT_HEIGHT * dpr),
      false /* do not touch inline CSS – our stylesheet handles display size */
    );
    camera.aspect = newWidth / GRADIENT_HEIGHT;
    camera.updateProjectionMatrix();
  }

  scheduleRedraw();
}

// ---------------------------------------------------------------------------
// Tooltip logic
// ---------------------------------------------------------------------------

function onSelHistHover(event: MouseEvent) {
  if (
    !selHistCanvasRef.value ||
    !props.histogram ||
    props.histogram.length === 0 ||
    props.boundsLow === undefined ||
    props.boundsHigh === undefined
  ) {
    hoveredSelBin.value = null;
    tooltipData.value = null;
    return;
  }

  const rect = selHistCanvasRef.value.getBoundingClientRect();
  const x = event.clientX - rect.left;
  const numBins = props.histogram.length;
  const pixelStart = selLowFraction.value * rect.width;
  const pixelEnd = selHighFraction.value * rect.width;
  const selWidth = pixelEnd - pixelStart;

  if (selWidth <= 0 || x < pixelStart || x > pixelEnd) {
    hoveredSelBin.value = null;
    tooltipData.value = null;
    return;
  }

  const binIndex = Math.floor(((x - pixelStart) / selWidth) * numBins);
  if (binIndex < 0 || binIndex >= numBins) {
    hoveredSelBin.value = null;
    tooltipData.value = null;
    return;
  }

  if (hoveredSelBin.value !== binIndex) {
    hoveredSelBin.value = binIndex;
    drawSelectionHistogram();
  }

  const binCenterX =
    rect.left + pixelStart + ((binIndex + 0.5) / numBins) * selWidth;
  tooltipX.value = binCenterX;
  tooltipY.value = rect.top - 4;
  tooltipData.value = computeBinTooltip(
    binIndex,
    props.histogram,
    props.boundsLow,
    props.boundsHigh
  );
}

function onSelHistLeave() {
  if (hoveredSelBin.value !== null) {
    hoveredSelBin.value = null;
    drawSelectionHistogram();
  }
  tooltipData.value = null;
}

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

watch(
  [
    () => props.colormap,
    () => props.invertColormap,
    () => props.posterizeLevels,
  ],
  updateGradientUniforms
);

watch(
  [
    () => props.boundsLow,
    () => props.boundsHigh,
    () => props.dataBoundsLow,
    () => props.dataBoundsHigh,
  ],
  scheduleRedraw
);

watch(() => props.histogram, drawSelectionHistogram);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(() => {
  initThreeJs();
  resizeObserver = new ResizeObserver(onResize);
  if (widgetRef.value) {
    resizeObserver.observe(widgetRef.value);
  }
  onResize();
  requestAnimationFrame(redrawAll);
});

onBeforeUnmount(() => {
  cancelAnimationFrame(frameId);
  if (widgetRef.value) {
    resizeObserver?.unobserve(widgetRef.value);
  }
  resizeObserver?.disconnect();
  lutMesh?.geometry.dispose();
  (lutMesh?.material as THREE.ShaderMaterial)?.dispose();
  scene?.clear();
  camera?.clear();
  renderer?.dispose();
  scene = undefined;
  camera = undefined;
  renderer = undefined;
  lutMesh = undefined;
});
</script>

<template>
  <div ref="widgetRef" class="colorbar-widget">
    <!-- Full-range distribution plot + tick labels -->
    <DistributionPlot
      :full-histogram="props.fullHistogram"
      :data-bounds-low="props.dataBoundsLow"
      :data-bounds-high="props.dataBoundsHigh"
      :bounds-low="props.boundsLow"
      :bounds-high="props.boundsHigh"
      :is-pannable="isPannable"
      @pan-start="onDistributionPanStart"
      @handle-drag-start="onDistributionHandleDragStart"
      @pointer-move="(e) => sliderRef?.onMove(e)"
      @pointer-end="() => sliderRef?.onEnd()"
    />

    <!-- Range slider (two-handled) -->
    <RangeSlider
      ref="sliderRef"
      :low="props.boundsLow ?? props.dataBoundsLow ?? 0"
      :high="props.boundsHigh ?? props.dataBoundsHigh ?? 1"
      :min="props.dataBoundsLow ?? 0"
      :max="props.dataBoundsHigh ?? 1"
      @update:low="(v) => emit('update:boundsLow', v)"
      @update:high="(v) => emit('update:boundsHigh', v)"
    />

    <!-- Gradient + selection histogram -->
    <div class="gradient-section">
      <canvas ref="gradientCanvasRef"></canvas>
      <canvas
        ref="selHistCanvasRef"
        class="sel-hist-overlay"
        :class="{ 'is-pannable': isPannable }"
        @mousemove="onSelHistHover"
        @mouseleave="onSelHistLeave"
        @pointerdown="onGradientPointerDown"
        @pointermove="(e) => sliderRef?.onMove(e)"
        @pointerup="() => sliderRef?.onEnd()"
        @pointercancel="() => sliderRef?.onEnd()"
        @lostpointercapture="() => sliderRef?.onEnd()"
      ></canvas>
    </div>

    <!-- Value labels -->
    <div class="label-section">
      <span class="value-label" :style="lowLabelStyle">{{ lowLabel }}</span>
      <span
        v-for="(mid, idx) in midLabelsArray"
        :key="idx"
        class="value-label mid-label"
        :style="{ left: mid.fraction * 100 + '%' }"
        >{{ mid.text }}</span
      >
      <span class="value-label" :style="highLabelStyle">{{ highLabel }}</span>
    </div>

    <!-- Tooltip -->
    <div
      v-if="tooltipData"
      ref="tooltipRef"
      class="colorbar-tooltip box"
      :style="tooltipStyle"
    >
      <div class="tt-row">
        <span class="tt-label">Range</span> {{ tooltipData.range }}
      </div>
      <div class="tt-row has-text-weight-semibold">
        <span class="tt-label">Frequency</span> {{ tooltipData.frequency }}
      </div>
      <div v-if="tooltipData.beyond" class="tt-row tt-beyond mt-1 is-italic">
        ⚠ {{ tooltipData.beyond }}
      </div>
    </div>
  </div>
</template>

<style scoped>
.colorbar-widget {
  position: relative;
  width: 100%;
  user-select: none;
}

.gradient-section {
  position: relative;
  height: 44px;
  width: 100%;
  border-radius: 3px;
  overflow: hidden;
}

.gradient-section canvas {
  display: block;
  width: 100%;
  height: 100%;
}

.sel-hist-overlay {
  position: absolute;
  top: 0;
  left: 0;
  width: 100%;
  height: 100%;
  z-index: 1;
  pointer-events: auto;
  cursor: crosshair;
}

.sel-hist-overlay.is-pannable {
  cursor: grab;
}

.sel-hist-overlay.is-pannable:active {
  cursor: grabbing;
}

.label-section {
  position: relative;
  height: 17px;
  width: 100%;
  margin-top: 2px;
}

.value-label {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  font-size: 12px;
  font-weight: 600;
  white-space: nowrap;
  pointer-events: none;
  line-height: 1;
  color: var(--bulma-grey-dark);
}

.mid-label {
  font-weight: 400;
  font-size: 11px;
  color: var(--bulma-grey);
}

.colorbar-tooltip {
  position: fixed;
  pointer-events: none;
  z-index: 1000;
  /* override Bulma box's default 1.25rem padding */
  padding: 5px 10px;
  font-size: 13px;
  transform: translate(-50%, -100%);
  white-space: nowrap;
  line-height: 1.5;
}

.tt-beyond {
  font-size: 10px;
  opacity: 0.7;
}

.tt-label {
  opacity: 0.6;
  font-weight: 400;
  margin-right: 2px;
}
</style>
