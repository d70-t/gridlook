<script setup lang="ts">
import { ref, computed } from "vue";

const props = defineProps<{
  low: number;
  high: number;
  min: number;
  max: number;
}>();

const emit = defineEmits<{
  "update:low": [value: number];
  "update:high": [value: number];
  /** Fired when a pan gesture begins (from band or external canvas). */
  panStart: [];
}>();

const trackRef = ref<HTMLDivElement>();
type DragMode = "low" | "high" | "pan" | null;
const dragging = ref<DragMode>(null);
const panStartX = ref(0);
const panStartLow = ref(0);
const panStartHigh = ref(0);

const range = computed(() => props.max - props.min);

/** True only when the slider has a real, usable numeric range. */
function hasValidRange(): boolean {
  return range.value > 0 && isFinite(range.value);
}

const lowFraction = computed(() =>
  hasValidRange()
    ? Math.max(0, Math.min(1, (props.low - props.min) / range.value))
    : 0
);

const highFraction = computed(() =>
  hasValidRange()
    ? Math.max(0, Math.min(1, (props.high - props.min) / range.value))
    : 1
);

const isPannable = computed(
  () =>
    hasValidRange() && (lowFraction.value > 0.001 || highFraction.value < 0.999)
);

const lowHandleStyle = computed(() => ({
  left: `${lowFraction.value * 100}%`,
}));
const highHandleStyle = computed(() => ({
  left: `${highFraction.value * 100}%`,
}));
const bandStyle = computed(() => ({
  left: `${lowFraction.value * 100}%`,
  width: `${(highFraction.value - lowFraction.value) * 100}%`,
}));

function trackWidth(): number {
  return trackRef.value?.getBoundingClientRect().width ?? 1;
}

function startDrag(which: "low" | "high", event: PointerEvent) {
  if (!hasValidRange()) {
    return;
  }

  if (which === "high" && props.low >= props.high && props.high >= props.max) {
    which = "low";
  }
  dragging.value = which;
  (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
  event.preventDefault();
}

/** Initiate dragging a single handle from an external element (e.g. a canvas).
 *  The caller is responsible for having already emitted the initial value
 *  update so the handle visually jumps to the right position before the drag.
 *  @param which      — which handle to drag
 *  @param event      — the originating PointerEvent
 *  @param captureEl  — element to set pointer capture on; defaults to currentTarget
 */
function beginDrag(
  which: "low" | "high",
  event: PointerEvent,
  captureEl?: HTMLElement
): void {
  if (!hasValidRange()) {
    return;
  }
  dragging.value = which;
  (captureEl ?? (event.currentTarget as HTMLElement)).setPointerCapture(
    event.pointerId
  );
  event.preventDefault();
}

/** Initiate a pan gesture from an external element (e.g. a canvas).
 *  @param event        — the originating PointerEvent
 *  @param captureEl    — element to call setPointerCapture on; defaults to the
 *                        event's currentTarget (i.e. the selection band).
 *                        Pass the canvas element when triggering from outside.
 */
function beginPan(event: PointerEvent, captureEl?: HTMLElement) {
  if (!isPannable.value || !hasValidRange()) {
    return;
  }
  dragging.value = "pan";
  panStartX.value = event.clientX;
  panStartLow.value = props.low;
  panStartHigh.value = props.high;
  (captureEl ?? (event.currentTarget as HTMLElement)).setPointerCapture(
    event.pointerId
  );
  event.preventDefault();
  emit("panStart");
}

/** Handle a pointermove event – works both for internal and externally-captured pointers. */
function onMove(event: PointerEvent) {
  if (!dragging.value || !hasValidRange()) {
    return;
  }

  if (dragging.value === "pan") {
    const w = trackWidth();
    const dx = event.clientX - panStartX.value;
    const dValue = (dx / w) * range.value;
    const selWidth = panStartHigh.value - panStartLow.value;
    const rawLow = panStartLow.value + dValue;
    const clamped = Math.max(props.min, Math.min(props.max - selWidth, rawLow));
    emit("update:low", clamped);
    emit("update:high", clamped + selWidth);
    return;
  }

  if (!trackRef.value) {
    return;
  }
  const rect = trackRef.value.getBoundingClientRect();
  const frac = Math.max(
    0,
    Math.min(1, (event.clientX - rect.left) / rect.width)
  );
  const value = props.min + frac * range.value;

  if (dragging.value === "low") {
    const capHigh = isFinite(props.high) ? props.high : props.max;
    emit("update:low", Math.min(value, capHigh));
  } else {
    const capLow = isFinite(props.low) ? props.low : props.min;
    emit("update:high", Math.max(value, capLow));
  }
}

/** End any active drag gesture. */
function onEnd() {
  dragging.value = null;
}

/**
 * Handle a click on the bare track (outside the selection band and handles).
 * Moves the nearest handle to the clicked position and begins dragging it.
 * Uses @pointerdown.self so it only fires when the event target is the root
 * element itself — clicks on child elements (band, handles) are ignored.
 */
function onTrackPointerDown(event: PointerEvent) {
  if (!trackRef.value || !hasValidRange()) {
    return;
  }
  const rect = trackRef.value.getBoundingClientRect();
  const frac = Math.max(
    0,
    Math.min(1, (event.clientX - rect.left) / rect.width)
  );
  const value = props.min + frac * range.value;

  if (frac < lowFraction.value) {
    const capHigh = isFinite(props.high) ? props.high : props.max;
    emit("update:low", Math.min(value, capHigh));
    dragging.value = "low";
  } else if (frac > highFraction.value) {
    const capLow = isFinite(props.low) ? props.low : props.min;
    emit("update:high", Math.max(value, capLow));
    dragging.value = "high";
  } else {
    // Inside the selection — move the closest handle to the clicked position.
    const distToLow = Math.abs(frac - lowFraction.value);
    const distToHigh = Math.abs(frac - highFraction.value);
    if (distToLow <= distToHigh) {
      const capHigh = isFinite(props.high) ? props.high : props.max;
      emit("update:low", Math.min(value, capHigh));
      dragging.value = "low";
    } else {
      const capLow = isFinite(props.low) ? props.low : props.min;
      emit("update:high", Math.max(value, capLow));
      dragging.value = "high";
    }
  }

  trackRef.value.setPointerCapture(event.pointerId);
  event.preventDefault();
}

defineExpose({
  lowFraction,
  highFraction,
  isPannable,
  beginDrag,
  beginPan,
  onMove,
  onEnd,
});
</script>

<template>
  <div
    ref="trackRef"
    class="range-slider"
    @pointerdown.self="onTrackPointerDown"
    @pointermove="onMove"
    @pointerup="onEnd"
    @pointercancel="onEnd"
    @lostpointercapture="onEnd"
  >
    <!-- Highlighted band between the two handles -->
    <div
      class="selection-band"
      :style="bandStyle"
      @pointerdown="onTrackPointerDown"
      @pointermove="onMove"
      @pointerup="onEnd"
      @pointercancel="onEnd"
      @lostpointercapture="onEnd"
    ></div>

    <!-- Low handle -->
    <div
      class="handle"
      :class="{ active: dragging === 'low' }"
      :style="lowHandleStyle"
      @pointerdown="(e) => startDrag('low', e)"
      @pointermove="onMove"
      @pointerup="onEnd"
      @pointercancel="onEnd"
      @lostpointercapture="onEnd"
    >
      <div class="handle-caret"></div>
    </div>

    <!-- High handle -->
    <div
      class="handle"
      :class="{ active: dragging === 'high' }"
      :style="highHandleStyle"
      @pointerdown="(e) => startDrag('high', e)"
      @pointermove="onMove"
      @pointerup="onEnd"
      @pointercancel="onEnd"
      @lostpointercapture="onEnd"
    >
      <div class="handle-caret"></div>
    </div>
  </div>
</template>

<style scoped>
.range-slider {
  position: relative;
  height: 20px;
  width: 100%;
  touch-action: none;
  overflow: visible;
  cursor: pointer;
}

/* Full-width inactive track */
.range-slider::before {
  content: "";
  position: absolute;
  top: 8px;
  left: 0;
  right: 0;
  height: 4px;
  background: var(--bulma-border);
  border-radius: var(--bulma-radius);
  pointer-events: none;
}

.selection-band {
  position: absolute;
  top: 0;
  height: 100%;
  background: transparent;
  pointer-events: auto;
  cursor: pointer;
}

/* Visual 4 px color strip — same position as the track ::before */
.selection-band::before {
  content: "";
  position: absolute;
  top: 8px;
  left: 0;
  right: 0;
  height: 4px;
  background: var(--bulma-link);
  border-radius: var(--bulma-radius);
  pointer-events: none;
}

.handle {
  position: absolute;
  top: 0;
  width: 26px;
  height: 20px;
  transform: translateX(-13px);
  cursor: grab;
  z-index: 2;
  touch-action: none;
}

.handle:active,
.handle.active {
  cursor: grabbing;
}

/* Circle thumb – matches the global range thumb style */
.handle-caret {
  position: absolute;
  top: 3px;
  left: 50%;
  width: 14px;
  height: 14px;
  background: var(--bulma-link);
  border: 2px solid var(--bulma-scheme-main);
  border-radius: 50%;
  transform: translateX(-50%);
  box-shadow: 0 1px 3px rgba(0, 0, 0, 0.2);
  transition: filter 0.15s ease;
}

.handle:hover .handle-caret {
  filter: brightness(0.82);
}

.handle.active .handle-caret {
  filter: brightness(0.72);
}
</style>
