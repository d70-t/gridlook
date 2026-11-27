<script lang="ts" setup>
/**
 * How to draw with the armed tool: a small sketch over the demo map (the
 * hand presses where the points go, the outline follows) and the steps in
 * words, the current one marked. Under the drawing bar; it never covers
 * the map on a phone (folded to one line there). It folds away once the
 * first point is placed (the bar's "How?" brings it back).
 */
import { computed } from "vue";

import { DEMO_EUROPE, DEMO_FRAME, DEMO_GERMANY } from "./countryDemo.ts";
import { currentStep, drawGuide, sketchPath } from "./drawGuides.ts";

import type { TAnalysisKind } from "@/lib/analysis/types.ts";
import type { TDrawMode } from "@/store/analysisStore.ts";

const props = defineProps<{
  mode: TDrawMode;
  kind?: TAnalysisKind;
  placed: number;
  /** A phone: the steps only, no sketch. */
  compact: boolean;
}>();

// The parent shows this only for a drawing tool: there is a guide.
const guide = computed(() => drawGuide(props.mode, props.kind)!);
const step = computed(() => currentStep(props.mode, props.placed));
const still =
  globalThis.matchMedia?.("(prefers-reduced-motion: reduce)").matches ?? false;

/** One loop of the sketch (s); it plays three times, then rests drawn. */
const LOOP = 6;
const REPEAT = 3;

/** When (fraction of the loop) the hand reaches each point. */
const times = computed(() => {
  const n = guide.value?.points.length ?? 1;
  return guide.value!.points.map((_, k) =>
    n === 1 ? 0.3 : 0.12 + (k * 0.6) / (n - 1)
  );
});

const sketch = computed(() => {
  const g = guide.value;
  if (!g || (g.shape !== "path" && g.shape !== "polygon")) {
    return undefined;
  }
  const closed = g.shape === "polygon";
  const { d, length } = sketchPath(g.points, closed);
  // How much of the line is drawn when the hand reaches each point.
  const ends = [...g.points, ...(closed ? [g.points[0]] : [])];
  const drawn = [0];
  for (let k = 1; k < ends.length; k++) {
    drawn.push(
      drawn[k - 1] +
        Math.hypot(ends[k].x - ends[k - 1].x, ends[k].y - ends[k - 1].y)
    );
  }
  const at = [...times.value, ...(closed ? [0.86] : [])];
  return {
    d,
    length,
    keyTimes: ["0", ...at.map(String), "1"].join(";"),
    values: [length, ...drawn.map((v) => Math.max(0, length - v)), 0].join(";"),
  };
});

/** The hand's path: in from the lower right, then point to point. */
const hand = computed(() => {
  const g = guide.value!;
  const t = times.value;
  const first = g.points[0];
  const stops = [{ x: first.x + 50, y: first.y + 38 }, ...g.points];
  return {
    values: [...stops, g.points.at(-1)!].map((p) => `${p.x} ${p.y}`).join(";"),
    keyTimes: ["0", ...t.map(String), "1"].join(";"),
  };
});

/** Opacity 0 until `at`, then 1 (a point placed, a fill shown). */
const appearAt = (at: number) => ({
  values: "0;0;1;1",
  keyTimes: `0;${Math.max(0, at - 0.01)};${at};1`,
});

const box = computed(() => {
  const g = guide.value;
  if (g?.shape !== "box") {
    return undefined;
  }
  const [a, b] = g.points;
  const [t0, t1] = times.value;
  return {
    x: a.x,
    y: a.y,
    w: b.x - a.x,
    h: b.y - a.y,
    keyTimes: `0;${t0};${t1};1`,
  };
});
</script>

<template>
  <section
    class="draw-guide analysis-panel"
    :class="{ compact }"
    aria-label="How to draw"
  >
    <svg
      v-if="!compact && guide"
      class="draw-guide-sketch"
      :viewBox="`0 0 ${DEMO_FRAME.width} ${DEMO_FRAME.height}`"
      preserveAspectRatio="xMidYMid slice"
      aria-hidden="true"
      focusable="false"
    >
      <rect class="sea" :width="DEMO_FRAME.width" :height="DEMO_FRAME.height" />
      <path class="land" :d="DEMO_EUROPE" />
      <path class="land" :d="DEMO_GERMANY" />
      <!-- The outline drawn as the hand goes. -->
      <template v-if="sketch">
        <path
          v-if="guide.shape === 'polygon'"
          class="fill"
          :d="sketch.d"
          :opacity="still ? 0.35 : 0"
        >
          <animate
            v-if="!still"
            attributeName="opacity"
            values="0;0;0.35;0.35"
            keyTimes="0;0.86;0.92;1"
            :dur="`${LOOP}s`"
            :repeatCount="REPEAT"
            fill="freeze"
          />
        </path>
        <path
          class="line"
          :d="sketch.d"
          :stroke-dasharray="sketch.length"
          :stroke-dashoffset="still ? 0 : sketch.length"
        >
          <animate
            v-if="!still"
            attributeName="stroke-dashoffset"
            :values="sketch.values"
            :keyTimes="sketch.keyTimes"
            :dur="`${LOOP}s`"
            :repeatCount="REPEAT"
            fill="freeze"
          />
        </path>
      </template>
      <rect
        v-if="box"
        class="fill line"
        :x="box.x"
        :y="box.y"
        :width="still ? box.w : 0"
        :height="still ? box.h : 0"
      >
        <template v-if="!still">
          <animate
            attributeName="width"
            :values="`0;0;${box.w};${box.w}`"
            :keyTimes="box.keyTimes"
            :dur="`${LOOP}s`"
            :repeatCount="REPEAT"
            fill="freeze"
          />
          <animate
            attributeName="height"
            :values="`0;0;${box.h};${box.h}`"
            :keyTimes="box.keyTimes"
            :dur="`${LOOP}s`"
            :repeatCount="REPEAT"
            fill="freeze"
          />
        </template>
      </rect>
      <!-- Each point as it is placed. -->
      <template v-if="guide.shape !== 'box'">
        <circle
          v-for="(p, k) in guide.points"
          :key="k"
          class="dot"
          :class="{ first: guide.shape === 'polygon' && k === 0 }"
          :cx="p.x"
          :cy="p.y"
          :r="guide.shape === 'point' ? 5 : 3.6"
          :opacity="still ? 1 : 0"
        >
          <animate
            v-if="!still"
            attributeName="opacity"
            v-bind="appearAt(times[k])"
            :dur="`${LOOP}s`"
            :repeatCount="REPEAT"
            fill="freeze"
          />
        </circle>
      </template>
      <!-- The hand, as in the country picker's sketch. -->
      <g v-if="!still" class="hand">
        <animateTransform
          attributeName="transform"
          type="translate"
          :values="hand.values"
          :keyTimes="hand.keyTimes"
          :dur="`${LOOP}s`"
          :repeatCount="REPEAT"
          fill="freeze"
        />
        <g transform="rotate(-12)">
          <path
            class="glove"
            d="M-2.2 2A2.2 2.2 0 0 1 2.2 2V8.6A1.9 1.9 0 0 1 5.8 9.2A1.9 1.9 0 0 1 9.2 10A1.8 1.8 0 0 1 12.4 11.2V15.5Q12.4 21.5 6.4 21.5H2.4Q-0.6 21.5 -2.2 19L-6.4 12.6A1.8 1.8 0 0 1 -3.4 10.6L-2.2 12.2Z"
          />
          <path class="knuckles" d="M2.2 8.6V12M5.8 9.2V12.4M9.2 10V12.8" />
        </g>
      </g>
    </svg>
    <ol v-if="guide" class="draw-guide-steps">
      <li
        v-for="(text, k) in guide.steps"
        :key="k"
        :class="{ now: k === step, done: k < step }"
        :aria-current="k === step ? 'step' : undefined"
      >
        {{ text }}
      </li>
    </ol>
  </section>
</template>

<style scoped>
.draw-guide {
  display: grid;
  grid-template-columns: 168px minmax(0, 1fr);
  grid-template-rows: auto auto;
  gap: 4px 12px;
  align-items: center;
  margin-top: 6px;
  padding: 8px 10px;
  border-radius: 10px;
  font-size: 0.78rem;
}
.draw-guide.compact {
  grid-template-columns: minmax(0, 1fr);
}
.draw-guide-sketch {
  grid-row: 1 / span 2;
  width: 168px;
  height: 105px;
  border: 1.5px dashed var(--plot-border);
  border-radius: 10px;
  pointer-events: none;
  --ink: color-mix(in srgb, var(--plot-fg) 70%, var(--plot-bg));
}
.sea {
  fill: color-mix(in srgb, var(--plot-accent) 12%, var(--plot-bg));
}
.land {
  fill: color-mix(in srgb, #f5d98b 35%, var(--plot-bg));
  stroke: var(--ink);
  stroke-width: 0.7;
  stroke-linejoin: round;
}
.line {
  fill: none;
  stroke: var(--plot-accent);
  stroke-width: 2.2;
  stroke-linejoin: round;
  stroke-linecap: round;
}
.fill {
  fill: color-mix(in srgb, var(--plot-accent) 35%, transparent);
}
rect.fill.line {
  fill: color-mix(in srgb, var(--plot-accent) 22%, transparent);
}
.dot {
  fill: var(--plot-bg);
  stroke: var(--plot-accent);
  stroke-width: 2;
}
.dot.first {
  stroke-width: 3;
}
.glove {
  fill: #ffffff;
  stroke: #1f2937;
  stroke-width: 1.1;
  stroke-linejoin: round;
}
.knuckles {
  fill: none;
  stroke: #1f2937;
  stroke-width: 1.1;
  stroke-linecap: round;
}
.draw-guide-steps {
  margin: 0;
  padding-left: 1.3em;
  color: var(--plot-muted);
  line-height: 1.45;
}
.draw-guide-steps li.now {
  color: var(--plot-fg);
  font-weight: 600;
}
.draw-guide-steps li.done {
  text-decoration: line-through;
  text-decoration-color: color-mix(in srgb, var(--plot-muted) 60%, transparent);
}
</style>
