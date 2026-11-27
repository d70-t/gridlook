<script lang="ts" setup>
/**
 * A figure drawn by a function on a canvas (wind rose, hodograph): sized
 * to its box, redrawn when it or the drawing changes, and exported like
 * the charts (PNG, or a PDF page's recording canvas).
 */
import { useResizeObserver } from "@vueuse/core";
import { nextTick, onMounted, ref, watch } from "vue";

import type { TProbe } from "./windFigures.ts";

const props = defineProps<{
  draw: (
    context: CanvasRenderingContext2D,
    width: number,
    height: number
  ) => void;
  label: string;
  /** What is under the pointer (25 Nov: the figures read out on hover). */
  probe?: (
    x: number,
    y: number,
    width: number,
    height: number
  ) => TProbe | undefined;
  /** A click on the figure (a legend entry toggles). */
  press?: (x: number, y: number, width: number, height: number) => void;
}>();

const probed = ref<TProbe>();
function where(event: PointerEvent | MouseEvent) {
  const rect = box.value!.getBoundingClientRect();
  return [
    event.clientX - rect.left,
    event.clientY - rect.top,
    rect.width,
    rect.height,
  ] as const;
}
function onMove(event: PointerEvent) {
  probed.value = props.probe?.(...where(event));
}
async function onClick(event: MouseEvent) {
  const at = where(event);
  props.press?.(...at);
  // Said again once the figure has taken the click (a hidden class).
  await nextTick();
  probed.value = props.probe?.(...at);
}

const box = ref<HTMLDivElement>();
const canvas = ref<HTMLCanvasElement>();

function paint(
  element: HTMLCanvasElement,
  width: number,
  height: number,
  ratio: number
) {
  element.width = Math.max(1, Math.round(width * ratio));
  element.height = Math.max(1, Math.round(height * ratio));
  const context = element.getContext("2d")!;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  props.draw(context, width, height);
}

function redraw() {
  if (canvas.value && box.value) {
    paint(
      canvas.value,
      box.value.clientWidth,
      box.value.clientHeight,
      window.devicePixelRatio || 1
    );
  }
}

onMounted(redraw);
watch(() => props.draw, redraw);
useResizeObserver(box, redraw);

async function renderExport(
  width: number,
  height: number,
  target?: HTMLCanvasElement,
  /** Image pixels per layout pixel (2 for the standard PNG). */
  ratio = 2
) {
  const element = target ?? document.createElement("canvas");
  paint(element, width, height, ratio);
  return element;
}

defineExpose({ canvas: () => canvas.value, renderExport });
</script>

<template>
  <div
    ref="box"
    class="analysis-canvas-figure"
    :class="{ 'is-toggle': probed?.toggles }"
    @pointermove="onMove"
    @pointerleave="probed = undefined"
    @click="onClick"
  >
    <canvas ref="canvas" role="img" :aria-label="label"></canvas>
    <span
      v-if="probed && !probed.toggles"
      class="figure-mark"
      :style="{ left: `${probed.x}px`, top: `${probed.y}px` }"
    ></span>
    <div
      v-if="probed"
      class="figure-readout"
      role="status"
      :class="{
        'is-left': box && probed.x > box.clientWidth * 0.55,
      }"
      :style="{ left: `${probed.x}px`, top: `${probed.y}px` }"
    >
      <strong v-if="probed.title">{{ probed.title }}</strong>
      <span
        v-for="line in probed.lines"
        :key="line.text"
        :class="{ 'is-strong': line.strong }"
      >
        <span
          v-if="line.colour"
          class="figure-swatch"
          :style="{ background: line.colour }"
        ></span
        >{{ line.text }}
      </span>
    </div>
  </div>
</template>

<style scoped>
.analysis-canvas-figure {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 160px;
}
.analysis-canvas-figure canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.analysis-canvas-figure.is-toggle {
  cursor: pointer;
}
.figure-mark {
  position: absolute;
  width: 10px;
  height: 10px;
  margin: -5px 0 0 -5px;
  border: 2px solid var(--plot-fg);
  border-radius: 50%;
  pointer-events: none;
}
.figure-readout {
  position: absolute;
  z-index: 2;
  display: grid;
  gap: 1px;
  transform: translate(12px, -50%);
  padding: 6px 8px;
  background: var(--plot-bg);
  color: var(--plot-fg);
  border: 1px solid var(--plot-border);
  border-radius: 6px;
  box-shadow: 0 6px 16px rgba(15, 23, 42, 0.18);
  font-size: 0.78rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}
.figure-readout.is-left {
  transform: translate(calc(-100% - 12px), -50%);
}
.figure-readout .is-strong {
  font-weight: 700;
}
.figure-swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 2px;
}
</style>
