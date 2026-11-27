<script lang="ts" setup>
import {
  Chart,
  LinearScale,
  LogarithmicScale,
  LineController,
  LineElement,
  PointElement,
  Filler,
  Interaction,
  ScatterController,
  Tooltip,
  type ChartDataset,
  type Plugin,
  type Scale,
} from "chart.js";
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";

import { dragRange, oneLine } from "./chartZoom.ts";
import { valueTags } from "./distribution.ts";
import { plotColor } from "./figure.ts";
import { boxOf } from "./members.ts";
import { drawAxisMarks } from "./pathMarks.ts";
import {
  finiteSpan,
  grownPrefix,
  nearestSample,
  type TSeriesSpec,
  walkedPoints,
} from "./plotFigure.ts";
import {
  axisRows,
  orderedPoints,
  seriesDateLayout,
  unreadDateSpans,
} from "./seriesDates.ts";
import { tickText } from "./valueTicks.ts";
import {
  drawArrow,
  drawBarb,
  knotsPer,
  largestSpeed,
  thinned,
} from "./windBarbs.ts";

import {
  nearestTimeIndex,
  parseTimeAxis,
  type TTimeAxis,
} from "@/lib/analysis/calendar.ts";
import { timeTicks } from "@/lib/analysis/timeTicks.ts";
import { formatValue } from "@/utils/formatValue.ts";

const props = defineProps<{
  spec: TSeriesSpec;
  /** The map's current time (raw coordinate): a marker that follows it. */
  mapTime?: number;
  /**
   *  The map's row in this series, when known exactly (several samples
   * can share the map's time).
   */
  mapRow?: number;
  /** A distance (m) pointed at on the map's path (a path chart). */
  cursor?: number;
  /** The map's level (index into a profile's levels): a line marks it. */
  mapLevel?: number;
  /** Levels found in a profile (mixed layer, tropopause…): marked lines. */
  marks?: { at: number; label: string }[];
  /**
   * The zoom it had before it was last unmounted (Data, then Chart): taken back
   * when its axis is still the same.
   */
  keptZoom?: { key: string; range?: { min: number; max: number } };
}>();
/** The distance (m) under the pointer on a path chart, or undefined. */
const emit = defineEmits<{
  hoverDistance: [meters: number | undefined];
  /** The stretch zoomed to, with the axis it belongs to (`key`). */
  zoom: [zoom: { key: string; range?: { min: number; max: number } }];
}>();

Chart.register(
  LineController,
  ScatterController,
  LineElement,
  PointElement,
  LinearScale,
  LogarithmicScale,
  Tooltip,
  Filler
);

type TPoint = { x: number; y: number | null; i: number };

/**
 * A distribution's readout follows its bars, the first dataset: the bin
 * nearest the pointer along x, whatever curve or mark lies nearer (24 Nov:
 * over the smoothed curve the pointer showed a point and no label, the
 * curve being what was nearest).
 */
(Interaction.modes as unknown as Record<string, unknown>).bins = (
  target: Chart,
  event: { x: number }
) => {
  const meta = target.getDatasetMeta(0);
  let [best, distance] = [-1, Infinity];
  meta.data.forEach((element, index) => {
    const raw =
      meta.data[index] && (target.data.datasets[0].data[index] as TPoint);
    if (!raw || raw.y === null || !Number.isFinite(raw.y)) {
      return;
    }
    const gap = Math.abs(element.x - event.x);
    if (gap < distance) {
      [best, distance] = [index, gap];
    }
  });
  return best < 0
    ? []
    : [{ element: meta.data[best], datasetIndex: 0, index: best }];
};

const canvas = ref<HTMLCanvasElement>();
let chart: Chart<"line", TPoint[]> | undefined;
let timeAxis: TTimeAxis | undefined;
let tickLabels = new Map<number, string>();
let timeContext = "";

// Successive partial results share their time axis. Hover and map-marker
// redraws reuse its extent, ordering and nearest map time.
const dates = computed(() =>
  props.spec.mode === "time" ? props.spec.x : undefined
);
const dateLayout = computed(() => dates.value && seriesDateLayout(dates.value));
const mapIndex = computed(() =>
  props.mapRow !== undefined
    ? props.mapRow
    : dates.value && props.mapTime !== undefined
      ? nearestTimeIndex(dates.value, props.mapTime)
      : -1
);
/** Whether the index axis (dates, a profile's levels) needs sorting. */
const indexValues = computed(() =>
  props.spec.mode === "profile"
    ? props.spec.y
    : props.spec.mode === "histogram"
      ? undefined
      : props.spec.x
);
const unordered = computed(() =>
  indexValues.value ? !seriesDateLayout(indexValues.value).ascending : false
);

/** The export's pixel width while an export is drawn. */
let exportColumns: number | undefined;
/** The bucket count the shown data was reduced to. */
let reducedTo = 0;

/**
 * Display buckets: about one per drawable pixel column, of the window or
 * of the export being drawn (an 1,800 px export keeps 1,800 columns).
 */
function buckets() {
  // A zoomed chart (and its export) keeps about one point per pixel of
  // the stretch shown: that stretch alone is reduced (orderedPoints).
  return Math.round(
    exportColumns ?? Math.max(200, Math.round(canvas.value?.clientWidth || 800))
  );
}

/** Zoomed to a stretch of the x axis (dragged across); undefined: all. */
const zoom = ref<{ min: number; max: number }>();
/** The drag being made, in pixels across the chart. */
const selecting = ref<{
  from: number;
  to: number;
  top: number;
  bottom: number;
}>();
/** The pointer's readout: one line over the plot, and a crosshair. */
const hover = ref<{
  /** The date (or place) on top, the values on one line under it. */
  head: string;
  text: string;
  at: number;
  /** The pointer's sample on the plot, for the box beside it. */
  x: number;
  y: number;
  horizontal: boolean;
  area: { left: number; right: number; top: number; bottom: number };
}>();
/**
 *  The hover box beside the sample, Zabbix-like: right of it, or left past
 * the middle; kept inside the plot (clear of the barbs above it).
 */
const hoverBox = computed(() => {
  const h = hover.value;
  if (!h) {
    return undefined;
  }
  const width = canvas.value?.clientWidth ?? h.area.right;
  const flip = h.x > (h.area.left + h.area.right) / 2;
  const top = Math.min(Math.max(h.area.top + 4, h.y - 44), h.area.bottom - 58);
  // As wide as the room on its side allows, never past the chart.
  const room = `${Math.max(120, Math.min(340, (flip ? h.x : width - h.x) - 20))}px`;
  return flip
    ? { right: `${width - h.x + 12}px`, top: `${top}px`, maxWidth: room }
    : { left: `${h.x + 12}px`, top: `${top}px`, maxWidth: room };
});

/** Reset zoom in the plot's lower right, clear of the barbs and labels. */
const resetAt = computed(() => {
  void drawTick.value;
  const area = chart?.chartArea;
  const width = canvas.value?.clientWidth;
  return area && width
    ? { right: `${width - area.right + 6}px`, top: `${area.bottom - 28}px` }
    : { right: "6px", bottom: "40px" };
});
/** Charts that zoom along x: series in time, along a path, cycles. */
const zoomable = computed(() =>
  ["time", "path", "cycle"].includes(props.spec.mode)
);

/** The x extent of the whole series, as drawn without zoom. */
const fullRange = computed(() => {
  if (!zoomable.value) {
    return undefined;
  }
  const dates = dateLayout.value;
  if (dates) {
    return dates.min < dates.max
      ? { min: dates.min, max: dates.max }
      : undefined;
  }
  const x = props.spec.x;
  if (!x.length) {
    return undefined;
  }
  let [min, max] = [Infinity, -Infinity];
  for (const v of x) {
    if (Number.isFinite(v)) {
      [min, max] = [Math.min(min, v), Math.max(max, v)];
    }
  }
  return min < max ? { min, max } : undefined;
});

function colors() {
  const el = canvas.value;
  return {
    fg: plotColor(el, "--plot-fg", "#1f2937"),
    muted: plotColor(el, "--plot-muted", "#4b5563"),
    grid: plotColor(el, "--plot-grid", "rgba(0,0,0,0.1)"),
    line: plotColor(el, "--plot-line", "#1d4ed8"),
    warn: plotColor(el, "--plot-warn", "#92400e"),
    unread: plotColor(el, "--plot-unread", "rgba(100,116,139,0.16)"),
    bg: plotColor(el, "--plot-bg", "#ffffff"),
  };
}

/** `y` against `x` in index-axis order, at the drawable width. */
function ordered(x: number[], y: number[], read = y.length): TPoint[] {
  const shown = zoomable.value ? zoom.value : undefined;
  return orderedPoints(x, y, buckets(), read, shown);
}

function points(): TPoint[] {
  const { spec } = props;
  if (spec.mode === "histogram") {
    return spec.x.map((value, at) => ({
      x: value,
      y: Number.isNaN(spec.y[at]) || Number.isNaN(value) ? null : spec.y[at],
      i: at,
    }));
  }
  if (spec.mode === "profile") {
    // Levels in their order on the axis; a missing value on either axis
    // is a gap (a profile's value is x).
    const rows = axisRows(spec.y) ?? Array.from(spec.y, (_, at) => at);
    return rows.map((at) => ({
      x: spec.x[at],
      y:
        Number.isNaN(spec.y[at]) || Number.isNaN(spec.x[at])
          ? null
          : spec.y[at],
      i: at,
    }));
  }
  // A track against latitude as walked: sorting by latitude joined the wrong
  // samples.
  if (spec.mode === "path" && spec.along) {
    return walkedPoints(spec);
  }
  return ordered(spec.x, spec.y, spec.unreadFrom);
}

function coveragePoints(below: boolean): TPoint[] {
  const coverage = props.spec.coverage;
  if (!coverage || (below && coverage.threshold === undefined)) {
    return [];
  }
  const threshold = coverage.threshold;
  const { x } = props.spec;
  // Both are bounded by the drawable width; the exact values stay in Data.
  const read = props.spec.unreadFrom ?? coverage.values.length;
  // Grown with the rows read, not made again for each one.
  const percent = grownPrefix(
    [coverage.values, threshold, below],
    read,
    (at) => {
      const value = coverage.values[at];
      return below && !(threshold !== undefined && value < threshold)
        ? Number.NaN
        : value * 100;
    }
  );
  return ordered(x, percent).filter((point) => !below || point.y !== null);
}

/** Calendar ticks at the instants they name, sized to the chart width. */
function buildTimeTicks(scale: Scale) {
  if (!timeAxis) {
    return;
  }
  const maxTicks = Math.max(2, Math.floor(scale.width / 64));
  const { ticks } = timeTicks(timeAxis, scale.min, scale.max, maxTicks);
  tickLabels = new Map(ticks.map((t) => [t.value, t.label]));
  scale.ticks = ticks.map((t) => ({ value: t.value }));
}

function xTitle() {
  const { spec } = props;
  if (spec.mode !== "time") {
    return spec.xTitle;
  }
  return timeAxis
    ? `${spec.xTitle}${timeContext ? `, ${timeContext}` : ""}`
    : spec.xTitle;
}

/** The coverage strip's label and the dashed display threshold. */
function drawCoverageGuides(target: Chart) {
  const { spec } = props;
  const area = target.chartArea;
  const context = target.ctx;
  const c = colors();
  const threshold = spec.coverage?.threshold;
  const coverageScale = target.scales.coverage;
  if (coverageScale) {
    // The strip is labelled inside, so the two left axes keep one title.
    context.save();
    context.fillStyle = c.muted;
    context.font = "10px sans-serif";
    // At the right end: the map's tag rides near the left (its date).
    context.textAlign = "right";
    context.fillText(
      props.spec.coverage?.sites ? "Valid sites 0–100 %" : "Valid area 0–100 %",
      area.right - 4,
      coverageScale.bottom - 3
    );
    context.restore();
  }
  if (threshold !== undefined && coverageScale) {
    const y = coverageScale.getPixelForValue(threshold * 100);
    context.save();
    context.strokeStyle = c.warn;
    context.setLineDash([4, 3]);
    context.beginPath();
    context.moveTo(area.left, y);
    context.lineTo(area.right, y);
    context.stroke();
    context.fillStyle = c.warn;
    context.font = "10px sans-serif";
    context.textAlign = "right";
    context.fillText(
      `threshold ${Math.round(threshold * 100)} %`,
      area.right - 4,
      y - 3
    );
    context.restore();
  }
}

/** Unread interval shading, the coverage threshold and gap labels. */
/** Bumped once the chart has drawn: overlays placed from its scales follow. */
const drawTick = ref(0);
const overlay: Plugin<"line"> = {
  id: "gridlookOverlay",
  afterRender() {
    drawTick.value++;
  },
  beforeDatasetsDraw(target) {
    const area = target.chartArea;
    const context = target.ctx;
    const c = colors();
    const scale = target.scales.x;
    const spans = unreadSpans(
      (scale.max - scale.min) / Math.max(1, 2 * area.width)
    );
    let labelled = false;
    for (const [from, to] of spans) {
      const a = target.scales.x.getPixelForValue(from);
      const b = target.scales.x.getPixelForValue(to);
      const left = Math.max(area.left, Math.min(a, b));
      const right = Math.min(area.right, Math.max(a, b));
      if (left < right) {
        context.save();
        context.fillStyle = c.unread;
        context.fillRect(left, area.top, right - left, area.bottom - area.top);
        if (!labelled && right - left > 46) {
          context.fillStyle = c.muted;
          context.font = "11px sans-serif";
          // At the region's right end: the map's tag rides at its left.
          context.textAlign = "right";
          context.fillText("Not read", right - 4, area.top + 12);
          labelled = true;
        }
        context.restore();
      }
    }
    drawCoverageGuides(target);
    drawTails(target);
  },
  afterDatasetsDraw(target) {
    labelGaps(target);
    drawMapTime(target);
    drawPathMarks(target);
    drawWind(target);
    drawMemberMeans(target);
    drawDistributionMarks(target);
    drawBoxes(target);
    drawFitLegend(target);
  },
};

/**
 * The trend's value as a small legend at the top right of the values'
 * panel: a dashed swatch in the fit's colour and "Fit +3.7 K per decade".
 * (The Trend button keeps its short label, so the toolbar does not grow.)
 */
/** Where the fit legend sits (left, right, bottom), if there is one. */
function fitLegendBox(target: Chart) {
  const fit = props.spec.fit;
  if (!fit?.label) {
    return undefined;
  }
  const area = target.chartArea;
  const top = (target.scales.coverage ? target.scales.y.top : area.top) + 4;
  const context = target.ctx;
  context.save();
  context.font = "600 10px sans-serif";
  const width = context.measureText(`Fit ${fit.label}`).width;
  context.restore();
  const x = area.right - width - 30;
  return { x, left: x - 4, right: area.right + 2, top, bottom: top + 15 };
}

function drawFitLegend(target: Chart) {
  const box = fitLegendBox(target);
  if (!box) {
    return;
  }
  const context = target.ctx;
  const c = colors();
  const { x, top } = box;
  const text = `Fit ${props.spec.fit!.label}`;
  context.save();
  context.font = "600 10px sans-serif";
  const width = context.measureText(text).width;
  context.fillStyle = c.bg;
  context.globalAlpha = 0.85;
  context.fillRect(x - 4, top, width + 32, 15);
  context.globalAlpha = 1;
  context.strokeStyle = c.warn;
  context.lineWidth = 1.5;
  context.setLineDash([5, 3]);
  context.beginPath();
  context.moveTo(x, top + 7.5);
  context.lineTo(x + 20, top + 7.5);
  context.stroke();
  context.setLineDash([]);
  context.fillStyle = c.fg;
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(text, x + 25, top + 8);
  context.restore();
}

/**
 * Boxes by month: whiskers to the extremes, a box over the middle half,
 * the median across it.
 */
function drawBoxes(target: Chart) {
  const { spec } = props;
  if (!spec.boxes) {
    return;
  }
  const context = target.ctx;
  const c = colors();
  const x = (value: number) => target.scales.x.getPixelForValue(value);
  const y = (value: number) => target.scales.y.getPixelForValue(value);
  const half = Math.min(14, Math.abs(x(2) - x(1)) * 0.3);
  context.save();
  spec.boxes.forEach((box, at) => {
    if (!box) {
      return;
    }
    const px = x(spec.x[at]);
    context.strokeStyle = c.line;
    context.lineWidth = 1;
    context.beginPath();
    context.moveTo(px, y(box.low));
    context.lineTo(px, y(box.q1));
    context.moveTo(px, y(box.q3));
    context.lineTo(px, y(box.high));
    context.moveTo(px - half / 2, y(box.low));
    context.lineTo(px + half / 2, y(box.low));
    context.moveTo(px - half / 2, y(box.high));
    context.lineTo(px + half / 2, y(box.high));
    context.stroke();
    context.fillStyle = `${c.line}33`;
    context.fillRect(px - half, y(box.q3), 2 * half, y(box.q1) - y(box.q3));
    context.strokeRect(px - half, y(box.q3), 2 * half, y(box.q1) - y(box.q3));
    context.strokeStyle = c.fg;
    context.lineWidth = 2;
    context.beginPath();
    context.moveTo(px - half, y(box.median));
    context.lineTo(px + half, y(box.median));
    context.stroke();
  });
  context.restore();
}

/** Room above a distribution's bars for its 95 % bracket and labels. */
const DISTRIBUTION_ROOM = 36;

/**
 * Over a distribution: a bracket above the bars spanning the chosen
 * central range of the valid area (dotted lines down to the axis at its
 * ends), the median as a solid line and the mean dashed.
 */
// eslint-disable-next-line max-lines-per-function
function drawDistributionMarks(target: Chart) {
  const marks = props.spec.distribution;
  if (!marks) {
    return;
  }
  const context = target.ctx;
  const area = target.chartArea;
  const c = colors();
  const x = (value: number) =>
    Math.min(
      area.right,
      Math.max(area.left, target.scales.x.getPixelForValue(value))
    );
  const top = area.top - DISTRIBUTION_ROOM + 15;
  context.save();
  context.strokeStyle = c.fg;
  context.fillStyle = c.fg;
  drawRangeBracket(
    context,
    [x(marks.range.low), x(marks.range.high)],
    top,
    area.bottom,
    `${marks.range.percent} % of area`
  );
  // The lower of the two is labelled to the left of its line, the higher
  // to the right, so the tags never cover each other; one tag when the
  // two coincide.
  const marker = {
    x,
    from: top + 8,
    to: area.bottom,
    bg: c.bg,
  };
  for (const tag of valueTags(marks, x)) {
    if (tag.style === "both") {
      // The mean's amber dash over the median's dark line.
      drawValueLine(context, marker, {
        value: tag.value,
        label: tag.label,
        colour: c.fg,
        dash: [],
        left: tag.left,
      });
      context.strokeStyle = c.warn;
      context.lineWidth = 2;
      context.setLineDash([6, 3]);
      context.beginPath();
      context.moveTo(x(marks.mean), marker.from + 14);
      context.lineTo(x(marks.mean), marker.to);
      context.stroke();
      context.setLineDash([]);
      continue;
    }
    drawValueLine(context, marker, {
      value: tag.value,
      label: tag.label,
      colour: tag.style === "median" ? c.fg : c.warn,
      dash: tag.style === "median" ? [] : [6, 3],
      left: tag.left,
    });
  }
  const scale = target.scales.x;
  if (
    marks.above &&
    marks.above.value >= scale.min &&
    marks.above.value <= scale.max
  ) {
    // Below the median and mean tags, on the side with more room.
    const right = x(marks.above.value) < (area.left + area.right) / 2;
    drawValueLine(
      context,
      { ...marker, from: marker.from + 20 },
      {
        value: marks.above.value,
        label: `≈ ${formatValue(Math.round(marks.above.share * 1000) / 10)} % above`,
        colour: c.line,
        dash: [2, 2],
        left: !right,
      }
    );
  }
  context.restore();
}

/**
 * A value's vertical line (2 px, its own colour and dash) with a tag at
 * its top: the name and value on the background, beside the line.
 */
function drawValueLine(
  context: CanvasRenderingContext2D,
  at: { x: (value: number) => number; from: number; to: number; bg: string },
  line: {
    value: number;
    label: string;
    colour: string;
    dash: number[];
    left: boolean;
  }
) {
  const px = at.x(line.value);
  context.strokeStyle = line.colour;
  context.lineWidth = 2;
  context.setLineDash(line.dash);
  context.beginPath();
  context.moveTo(px, at.from);
  context.lineTo(px, at.to);
  context.stroke();
  context.setLineDash([]);
  context.font = "600 10px sans-serif";
  const width = context.measureText(line.label).width + 8;
  // On its side of the line, or the other when that side has no room; never
  // past the figure (24 Nov: "median 290" ran off a narrow chart).
  const right = context.canvas.clientWidth || context.canvas.width;
  const before = px - 3 - width;
  const after = px + 3;
  const preferred = line.left ? before : after;
  const other = line.left ? after : before;
  const fits = (x: number) => x >= 1 && x + width <= right - 1;
  const x = fits(preferred)
    ? preferred
    : fits(other)
      ? other
      : Math.max(1, Math.min(preferred, right - width - 1));
  context.fillStyle = at.bg;
  context.globalAlpha = 0.9;
  context.fillRect(x, at.from, width, 14);
  context.globalAlpha = 1;
  context.strokeStyle = line.colour;
  context.lineWidth = 1;
  context.strokeRect(x, at.from, width, 14);
  context.fillStyle = line.colour;
  context.textAlign = "left";
  context.textBaseline = "middle";
  context.fillText(line.label, x + 4, at.from + 7.5);
}

/** The central range: a bracket above the bars, dotted down to the axis. */

function drawRangeBracket(
  context: CanvasRenderingContext2D,
  [low, high]: number[],
  top: number,
  bottom: number,
  label: string
) {
  context.lineWidth = 1;
  context.setLineDash([2, 3]);
  for (const edge of [low, high]) {
    context.beginPath();
    context.moveTo(edge, top);
    context.lineTo(edge, bottom);
    context.stroke();
  }
  context.setLineDash([]);
  context.beginPath();
  context.moveTo(low, top);
  context.lineTo(high, top);
  context.moveTo(low, top - 4);
  context.lineTo(low, top + 4);
  context.moveTo(high, top - 4);
  context.lineTo(high, top + 4);
  context.stroke();
  context.font = "10px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "bottom";
  context.fillText(label, (low + high) / 2, top - 2);
}

/**
 * The tails outside the central range, lightly shaded under the bars and
 * labelled with their share each ("2.5 %"), where there is room.
 */
function drawTails(target: Chart) {
  const marks = props.spec.distribution;
  if (!marks) {
    return;
  }
  const context = target.ctx;
  const area = target.chartArea;
  const c = colors();
  const at = (value: number) =>
    Math.min(
      area.right,
      Math.max(area.left, target.scales.x.getPixelForValue(value))
    );
  context.save();
  context.font = "10px sans-serif";
  context.textBaseline = "top";
  context.textAlign = "center";
  // Each tail labelled with the area actually outside the range.
  for (const [from, to, tail] of [
    [area.left, at(marks.range.low), marks.range.below],
    [at(marks.range.high), area.right, marks.range.above],
  ]) {
    const share = `${formatValue(tail)} %`;
    if (to - from < 1) {
      continue;
    }
    context.fillStyle = c.unread;
    context.fillRect(from, area.top, to - from, area.bottom - area.top);
    if (to - from > 30) {
      context.fillStyle = c.muted;
      context.fillText(share, (from + to) / 2, area.top + 4);
    }
  }
  context.restore();
}

/** Room for the members' period means beside a series. */
const MEMBER_ROOM = 46;

/**
 * Beside an ensemble series: each member's mean over the period as a dot
 * (the plotted member's filled), a box from the lower to the upper
 * quartile with the median, and whiskers to the extremes.
 */
// eslint-disable-next-line max-lines-per-function
function drawMemberMeans(target: Chart) {
  const members = props.spec.members;
  if (!members || props.spec.mode !== "time") {
    return;
  }
  const box = boxOf(members.means);
  if (!box.count) {
    if (members.withheld) {
      // Said where the box would be: overlapping cells, or none of a length,
      // give no period mean.
      const context = target.ctx;
      const x = target.chartArea.right + MEMBER_ROOM / 2 + 2;
      context.save();
      context.fillStyle = colors().muted;
      context.font = "10px sans-serif";
      context.textAlign = "center";
      context.textBaseline = "top";
      context.fillText("no period", x + 4, target.chartArea.bottom + 4);
      context.fillText("mean", x + 4, target.chartArea.bottom + 15);
      context.restore();
    }
    return;
  }
  const context = target.ctx;
  const area = target.chartArea;
  const y = (value: number) => target.scales.y.getPixelForValue(value);
  const c = colors();
  const x = area.right + MEMBER_ROOM / 2 + 2;
  context.save();
  context.strokeStyle = c.fg;
  context.lineWidth = 1;
  context.beginPath();
  context.moveTo(x, y(box.min));
  context.lineTo(x, y(box.max));
  context.stroke();
  context.fillStyle = `${c.line}26`;
  context.fillRect(x - 7, y(box.q3), 14, y(box.q1) - y(box.q3));
  context.strokeRect(x - 7, y(box.q3), 14, y(box.q1) - y(box.q3));
  context.lineWidth = 2;
  context.beginPath();
  context.moveTo(x - 7, y(box.median));
  context.lineTo(x + 7, y(box.median));
  context.stroke();
  drawMemberDots(context, members, x, y, c.line);
  context.fillStyle = c.muted;
  context.font = "10px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "top";
  // Means over the steps of known length only, when some had none.
  context.fillText(
    members.sample ? "sample" : members.leftOut ? "known-length" : "period",
    x + 4,
    area.bottom + 4
  );
  context.fillText("means", x + 4, area.bottom + 15);
  context.restore();
}

/** One dot per member beside the box (the plotted member's filled). */
function drawMemberDots(
  context: CanvasRenderingContext2D,
  members: TMembers,
  x: number,
  y: (value: number) => number,
  line: string
) {
  members.means.forEach((mean, member) => {
    if (!Number.isFinite(mean)) {
      return;
    }
    // Spread a little sideways, so equal means stay visible.
    const dx = 11 + ((member * 5) % 9);
    const chosen = member === members.chosen;
    context.beginPath();
    context.arc(x + dx, y(mean), chosen ? 3 : 2.2, 0, 2 * Math.PI);
    context.fillStyle = chosen ? line : `${line}99`;
    context.fill();
  });
}

/**
 * Which barbs stand where: kept until the data, the size or the scale
 * changes (a moving map-time marker redraws without sorting 200,000
 * positions again).
 */
function placeBarbs(
  wind: { u: number[]; v: number[] },
  coordinates: number[],
  along: { min: number; max: number; getPixelForValue: (v: number) => number },
  [low, high]: [number, number],
  profile: boolean
) {
  const key = `${profile}|${low}|${high}|${along.min}|${along.max}`;
  const known = barbCache.get(wind);
  if (known?.key === key && known.coordinates === coordinates) {
    return known;
  }
  const positions = coordinates.map((value, at) => {
    const p = along.getPixelForValue(value);
    return Number.isFinite(wind.u[at]) &&
      Number.isFinite(wind.v[at]) &&
      p >= low &&
      p <= high
      ? p
      : Number.NaN;
  });
  const placed = {
    key,
    coordinates,
    picks: thinned(positions, profile ? 22 : 26).map((at) => ({
      at,
      position: positions[at],
    })),
  };
  barbCache.set(wind, placed);
  return placed;
}

/** The barbs placed for a wind, at one size and scale. */
const barbCache = new WeakMap<
  object,
  {
    key: string;
    coordinates: number[];
    picks: { at: number; position: number }[];
  }
>();

/** Room for the barbs: a strip above a series, a column beside a profile. */
const WIND_ROOM = 36;

/**
 * Wind barbs at real samples, thinned so they do not touch: in a strip
 * above a time series, or a column right of a profile, labelled in knots.
 */
function drawWind(target: Chart) {
  const { spec } = props;
  const wind = spec.wind;
  if (!wind || spec.mode === "histogram") {
    return;
  }
  const area = target.chartArea;
  const context = target.ctx;
  const { factor } = knotsPer(wind.units);
  const profile = spec.mode === "profile";
  const along = profile ? target.scales.y : target.scales.x;
  const coordinates = profile ? spec.y : spec.x;
  const [low, high] = profile
    ? [area.top, area.bottom]
    : [area.left, area.right];
  const placed = placeBarbs(wind, coordinates, along, [low, high], profile);
  const color = colors().fg;
  const station = profile
    ? area.right + WIND_ROOM / 2 + 4
    : area.top - WIND_ROOM / 2;
  // Currents as arrows scaled to the fastest drawn, its picks only.
  const most = wind.current
    ? largestSpeed(
        wind.u,
        wind.v,
        placed.picks.map((pick) => pick.at)
      )
    : 0;
  for (const { at, position } of placed.picks) {
    const [x, y] = profile ? [station, position] : [position, station];
    if (wind.current) {
      drawArrow(context, x, y, wind.u[at], wind.v[at], most, {
        length: 15,
        color,
      });
    } else {
      drawBarb(context, x, y, wind.u[at] * factor, wind.v[at] * factor, {
        length: 15,
        color,
        flip: wind.flip,
      });
    }
  }
  // Arrows are as long as the fastest current shown (its speed: hover).
  labelWind(
    target,
    profile,
    station,
    wind.current ? "current" : profile ? "kn" : "wind (kn)"
  );
}

/** "kn" under the column, or "wind (kn)" left of the strip. */
function labelWind(
  target: Chart,
  profile: boolean,
  station: number,
  text: string
) {
  const context = target.ctx;
  const area = target.chartArea;
  context.save();
  context.fillStyle = colors().muted;
  context.font = "10px sans-serif";
  context.textBaseline = "middle";
  context.textAlign = profile ? "center" : "right";
  context.fillText(
    text,
    profile ? station : area.left - 6,
    profile ? area.bottom + 14 : station
  );
  context.restore();
}

/**
 * The map's current time on a time series: a dashed line, and a point on
 * the curve at the nearest time step, moving with the map's time slider.
 */
function drawMapTime(target: Chart) {
  const { spec, mapTime } = props;
  if (spec.mode !== "time" || mapTime === undefined || !spec.x.length) {
    return;
  }
  const layout = dateLayout.value!;
  if (mapTime < layout.min || mapTime > layout.max) {
    return;
  }
  const area = target.chartArea;
  const x = target.scales.x.getPixelForValue(mapTime);
  const context = target.ctx;
  const accent = plotColor(canvas.value, "--plot-accent", "#1d4ed8");
  context.save();
  context.strokeStyle = accent;
  context.setLineDash([5, 3]);
  context.beginPath();
  context.moveTo(x, area.top);
  context.lineTo(x, area.bottom);
  context.stroke();
  context.setLineDash([]);
  const at = mapIndex.value;
  const value = spec.y[at];
  if (Number.isFinite(value)) {
    const y = target.scales.y.getPixelForValue(value);
    context.fillStyle = accent;
    context.strokeStyle = plotColor(canvas.value, "--plot-bg", "#ffffff");
    context.lineWidth = 2;
    context.beginPath();
    context.arc(x, y, 5, 0, 2 * Math.PI);
    context.fill();
    context.stroke();
  }
  context.fillStyle = accent;
  context.font = "600 10px sans-serif";
  // The value at the map's time rides with the marker.
  const label = Number.isFinite(value)
    ? `map: ${formatValue(value)}${spec.units ? ` ${spec.units}` : ""}`
    : at >= (spec.unreadFrom ?? spec.x.length)
      ? "map: not read"
      : "map: no value";
  drawMapLabel(target, label, x);
  context.restore();
}

/**
 * The map's tag beside its line, on a light backing: under an area
 * series' coverage strip, and below the fit legend when they would meet.
 */
function drawMapLabel(target: Chart, label: string, x: number) {
  const context = target.ctx;
  const area = target.chartArea;
  const accent = plotColor(canvas.value, "--plot-accent", "#1d4ed8");
  const width = context.measureText(label).width;
  const top = target.scales.coverage ? target.scales.y.top : area.top;
  const left = x + 4 + width > area.right ? x - 4 - width : x + 4;
  const fit = fitLegendBox(target);
  const meets = fit && left < fit.right && left + width > fit.left;
  const baseline = meets ? fit.bottom + 12 : top + 10;
  context.fillStyle = plotColor(canvas.value, "--plot-bg", "#ffffff");
  context.globalAlpha = 0.85;
  context.fillRect(left - 2, baseline - 9, width + 4, 12);
  context.globalAlpha = 1;
  context.fillStyle = accent;
  context.fillText(label, left, baseline);
}

/** Numbered path points on the distance axis, as on the map. */
function drawPathMarks(target: Chart) {
  const marks = props.spec.mode === "path" ? props.spec.marks : undefined;
  if (!marks?.length) {
    return;
  }
  const area = target.chartArea;
  const c = colors();
  drawAxisMarks(
    target.ctx,
    marks,
    (value) => target.scales.x.getPixelForValue(value),
    area.bottom,
    {
      fill: plotColor(canvas.value, "--plot-bg", "#ffffff"),
      text: c.fg,
      ring: c.line,
    },
    [area.left, area.right]
  );
}

/** The map's level across a profile, moving as the level plays. */
const levelAt = computed(() => {
  void drawTick.value;
  const target = chart;
  const k = props.mapLevel;
  const y = k === undefined ? undefined : props.spec.y[k];
  if (y === undefined || props.spec.mode !== "profile" || !target) {
    return undefined;
  }
  const at = target.scales.y.getPixelForValue(y);
  const area = target.chartArea;
  return at >= area.top && at <= area.bottom
    ? {
        top: `${at}px`,
        left: `${area.left}px`,
        width: `${area.right - area.left}px`,
      }
    : undefined;
});

/** A profile's found levels, as labelled lines across the chart. */
const marksAt = computed(() => {
  void drawTick.value;
  const target = chart;
  if (!props.marks?.length || props.spec.mode !== "profile" || !target) {
    return [];
  }
  const area = target.chartArea;
  // Close levels take turns at the left and right, so labels never sit on
  // one another.
  let side = 0;
  let last = -Infinity;
  return [...props.marks]
    .sort((a, b) => a.at - b.at)
    .flatMap((mark) => {
      const at = target.scales.y.getPixelForValue(mark.at);
      side = Math.abs(at - last) < 16 ? 1 - side : 0;
      last = at;
      return at >= area.top && at <= area.bottom
        ? [
            {
              label: mark.label,
              right: side === 1,
              style: {
                top: `${at}px`,
                left: `${area.left}px`,
                width: `${area.right - area.left}px`,
              },
            },
          ]
        : [];
    });
});

/** The map's pointer along the path, as a line over the chart's area. */
const cursorAt = computed(() => {
  void drawTick.value;
  const target = chart;
  if (props.cursor === undefined || props.spec.mode !== "path" || !target) {
    return undefined;
  }
  // Against latitude: at the sample nearest the map's distance.
  const along = props.spec.along;
  const at = along ? nearestSample(along, props.cursor) : -1;
  const x = target.scales.x.getPixelForValue(
    along ? (at >= 0 ? props.spec.x[at] : Number.NaN) : props.cursor / 1000
  );
  const area = target.chartArea;
  return x >= area.left && x <= area.right
    ? {
        left: `${x}px`,
        top: `${area.top}px`,
        height: `${area.bottom - area.top}px`,
      }
    : undefined;
});

/** Report the path distance under the pointer (km on the axis → m). */
function hoverPath(
  event: { x: number | null; y?: number | null },
  target: Chart
) {
  if (props.spec.mode !== "path" || event.x === null) {
    return;
  }
  const area = target.chartArea;
  if (event.x < area.left || event.x > area.right) {
    emit("hoverDistance", undefined);
    return;
  }
  // Against latitude, the nearest sample on screen gives its distance: degrees
  // are no kilometres, and a latitude can repeat on a turning track.
  const along = props.spec.along;
  if (along) {
    // Its points are the samples in order (points): the k-th is sample k.
    const meta = target.getDatasetMeta(0);
    let [best, nearest] = [Infinity, -1];
    meta.data.forEach((element, k) => {
      const d = Math.hypot(element.x - event.x!, element.y - (event.y ?? 0));
      if (Number.isFinite(d) && d < best) {
        [best, nearest] = [d, k];
      }
    });
    emit("hoverDistance", nearest >= 0 ? along[nearest] : undefined);
    return;
  }
  emit("hoverDistance", target.scales.x.getValueForPixel(event.x)! * 1000);
}

/** Why a run of samples has no line: hidden by the threshold or missing. */
function gapReason(from: number, to: number, rows?: number[]) {
  const coverage = props.spec.coverage;
  const status = props.spec.status;
  if (status) {
    let outside = true;
    for (let at = from; at <= to; at++) {
      outside &&= status[rows?.[at] ?? at] === "no stored cell";
    }
    return outside ? "No stored cell" : "Missing value";
  }
  if (!coverage) {
    // Nothing at all: say where, not just "no data".
    return from === 0 && to >= props.spec.y.length - 1
      ? "Every date is missing at this point"
      : "No data";
  }
  let hidden = true;
  for (let at = from; at <= to; at++) {
    hidden &&= coverage.values[rows?.[at] ?? at] > 0;
  }
  return hidden && coverage.threshold !== undefined
    ? "Below threshold"
    : "No valid value";
}

let lastUnread:
  | {
      dates: number[];
      from: number;
      minimumWidth: number;
      spans: [number, number][];
    }
  | undefined;

function unreadSpans(minimumWidth: number) {
  const axis = dates.value;
  const layout = dateLayout.value;
  const from = props.spec.unreadFrom;
  if (!axis || !layout || from === undefined) {
    return [];
  }
  if (
    lastUnread?.dates === axis &&
    lastUnread.from === from &&
    lastUnread.minimumWidth === minimumWidth
  ) {
    return lastUnread.spans;
  }
  const spans = unreadDateSpans(axis, layout, from, minimumWidth);
  lastUnread = { dates: axis, from, minimumWidth, spans };
  return spans;
}

/** Name wide gaps in the read part where they occur. */
type TGapLabel = { position: number; text: string };
let lastGaps:
  { spec: TSeriesSpec; scale: number; labels: TGapLabel[] } | undefined;

function wideGaps(target: Chart, pixelScale: number) {
  const { spec } = props;
  const labels: TGapLabel[] = [];
  const limit = spec.unreadFrom ?? spec.y.length;
  // The display reducer always emits a null for a gap. A complete read
  // prefix with no gaps needs no further scan on this redraw.
  const data = target.data.datasets[0]?.data as TPoint[] | undefined;
  if (!data?.some((point) => point.y === null)) {
    return labels;
  }
  const rows = axisRows(spec.x, limit);
  const row = (at: number) => rows?.[at] ?? at;
  const count = rows?.length ?? limit;
  for (let at = 0; at < count && labels.length < 4; at++) {
    if (!Number.isNaN(spec.y[row(at)])) {
      continue;
    }
    let end = at;
    while (end + 1 < count && Number.isNaN(spec.y[row(end + 1)])) {
      end++;
    }
    const left = spec.x[row(Math.max(0, at - 1))];
    const right = spec.x[row(Math.min(count - 1, end + 1))];
    if (Math.abs(right - left) * pixelScale > 56) {
      labels.push({
        position: (left + right) / 2,
        text: gapReason(at, end, rows),
      });
    }
    at = end;
  }
  return labels;
}

function labelGaps(target: Chart) {
  const { spec } = props;
  if (spec.mode === "profile") {
    return;
  }
  const scale = target.scales.x;
  const pixelScale = scale.width / (scale.max - scale.min);
  if (lastGaps?.spec !== spec || lastGaps.scale !== pixelScale) {
    lastGaps = {
      spec,
      scale: pixelScale,
      labels: wideGaps(target, pixelScale),
    };
  }
  const context = target.ctx;
  const yScale = target.scales.y;
  context.save();
  context.fillStyle = colors().muted;
  context.font = "11px sans-serif";
  context.textAlign = "center";
  for (const { text, position } of lastGaps.labels) {
    context.fillText(
      text,
      scale.getPixelForValue(position),
      (yScale.top + yScale.bottom) / 2
    );
  }
  context.restore();
}

/**
 * Markers when samples are few; with many, only for a finite value between
 * two gaps, which draws no line segment and would otherwise vanish.
 */
function pointRadius(data: TPoint[]) {
  if (props.spec.mode === "histogram") {
    return 0;
  }
  if (data.length <= 60) {
    return 2.5;
  }
  // A profile's observed value is on x, a series' on y: both must be set.
  const valid = (at: number) =>
    data[at] !== undefined &&
    data[at].y !== null &&
    Number.isFinite(data[at].x) &&
    Number.isFinite(data[at].y as number);
  const isolated = (at: number) =>
    valid(at) &&
    (at === 0 || !valid(at - 1)) &&
    (at === data.length - 1 || !valid(at + 1));
  return (ctx: { dataIndex: number }) => (isolated(ctx.dataIndex) ? 2 : 0);
}

/**
 * An area mean's band, drawn under the line (higher order first): the
 * lower edge, then the upper edge filled down to it.
 */
function bandDatasets(line: string): ChartDataset<"line", TPoint[]>[] {
  const { spec } = props;
  if (!spec.band) {
    return [];
  }
  const edge = {
    borderColor: `${line}66`,
    borderWidth: 0.75,
    pointRadius: 0,
    pointHitRadius: 0,
    spanGaps: false,
    yAxisID: "y",
    order: 1,
  };
  return [
    {
      ...edge,
      label: `${spec.band.label} (lower)`,
      data: ordered(spec.x, spec.band.lower, spec.unreadFrom),
      fill: false,
    },
    {
      ...edge,
      label: `${spec.band.label} (upper)`,
      data: ordered(spec.x, spec.band.upper, spec.unreadFrom),
      fill: "-1",
      backgroundColor: `${line}2e`,
    },
  ];
}

// eslint-disable-next-line max-lines-per-function
function datasets(): ChartDataset<"line", TPoint[]>[] {
  const { spec } = props;
  const c = colors();
  const data = points();
  const list: ChartDataset<"line", TPoint[]>[] = [
    {
      label: spec.yTitle,
      data,
      borderColor: c.line,
      backgroundColor: c.line,
      borderWidth: 1.5,
      pointRadius: spec.boxes ? 0 : spec.markers ? 3 : pointRadius(data),
      pointHitRadius: spec.boxes ? 14 : 6,
      spanGaps: false,
      yAxisID: "y",
      // Boxes are drawn on their own: no line joins their medians.
      ...(spec.boxes ? { showLine: false } : {}),
      // Settings → Display: bars from zero (one per sample, edge to edge),
      // or points without a line.
      ...(spec.style === "bars"
        ? {
            stepped: "middle" as const,
            fill: "origin",
            backgroundColor: `${c.line}66`,
            borderWidth: 1,
            pointRadius: 0,
          }
        : spec.style === "points"
          ? {
              showLine: false,
              pointRadius: data.length > 2000 ? 1.2 : 2.5,
            }
          : {}),
      ...(spec.mode === "histogram"
        ? {
            fill: "origin",
            backgroundColor: `${c.line}55`,
          }
        : {}),
    },
  ];
  if (spec.coverage) {
    list.push(
      {
        label: spec.coverage.sites ? "Valid sites (%)" : "Valid area (%)",
        data: coveragePoints(false),
        borderColor: c.muted,
        backgroundColor: c.muted,
        borderWidth: 1,
        pointRadius: spec.y.length > 60 ? 0 : 1.5,
        spanGaps: false,
        yAxisID: "coverage",
      },
      {
        label: "Below threshold",
        type: "scatter" as never,
        data: coveragePoints(true),
        borderColor: c.warn,
        backgroundColor: c.warn,
        pointStyle: "triangle",
        pointRadius: 3.5,
        showLine: false,
        yAxisID: "coverage",
      }
    );
  }
  return [
    ...list,
    ...bandDatasets(c.line),
    ...memberDatasets(c),
    ...fitDatasets(c),
    ...curveDatasets(c),
    ...extraDatasets(c),
  ];
}

/** A running mean over the series, and points such as yearly maxima. */
function extraDatasets(
  c: ReturnType<typeof colors>
): ChartDataset<"line", TPoint[]>[] {
  const { spec } = props;
  const list: ChartDataset<"line", TPoint[]>[] = [];
  if (spec.overlay) {
    list.push({
      label: `fit ${spec.overlay.label}`,
      data: ordered(spec.x, spec.overlay.values, spec.unreadFrom),
      borderColor: c.warn,
      borderWidth: 2,
      pointRadius: 0,
      pointHitRadius: 0,
      yAxisID: "y",
      order: 0,
    });
  }
  if (spec.points) {
    list.push({
      label: `fit ${spec.points.label}`,
      data: spec.points.x.map((x, at) => ({
        x,
        y: spec.points!.y[at],
        i: 0,
      })),
      borderColor: c.fg,
      backgroundColor: c.fg,
      showLine: false,
      pointRadius: 3,
      pointHitRadius: 0,
      yAxisID: "y",
      order: 0,
    });
  }
  return list;
}

/** A distribution's curves over its bars: smoothed solid, normal dashed. */
function curveDatasets(
  c: ReturnType<typeof colors>
): ChartDataset<"line", TPoint[]>[] {
  const marks = props.spec.distribution;
  if (!marks) {
    return [];
  }
  return marks.curves.map((curve) => ({
    label: curve.label,
    data: curve.x.map((x, at) => ({ x, y: curve.y[at], i: 0 })),
    // The normal curve grey: amber is the mean's.
    borderColor: curve.dashed ? c.muted : c.fg,
    borderWidth: curve.dashed ? 1.25 : 1.75,
    borderDash: curve.dashed ? [6, 4] : [],
    pointRadius: 0,
    pointHitRadius: 0,
    tension: 0,
    yAxisID: "y",
    order: 0,
  }));
}

/** A fitted line (a trend), dashed, read out with the series. */
function fitDatasets(
  c: ReturnType<typeof colors>
): ChartDataset<"line", TPoint[]>[] {
  const { spec } = props;
  if (!spec.fit) {
    return [];
  }
  return [
    {
      label: `fit ${spec.fit.label}`,
      data: ordered(spec.x, spec.fit.values, spec.unreadFrom),
      borderColor: c.warn,
      borderWidth: 1.5,
      borderDash: [7, 4],
      pointRadius: 0,
      pointHitRadius: 0,
      yAxisID: "y",
      order: 0,
    },
  ];
}

/** On a log axis, only 1, 2 and 5 of each decade are labelled. */
function logTick(value: number) {
  const lead = value / 10 ** Math.floor(Math.log10(value));
  return [1, 2, 5].some((d) => Math.abs(lead - d) < 1e-6);
}

/** Points drawn beside the series (yearly maxima) widen the x axis. */
function extraX() {
  return props.spec.points?.x.filter(Number.isFinite) ?? [];
}

/** The y range of boxes: lowest to highest whisker. */
function boxRange(boxes: NonNullable<TSeriesSpec["boxes"]>) {
  const lows = boxes.flatMap((box) => (box ? [box.low] : []));
  const highs = boxes.flatMap((box) => (box ? [box.high] : []));
  return lows.length
    ? { suggestedMin: Math.min(...lows), suggestedMax: Math.max(...highs) }
    : {};
}

/** Datasets drawn for members only: left out of the pointer's readout. */
const MEMBER_LABEL = /^(member |members |fit |curve )/;

/**
 * Ensemble members behind the plotted one: thin lines (a plume), the
 * 10–90 % range shaded with its median dashed (a fan), or both.
 */
function memberDatasets(
  c: ReturnType<typeof colors>
): ChartDataset<"line", TPoint[]>[] {
  const members = props.spec.members;
  if (!members || props.spec.mode !== "time") {
    return [];
  }
  if (members.view === "chance") {
    return [...plumeDatasets(members, c, "26"), ...chanceDatasets(members, c)];
  }
  return [
    ...(members.view !== "fan" ? plumeDatasets(members, c) : []),
    ...(members.view !== "plume" ? fanDatasets(members, c) : []),
  ];
}

/** The threshold dashed across the series; the chance in its own strip. */
function chanceDatasets(
  members: TMembers,
  c: ReturnType<typeof colors>
): ChartDataset<"line", TPoint[]>[] {
  const { spec } = props;
  const threshold = members.threshold!;
  return [
    {
      ...QUIET,
      label: "members threshold",
      data: ordered(
        spec.x,
        spec.x.map(() => threshold),
        spec.unreadFrom
      ),
      borderColor: c.warn,
      borderWidth: 1,
      borderDash: [6, 4],
      order: 0,
    },
    {
      ...QUIET,
      label: "members above (%)",
      data: ordered(spec.x, members.chance!.share, spec.unreadFrom),
      borderColor: c.warn,
      borderWidth: 1.2,
      fill: "origin",
      backgroundColor: `${c.warn}22`,
      yAxisID: "chance",
      stepped: "middle" as const,
    },
  ];
}

type TMembers = NonNullable<TSeriesSpec["members"]>;

const QUIET = {
  pointRadius: 0,
  pointHitRadius: 0,
  spanGaps: false,
  yAxisID: "y",
  order: 2,
};

function plumeDatasets(
  members: TMembers,
  c: ReturnType<typeof colors>,
  alpha = "4d"
) {
  const { spec } = props;
  return members.series.flatMap((series, member) =>
    member === members.chosen
      ? []
      : [
          {
            ...QUIET,
            label: `member ${member}`,
            data: ordered(spec.x, series, spec.unreadFrom),
            borderColor: `${c.line}${alpha}`,
            borderWidth: 0.9,
          },
        ]
  );
}

function fanDatasets(
  members: TMembers,
  c: ReturnType<typeof colors>
): ChartDataset<"line", TPoint[]>[] {
  const { spec } = props;
  const edge = { ...QUIET, borderColor: `${c.line}40`, borderWidth: 0.75 };
  return [
    {
      ...edge,
      label: "members 10 %",
      data: ordered(spec.x, members.p10, spec.unreadFrom),
      fill: false,
    },
    {
      ...edge,
      label: "members 90 %",
      data: ordered(spec.x, members.p90, spec.unreadFrom),
      fill: "-1",
      backgroundColor: `${c.line}24`,
    },
    {
      ...QUIET,
      label: "members median",
      data: ordered(spec.x, members.p50, spec.unreadFrom),
      borderColor: c.fg,
      borderWidth: 1.2,
      borderDash: [5, 3],
      order: 0,
    },
  ];
}

// eslint-disable-next-line max-lines-per-function
function options() {
  const { spec } = props;
  const c = colors();
  const grid = { color: c.grid };
  const tickFont = { size: 11 };
  const title = (text: string) => ({
    display: true,
    text,
    color: c.fg,
    font: { size: 11 },
  });
  const valueTicks = {
    color: c.muted,
    font: tickFont,
    maxTicksLimit: 6,
    callback: (
      value: number | string,
      _at: number,
      ticks: { value: number }[]
    ) => tickText(Number(value), ticks),
  };
  const timeMode = spec.mode === "time";
  const chanceStrip = timeMode && spec.members?.view === "chance";
  const windRoom = {
    ...(spec.wind && spec.mode === "profile" ? { right: WIND_ROOM + 8 } : {}),
    ...(spec.wind && (timeMode || spec.mode === "path")
      ? { top: WIND_ROOM }
      : {}),
    ...(spec.members && timeMode ? { right: MEMBER_ROOM } : {}),
    ...(spec.distribution ? { top: DISTRIBUTION_ROOM } : {}),
  };
  return {
    animation: false as const,
    layout: { padding: windRoom },
    responsive: true,
    maintainAspectRatio: false,
    // Points are sorted along the index axis (see ordered); only a strictly
    // ascending source has the unique indices `normalized` means.
    parsing: false as const,
    normalized: !unordered.value,
    indexAxis: (spec.mode === "profile" ? "y" : "x") as "x" | "y",
    interaction: {
      mode: (spec.distribution ? "bins" : "nearest") as "nearest",
      intersect: false,
      // Against latitude, by the nearest point on screen, as the map's pointer
      // is: one latitude can be two places on a turning track.
      axis: (spec.along ? "xy" : spec.mode === "profile" ? "y" : "x") as
        "x" | "y" | "xy",
    },
    onHover: (
      event: { x: number | null; y?: number | null },
      _: unknown,
      target: Chart
    ) => hoverPath(event, target),
    plugins: {
      tooltip: {
        // Drawn by the window as one line (Zabbix-like), not as a box.
        enabled: false,
        external: showHover,
        // The band's edges are read out with the mean, not on their own.
        filter: (item: { dataset: { label?: string } }) =>
          !/\((lower|upper)\)$/.test(item.dataset.label ?? "") &&
          !MEMBER_LABEL.test(item.dataset.label ?? ""),
        callbacks: {
          // No sample under the pointer (it left the line): no title.
          title: (items: { raw: unknown }[]) =>
            items[0] ? (spec.readout((items[0].raw as TPoint).i)[0] ?? "") : "",
          label: (item: { raw: unknown; datasetIndex: number }) => {
            const lines = spec.readout((item.raw as TPoint).i).slice(1);
            return item.datasetIndex === 0 ? lines : lines.slice(-1);
          },
        },
      },
    },
    scales: {
      x: {
        type: (spec.xLog ? "logarithmic" : "linear") as "linear",
        // The axis spans the data: no padding out to a rounder number.
        bounds: (spec.mode === "profile" ? "ticks" : "data") as
          "ticks" | "data",
        // The full committed extent, so leading or trailing gaps (or an
        // unread end) keep their place instead of shrinking the axis.
        ...(zoom.value && zoomable.value
          ? { min: zoom.value.min, max: zoom.value.max }
          : spec.along
            ? // A track against latitude: every sample's latitude, not its
              // ends'.
              finiteSpan(spec.x)
            : spec.mode !== "profile" && spec.x.length > 1
              ? {
                  min:
                    dateLayout.value?.min ??
                    Math.min(spec.x[0], spec.x[spec.x.length - 1], ...extraX()),
                  max:
                    dateLayout.value?.max ??
                    Math.max(spec.x[0], spec.x[spec.x.length - 1], ...extraX()),
                }
              : {}),
        grid,
        title: title(xTitle()),
        afterBuildTicks: timeMode && timeAxis ? buildTimeTicks : undefined,
        ticks: {
          color: c.muted,
          font: tickFont,
          maxRotation: 0,
          autoSkip: !timeMode,
          maxTicksLimit: timeMode ? undefined : spec.xLabel ? 13 : 6,
          // A cycle ticks every month, or every third hour.
          ...(spec.mode === "cycle" && !spec.xLog && !spec.xFree
            ? { stepSize: spec.xStep ?? (spec.x.length > 12 ? 3 : 1) }
            : {}),
          callback: (value: number | string) =>
            timeMode && timeAxis
              ? (tickLabels.get(Number(value)) ?? "")
              : spec.xLog && !logTick(Number(value))
                ? ""
                : spec.xLabel
                  ? spec.xLabel(Number(value))
                  : formatValue(Number(value)),
        },
      },
      y: {
        type: "linear" as const,
        reverse: Boolean(spec.invertY),
        grid,
        title: title(spec.yTitle),
        ticks: valueTicks,
        ...(spec.mode === "histogram" ? { min: 0 } : {}),
        // Boxes reach past their medians: the axis takes the whiskers.
        ...(spec.boxes ? boxRange(spec.boxes) : {}),
        ...(spec.yRange ? { min: spec.yRange[0], max: spec.yRange[1] } : {}),
        // Chart.js applies stackWeight even without a stack: set both or none.
        ...(spec.coverage || chanceStrip
          ? { stack: "series", stackWeight: 3 }
          : {}),
      },
      ...(chanceStrip
        ? {
            chance: {
              type: "linear" as const,
              position: "left" as const,
              stack: "series",
              stackWeight: 1,
              offset: true,
              min: 0,
              max: 100,
              grid,
              title: title("% above"),
              ticks: { ...valueTicks, stepSize: 50, callback: undefined },
            },
          }
        : {}),
      ...(spec.coverage
        ? {
            coverage: {
              type: "linear" as const,
              position: "left" as const,
              stack: "series",
              stackWeight: 1,
              offset: true,
              min: 0,
              max: 100,
              grid,
              // Gridlines at 0, 50 and 100 %; the strip is labelled inside.
              ticks: { display: false, stepSize: 50 },
            },
          }
        : {}),
    },
  };
}

function resolveTimeAxis() {
  const { spec } = props;
  timeAxis = undefined;
  timeContext = "";
  if (spec.mode === "time" && spec.time?.units) {
    const parsed = parseTimeAxis(spec.time.units, spec.time.calendar);
    timeAxis = "unsupported" in parsed ? undefined : (parsed as TTimeAxis);
  }
  if (timeAxis && spec.x.length) {
    // The shared year or month goes into the axis title.
    timeContext = timeTicks(
      timeAxis,
      dateLayout.value!.min,
      dateLayout.value!.max,
      6
    ).context;
  }
}

function build() {
  if (!canvas.value) {
    return;
  }
  resolveTimeAxis();
  reducedTo = buckets();
  chart = new Chart<"line", TPoint[]>(canvas.value, {
    type: "line",
    data: { datasets: datasets() },
    options: options() as never,
    plugins: [overlay],
  });
}

/** Update the one chart in place as parts arrive or settings change. */
function update() {
  if (!chart) {
    build();
    return;
  }
  resolveTimeAxis();
  reducedTo = buckets();
  chart.data.datasets = datasets();
  chart.options = options() as never;
  chart.update("none");
}

// Resized a fifth or more: reduced again for the new width (a window grown
// from 240 to 1,350 px draws 1,350 columns, not 240 stretched).
let resizing: ResizeObserver | undefined;
onMounted(() => {
  if (typeof ResizeObserver === "undefined" || !canvas.value) {
    return;
  }
  resizing = new ResizeObserver(() => {
    const now = buckets();
    if (chart && (now > reducedTo * 1.2 || now < reducedTo / 1.2)) {
      update();
    }
  });
  resizing.observe(canvas.value);
});
onBeforeUnmount(() => resizing?.disconnect());

onMounted(build);
// One update a frame however many parts arrive.
let pendingFrame: number | undefined;
function scheduleUpdate() {
  if (typeof requestAnimationFrame === "undefined") {
    update();
    return;
  }
  if (pendingFrame === undefined) {
    pendingFrame = requestAnimationFrame(() => {
      pendingFrame = undefined;
      update();
    });
  }
}
onBeforeUnmount(() => {
  if (pendingFrame !== undefined) {
    cancelAnimationFrame(pendingFrame);
  }
});
watch(() => props.spec, scheduleUpdate);
// Another kind of chart (or axis): the zoom no longer means anything.
/** The x axis a zoom belongs to: another one resets it. */
const zoomKey = computed(() =>
  JSON.stringify([
    props.spec.mode,
    props.spec.xTitle,
    props.spec.time?.units,
    props.spec.time?.calendar,
    fullRange.value?.min,
    fullRange.value?.max,
  ])
);
watch(zoomKey, () => {
  zoom.value = undefined;
});
// Back from Data: the stretch it showed, on the same axis.
if (props.keptZoom?.range && props.keptZoom.key === zoomKey.value) {
  zoom.value = props.keptZoom.range;
}
watch(zoom, (range) => {
  update();
  emit("zoom", { key: zoomKey.value, range });
});

/** The one-line readout and crosshair, from the tooltip's state. */
function showHover(context: {
  chart: Chart;
  tooltip: {
    opacity: number;
    caretX: number;
    caretY: number;
    dataPoints?: { raw: unknown }[];
  };
}) {
  const { tooltip, chart: target } = context;
  const points = tooltip.dataPoints ?? [];
  if (!tooltip.opacity || !points.length || selecting.value) {
    hover.value = undefined;
    return;
  }
  const index = (p: { raw: unknown }) => (p.raw as TPoint).i;
  const horizontal = props.spec.mode === "profile";
  const [head, ...first] = props.spec.readout(index(points[0]));
  hover.value = {
    head: head ?? "",
    text: oneLine(
      first,
      points.slice(1).map((p) => props.spec.readout(index(p)).slice(1))
    ),
    at: horizontal ? tooltip.caretY : tooltip.caretX,
    x: tooltip.caretX,
    y: tooltip.caretY,
    horizontal,
    area: { ...target.chartArea },
  };
}

/**
 *  Drag across the plot to zoom to that stretch (mouse or pen; a finger
 * scrolls the page or moves the window as before).
 */
function zoomStart(event: PointerEvent) {
  const area = chart?.chartArea;
  if (
    !zoomable.value ||
    !area ||
    event.target !== canvas.value ||
    event.button !== 0 ||
    event.pointerType === "touch"
  ) {
    return;
  }
  const [x, y] = canvasOffset(event);
  if (x < area.left || x > area.right || y < area.top || y > area.bottom) {
    return;
  }
  (event.currentTarget as HTMLElement).setPointerCapture?.(event.pointerId);
  selecting.value = { from: x, to: x, top: area.top, bottom: area.bottom };
  hover.value = undefined;
}
/** The pointer's place on the canvas (CSS pixels), whatever it is over. */
function canvasOffset(event: PointerEvent) {
  const rect = canvas.value!.getBoundingClientRect();
  return [event.clientX - rect.left, event.clientY - rect.top];
}
function zoomMove(event: PointerEvent) {
  const area = chart?.chartArea;
  if (selecting.value && area) {
    const [x] = canvasOffset(event);
    selecting.value.to = Math.max(area.left, Math.min(area.right, x));
  }
}
function zoomEnd() {
  const drag = selecting.value;
  selecting.value = undefined;
  const scale = chart?.scales.x;
  if (!drag || !scale) {
    return;
  }
  const range = dragRange(drag.from, drag.to, (pixel) =>
    scale.getValueForPixel(pixel)!
  );
  if (range) {
    zoom.value = range;
  }
}
function resetZoom() {
  zoom.value = undefined;
}
// The map-time marker moves without rebuilding the chart: with the map's
// time, and with its row (two rows can share one timestamp).
watch(
  () => [props.mapTime, props.mapRow],
  () => chart?.draw()
);
onBeforeUnmount(() => chart?.destroy());

/**
 * The figure at a fixed export size, independent of the window: the same
 * data and options drawn once on an off-screen canvas at twice the pixels.
 */
/**
 * The chart at a fixed export size: on a new canvas (PNG), or drawn onto
 * `target` (a PDF page's recording canvas).
 */
async function renderExport(
  width: number,
  height: number,
  target?: HTMLCanvasElement,
  /** Image pixels per layout pixel (2 for the standard PNG). */
  ratio = 2
) {
  const holder = document.createElement("div");
  holder.style.cssText = `position:fixed;left:-10000px;top:0;width:${width}px;height:${height}px`;
  // Theme variables resolve inside the window's element.
  (canvas.value?.parentElement ?? document.body).appendChild(holder);
  const element = target ?? document.createElement("canvas");
  element.style.cssText = `width:${width}px;height:${height}px`;
  holder.appendChild(element);
  // Reduced for the export's own pixel columns.
  exportColumns = Math.max(200, Math.round(width * ratio));
  let data: ReturnType<typeof datasets>;
  try {
    data = datasets();
  } finally {
    exportColumns = undefined;
  }
  const exportChart = new Chart<"line", TPoint[]>(element, {
    type: "line",
    data: { datasets: data },
    options: {
      ...(options() as object),
      responsive: false,
      devicePixelRatio: ratio,
    } as never,
    plugins: [overlay],
  });
  exportChart.resize(width, height);
  exportChart.update("none");
  if (target) {
    exportChart.destroy();
    holder.remove();
    return target;
  }
  const copy = document.createElement("canvas");
  copy.width = element.width;
  copy.height = element.height;
  copy.getContext("2d")!.drawImage(element, 0, 0);
  exportChart.destroy();
  holder.remove();
  return copy;
}

defineExpose({ canvas: () => canvas.value, renderExport });
</script>

<template>
  <div
    class="analysis-chart"
    :class="{ zoomable }"
    @pointerdown="zoomStart"
    @pointermove="zoomMove"
    @pointerup="zoomEnd"
    @pointercancel="selecting = undefined"
    @dblclick="resetZoom"
  >
    <canvas
      ref="canvas"
      role="img"
      :aria-label="`${spec.yTitle} against ${spec.xTitle}${zoomable ? '. Drag across to zoom; double-click to see all.' : ''}`"
      @pointerleave="
        emit('hoverDistance', undefined);
        hover = undefined;
      "
    ></canvas>
    <!-- The pointer's readout on one line, and its crosshair. -->
    <template v-if="hover">
      <div
        class="hover-line"
        :class="{ horizontal: hover.horizontal }"
        :style="
          hover.horizontal
            ? {
                top: `${hover.at}px`,
                left: `${hover.area.left}px`,
                width: `${hover.area.right - hover.area.left}px`,
              }
            : {
                left: `${hover.at}px`,
                top: `${hover.area.top}px`,
                height: `${hover.area.bottom - hover.area.top}px`,
              }
        "
        aria-hidden="true"
      ></div>
      <div class="hover-text" :style="hoverBox" role="status">
        <strong>{{ hover.head }}</strong>
        <span v-if="hover.text"
          ><i class="hover-swatch" aria-hidden="true"></i>{{ hover.text }}</span
        >
      </div>
    </template>
    <div
      v-if="selecting"
      class="zoom-selection"
      :style="{
        left: `${Math.min(selecting.from, selecting.to)}px`,
        width: `${Math.abs(selecting.to - selecting.from)}px`,
        top: `${selecting.top}px`,
        height: `${selecting.bottom - selecting.top}px`,
      }"
      aria-hidden="true"
    ></div>
    <button
      v-if="zoom"
      type="button"
      class="zoom-reset"
      :style="resetAt"
      title="Show the whole range (or double-click the chart)"
      @click="resetZoom"
    >
      <i class="fa-solid fa-magnifying-glass-minus" aria-hidden="true"></i>
      Reset zoom
    </button>
    <div
      v-if="cursorAt"
      class="map-cursor"
      :style="cursorAt"
      aria-hidden="true"
    ></div>
    <div
      v-for="mark in marksAt"
      :key="mark.label"
      class="found-level"
      :class="{ right: mark.right }"
      :style="mark.style"
      aria-hidden="true"
    >
      <span>{{ mark.label }}</span>
    </div>
    <div v-if="levelAt" class="map-level" :style="levelAt" aria-hidden="true">
      <span>map level</span>
    </div>
  </div>
</template>

<style scoped>
.analysis-chart {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 120px;
}
.map-cursor {
  position: absolute;
  width: 0;
  border-left: 2px solid var(--plot-accent, #2563eb);
  /* A halo: seen over any colour of the cells. */
  box-shadow: 0 0 0 1px
    color-mix(in srgb, var(--plot-bg, #fff) 70%, transparent);
  pointer-events: none;
}
.map-level {
  position: absolute;
  height: 0;
  border-top: 2px dashed var(--plot-accent, #2563eb);
  pointer-events: none;
}
.map-level span {
  position: absolute;
  right: 2px;
  bottom: 2px;
  padding: 0 4px;
  border-radius: 4px;
  background: color-mix(in srgb, var(--plot-bg, #fff) 80%, transparent);
  color: var(--plot-accent, #2563eb);
  font-size: 0.68rem;
  font-weight: 600;
}
.analysis-chart.zoomable {
  cursor: crosshair;
}
.hover-line {
  position: absolute;
  width: 0;
  border-left: 1px solid
    color-mix(in srgb, var(--plot-fg, #1f2937) 55%, transparent);
  pointer-events: none;
}
.hover-line.horizontal {
  height: 0;
  width: auto;
  border-left: 0;
  border-top: 1px solid
    color-mix(in srgb, var(--plot-fg, #1f2937) 55%, transparent);
}
/* A small box beside the pointer (Zabbix-like): the date, then the
 * values on one line, dot-separated. */
.hover-text {
  position: absolute;
  z-index: 2;
  display: flex;
  flex-direction: column;
  padding: 3px 7px;
  border: 1px solid var(--plot-border, #d1d5db);
  border-radius: 5px;
  background: color-mix(in srgb, var(--plot-bg, #fff) 94%, transparent);
  box-shadow: 0 2px 8px rgba(15, 23, 42, 0.18);
  color: var(--plot-fg, #1f2937);
  font-size: 0.7rem;
  font-variant-numeric: tabular-nums;
  line-height: 1.35;
  pointer-events: none;
}
/* The date on one line; the values wrap rather than being cut off. */
.hover-text strong {
  white-space: nowrap;
}
.hover-text span {
  white-space: normal;
  overflow-wrap: anywhere;
}
.hover-text strong {
  font-weight: 600;
  color: var(--plot-muted, #64748b);
}
.hover-swatch {
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 5px;
  border-radius: 2px;
  background: var(--plot-accent, #2563eb);
}
.zoom-selection {
  position: absolute;
  background: color-mix(in srgb, var(--plot-accent, #2563eb) 18%, transparent);
  border-inline: 1px solid var(--plot-accent, #2563eb);
  pointer-events: none;
}
.zoom-reset {
  position: absolute;
  z-index: 1;
  padding: 2px 8px;
  border: 1px solid var(--plot-border, #d1d5db);
  border-radius: 999px;
  background: var(--plot-bg, #fff);
  color: var(--plot-fg, #1f2937);
  font-size: 0.72rem;
  cursor: pointer;
}
/* A level found in the profile (mixed layer, tropopause…). */
.found-level {
  position: absolute;
  height: 0;
  border-top: 1px dashed var(--plot-warn, #d97706);
  pointer-events: none;
}
.found-level.right span {
  left: auto;
  right: 4px;
}
.found-level span {
  position: absolute;
  left: 4px;
  bottom: 1px;
  padding: 0 4px;
  border-radius: 3px;
  background: color-mix(in srgb, var(--plot-bg, #fff) 85%, transparent);
  color: var(--plot-warn, #d97706);
  font-size: 0.66rem;
  white-space: nowrap;
}
</style>
