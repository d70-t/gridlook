<script lang="ts" setup>
/**
 * Compare plots: open time series (any dataset, snapshots included)
 * against one chosen as the reference, matched by date. A Taylor diagram
 * (correlation, standard deviation and centred RMS difference, normalised
 * by the reference's), the statistics with the mean bias kept apart, and a
 * portrait of RMS errors by season relative to the median plot. Each plot
 * counts once.
 */
import { useElementSize } from "@vueuse/core";
import { computed, onMounted, ref, watch } from "vue";

import {
  compareViewCsvParts,
  csvCell,
  onTaylor,
  pairSeries,
  portrait,
  quantityProblem,
  SEASONS,
  taylorReach,
  taylorRings,
  taylorStats,
  type TDatedSeries,
  validTimeAxis,
  validTimeProblem,
  withUnits,
} from "./compare.ts";
import CompareCharts, { type TCompareView } from "./CompareCharts.vue";
import { shownValues } from "./plotFigure.ts";
import {
  clampRect,
  humanStatus,
  isNarrow,
  maximizedRect,
  resizedRect,
  titleBarInset,
  type TResizeEdge,
} from "./plotLayout.ts";

import {
  parseTimeAxis,
  timeLabelAt,
  timeLabels,
} from "@/lib/analysis/calendar.ts";
import { temperatureMetadata } from "@/lib/analysis/displayUnits.ts";
import { ANALYSIS_KINDS } from "@/lib/analysis/types.ts";
import { converter, sameUnits } from "@/lib/analysis/unitConvert.ts";
import { formatBytes } from "@/lib/data/chunkLayout.ts";
import {
  DRAW_MODES,
  PLOT_STATUS,
  standardNameOf,
  useAnalysisStore,
  type TPlotWindow,
} from "@/store/analysisStore.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import { formatValue } from "@/utils/formatValue.ts";

const analysis = useAnalysisStore();
const globe = useGlobeControlStore();
const panel = ref<HTMLElement>();

// ----- the window: moved by its title, resized from every side
const rect = ref<{ x: number; y: number; w: number; h: number }>();
/** Sized by hand: until then it is as tall as its content (at most the map). */
const sized = ref(false);
const area = () => {
  const host = panel.value?.parentElement;
  const at = host?.getBoundingClientRect();
  return {
    width: host?.clientWidth ?? 1200,
    height: host?.clientHeight ?? 800,
    // How far the app's title bar reaches into the map, as for plots.
    top: at ? titleBarInset({ left: at.left, top: at.top }) : 0,
  };
};
const narrow = computed(() => isNarrow(area()));
// Opened or restored: in front, as a plot opened or restored is.
onMounted(() => analysis.raiseCompare());
watch(
  () => analysis.compare?.minimized,
  (minimized) => minimized === false && analysis.raiseCompare()
);
onMounted(() => {
  const { width, height } = area();
  const w = Math.min(880, width - 24);
  rect.value = {
    x: Math.round((width - w) / 2),
    y: 48,
    w,
    h: Math.min(height - 72, 680),
  };
});
const EDGES: TResizeEdge[] = ["n", "s", "e", "w", "ne", "nw", "se", "sw"];
function gesture(event: PointerEvent, edge: TResizeEdge) {
  const start = rect.value && {
    ...rect.value,
    h: panel.value?.offsetHeight ?? rect.value.h,
  };
  if (
    !start ||
    narrow.value ||
    maximized.value ||
    event.button !== 0 ||
    (edge === "move" && (event.target as HTMLElement).closest("button"))
  ) {
    return;
  }
  const target = event.currentTarget as HTMLElement;
  target.setPointerCapture?.(event.pointerId);
  const [x0, y0] = [event.clientX, event.clientY];
  const move = (e: PointerEvent) => {
    rect.value = resizedRect(
      start,
      edge,
      e.clientX - x0,
      e.clientY - y0,
      area()
    );
    sized.value ||= edge !== "move";
  };
  const end = () => {
    target.removeEventListener("pointermove", move);
    target.removeEventListener("pointerup", end);
    target.removeEventListener("pointercancel", end);
  };
  target.addEventListener("pointermove", move);
  target.addEventListener("pointerup", end);
  target.addEventListener("pointercancel", end);
}
/**
 * Minimized into Plotting tools' list, with the plots (25 Nov: it sat in a
 * corner of its own), or filling the map.
 */
const minimized = computed(() => Boolean(analysis.compare?.minimized));
const maximized = ref(false);
function minimize() {
  if (analysis.compare) {
    analysis.compare = { ...analysis.compare, minimized: true };
    analysis.announcement = "Compare plots minimized to Plotting tools.";
  }
}
function toggleMaximize() {
  maximized.value = !maximized.value;
}
/**
 * Maximized: the map above Plotting tools and below the app's title bar,
 * the rectangle a maximized plot fills (24 Nov: Compare covered the
 * header).
 */
const hostSize = useElementSize(computed(() => panel.value?.parentElement));
// The panel stays inside the map when it shrinks (a narrower browser, the
// sidebar opened), as plot windows do (24 Nov: it ran off the right edge).
watch([hostSize.width, hostSize.height], () => {
  const { width, height } = area();
  if (rect.value && width && height) {
    rect.value = clampRect(rect.value, { width, height });
  }
});
function maximizedStyle() {
  // Follows the map's size (a resized browser, the sidebar).
  void hostSize.width.value;
  void hostSize.height.value;
  const fill = maximizedRect(area());
  return {
    left: `${fill.x}px`,
    top: `${fill.y}px`,
    width: `${fill.w}px`,
    height: `${fill.h}px`,
    maxHeight: "none",
    transform: "none",
  };
}
const panelStyle = computed(() =>
  maximized.value && !narrow.value
    ? maximizedStyle()
    : rect.value && !narrow.value
      ? {
          left: `${rect.value.x}px`,
          top: `${rect.value.y}px`,
          width: `${rect.value.w}px`,
          transform: "none",
          ...(sized.value
            ? { height: `${rect.value.h}px`, maxHeight: "none" }
            : { maxHeight: `${area().height - rect.value.y - 12}px` }),
        }
      : undefined
);

// ----- picking places for it: the series made while it is open join it
/** Start a point or an area for Compare (the map shows while drawing). */
function pick(kind: "point" | "area") {
  const rotating = globe.isRotating;
  globe.isRotating = false;
  analysis.startDrawing(
    kind === "point" ? DRAW_MODES.POINT : DRAW_MODES.BOX,
    kind === "point"
      ? ANALYSIS_KINDS.POINT_SERIES
      : ANALYSIS_KINDS.REGION_SERIES,
    undefined,
    undefined,
    rotating
  );
}
const drawing = computed(() => analysis.drawMode !== DRAW_MODES.NONE);

/** Finished time series: what can be compared. */
const eligible = computed(() =>
  analysis.windows.filter(
    (w) =>
      w.result &&
      !w.result.partial &&
      w.result.time &&
      (w.kind === ANALYSIS_KINDS.POINT_SERIES ||
        w.kind === ANALYSIS_KINDS.REGION_SERIES)
  )
);
const chosen = computed(() =>
  eligible.value.filter((w) => analysis.compare?.ids.includes(w.id))
);
const reference = computed(() =>
  eligible.value.find((w) => w.id === analysis.compare?.reference)
);
// A series that finishes while Compare collects joins it (the first one
// becomes the reference when there is none).
let known = new Set(eligible.value.map((w) => w.id));
watch(
  () => eligible.value.map((w) => w.id),
  (ids) => {
    const compare = analysis.compare;
    const fresh = ids.filter((id) => !known.has(id));
    known = new Set(ids);
    if (!compare?.collect || !fresh.length) {
      return;
    }
    const joined = [...new Set([...compare.ids, ...fresh])];
    analysis.compare = {
      ...compare,
      ids: joined,
      reference: ids.includes(compare.reference)
        ? compare.reference
        : joined[0],
    };
  }
);
/**
 * Series still being read (or waiting) that will join when done: those
 * asked for (a shared link's), or any while Compare collects.
 */
const coming = computed(() =>
  analysis.windows.filter(
    (w) =>
      (w.kind === ANALYSIS_KINDS.POINT_SERIES ||
        w.kind === ANALYSIS_KINDS.REGION_SERIES) &&
      !eligible.value.includes(w) &&
      !w.result?.partial &&
      w.status !== PLOT_STATUS.ERROR &&
      w.status !== PLOT_STATUS.CANCELLED &&
      w.status !== PLOT_STATUS.UNAVAILABLE &&
      (analysis.compare?.collect || analysis.compare?.ids.includes(w.id))
  )
);
/** What Read would decode, for a plot waiting for approval. */
function sizeOf(w: TPlotWindow) {
  const bytes = w.estimate?.decodedBytes;
  return bytes ? formatBytes(bytes) : "";
}
/** A coming plot's share read, or undefined while it cannot say. */
function shareRead(w: TPlotWindow) {
  const p = w.status === PLOT_STATUS.RUNNING ? w.progress : undefined;
  return p && p.total > 0 ? p.done / p.total : undefined;
}
/**
 * There is always a reference while plots are open (25 Nov: closing them
 * all and picking again left none): a closed one is replaced by the first
 * compared plot still open, or the first open. One still being read (a
 * shared link's) is kept.
 */
watch(
  () => [
    eligible.value.map((w) => w.id).join(),
    analysis.compare?.reference,
    coming.value.map((w) => w.id).join(),
  ],
  () => {
    const compare = analysis.compare;
    const open = eligible.value.map((w) => w.id);
    if (
      !compare ||
      !open.length ||
      open.includes(compare.reference) ||
      coming.value.some((w) => w.id === compare.reference)
    ) {
      return;
    }
    const next = compare.ids.find((id) => open.includes(id)) ?? open[0];
    analysis.compare = {
      ...compare,
      ids: [...new Set([...compare.ids, next])],
      reference: next,
    };
  },
  { immediate: true }
);

/**
 * A plot's series as shown (below-coverage means hidden), by date; raw
 * offsets of a calendar without a decoder keep their units and calendar.
 */
/** A result's times as compared: a forecast's valid times, built once. */
const validAxes = new WeakMap<
  object,
  NonNullable<TPlotWindow["result"]>["time"]
>();
function comparedTime(result: NonNullable<TPlotWindow["result"]>) {
  let time = validAxes.get(result);
  if (!time) {
    const valid = validTimeAxis(result.time!, result.selections);
    time = "reason" in valid ? result.time! : valid;
    validAxes.set(result, time);
  }
  return time!;
}

function dated(w: TPlotWindow, convert?: (v: number) => number): TDatedSeries {
  // A forecast at its valid times (refused below when they are unknown).
  const time = comparedTime(w.result!);
  const shown = shownValues(w.result!);
  const values = convert ? shown.map(convert) : shown;
  // The axis itself goes with it: pairs are matched as Against matches.
  const axis = { ...time, cellMethods: w.result!.cellMethods };
  return "unsupported" in parseTimeAxis(time.units, time.calendar)
    ? {
        dates: time.raw.map((raw) => `${raw} ${time.units} ${time.calendar}`),
        values,
        exact: true,
        time: axis,
      }
    : {
        dates: timeLabels(time),
        values,
        calendar: time.calendar,
        monthlyCells: monthlyCells(time),
        time: axis,
      };
}

/** Whether every declared time cell is a calendar month long (28–31 days). */
function monthlyCells(time: NonNullable<TPlotWindow["result"]>["time"]) {
  const axis = parseTimeAxis(time?.units, time?.calendar);
  const bounds = time?.bounds;
  if (!bounds?.length || "unsupported" in axis) {
    return false;
  }
  for (let k = 0; k + 1 < bounds.length; k += 2) {
    const daysLong =
      (Math.abs(bounds[k + 1] - bounds[k]) * axis.unitSeconds) / 86400;
    if (daysLong < 27.5 || daysLong > 31.5) {
      return false;
    }
  }
  return true;
}

/** What a pair is, in words: one instant, one interval, one month. */
function pairWords(by: string) {
  return by === "interval"
    ? "dates (shared intervals)"
    : by === "month"
      ? "dates (calendar months: monthly statistics across calendars)"
      : by === "day"
        ? "dates (daily means)"
        : "times (same instants)";
}

/** The first and last date a plot has loaded, for "none shared". */
function loadedSpan(w: TPlotWindow) {
  // At the times paired: a forecast's valid times, not its initializations.
  const time = w.result?.time && comparedTime(w.result);
  if (!time?.raw.length) {
    return "no dates";
  }
  let lo = 0;
  let hi = 0;
  time.raw.forEach((v, i) => {
    lo = v < time.raw[lo] ? i : lo;
    hi = v > time.raw[hi] ? i : hi;
  });
  const [a, b] = [timeLabelAt(time, lo), timeLabelAt(time, hi)];
  return a === b ? a : `${a} – ${b}`;
}

function nameOf(w: TPlotWindow) {
  const r = w.result!;
  const name = r.longName || r.query.variable.split("/").pop();
  return `${w.label}: ${name} (${w.datasetName})`;
}

// One colour per compared plot, the same in the diagram and the tables.
const COLOURS = [
  "#1b9e77",
  "#d95f02",
  "#7570b3",
  "#e7298a",
  "#66a61e",
  "#e6ab02",
  "#a6761d",
  "#1f78b4",
];

/**
 * Why two plots are of different physical quantities, when their
 * standard names (or, without them, their kinds of rate) say so.
 */
function otherQuantity(w: TPlotWindow, ref: TPlotWindow) {
  const side = (plot: TPlotWindow) => ({
    variable: plot.result!.query.variable,
    standardName: standardNameOf(plot.result!, analysis.variableSources),
    units: plot.result!.units,
    cellMethods: plot.result!.cellMethods,
    timeDimension: plot.result!.time?.dimension,
    unitsMetadata: plot.result!.unitsMetadata,
  });
  return quantityProblem(side(w), side(ref));
}

/** Why a forecast plot of the two has no valid times to pair by. */
function leadProblem(w: TPlotWindow, ref: TPlotWindow) {
  for (const plot of [w, ref]) {
    const reason = validTimeProblem(
      plot.result!.time!,
      plot.result!.selections
    );
    if (reason) {
      return `${plot === ref ? "the reference" : "this plot"}: ${reason}`;
    }
  }
  return undefined;
}

/** Each compared plot against the reference: pairs and statistics. */
const rows = computed(() => {
  const ref = reference.value;
  if (!ref) {
    return [];
  }
  const base = dated(ref);
  return chosen.value
    .filter((w) => w.id !== ref.id)
    .map((w, at) => {
      // In the reference's units (K beside °C converts), or not compared.
      const from = w.result!.units;
      const to = ref.result!.units;
      // As the plots show them: an anomaly in K beside one in °C differs by no
      // offset.
      const meaning = (plot: TPlotWindow) =>
        temperatureMetadata(
          plot.result!,
          standardNameOf(plot.result!, analysis.variableSources)
        );
      // Errors are of one quantity: a carbon flux is no current, whatever a
      // water-equivalent factor makes of their units, and air pressure is no
      // wind stress in the same Pa.
      const other = otherQuantity(w, ref) ?? leadProblem(w, ref);
      const convert = other
        ? undefined
        : converter(from, to, {
            from: meaning(w),
            to: meaning(ref),
          });
      // Not compared: no pairs made at all.
      const pair = convert
        ? pairSeries(base, dated(w, convert))
        : pairSeries(base, { dates: [], values: [] });
      return {
        w,
        colour: COLOURS[at % COLOURS.length],
        pair,
        stats: convert ? taylorStats(pair.reference, pair.other) : undefined,
        from: sameUnits(from, to) ? undefined : from,
        units: other
          ? other
          : sameUnits(from, to)
            ? undefined
            : convert
              ? `converted from ${from}`
              : `${from ?? "no units"}: does not convert to ${to ?? "no units"}`,
      };
    });
});
const rowOf = (id: string) => rows.value.find((row) => row.w.id === id);

/** Which view of the comparison: the Taylor diagram and tables, or another. */
const VIEWS: { id: "taylor" | TCompareView; name: string }[] = [
  { id: "taylor", name: "Taylor and portrait" },
  { id: "bias", name: "Bias over time" },
  { id: "scatter", name: "Scatter" },
  { id: "qq", name: "Q–Q" },
  { id: "parallel", name: "Parallel coordinates" },
];
// The view asked for by a found chart (Taylor diagram, Q–Q…), kept until
// there are pairs to show it with.
const view = ref<"taylor" | TCompareView>(analysis.compare?.view ?? "taylor");
watch(
  () => analysis.compare?.view,
  (asked) => {
    if (asked) {
      view.value = asked;
    }
  }
);
/** The scored rows as the other views take them. */
const chartRows = computed(() =>
  scored.value.map((row) => ({
    label: row.w.label,
    colour: row.colour,
    pair: row.pair,
    stats: row.stats!,
    from: row.from,
  }))
);
const scored = computed(() => rows.value.filter((row) => row.stats));
const seasons = computed(() => portrait(scored.value.map((row) => row.pair)));

// ----- the Taylor diagram (normalised standard deviation, correlation)
const SIZE = 300;
const PAD = 34;
/** Rows with a Taylor point; the others are named under the diagram. */
const placed = computed(() =>
  scored.value.filter((row) => onTaylor(row.stats!))
);
const unplaced = computed(() =>
  scored.value.filter((row) => !onTaylor(row.stats!))
);
const negative = computed(() =>
  placed.value.some((row) => row.stats!.correlation < 0)
);
const reach = computed(() =>
  taylorReach(placed.value.map((row) => row.stats!.stdTest / row.stats!.stdRef))
);
const width = computed(() =>
  negative.value ? 2 * SIZE + 2 * PAD : SIZE + 2 * PAD
);
const origin = computed(() => ({
  x: negative.value ? PAD + SIZE : PAD,
  y: SIZE + PAD,
}));
const scale = computed(() => SIZE / reach.value);
function at(radius: number, angle: number) {
  return {
    x: origin.value.x + radius * scale.value * Math.cos(angle),
    y: origin.value.y - radius * scale.value * Math.sin(angle),
  };
}
const arc = (radius: number, from: number, to: number) => {
  const a = at(radius, from);
  const b = at(radius, to);
  const large = to - from > Math.PI ? 1 : 0;
  return `M${a.x} ${a.y} A${radius * scale.value} ${radius * scale.value} 0 ${large} 0 ${b.x} ${b.y}`;
};
const span = computed(() => (negative.value ? Math.PI : Math.PI / 2));
const stdArcs = computed(() => taylorRings(reach.value));
const CORRELATIONS = [0, 0.2, 0.4, 0.6, 0.8, 0.9, 0.95, 0.99];
const rays = computed(() =>
  [
    ...CORRELATIONS,
    ...(negative.value ? CORRELATIONS.filter((c) => c).map((c) => -c) : []),
  ].map((c) => ({ c, angle: Math.acos(c) }))
);
/** Centred RMS difference arcs around the reference, inside the frame. */
const rmsArcs = computed(() =>
  [0.25, 0.5, 0.75, 1, 1.5].map((radius) => {
    const points: string[] = [];
    for (let k = 0; k <= 90; k++) {
      const t = (Math.PI * k) / 90;
      const x = 1 + radius * Math.cos(t);
      const y = radius * Math.sin(t);
      const r = Math.hypot(x, y);
      const angle = Math.atan2(y, x);
      if (r <= reach.value && angle <= span.value) {
        const p = at(r, angle);
        points.push(`${p.x},${p.y}`);
      }
    }
    return { radius, points: points.join(" ") };
  })
);
const marks = computed(() => {
  const taken: { x: number; y: number }[] = [];
  return placed.value.map((row) => {
    const s = row.stats!;
    const point = at(
      s.stdTest / s.stdRef,
      Math.acos(Math.max(-1, Math.min(1, s.correlation)))
    );
    // Labels of nearby marks step up, away from the axis title under the
    // diagram, so each stays readable (24 Nov: P2 over P3, P3 over the
    // title).
    let labelY = point.y - 6;
    while (
      taken.some(
        (p) => Math.abs(p.x - point.x) < 36 && Math.abs(p.y - labelY) < 14
      )
    ) {
      labelY -= 15;
    }
    taken.push({ x: point.x, y: labelY });
    return { ...row, ...point, labelY };
  });
});

/** Two decimals, or a dash where the statistic is undefined. */
const fixed = (value: number) =>
  Number.isFinite(value) ? value.toFixed(2) : "–";

/** Diverging colour of a relative error: blue better, red worse. */
function cellColour(relative: number) {
  if (!Number.isFinite(relative)) {
    return "transparent";
  }
  const t = Math.max(-1, Math.min(1, relative / 0.5));
  const [r, g, b] =
    t < 0
      ? [255 + (33 - 255) * -t, 255 + (102 - 255) * -t, 255 + (172 - 255) * -t]
      : [255 + (178 - 255) * t, 255 + (24 - 255) * t, 255 + (43 - 255) * t];
  return `rgb(${Math.round(r)}, ${Math.round(g)}, ${Math.round(b)})`;
}

function toggle(id: string, on: boolean) {
  const compare = analysis.compare;
  if (!compare) {
    return;
  }
  const ids = on
    ? [...new Set([...compare.ids, id])]
    : compare.ids.filter((other) => other !== id);
  analysis.compare = { ...compare, ids };
}

function setReference(id: string) {
  const compare = analysis.compare!;
  // Keeps collecting and the view asked for (25 Nov: setting a reference
  // stopped new series from joining).
  analysis.compare = {
    ...compare,
    ids: [...new Set([...compare.ids, id])],
    reference: id,
  };
}

/** The statistics as CSV, one row per compared plot. */
function downloadCsv() {
  const ref = reference.value;
  if (!ref) {
    return;
  }
  const header = [
    "plot",
    "reference",
    "matched_by",
    "n",
    "correlation",
    "std_ratio",
    // In the reference's units (converted plots name theirs in Compare).
    withUnits("crmsd", ref.result?.units),
    withUnits("bias", ref.result?.units),
    ...SEASONS.map((s) => withUnits(`rmse_${s.name}`, ref.result?.units)),
  ];
  // Missing numbers (no correlation, a season without dates) are empty
  // cells, never NaN, Infinity or "undefined".
  const lines = scored.value.map((row, at) =>
    [
      row.w.label,
      ref.label,
      row.pair.by,
      row.stats!.n,
      row.stats!.correlation,
      row.stats!.stdTest / row.stats!.stdRef,
      row.stats!.crmsd,
      row.stats!.bias,
      ...SEASONS.map((_, s) => seasons.value.errors[at]?.[s]),
    ]
      .map(csvCell)
      .join(",")
  );
  save([header.join(","), ...lines].join("\n"), `compare_vs_${ref.label}.csv`);
}

/** The view shown (bias, scatter, Q–Q, parallel coordinates) as CSV. */
// Written in parts with turns between them; a second click waits for it.
const writing = ref(false);
async function downloadView() {
  const ref = reference.value;
  if (!ref || view.value === "taylor" || writing.value) {
    return;
  }
  writing.value = true;
  try {
    const parts = await compareViewCsvParts(view.value, chartRows.value, {
      label: ref.label,
      units: ref.result?.units,
    });
    if (parts) {
      save(parts, `compare_${view.value}_vs_${ref.label}.csv`);
    }
  } finally {
    writing.value = false;
  }
}

function save(text: string | string[], name: string) {
  const blob = new Blob(Array.isArray(text) ? text : [text], {
    type: "text/csv",
  });
  const link = document.createElement("a");
  link.href = URL.createObjectURL(blob);
  link.download = name;
  link.click();
  URL.revokeObjectURL(link.href);
}
</script>

<template>
  <section
    v-show="!drawing && !minimized"
    ref="panel"
    class="analysis-panel analysis-compare"
    :class="{ narrow }"
    :style="[panelStyle, { zIndex: analysis.compare?.z }]"
    role="dialog"
    aria-label="Compare plots"
    @pointerdown.capture="analysis.raiseCompare()"
    @focusin="analysis.raiseCompare()"
    @keydown.esc.stop="analysis.compare = undefined"
  >
    <header
      class="compare-head"
      :title="narrow ? undefined : 'Drag to move'"
      @pointerdown="gesture($event, 'move')"
      @dblclick="
        !narrow &&
        !($event.target as HTMLElement).closest('button') &&
        toggleMaximize()
      "
    >
      <h2>
        <i class="fa-solid fa-scale-balanced mr-1" aria-hidden="true"></i
        >Compare plots
      </h2>
      <span class="compare-window-buttons">
        <button
          type="button"
          class="compare-close"
          aria-label="Minimize Compare plots to Plotting tools"
          title="Minimize to Plotting tools"
          data-compare-minimize
          @click="minimize"
        >
          <i class="fa-solid fa-window-minimize" aria-hidden="true"></i>
        </button>
        <button
          v-if="!narrow"
          type="button"
          class="compare-close"
          :aria-label="
            maximized ? 'Restore Compare plots' : 'Maximize Compare plots'
          "
          :title="maximized ? 'Restore size' : 'Maximize'"
          data-compare-maximize
          @click="toggleMaximize"
        >
          <i
            class="fa-solid"
            :class="maximized ? 'fa-window-restore' : 'fa-window-maximize'"
            aria-hidden="true"
          ></i>
        </button>
        <button
          type="button"
          class="compare-close"
          aria-label="Close Compare plots"
          title="Close"
          @click="analysis.compare = undefined"
        >
          <i class="fa-solid fa-xmark" aria-hidden="true"></i>
        </button>
      </span>
    </header>
    <div v-show="!minimized" class="compare-scroll">
      <p class="compare-help">
        Time series against a reference, matched by date. Each plot counts once;
        plots from datasets you left stay here as snapshots.
      </p>
      <!-- Fewer than two series: what Compare needs, and how to make them. -->
      <div
        v-if="eligible.length < 2 && eligible.length + coming.length >= 2"
        class="compare-start"
        data-compare-waiting
      >
        <p class="compare-start-title">
          Reading {{ coming.length }}
          {{ coming.length === 1 ? "plot" : "plots" }} to compare
        </p>
        <p class="compare-muted">
          They join here when read; the charts follow once two are in.
        </p>
      </div>
      <div
        v-else-if="eligible.length < 2"
        class="compare-start"
        data-compare-start
      >
        <p class="compare-start-title">
          {{
            eligible.length
              ? `One more place or area to compare with ${eligible[0].label}`
              : "Pick two places or areas to compare"
          }}
        </p>
        <p class="compare-muted">
          Each becomes a time series of
          <strong>{{ globe.varnameDisplay || "the map's variable" }}</strong>;
          when it is read it joins here, the first as the reference.
        </p>
        <div class="compare-start-actions">
          <button
            type="button"
            class="compare-button primary"
            data-compare-pick="point"
            @click="pick('point')"
          >
            <i class="fa-solid fa-location-dot mr-1" aria-hidden="true"></i>Pick
            a point
          </button>
          <button
            type="button"
            class="compare-button"
            data-compare-pick="area"
            @click="pick('area')"
          >
            <i class="fa-regular fa-square mr-1" aria-hidden="true"></i>Draw an
            area
          </button>
        </div>
      </div>
      <div v-else class="compare-add">
        <span class="compare-muted">Add another:</span>
        <button type="button" class="compare-button" @click="pick('point')">
          <i class="fa-solid fa-location-dot mr-1" aria-hidden="true"></i>Point
        </button>
        <button type="button" class="compare-button" @click="pick('area')">
          <i class="fa-regular fa-square mr-1" aria-hidden="true"></i>Area
        </button>
      </div>
      <!-- Plots still being read (a shared link's): each with its progress,
           or Read where it waits for approval (25 Nov). -->
      <ul v-if="coming.length" class="compare-coming" aria-label="Being read">
        <li v-for="w in coming" :key="w.id" :data-compare-coming="w.id">
          <span class="compare-coming-id">{{ w.label }}</span>
          <progress
            class="compare-coming-bar"
            max="1"
            :value="shareRead(w)"
            :aria-label="`${w.label}: ${humanStatus(w)}`"
          ></progress>
          <span class="compare-muted compare-coming-state">{{
            humanStatus(w)
          }}</span>
          <button
            v-if="w.status === PLOT_STATUS.CONFIRM"
            type="button"
            class="compare-button"
            :title="`Read ${w.label}${sizeOf(w) ? `: ${sizeOf(w)}` : ''}`"
            @click="analysis.confirm(w.id)"
          >
            Read{{ sizeOf(w) ? ` ${sizeOf(w)}` : "" }}
          </button>
        </li>
      </ul>
      <table v-if="eligible.length" class="compare-plots">
        <thead>
          <tr>
            <th scope="col">Reference</th>
            <th scope="col">Compare</th>
            <th scope="col">Plot</th>
            <th scope="col">Matched</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="w in eligible" :key="w.id">
            <td>
              <input
                type="radio"
                name="compare-reference"
                :checked="w.id === analysis.compare?.reference"
                :aria-label="`${w.label} as the reference`"
                @change="setReference(w.id)"
              />
            </td>
            <td>
              <input
                type="checkbox"
                :checked="analysis.compare?.ids.includes(w.id)"
                :disabled="w.id === analysis.compare?.reference"
                :aria-label="`Compare ${w.label}`"
                @change="
                  toggle(w.id, ($event.target as HTMLInputElement).checked)
                "
              />
            </td>
            <td>
              <span
                v-if="rowOf(w.id)"
                class="compare-swatch"
                :style="{
                  background: rowOf(w.id)!.colour,
                }"
              ></span>
              {{ nameOf(w) }}
            </td>
            <td class="compare-muted">
              <template v-if="w.id === analysis.compare?.reference"
                >reference</template
              >
              <!-- Not compared: why, not "no shared dates" (nothing was
                   paired at all). -->
              <template
                v-else-if="
                  rowOf(w.id) && !rowOf(w.id)!.stats && rowOf(w.id)!.units
                "
              >
                <span class="compare-warn">{{ rowOf(w.id)!.units }}</span>
              </template>
              <template
                v-else-if="rowOf(w.id) && !rowOf(w.id)!.pair.keys.length"
              >
                <!-- The same dates, other cells (an interval statistic beside
                     readings at instants): said so, not the range twice. -->
                <template v-if="loadedSpan(w) === loadedSpan(reference!)"
                  >No shared observations: the same dates, but other time cells
                  (an interval statistic beside readings at instants)</template
                >
                <template v-else
                  >No shared dates: {{ w.label }} has {{ loadedSpan(w) }}, the
                  reference {{ loadedSpan(reference!) }}</template
                >
              </template>
              <template v-else-if="rowOf(w.id)">
                {{ rowOf(w.id)!.pair.keys.length }}
                {{ pairWords(rowOf(w.id)!.pair.by) }}
                <span v-if="rowOf(w.id)!.units" class="compare-warn">
                  — {{ rowOf(w.id)!.units }}</span
                >
              </template>
            </td>
          </tr>
        </tbody>
      </table>

      <p
        v-if="!scored.length && eligible.length >= 2"
        class="compare-muted compare-empty"
      >
        Choose a reference and at least one other plot that shares two or more
        dates with it. Plots match on the dates they have loaded: load more
        dates under a plot until the two overlap.
      </p>
      <div
        v-if="scored.length"
        class="compare-views"
        role="tablist"
        aria-label="Comparison view"
      >
        <button
          v-for="v in VIEWS"
          :key="v.id"
          type="button"
          role="tab"
          class="analysis-tool"
          :aria-selected="view === v.id"
          :class="{ active: view === v.id }"
          @click="view = v.id"
        >
          {{ v.name }}
        </button>
      </div>
      <CompareCharts
        v-if="scored.length && view !== 'taylor'"
        :view="view"
        :rows="chartRows"
        :reference-label="reference?.label ?? 'reference'"
        :units="reference?.result?.units"
      />
      <button
        v-if="scored.length && view !== 'taylor'"
        type="button"
        class="analysis-tool"
        :disabled="writing"
        :aria-busy="writing"
        @click="downloadView"
      >
        <i class="fa-solid fa-download mr-1" aria-hidden="true"></i
        >{{ writing ? "Writing CSV…" : "This view (CSV)" }}
      </button>
      <div v-else-if="scored.length" class="compare-figures">
        <figure class="compare-taylor">
          <svg
            :viewBox="`0 0 ${width} ${SIZE + PAD * 2.1}`"
            role="img"
            :aria-label="`Taylor diagram against ${reference?.label}`"
          >
            <g class="taylor-grid">
              <path
                v-for="r in stdArcs"
                :key="`s${r}`"
                :d="arc(r, 0, span)"
                :class="{ 'taylor-one': Math.abs(r - 1) < 1e-9 }"
              />
              <line
                v-for="ray in rays"
                :key="`c${ray.c}`"
                :x1="origin.x"
                :y1="origin.y"
                :x2="at(reach, ray.angle).x"
                :y2="at(reach, ray.angle).y"
              />
              <polyline
                v-for="rms in rmsArcs"
                :key="`r${rms.radius}`"
                class="taylor-rms"
                :points="rms.points"
              />
            </g>
            <text
              v-for="ray in rays"
              :key="`t${ray.c}`"
              class="taylor-label"
              :x="at(reach * 1.04, ray.angle).x"
              :y="at(reach * 1.04, ray.angle).y"
              :text-anchor="ray.angle > Math.PI / 2 ? 'end' : 'start'"
            >
              {{ ray.c }}
            </text>
            <text
              class="taylor-label"
              :x="at(reach * 0.72, span / 2 + 0.12).x"
              :y="at(reach * 0.72, span / 2 + 0.12).y - 14"
            >
              correlation
            </text>
            <text
              class="taylor-label"
              :x="origin.x + (scale * reach) / 2"
              :y="origin.y + 16"
              text-anchor="middle"
            >
              standard deviation / reference
            </text>
            <circle
              class="taylor-reference"
              :cx="at(1, 0).x"
              :cy="at(1, 0).y"
              r="5"
            />
            <g v-for="mark in marks" :key="mark.w.id">
              <circle :cx="mark.x" :cy="mark.y" r="5" :fill="mark.colour" />
              <text class="taylor-mark" :x="mark.x + 7" :y="mark.labelY">
                {{ mark.w.label }}
              </text>
            </g>
          </svg>
          <figcaption class="compare-muted">
            The reference ({{ reference?.label }}) sits at 1 on the axis; the
            distance to it is the centred RMS difference (arcs).
            <span v-if="unplaced.length" class="compare-warn">
              Not on the diagram:
              {{ unplaced.map((row) => row.w.label).join(", ") }} — correlation
              and σ / σref need both series to vary over their common dates;
              cRMSD and bias are in the table.
            </span>
          </figcaption>
        </figure>

        <div class="compare-tables">
          <table class="compare-stats">
            <thead>
              <tr>
                <th scope="col">Plot</th>
                <th scope="col" title="Correlation">r</th>
                <th scope="col" title="Standard deviation over the reference's">
                  σ / σref
                </th>
                <th scope="col" title="Centred RMS difference">cRMSD</th>
                <th scope="col" title="Mean of the plot minus the reference's">
                  Bias
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in scored" :key="row.w.id">
                <th scope="row">
                  <span
                    class="compare-swatch"
                    :style="{ background: row.colour }"
                  ></span>
                  {{ row.w.label }}
                </th>
                <td>{{ fixed(row.stats!.correlation) }}</td>
                <td>{{ fixed(row.stats!.stdTest / row.stats!.stdRef) }}</td>
                <td>{{ formatValue(row.stats!.crmsd) }}</td>
                <td>{{ formatValue(row.stats!.bias) }}</td>
              </tr>
            </tbody>
          </table>

          <table class="compare-portrait" aria-label="RMS error by season">
            <thead>
              <tr>
                <th scope="col">RMS error</th>
                <th v-for="season in SEASONS" :key="season.name" scope="col">
                  {{ season.name }}
                </th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(row, index) in scored" :key="row.w.id">
                <th scope="row">{{ row.w.label }}</th>
                <td
                  v-for="(error, season) in seasons.errors[index]"
                  :key="season"
                  :style="{
                    background: cellColour(seasons.relative[index][season]),
                  }"
                  :title="
                    Number.isFinite(seasons.relative[index][season])
                      ? `${Math.round(100 * seasons.relative[index][season])} % against the median plot`
                      : 'no dates in this season'
                  "
                >
                  {{ Number.isFinite(error) ? formatValue(error) : "–" }}
                </td>
              </tr>
            </tbody>
          </table>
          <p class="compare-muted">
            Portrait: blue is better, red worse than the median plot in that
            season (relative RMS error).
          </p>
          <button type="button" class="analysis-tool" @click="downloadCsv">
            <i class="fa-solid fa-download mr-1" aria-hidden="true"></i
            >Statistics (CSV)
          </button>
        </div>
      </div>
    </div>
    <div
      v-for="edge in narrow || maximized ? [] : EDGES"
      :key="edge"
      class="compare-resize"
      :class="[`compare-resize-${edge}`]"
      aria-hidden="true"
      @pointerdown="gesture($event, edge)"
    ></div>
  </section>
</template>

<style scoped>
.analysis-compare {
  position: absolute;
  left: 50%;
  top: 48px;
  transform: translateX(-50%);
  width: min(880px, calc(100% - 24px));
  max-height: calc(100% - 72px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  padding: 12px 0 0;
  font-size: 0.8rem;
  color: var(--plot-fg);
}
.compare-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
}
.compare-head h2 {
  margin: 0;
  font-size: 0.95rem;
  font-weight: 600;
}
.compare-coming {
  display: grid;
  gap: 6px;
  margin: 0 0 12px;
  padding: 0;
  list-style: none;
}
.compare-coming li {
  display: grid;
  grid-template-columns: auto minmax(80px, 1fr) auto auto;
  align-items: center;
  gap: 8px;
}
.compare-coming-id {
  font-weight: 600;
}
.compare-coming-bar {
  width: 100%;
  height: 6px;
  accent-color: var(--bulma-link, #485fc7);
}
.compare-coming-state {
  font-size: 0.8rem;
  font-variant-numeric: tabular-nums;
}
.compare-window-buttons {
  display: inline-flex;
  gap: 2px;
}
.compare-close {
  border: none;
  background: none;
  color: var(--plot-muted);
  cursor: pointer;
  width: 28px;
  height: 28px;
  border-radius: 14px;
}
.compare-close:hover,
.compare-close:focus-visible {
  background: var(--plot-hover);
  color: var(--plot-fg);
}
.compare-help,
.compare-muted {
  color: var(--plot-muted);
}
.compare-help {
  margin: 2px 0 8px;
}
.compare-warn {
  color: var(--plot-warn);
}
.compare-empty {
  margin-top: 12px;
}
.compare-plots,
.compare-stats,
.compare-portrait {
  border-collapse: collapse;
  width: 100%;
}
.compare-plots th,
.compare-plots td,
.compare-stats th,
.compare-stats td,
.compare-portrait th,
.compare-portrait td {
  padding: 3px 6px;
  border-bottom: 1px solid var(--plot-border);
  text-align: left;
  font-weight: normal;
  font-variant-numeric: tabular-nums;
}
.compare-plots thead th,
.compare-stats thead th,
.compare-portrait thead th {
  color: var(--plot-muted);
  font-size: 0.72rem;
}
.compare-portrait td {
  text-align: center;
  color: #1f2937;
}
.compare-swatch {
  display: inline-block;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  margin-right: 4px;
  vertical-align: baseline;
}
.compare-figures {
  display: grid;
  grid-template-columns: minmax(280px, 1.1fr) minmax(260px, 1fr);
  gap: 16px;
  margin-top: 12px;
  align-items: start;
}
.compare-views {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
  margin: 8px 0;
}
.compare-views button {
  padding: 4px 10px;
  border: 1px solid var(--plot-border);
  border-radius: 6px;
  background: var(--plot-raised);
  color: var(--plot-fg);
  font: inherit;
  cursor: pointer;
}
.compare-views .active {
  border-color: var(--plot-accent);
  color: var(--plot-accent);
  font-weight: 600;
}
/* The diagram scales with its column, within limits (24 Nov: maximized,
 * its labels grew to 30 px and it ran past the panel; narrow, they
 * shrank): at most 1.3 times its drawn size, at least 0.8 times (the
 * column then scrolls sideways). */
.compare-taylor {
  margin: 0;
  overflow-x: auto;
}
.compare-taylor svg {
  display: block;
  width: 100%;
  min-width: 300px;
  height: auto;
  max-height: 482px;
  font-size: 12px;
}
.compare-tables {
  display: flex;
  flex-direction: column;
  gap: 10px;
  align-items: flex-start;
}
.taylor-grid path,
.taylor-grid line {
  fill: none;
  stroke: var(--plot-grid, rgba(0, 0, 0, 0.12));
  stroke-width: 1;
}
.taylor-grid .taylor-one {
  stroke: var(--plot-muted);
  stroke-dasharray: 4 3;
}
.taylor-rms {
  fill: none;
  stroke: #1b9e77;
  stroke-opacity: 0.35;
  stroke-dasharray: 2 3;
}
.taylor-label {
  fill: var(--plot-muted);
  font-size: 12px;
}
.taylor-mark {
  fill: var(--plot-fg);
  font-size: 13px;
  font-weight: 600;
}
.taylor-reference {
  fill: var(--plot-fg);
}
@media (max-width: 720px) {
  .compare-figures {
    grid-template-columns: 1fr;
  }
}
.compare-head {
  cursor: move;
  touch-action: none;
}
.analysis-compare.narrow .compare-head {
  cursor: default;
  touch-action: auto;
}
/* A narrow map: Compare is a sheet over it. */
.analysis-compare.narrow {
  left: 0;
  top: 0;
  transform: none;
  width: 100%;
  height: 100%;
  max-height: 100%;
  border-radius: 0;
}
.compare-start {
  margin: 10px 0 12px;
  padding: 14px;
  border: 1px dashed var(--plot-border);
  border-radius: 8px;
  text-align: center;
}
.compare-start-title {
  margin: 0 0 4px;
  font-size: 0.9rem;
  font-weight: 600;
}
.compare-start-actions,
.compare-add {
  display: flex;
  flex-wrap: wrap;
  justify-content: center;
  gap: 8px;
  margin-top: 10px;
}
.compare-add {
  justify-content: flex-start;
  align-items: center;
  margin: 6px 0 10px;
}
.compare-resize {
  position: absolute;
  touch-action: none;
  z-index: 2;
}
.compare-resize-e,
.compare-resize-w {
  top: 14px;
  bottom: 14px;
  width: 6px;
  cursor: ew-resize;
}
.compare-resize-e {
  right: 0;
}
.compare-resize-w {
  left: 0;
}
.compare-resize-n,
.compare-resize-s {
  left: 14px;
  right: 14px;
  height: 6px;
  cursor: ns-resize;
}
.compare-resize-n {
  top: 0;
}
.compare-resize-s {
  bottom: 0;
}
.compare-resize-ne,
.compare-resize-nw,
.compare-resize-se,
.compare-resize-sw {
  width: 14px;
  height: 14px;
}
.compare-resize-ne {
  top: 0;
  right: 0;
  cursor: nesw-resize;
}
.compare-resize-nw {
  top: 0;
  left: 0;
  cursor: nwse-resize;
}
.compare-resize-se {
  bottom: 0;
  right: 0;
  cursor: nwse-resize;
}
.compare-resize-sw {
  bottom: 0;
  left: 0;
  cursor: nesw-resize;
}
/* The title stays; the rest scrolls (the edges stay on the frame). */
.compare-head {
  padding: 0 16px;
}
.compare-scroll {
  flex: 1;
  min-height: 0;
  overflow: auto;
  overscroll-behavior: contain;
  padding: 0 16px 16px;
}
.compare-button {
  display: inline-flex;
  align-items: center;
  min-height: 30px;
  padding: 4px 12px;
  border: 1px solid var(--plot-border);
  border-radius: 6px;
  background: var(--plot-raised);
  color: var(--plot-fg);
  font: inherit;
  cursor: pointer;
}
.compare-button:hover {
  border-color: var(--plot-accent);
}
.compare-button.primary {
  border-color: var(--plot-accent);
  background: var(--plot-accent);
  color: var(--plot-bg);
  font-weight: 600;
}
@media (pointer: coarse) {
  .compare-button {
    min-height: 44px;
  }
}
</style>
