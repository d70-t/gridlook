<script setup lang="ts">
import {
  Chart,
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  Filler,
} from "chart.js";
import Annotation from "chartjs-plugin-annotation";
import {
  ref,
  computed,
  watch,
  onMounted,
  onBeforeUnmount,
  nextTick,
} from "vue";

import { computeBinTooltip, type BinTooltip } from "./colorbarUtils";

// ---------------------------------------------------------------------------
// Props & emits
// ---------------------------------------------------------------------------

const props = defineProps<{
  fullHistogram?: number[];
  dataBoundsLow?: number;
  dataBoundsHigh?: number;
  boundsLow?: number;
  boundsHigh?: number;
  isPannable?: boolean;
}>();

const emit = defineEmits<{
  /** User pressed down on the selected range — caller should begin a pan. */
  panStart: [event: PointerEvent, element: HTMLElement];
  /** User clicked outside the selection — caller should jump a handle here and begin dragging. */
  handleDragStart: [
    event: PointerEvent,
    element: HTMLElement,
    which: "low" | "high",
    value: number,
  ];
  /** Forwarded pointermove while a pan capture is active. */
  pointerMove: [event: PointerEvent];
  /** Forwarded pointerup / cancel / lostpointercapture. */
  pointerEnd: [];
}>();

Chart.register(
  LineController,
  LineElement,
  PointElement,
  LinearScale,
  Filler,
  Annotation
);

// ---------------------------------------------------------------------------
// DOM refs & hover state
// ---------------------------------------------------------------------------

const canvasRef = ref<HTMLCanvasElement>();
const tooltipRef = ref<HTMLElement | null>(null);
const hoveredBin = ref<number | null>(null);
const tooltipX = ref(0);
const tooltipY = ref(0);
const tooltipData = ref<BinTooltip | null>(null);

let chart: Chart | undefined;

const dataRange = computed(() =>
  props.dataBoundsLow !== undefined && props.dataBoundsHigh !== undefined
    ? props.dataBoundsHigh - props.dataBoundsLow
    : 0
);

/** Whether a data-space x value falls inside the current selection. */
function inSelection(x: number): boolean {
  return (
    props.boundsLow !== undefined &&
    props.boundsHigh !== undefined &&
    x >= props.boundsLow &&
    x <= props.boundsHigh
  );
}

/** Clear hover highlight and tooltip (called before pointer-capture events). */
function clearHover() {
  hoveredBin.value = null;
  tooltipData.value = null;
}

// ---------------------------------------------------------------------------
// Tick helpers
// ---------------------------------------------------------------------------

function niceTickStep(lo: number, hi: number, maxCount: number): number {
  const roughStep = (hi - lo) / maxCount;
  const mag = Math.pow(10, Math.floor(Math.log10(roughStep)));
  const residual = roughStep / mag;
  if (residual <= 1.5) {
    return mag;
  }
  if (residual <= 3) {
    return 2 * mag;
  }
  if (residual <= 7) {
    return 5 * mag;
  }
  return 10 * mag;
}

function computeNiceTicks(lo: number, hi: number, maxCount = 5): number[] {
  if (!isFinite(lo) || !isFinite(hi) || hi <= lo) {
    return [];
  }
  const step = niceTickStep(lo, hi, maxCount);
  const ticks: number[] = [];
  const start = Math.ceil(lo / step) * step;
  for (let v = start; v <= hi + step * 1e-9; v += step) {
    if (v >= lo && v <= hi) {
      ticks.push(parseFloat(v.toPrecision(10)));
    }
  }
  return ticks;
}

const niceTicks = computed(() =>
  props.dataBoundsLow !== undefined && props.dataBoundsHigh !== undefined
    ? computeNiceTicks(props.dataBoundsLow, props.dataBoundsHigh, 5)
    : []
);

function tickFraction(tick: number): number {
  if (dataRange.value <= 0 || props.dataBoundsLow === undefined) {
    return 0;
  }
  return (tick - props.dataBoundsLow) / dataRange.value;
}

function formatTick(value: number): string {
  if (value === 0) {
    return "0";
  }
  const abs = Math.abs(value);
  if (abs >= 1e5 || abs < 1e-2) {
    return value.toExponential(1);
  }
  return String(parseFloat(value.toPrecision(3)));
}

// ---------------------------------------------------------------------------
// Chart.js annotations
// ---------------------------------------------------------------------------

function setChartAnnotations() {
  if (!chart) {
    return;
  }
  (
    chart.options.plugins as unknown as {
      annotation: { annotations: Record<string, object> };
    }
  ).annotation.annotations = buildAnnotations();
}

// eslint-disable-next-line max-lines-per-function
function buildAnnotations(): Record<string, object> {
  const annotations: Record<string, object> = {};

  for (const [i, tick] of niceTicks.value.entries()) {
    annotations[`grid${i}`] = {
      type: "line",
      xMin: tick,
      xMax: tick,
      borderColor: "rgba(160, 160, 160, 0.25)",
      borderWidth: 1,
    };
  }

  if (
    props.boundsLow !== undefined &&
    props.boundsHigh !== undefined &&
    dataRange.value > 0
  ) {
    annotations.selBox = {
      type: "box",
      xMin: props.boundsLow,
      xMax: props.boundsHigh,
      backgroundColor: "rgba(74, 144, 217, 0.06)",
      borderWidth: 0,
    };
    annotations.caretLow = {
      type: "line",
      xMin: props.boundsLow,
      xMax: props.boundsLow,
      borderColor: "rgba(74, 144, 217, 0.45)",
      borderWidth: 1,
    };
    annotations.caretHigh = {
      type: "line",
      xMin: props.boundsHigh,
      xMax: props.boundsHigh,
      borderColor: "rgba(74, 144, 217, 0.45)",
      borderWidth: 1,
    };
  }

  if (
    hoveredBin.value !== null &&
    props.fullHistogram?.length &&
    dataRange.value > 0
  ) {
    const numBins = props.fullHistogram.length;
    const binSize = dataRange.value / numBins;
    annotations.hoverBox = {
      type: "box",
      xMin: props.dataBoundsLow! + hoveredBin.value * binSize,
      xMax: props.dataBoundsLow! + (hoveredBin.value + 1) * binSize,
      backgroundColor: "rgba(255, 255, 255, 0.30)",
      borderWidth: 0,
    };
  }

  return annotations;
}

// ---------------------------------------------------------------------------
// Chart.js data & lifecycle
// ---------------------------------------------------------------------------

function buildChartData(): { x: number; y: number }[] {
  if (
    !props.fullHistogram?.length ||
    props.dataBoundsLow === undefined ||
    props.dataBoundsHigh === undefined ||
    dataRange.value <= 0
  ) {
    return [];
  }
  const bins = props.fullHistogram;
  const numBins = bins.length;
  const binSize = dataRange.value / numBins;
  const maxCount = Math.max(...bins, 1);
  return bins.map((v, i) => ({
    x: props.dataBoundsLow! + (i + 0.5) * binSize,
    y: v / maxCount,
  }));
}

const noDataPlugin = {
  id: "noData",
  afterDraw(c: Chart) {
    if (c.data.datasets[0]?.data.every((item) => item === 0)) {
      const { ctx, width, height } = c;
      c.clear();
      ctx.save();
      ctx.textAlign = "center";
      ctx.textBaseline = "middle";
      ctx.fillStyle = "var(--bulma-grey)";
      ctx.fillText("No data to display", width / 2, height / 2);
      ctx.restore();
    }
  },
};

function createChart() {
  if (!canvasRef.value) {
    return;
  }

  chart = new Chart<"line", { x: number; y: number }[]>(canvasRef.value, {
    type: "line",
    plugins: [noDataPlugin],
    data: {
      datasets: [
        {
          data: buildChartData(),
          fill: "origin",
          borderWidth: 1.2,
          pointRadius: 0,
          segment: {
            backgroundColor: (ctx) => {
              const mid = ((ctx.p0.parsed.x ?? 0) + (ctx.p1.parsed.x ?? 0)) / 2;
              return inSelection(mid)
                ? "rgba(74, 144, 217, 0.28)"
                : "rgba(148, 163, 178, 0.18)";
            },
            borderColor: (ctx) => {
              const mid = ((ctx.p0.parsed.x ?? 0) + (ctx.p1.parsed.x ?? 0)) / 2;
              return inSelection(mid)
                ? "rgba(74, 144, 217, 0.6)"
                : "rgba(148, 163, 178, 0.40)";
            },
          },
        },
      ],
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: {
          type: "linear",
          display: false,
          min: props.dataBoundsLow ?? 0,
          max: props.dataBoundsHigh ?? 1,
        },
        y: { display: false },
      },
    },
  });
  setChartAnnotations();
  chart.update("none");
}

function updateChart() {
  if (!chart) {
    return;
  }
  chart.data.datasets[0].data = buildChartData();
  (chart.options.scales!.x as { min: number; max: number }).min =
    props.dataBoundsLow ?? 0;
  (chart.options.scales!.x as { min: number; max: number }).max =
    props.dataBoundsHigh ?? 1;
  setChartAnnotations();
  chart.update("none");
}

// ---------------------------------------------------------------------------
// Hover, tooltip & pointer handlers
// ---------------------------------------------------------------------------

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
    tooltipY.value += r.height + 8;
  }
});

function onHover(event: MouseEvent) {
  if (
    !canvasRef.value ||
    !props.fullHistogram?.length ||
    props.dataBoundsLow === undefined ||
    props.dataBoundsHigh === undefined
  ) {
    hoveredBin.value = null;
    tooltipData.value = null;
    return;
  }
  const rect = canvasRef.value.getBoundingClientRect();
  const numBins = props.fullHistogram.length;
  const binIndex = Math.floor(
    ((event.clientX - rect.left) / rect.width) * numBins
  );
  if (binIndex < 0 || binIndex >= numBins) {
    tooltipData.value = null;
    return;
  }
  if (hoveredBin.value !== binIndex) {
    hoveredBin.value = binIndex;
    setChartAnnotations();
    chart?.update("none");
  }
  tooltipX.value = rect.left + ((binIndex + 0.5) / numBins) * rect.width;
  tooltipY.value = rect.top - 4;
  tooltipData.value = computeBinTooltip(
    binIndex,
    props.fullHistogram,
    props.dataBoundsLow,
    props.dataBoundsHigh
  );
}

function onLeave() {
  if (hoveredBin.value !== null) {
    hoveredBin.value = null;
    setChartAnnotations();
    chart?.update("none");
  }
  tooltipData.value = null;
}

function onPointerDown(event: PointerEvent) {
  if (
    !canvasRef.value ||
    props.boundsLow === undefined ||
    props.boundsHigh === undefined ||
    props.dataBoundsLow === undefined ||
    props.dataBoundsHigh === undefined
  ) {
    return;
  }

  const rect = canvasRef.value.getBoundingClientRect();
  const fraction = (event.clientX - rect.left) / rect.width;
  const dr = props.dataBoundsHigh - props.dataBoundsLow;
  if (dr <= 0) {
    return;
  }

  const lo = (props.boundsLow - props.dataBoundsLow) / dr;
  const hi = (props.boundsHigh - props.dataBoundsLow) / dr;
  const value = props.dataBoundsLow + fraction * dr;
  const el = event.currentTarget as HTMLElement;

  clearHover();
  setChartAnnotations();
  chart?.update("none");
  if (fraction < lo) {
    emit(
      "handleDragStart",
      event,
      el,
      "low",
      Math.max(props.dataBoundsLow, Math.min(props.boundsHigh, value))
    );
  } else if (fraction > hi) {
    emit(
      "handleDragStart",
      event,
      el,
      "high",
      Math.min(props.dataBoundsHigh, Math.max(props.boundsLow, value))
    );
  } else if (props.isPannable) {
    emit("panStart", event, el);
  }
}

// ---------------------------------------------------------------------------
// Watchers
// ---------------------------------------------------------------------------

watch(
  [
    () => props.boundsLow,
    () => props.boundsHigh,
    () => props.dataBoundsLow,
    () => props.dataBoundsHigh,
    () => props.fullHistogram,
  ],
  updateChart
);

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

onMounted(createChart);
onBeforeUnmount(() => {
  chart?.destroy();
  chart = undefined;
});
</script>

<template>
  <div class="distribution-plot">
    <!-- Histogram chart -->
    <div class="hist-section">
      <canvas
        ref="canvasRef"
        @mousemove="onHover"
        @mouseleave="onLeave"
        @pointerdown="onPointerDown"
        @pointermove="(e) => emit('pointerMove', e)"
        @pointerup="() => emit('pointerEnd')"
        @pointercancel="() => emit('pointerEnd')"
        @lostpointercapture="() => emit('pointerEnd')"
      ></canvas>
    </div>

    <!-- Tick labels -->
    <div class="tick-section">
      <span
        v-for="(tick, i) in niceTicks"
        :key="i"
        class="tick-label"
        :style="{ left: tickFraction(tick) * 100 + '%' }"
        >{{ formatTick(tick) }}</span
      >
    </div>

    <!-- Tooltip -->
    <div
      v-if="tooltipData"
      ref="tooltipRef"
      class="plot-tooltip box"
      :style="{ left: tooltipX + 'px', top: tooltipY + 'px' }"
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
.distribution-plot {
  position: relative;
  width: 100%;
}

.hist-section {
  position: relative;
  height: 70px;
  width: 100%;
  background: var(--bulma-scheme-main-bis);
  border: 1px solid var(--bulma-border-weak);
  border-radius: 3px;
}

.hist-section canvas {
  display: block;
  width: 100%;
  height: 100%;
  cursor: crosshair;
}

.tick-section {
  position: relative;
  height: 16px;
  width: 100%;
  margin-top: 1px;
}

.tick-label {
  position: absolute;
  top: 0;
  transform: translateX(-50%);
  font-size: 11px;
  color: var(--bulma-grey);
  white-space: nowrap;
  pointer-events: none;
  line-height: 1;
}

.plot-tooltip {
  position: fixed;
  pointer-events: none;
  z-index: 1000;
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
