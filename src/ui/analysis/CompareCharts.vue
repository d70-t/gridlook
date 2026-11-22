<script lang="ts" setup>
/**
 * More views of the compared plots against the reference, one SVG each:
 * the bias over time (each plot minus the reference at their common
 * dates), a scatter of plot against reference values with the 1:1 line,
 * a Q–Q plot of their percentiles, and parallel coordinates of the scores.
 */
import { computed, ref } from "vue";

import { budgetedScatter, dotsPath, extent, thinLine } from "./chartBudget.ts";
import {
  biasSeries,
  keyDays,
  parallelScores,
  quantilePairs,
  type TPair,
  type taylorStats,
} from "./compare.ts";
import { niceTicks } from "./heatmapRaster.ts";

import { formatValue } from "@/utils/formatValue.ts";

export type TCompareView = "bias" | "scatter" | "qq" | "parallel";

const props = defineProps<{
  view: TCompareView;
  rows: {
    label: string;
    colour: string;
    pair: TPair;
    stats: NonNullable<ReturnType<typeof taylorStats>>;
  }[];
  referenceLabel: string;
  units?: string;
}>();

const W = 640;
const H = 320;
// Room for the labels at their size (13 px ticks, 14 px titles).
const M = { left: 66, right: 16, top: 14, bottom: 46 };
const plotW = W - M.left - M.right;
const plotH = H - M.top - M.bottom;

/** About five round ticks: a bounded count, whatever the span. */
const ticks = (low: number, high: number) => niceTicks(low, high, 5);

const u = computed(() => (props.units ? ` (${props.units})` : ""));

/** A date's position in days, in the compared calendar. */
const days = (key: string) => keyDays(key, props.rows[0]?.pair.calendar);

/** Bias over time: each plot minus the reference, on one date axis. */
function biasView() {
  // Every plot's common dates on one axis of elapsed time (days), in
  // the reference's calendar.
  const keys = [...new Set(props.rows.flatMap((row) => row.pair.keys))].sort(
    (a, b) => days(a) - days(b)
  );
  // Stamps as short as the whole axis allows (an hour kept where hours vary).
  const stamps = new Map(
    shortStamps(keys).map((label, at) => [keys[at], label])
  );
  return {
    xTitle: "Date",
    yTitle: `Plot − ${props.referenceLabel}${u.value}`,
    keys,
    lines: true,
    series: props.rows.map((row) => {
      const bias = biasSeries(row.pair);
      return bias.keys.map((key, at) => ({
        x: days(key),
        y: bias.values[at],
        tag: stamps.get(key) ?? key,
      }));
    }),
    zero: true,
    oneToOne: false,
  };
}

/** Points per plot in data units, and the axis titles, for this view. */
const data = computed(() => {
  if (props.view === "bias") {
    return biasView();
  }
  if (props.view === "scatter" || props.view === "qq") {
    const qq = props.view === "qq";
    return {
      xTitle: `${props.referenceLabel}${qq ? " percentiles" : ""}${u.value}`,
      yTitle: `Plot${qq ? " percentiles" : ""}${u.value}`,
      keys: [] as string[],
      lines: qq,
      series: props.rows.map((row) => {
        const stamps = qq ? [] : shortStamps(row.pair.keys);
        return qq
          ? quantilePairs(row.pair).map((q) => ({
              x: q.reference,
              y: q.other,
              tag: `${Math.round(q.p * 100)}th percentile`,
            }))
          : row.pair.reference.map((x, at) => ({
              x,
              y: row.pair.other[at],
              tag: stamps[at],
            }));
      }),
      zero: false,
      oneToOne: true,
    };
  }
  return undefined;
});

const bounds = computed(() => {
  const d = data.value;
  if (!d) {
    return undefined;
  }
  const ex = extent(...d.series.map((points) => points.map((p) => p.x)));
  const ey = extent(
    ...d.series.map((points) => points.map((p) => p.y)),
    d.zero ? [0] : []
  );
  if (!ex || !ey) {
    return undefined;
  }
  let [x0, x1, y0, y1] = [ex.low, ex.high, ey.low, ey.high];
  if (d.oneToOne) {
    // Square: the 1:1 line at 45°.
    x0 = y0 = Math.min(x0, y0);
    x1 = y1 = Math.max(x1, y1);
  }
  const pad = (a: number, b: number) =>
    b > a ? (b - a) * 0.04 : Math.max(1, Math.abs(a) * 1e-6);
  return {
    x0: x0 - pad(x0, x1),
    x1: x1 + pad(x0, x1),
    y0: y0 - pad(y0, y1),
    y1: y1 + pad(y0, y1),
  };
});
const sx = (x: number) =>
  M.left +
  ((x - bounds.value!.x0) / (bounds.value!.x1 - bounds.value!.x0)) * plotW;
const sy = (y: number) =>
  M.top +
  plotH -
  ((y - bounds.value!.y0) / (bounds.value!.y1 - bounds.value!.y0)) * plotH;

const xTicks = computed(() => {
  const d = data.value!;
  if (d.keys.length) {
    // Dates: the first, last and the common dates nearest those between,
    // each at its own time; as many as their labels leave room for, the
    // time of day left out where it is always the same (24 Nov: five full
    // stamps ran into each other).
    const positions = d.keys.map(days);
    const [first, last] = [positions[0], positions[positions.length - 1]];
    const labels = shortStamps(d.keys);
    const longest = Math.max(...labels.map((label) => label.length));
    const count = Math.max(
      2,
      Math.min(5, Math.floor(plotW / (longest * 8 + 16)))
    );
    const picked = new Set(
      Array.from({ length: count }, (_, k) => k / (count - 1)).map((f) => {
        const target = first + f * (last - first);
        let best = 0;
        positions.forEach((day, at) => {
          best =
            Math.abs(day - target) < Math.abs(positions[best] - target)
              ? at
              : best;
        });
        return best;
      })
    );
    // The first label starts at the axis, the last ends there.
    const shown = [...picked];
    return shown.map((at, k) => ({
      x: positions[at],
      label: labels[at],
      anchor:
        k === 0 && shown.length > 1
          ? "start"
          : k === shown.length - 1 && shown.length > 1
            ? "end"
            : "middle",
    }));
  }
  return ticks(bounds.value!.x0, bounds.value!.x1).map((x) => ({
    x,
    label: formatValue(x),
    anchor: "middle",
  }));
});
/** Date stamps without a time of day (or seconds) that never varies. */
function shortStamps(keys: string[]) {
  // The day ends at the space, whatever its year's length.
  const day = (key: string) =>
    key.includes(" ") ? key.indexOf(" ") : key.length;
  const time = (key: string) => key.slice(day(key) + 1);
  if (keys.every((key) => /^(00:00(:00(\.0+)?)?)?$/.test(time(key)))) {
    return keys.map((key) => key.slice(0, day(key)));
  }
  if (keys.every((key) => /^\d\d:\d\d(:00(\.0+)?)?$/.test(time(key)))) {
    return keys.map((key) => key.slice(0, day(key) + 6));
  }
  return keys;
}
const yTicks = computed(() =>
  ticks(bounds.value!.y0, bounds.value!.y1).map((y) => ({
    y,
    label: formatValue(y),
  }))
);
/**
 * Lines and marks as drawn: thinned to the chart's pixels, the marks of
 * every plot in one budget per panel, each plot's dots as one path.
 */
const drawn = computed(() => {
  const series = data.value!.series;
  const lines = data.value!.lines;
  const scattered = lines
    ? undefined
    : budgetedScatter(
        series.map((points) => ({
          xs: points.map((p) => p.x),
          ys: points.map((p) => p.y),
        })),
        sx,
        sy
      ).kept;
  return series.map((points, at) => {
    const line = lines ? thinLine(points, sx) : [];
    const marks = lines
      ? points.length <= 60
        ? points
        : []
      : scattered![at].map((k) => points[k]);
    return {
      path: line
        .map(
          (p, k) =>
            `${k ? "L" : "M"}${sx(p.x).toFixed(1)},${sy(p.y).toFixed(1)}`
        )
        .join(""),
      dots: dotsPath(
        marks.map((p) => ({ x: sx(p.x), y: sy(p.y) })),
        lines ? 2 : 2.5
      ),
    };
  });
});

// ----- hover (25 Nov): over time, one label with every plot's value at
// the nearest date, as the plot charts read out; a scatter or Q–Q, whose
// plots share no x, the nearest mark's values.
const figure = ref<HTMLElement>();
const hover = ref<{
  /** The marks read out: [series, point] pairs. */
  marks: [number, number][];
  /** Where the label points (drawn units), and on screen in the figure. */
  cx: number;
  cy: number;
  left: number;
  top: number;
}>();
/** Within this many drawn units of the pointer, a mark is read out. */
const REACH = 28;
/** Each plot's point index by its x, for the date under the pointer. */
const byX = computed(() =>
  data.value?.series.map(
    (points) => new Map(points.map((p, k) => [p.x, k] as const))
  )
);
function nearestDate(px: number) {
  let best: { x: number; gap: number } | undefined;
  for (const key of data.value!.keys) {
    const x = days(key);
    const gap = Math.abs(sx(x) - px);
    if (!best || gap < best.gap) {
      best = { x, gap };
    }
  }
  return best && best.gap < REACH ? best.x : undefined;
}
/** The plots' marks at a date, where they have one. */
function marksAt(x: number | undefined): [number, number][] {
  const d = data.value!;
  if (x === undefined) {
    return [];
  }
  return byX.value!.flatMap((index, at) => {
    const k = index.get(x);
    return k !== undefined && Number.isFinite(d.series[at][k].y)
      ? [[at, k] as [number, number]]
      : [];
  });
}
function nearestMark(pt: { x: number; y: number }) {
  let best: { at: number; k: number; d2: number } | undefined;
  data.value!.series.forEach((points, at) =>
    points.forEach((p, k) => {
      if (!Number.isFinite(p.x) || !Number.isFinite(p.y)) {
        return;
      }
      const d2 = (sx(p.x) - pt.x) ** 2 + (sy(p.y) - pt.y) ** 2;
      if (d2 < REACH ** 2 && (!best || d2 < best.d2)) {
        best = { at, k, d2 };
      }
    })
  );
  return best;
}
function onMove(event: PointerEvent) {
  const svg = event.currentTarget as SVGSVGElement;
  const ctm = svg.getScreenCTM();
  const d = data.value;
  if (!ctm || !d || !bounds.value) {
    return;
  }
  const pt = new DOMPoint(event.clientX, event.clientY).matrixTransform(
    ctm.inverse()
  );
  let marks: [number, number][] = [];
  let [cx, cy] = [pt.x, pt.y];
  if (d.keys.length) {
    const x = nearestDate(pt.x);
    marks = marksAt(x);
    cx = x === undefined ? cx : sx(x);
  } else {
    const best = nearestMark(pt);
    if (best) {
      marks = [[best.at, best.k]];
      const p = d.series[best.at][best.k];
      [cx, cy] = [sx(p.x), sy(p.y)];
    }
  }
  if (!marks.length) {
    hover.value = undefined;
    return;
  }
  const screen = new DOMPoint(cx, cy).matrixTransform(ctm);
  const box = figure.value!.getBoundingClientRect();
  hover.value = {
    marks,
    cx,
    cy,
    left: screen.x - box.left + figure.value!.scrollLeft,
    top: screen.y - box.top,
  };
}
const readout = computed(() => {
  const h = hover.value;
  const d = data.value;
  if (!h || !d) {
    return undefined;
  }
  const unit = props.units ? ` ${props.units}` : "";
  const value = (v: number) => `${formatValue(v)}${unit}`;
  const [first, k0] = h.marks[0];
  const point = d.series[first][k0];
  if (props.view === "bias") {
    return {
      title: point.tag,
      // Highest first, as the lines lie on the chart.
      lines: h.marks
        .map(([at, k]) => ({ at, y: d.series[at][k].y }))
        .sort((a, b) => b.y - a.y)
        .map(({ at, y }) => ({
          colour: props.rows[at].colour,
          text: `${props.rows[at].label} − ${props.referenceLabel}: ${y > 0 ? "+" : ""}${value(y)}`,
        })),
    };
  }
  const label = props.rows[first].label;
  return {
    title: point.tag,
    lines: [
      { colour: undefined, text: `${props.referenceLabel}: ${value(point.x)}` },
      { colour: props.rows[first].colour, text: `${label}: ${value(point.y)}` },
    ],
  };
});

// ----- parallel coordinates
const parallel = computed(() =>
  props.view === "parallel"
    ? parallelScores(props.rows.map((row) => row.stats))
    : undefined
);
const axisX = (k: number) => M.left + (k / 3) * plotW;
const axisY = (t: number) => M.top + (1 - t) * plotH;
/** An undefined score (e.g. no spread in the reference) breaks the line. */
const polyline = (placed: number[]) =>
  placed
    .map((t, k) =>
      Number.isFinite(t)
        ? `${k && Number.isFinite(placed[k - 1]) ? "L" : "M"}${axisX(k)},${axisY(t)}`
        : ""
    )
    .join("");
</script>

<template>
  <figure ref="figure" class="compare-chart">
    <svg
      v-if="data && bounds"
      :viewBox="`0 0 ${W} ${H}`"
      role="img"
      :aria-label="`${data.yTitle} against ${data.xTitle}`"
      @pointermove="onMove"
      @pointerleave="hover = undefined"
    >
      <g class="chart-grid">
        <line
          v-for="t in yTicks"
          :key="`y${t.y}`"
          :x1="M.left"
          :x2="W - M.right"
          :y1="sy(t.y)"
          :y2="sy(t.y)"
        />
      </g>
      <line
        v-if="data.zero"
        class="chart-zero"
        :x1="M.left"
        :x2="W - M.right"
        :y1="sy(0)"
        :y2="sy(0)"
      />
      <line
        v-if="data.oneToOne"
        class="chart-zero"
        :x1="sx(bounds.x0)"
        :y1="sy(bounds.y0)"
        :x2="sx(bounds.x1)"
        :y2="sy(bounds.y1)"
      />
      <g v-for="(points, at) in data.series" :key="at">
        <path
          v-if="data.lines"
          :d="drawn[at].path"
          fill="none"
          :stroke="rows[at].colour"
          stroke-width="1.5"
        />
        <path
          v-if="drawn[at].dots"
          :d="drawn[at].dots"
          :fill="rows[at].colour"
          fill-opacity="0.75"
        />
      </g>
      <g v-if="hover && readout" class="chart-hover">
        <line
          v-if="data.keys.length"
          :x1="hover.cx"
          :x2="hover.cx"
          :y1="M.top"
          :y2="H - M.bottom"
        />
        <circle
          v-for="[at, k] in hover.marks"
          :key="at"
          :cx="sx(data.series[at][k].x)"
          :cy="sy(data.series[at][k].y)"
          r="4.5"
          :fill="rows[at].colour"
        />
      </g>
      <g class="chart-axis">
        <line
          :x1="M.left"
          :x2="W - M.right"
          :y1="H - M.bottom"
          :y2="H - M.bottom"
        />
        <line :x1="M.left" :x2="M.left" :y1="M.top" :y2="H - M.bottom" />
        <text
          v-for="t in xTicks"
          :key="`x${t.x}`"
          :x="sx(t.x)"
          :y="H - M.bottom + 14"
          :text-anchor="t.anchor"
        >
          {{ t.label }}
        </text>
        <text
          v-for="t in yTicks"
          :key="`yl${t.y}`"
          :x="M.left - 6"
          :y="sy(t.y) + 3"
          text-anchor="end"
        >
          {{ t.label }}
        </text>
        <text
          :x="M.left + plotW / 2"
          :y="H - 6"
          text-anchor="middle"
          class="chart-title"
        >
          {{ data.xTitle }}
        </text>
        <text
          :transform="`translate(12 ${M.top + plotH / 2}) rotate(-90)`"
          text-anchor="middle"
          class="chart-title"
        >
          {{ data.yTitle }}
        </text>
      </g>
    </svg>
    <svg
      v-else-if="parallel"
      :viewBox="`0 0 ${W} ${H}`"
      role="img"
      aria-label="Parallel coordinates of the scores, better at the top"
    >
      <g class="chart-axis">
        <g v-for="(axis, k) in parallel.axes" :key="axis.name">
          <line :x1="axisX(k)" :x2="axisX(k)" :y1="M.top" :y2="M.top + plotH" />
          <text
            :x="axisX(k)"
            :y="H - 26"
            text-anchor="middle"
            class="chart-title"
          >
            {{ axis.name }}
          </text>
          <text :x="axisX(k)" :y="H - 8" text-anchor="middle">
            {{ formatValue(k === 0 ? axis.min : axis.max) }} →
            {{ formatValue(k === 0 ? axis.max : axis.min) }}
          </text>
        </g>
      </g>
      <path class="chart-ideal" :d="polyline(parallel.ideal)" fill="none" />
      <g v-for="(row, at) in parallel.rows" :key="at">
        <path
          :d="polyline(row.placed)"
          fill="none"
          :stroke="rows[at].colour"
          stroke-width="2"
        />
        <template v-for="(t, k) in row.placed" :key="k">
          <circle
            v-if="Number.isFinite(t)"
            :cx="axisX(k)"
            :cy="axisY(t)"
            r="3"
            :fill="rows[at].colour"
          >
            <title>
              {{ rows[at].label }}: {{ formatValue(row.values[k]) }}
            </title>
          </circle>
        </template>
      </g>
    </svg>
    <div
      v-if="hover && readout && data"
      class="chart-readout"
      role="status"
      :style="{
        left: `${hover.left}px`,
        top: `${hover.top}px`,
      }"
      :class="{ 'is-left': hover.cx > W * 0.6 }"
    >
      <strong>{{ readout.title }}</strong>
      <span v-for="line in readout.lines" :key="line.text">
        <span
          class="chart-readout-swatch"
          :style="{ background: line.colour ?? 'transparent' }"
        ></span
        >{{ line.text }}
      </span>
    </div>
    <figcaption class="compare-muted">
      <template v-if="view === 'bias'">
        Each plot minus the reference at their common dates; 0 is no bias. Hover
        for every plot's value at a date.
      </template>
      <template v-else-if="view === 'scatter'">
        One dot per common date; on the 1:1 line the plot equals the reference.
        Hover a dot for its values.
      </template>
      <template v-else-if="view === 'qq'">
        Percentiles 1–99 of each plot against the reference's: on the 1:1 line
        the distributions match; parallel above it is a shift, a steeper line a
        wider spread.
      </template>
      <template v-else>
        Each line a plot, better at the top of every axis; dashed: the
        reference's ideal (r = 1, no error). Hover a dot for its value.
      </template>
    </figcaption>
  </figure>
</template>

<style scoped>
/* Scaled with the panel within limits: at most 1.2 times the drawn size
 * (a maximized panel), at least 0.75 times (a narrow one scrolls
 * sideways), so the labels stay between about 10 and 16 px. */
.compare-chart {
  position: relative;
  margin: 0;
  overflow-x: auto;
}
.compare-chart svg {
  display: block;
  width: 100%;
  min-width: 480px;
  height: auto;
  max-height: 384px;
  font-size: 13px;
}
.chart-grid line {
  stroke: var(--plot-grid);
}
.chart-zero,
.chart-ideal {
  stroke: var(--plot-fg);
  stroke-dasharray: 5 4;
  stroke-width: 1;
}
.chart-axis line {
  stroke: var(--plot-muted);
}
.chart-axis text {
  fill: var(--plot-muted);
}
.chart-axis .chart-title {
  fill: var(--plot-fg);
  font-size: 14px;
}
.compare-muted {
  color: var(--plot-muted);
}
.chart-hover {
  pointer-events: none;
}
.chart-hover circle {
  stroke: var(--plot-bg);
  stroke-width: 2;
}
.chart-hover line {
  stroke: var(--plot-muted);
  stroke-dasharray: 3 3;
}
.chart-readout {
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
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
  white-space: nowrap;
  pointer-events: none;
}
.chart-readout.is-left {
  transform: translate(calc(-100% - 12px), -50%);
}
.chart-readout-swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 50%;
}
</style>
