<script lang="ts" setup>
import { useResizeObserver } from "@vueuse/core";
import { computed, onMounted, ref, watch } from "vue";

import { cellUnder, titled } from "./chartZoom.ts";
import { drawScaleBar, keyLines } from "./colourBar.ts";
import { HIDDEN, paletteIndex, type TColourScale } from "./colourScale.ts";
import { plotColor } from "./figure.ts";
import {
  axisCells,
  cellsPerPixel,
  extent,
  niceTicks,
  PIXEL,
  rasterize,
  pointerTime,
  rowUnder,
  timeCells,
  type TRaster,
} from "./heatmapRaster.ts";
import { paletteLoader } from "./paletteLoader.ts";
import { drawAxisMarks } from "./pathMarks.ts";
import { timeWord, type THeatmapSpec } from "./plotFigure.ts";
import { drawBarbGrid, windLine } from "./windBarbs.ts";

import {
  parseTimeAxis,
  timeLabelAt,
  type TTimeAxis,
} from "@/lib/analysis/calendar.ts";
import { timeTicks } from "@/lib/analysis/timeTicks.ts";
import { formatValue } from "@/utils/formatValue.ts";

const props = defineProps<{
  spec: THeatmapSpec;
  /** The map's colour scale (or this plot's own range, labelled). */
  scale: TColourScale;
  /** The map's current time (raw coordinate), drawn as a marker. */
  mapTime?: number;
  /** The time row whose trace is shown, if any. */
  picked?: number;
  /** A distance (m) pointed at on the map's path: a line marks it here. */
  cursor?: number;
  /** The map's level (index on the axis): a line marks it (time–depth). */
  mapLevel?: number;
  /**
   * A level found at each date (time–vertical: the mixed layer, the 20 °C
   * isotherm, the tropopause…), in the axis's units: a line over the cells.
   */
  line?: { label: string; values: number[] };
}>();

const emit = defineEmits<{
  pick: [row: number];
  /** The path distance (m) under the pointer (distance × time). */
  hoverDistance: [meters: number | undefined];
  /**
   * How the figure is drawn (pixels holding several cells, overlapping
   * time bounds): for Read details on screen; exports print them.
   */
  notes: [notes: string[]];
}>();

const canvas = ref<HTMLCanvasElement>();
const box = ref<HTMLDivElement>();
const MARGIN = { left: 64, right: 80, top: 26, bottom: 44 };

const palettes = paletteLoader(
  (name) =>
    new Promise((resolve) => {
      const image = new Image();
      image.onload = () => {
        const scratch = document.createElement("canvas");
        scratch.width = 256;
        scratch.height = 1;
        const context = scratch.getContext("2d")!;
        context.drawImage(image, 0, 0, 256, 1);
        resolve(context.getImageData(0, 0, 256, 1).data);
      };
      image.onerror = () => resolve(undefined);
      image.src = `${import.meta.env.BASE_URL}static/colormaps/${name}.webp`;
    })
);

/** The palette at a position 0–1 (already inverted and stepped). */
function rgb(t: number): [number, number, number] {
  const index = Math.max(0, Math.min(255, Math.round(t * 255)));
  const palette = palettes.data;
  return palette
    ? [palette[4 * index], palette[4 * index + 1], palette[4 * index + 2]]
    : [index, index, index];
}

function colour(t: number) {
  const [r, g, b] = rgb(t);
  return `rgb(${r},${g},${b})`;
}

// Cells of the time steps and of the axis, from the result alone.
const cells = computed(() => {
  const { spec } = props;
  const rows = timeCells(spec.time.raw, spec.time.bounds);
  const columns = axisCells(spec.axis.values, spec.axis.bounds);
  return {
    rows,
    columns,
    time: extent(rows),
    axis: extent(columns),
  };
});

type TFrame = {
  plotW: number;
  plotH: number;
  /** Position (CSS pixels) of a time coordinate and of an axis value. */
  time: (raw: number) => number;
  axis: (value: number) => number;
};

/**
 * Axes ordered by value, whatever the order in the file: later times right
 * (or up), larger axis values right or up; a downward-positive vertical
 * (pressure, depth) puts larger values lower.
 */
function frame(width: number, height: number): TFrame {
  const { spec } = props;
  const plotW = Math.max(10, width - MARGIN.left - MARGIN.right);
  const plotH = Math.max(10, height - MARGIN.top - MARGIN.bottom);
  const { time, axis } = cells.value;
  const along = (v: number, lo: number, hi: number) =>
    (v - lo) / (hi - lo || 1);
  const xOf = (f: number) => MARGIN.left + f * plotW;
  const yOf = (f: number, down = false) =>
    MARGIN.top + (down ? f : 1 - f) * plotH;
  return spec.timeOn === "x"
    ? {
        plotW,
        plotH,
        time: (raw) => xOf(along(raw, time.low, time.high)),
        axis: (v) => yOf(along(v, axis.low, axis.high), spec.axis.reverse),
      }
    : {
        plotW,
        plotH,
        time: (raw) => yOf(along(raw, time.low, time.high)),
        axis: (v) => xOf(along(v, axis.low, axis.high)),
      };
}

/** The raster last drawn, and the one on screen (exports draw others). */
let lastRaster: TRaster | undefined;
let shownRaster: TRaster | undefined;

// Notes for the figure: unsampled time and pixels showing several cells.
const notes = { gaps: false, hidden: false, reduced: 1 };

/** The coloured cells as one image, at device resolution. */
// eslint-disable-next-line max-lines-per-function
function drawCells(
  context: CanvasRenderingContext2D,
  f: TFrame,
  ratio: number
) {
  const { spec } = props;
  const W = Math.max(1, Math.round(f.plotW * ratio));
  const H = Math.max(1, Math.round(f.plotH * ratio));
  const timePixels = spec.timeOn === "x" ? W : H;
  const axisPixels = spec.timeOn === "x" ? H : W;
  const origin = (p: number, start: number) => (p - start) * ratio;
  const raster = rasterize({
    values: spec.values,
    rows: cells.value.rows,
    columns: cells.value.columns,
    unreadFrom: spec.unreadFrom,
    timePixels,
    axisPixels,
    timeToPixel: (raw) =>
      origin(f.time(raw), spec.timeOn === "x" ? MARGIN.left : MARGIN.top),
    axisToPixel: (v) =>
      origin(f.axis(v), spec.timeOn === "x" ? MARGIN.top : MARGIN.left),
  });
  // Both axes reduced: a pixel holds up to rows × columns of cells.
  notes.reduced = cellsPerPixel(raster);
  lastRaster = raster;
  // The map's scale: a value has its map colour, or none where the map
  // hides it.
  const scale = props.scale;
  const lut = Array.from({ length: 256 }, (_, at) => rgb(at / 255));
  let hidden = false;
  const image = new ImageData(W, H);
  const data = image.data;
  let gaps = false;
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const [tp, ap] = spec.timeOn === "x" ? [x, y] : [y, x];
      const state = raster.state(tp, ap);
      const at = 4 * (y * W + x);
      if (state === PIXEL.VALUE) {
        const index = paletteIndex(scale, raster.value(tp, ap));
        if (index === HIDDEN) {
          // Not drawn on the map: left empty here too.
          hidden = true;
          continue;
        }
        const [r, g, b] = lut[index];
        data[at] = r;
        data[at + 1] = g;
        data[at + 2] = b;
        data[at + 3] = 255;
      } else if (state === PIXEL.MISSING) {
        // Hatched: a missing value in a sampled cell.
        const ink = (x + y) % 6 < 2;
        data[at] = data[at + 1] = data[at + 2] = ink ? 100 : 200;
        data[at + 3] = 255;
      } else if (state === PIXEL.GAP) {
        // Dotted: time with no sample (between instantaneous samples).
        gaps = true;
        const dot = x % 4 === 0 && y % 4 === 0;
        data[at] = data[at + 1] = data[at + 2] = 140;
        data[at + 3] = dot ? 200 : 0;
      }
    }
  }
  notes.gaps = gaps && cells.value.rows.lo.length > 1;
  notes.hidden = hidden;
  const layer = document.createElement("canvas");
  layer.width = W;
  layer.height = H;
  layer.getContext("2d")!.putImageData(image, 0, 0);
  context.save();
  context.imageSmoothingEnabled = false;
  context.drawImage(layer, MARGIN.left, MARGIN.top, f.plotW, f.plotH);
  context.restore();
}

let timeAxis: TTimeAxis | undefined;

// eslint-disable-next-line max-lines-per-function
function drawAxes(
  context: CanvasRenderingContext2D,
  f: TFrame,
  height: number
) {
  const { spec } = props;
  const fg = plotColor(canvas.value, "--plot-fg", "#1f2937");
  const muted = plotColor(canvas.value, "--plot-muted", "#4b5563");
  context.strokeStyle = plotColor(canvas.value, "--plot-border", "#94a3b8");
  context.strokeRect(MARGIN.left, MARGIN.top, f.plotW, f.plotH);
  context.font = "11px sans-serif";
  context.fillStyle = muted;
  const { time, axis } = cells.value;
  const parsed = parseTimeAxis(spec.time.units, spec.time.calendar);
  timeAxis = "unsupported" in parsed ? undefined : (parsed as TTimeAxis);
  const lengthAlong = spec.timeOn === "x" ? f.plotW : f.plotH;
  const count = Math.max(
    2,
    Math.floor(lengthAlong / (spec.timeOn === "x" ? 64 : 36))
  );
  const ticks = timeAxis
    ? timeTicks(timeAxis, time.low, time.high, count)
    : {
        ticks: niceTicks(time.low, time.high, 4).map((v) => ({
          value: v,
          label: formatValue(v),
        })),
        context: "",
      };
  for (const tick of ticks.ticks) {
    const p = f.time(tick.value);
    if (spec.timeOn === "x") {
      context.textAlign = "center";
      context.fillText(tick.label, p, MARGIN.top + f.plotH + 14);
    } else {
      context.textAlign = "right";
      context.fillText(tick.label, MARGIN.left - 6, p + 4);
    }
  }
  for (const v of niceTicks(axis.low, axis.high, 4)) {
    const p = f.axis(v);
    const label = spec.axis.format ? spec.axis.format(v) : formatValue(v);
    if (spec.timeOn === "x") {
      context.textAlign = "right";
      context.fillText(label, MARGIN.left - 6, p + 4);
    } else {
      context.textAlign = "center";
      context.fillText(
        label,
        p,
        MARGIN.top + f.plotH + (spec.axis.marks?.length ? 19 : 14)
      );
    }
  }
  // Raw units and origin when the calendar cannot be decoded.
  const timeTitle = timeAxis
    ? `${timeWord(spec.time)} (${spec.time.calendar ?? "standard"} calendar)${ticks.context ? `, ${ticks.context}` : ""}`
    : `${spec.time.dimension} (${spec.time.units ?? "raw values"})`;
  const [xTitle, yTitle] =
    spec.timeOn === "x"
      ? [timeTitle, spec.axis.title]
      : [spec.axis.title, timeTitle];
  context.fillStyle = fg;
  context.textAlign = "center";
  context.fillText(xTitle, MARGIN.left + f.plotW / 2, height - 6);
  context.save();
  context.translate(12, MARGIN.top + f.plotH / 2);
  context.rotate(-Math.PI / 2);
  context.fillText(yTitle, 0, 0);
  context.restore();
  context.textAlign = "left";
  if (spec.timeOn === "y" && spec.axis.marks?.length) {
    // The path's numbered points, as on the map.
    drawAxisMarks(
      context,
      spec.axis.marks,
      f.axis,
      MARGIN.top + f.plotH,
      {
        fill: plotColor(canvas.value, "--plot-bg", "#ffffff"),
        text: fg,
        ring: plotColor(canvas.value, "--plot-line", "#1d4ed8"),
      },
      [MARGIN.left, MARGIN.left + f.plotW]
    );
  }
}

/** The path distance (m) under the pointer, on a distance × time plot. */
/** The map's level across a time × level heatmap, as it moves. */
/** Bumped on every draw: overlays placed from the drawing follow it. */
const drawTick = ref(0);
const levelAt = computed(() => {
  void drawTick.value;
  const k = props.mapLevel;
  const value = k === undefined ? undefined : props.spec.axis.values[k];
  const width = box.value?.clientWidth;
  const height = box.value?.clientHeight;
  if (value === undefined || props.spec.timeOn !== "x" || !width || !height) {
    return undefined;
  }
  const y = frame(width, height).axis(value);
  return y >= MARGIN.top && y <= height - MARGIN.bottom
    ? {
        top: `${y}px`,
        left: `${MARGIN.left}px`,
        width: `${width - MARGIN.left - MARGIN.right}px`,
      }
    : undefined;
});

/** The map pointer's distance along the path, as a left offset (px). */
function cursorLeft() {
  const width = box.value?.clientWidth;
  if (
    props.cursor === undefined ||
    props.spec.timeOn !== "y" ||
    !props.spec.axis.marks ||
    !width
  ) {
    return undefined;
  }
  const { low, high } = cells.value.axis;
  const f = (props.cursor / 1000 - low) / (high - low || 1);
  return f >= 0 && f <= 1
    ? MARGIN.left + f * (width - MARGIN.left - MARGIN.right)
    : undefined;
}

function distanceAt(clientX: number) {
  if (props.spec.timeOn !== "y" || !props.spec.axis.marks || !canvas.value) {
    return undefined;
  }
  const rect = canvas.value.getBoundingClientRect();
  const plotW = rect.width - MARGIN.left - MARGIN.right;
  const f = (clientX - rect.left - MARGIN.left) / plotW;
  const { low, high } = cells.value.axis;
  return f >= 0 && f <= 1 ? (low + f * (high - low)) * 1000 : undefined;
}

function timeSpan(row: number) {
  return [cells.value.rows.lo[row], cells.value.rows.hi[row]];
}

/** Shade every row not read yet, wherever it lies in time. */
function drawUnread(context: CanvasRenderingContext2D, f: TFrame) {
  const { spec } = props;
  const from = spec.unreadFrom;
  if (from === undefined || from >= spec.time.raw.length) {
    return;
  }
  context.fillStyle = plotColor(
    canvas.value,
    "--plot-unread",
    "rgba(100,116,139,0.16)"
  );
  // Unread rows as pixel intervals, merged into visible runs: one fill per
  // run, not per row (one read date of 50,000 is one or two fills).
  const spans: [number, number][] = [];
  for (let row = from; row < spec.time.raw.length; row++) {
    const [a, b] = timeSpan(row);
    const [p, q] = [f.time(a), f.time(b)];
    spans.push([Math.min(p, q), Math.max(p, q)]);
  }
  // Rows usually run in time order: sort only when they do not.
  let ordered = true;
  for (let k = 1; k < spans.length && ordered; k++) {
    ordered = spans[k - 1][0] <= spans[k][0];
  }
  if (!ordered) {
    spans.sort((x, y) => x[0] - y[0]);
  }
  const runs: [number, number][] = [];
  for (const [p, q] of spans) {
    const last = runs[runs.length - 1];
    if (last && p <= last[1] + 1) {
      last[1] = Math.max(last[1], q);
    } else {
      runs.push([p, q]);
    }
  }
  for (const [p, q] of runs) {
    if (props.spec.timeOn === "x") {
      context.fillRect(p, MARGIN.top, Math.max(1, q - p), f.plotH);
    } else {
      context.fillRect(MARGIN.left, p, f.plotW, Math.max(1, q - p));
    }
  }
}

function drawPicked(context: CanvasRenderingContext2D, f: TFrame) {
  if (props.picked === undefined || !props.spec.time.raw.length) {
    return;
  }
  const [a, b] = timeSpan(props.picked);
  context.strokeStyle = plotColor(canvas.value, "--plot-fg", "#1f2937");
  context.lineWidth = 1.5;
  const [p, q] = [f.time(a), f.time(b)];
  if (props.spec.timeOn === "x") {
    context.strokeRect(
      Math.min(p, q),
      MARGIN.top,
      Math.max(2, Math.abs(q - p)),
      f.plotH
    );
  } else {
    context.strokeRect(
      MARGIN.left,
      Math.min(p, q),
      f.plotW,
      Math.max(2, Math.abs(q - p))
    );
  }
  context.lineWidth = 1;
}

function drawMapTime(context: CanvasRenderingContext2D, f: TFrame) {
  const { spec } = props;
  const { time } = cells.value;
  const at = props.mapTime;
  if (at === undefined || at < time.low || at > time.high) {
    return;
  }
  // The map's current time, moving with its time slider.
  const p = f.time(at);
  const accent = plotColor(canvas.value, "--plot-accent", "#1d4ed8");
  context.strokeStyle = accent;
  context.lineWidth = 2;
  context.setLineDash([5, 3]);
  context.beginPath();
  if (spec.timeOn === "x") {
    context.moveTo(p, MARGIN.top);
    context.lineTo(p, MARGIN.top + f.plotH);
  } else {
    context.moveTo(MARGIN.left, p);
    context.lineTo(MARGIN.left + f.plotW, p);
  }
  context.stroke();
  context.setLineDash([]);
  context.lineWidth = 1;
  // A small tag, as "map level": at the top of the line (its bottom met
  // the map level's line, the bare word unreadable over it: 23 Nov).
  const text = "map time";
  context.font = "600 10px sans-serif";
  const w = context.measureText(text).width + 8;
  const h = 14;
  let x: number;
  let y: number;
  if (spec.timeOn === "x") {
    x = p + 3 + w <= MARGIN.left + f.plotW ? p + 3 : p - 3 - w;
    y = MARGIN.top + 2;
  } else {
    x = MARGIN.left + 2;
    y = p - 3 - h >= MARGIN.top ? p - 3 - h : p + 3;
  }
  context.fillStyle = plotColor(canvas.value, "--plot-bg", "#ffffff");
  context.globalAlpha = 0.85;
  context.beginPath();
  context.roundRect(x, y, w, h, 4);
  context.fill();
  context.globalAlpha = 1;
  context.fillStyle = accent;
  context.textBaseline = "middle";
  context.fillText(text, x + 4, y + h / 2 + 0.5);
  context.textBaseline = "alphabetic";
}

/**
 * The colour bar: units above it, limits beside it, and keys for missing
 * values and unsampled time underneath; nothing is rotated or clipped.
 */
// eslint-disable-next-line max-lines-per-function
function drawColourBar(
  context: CanvasRenderingContext2D,
  f: TFrame,
  width: number
) {
  const fg = plotColor(canvas.value, "--plot-fg", "#1f2937");
  const muted = plotColor(canvas.value, "--plot-muted", "#4b5563");
  const x = width - MARGIN.right + 10;
  context.font = "11px sans-serif";
  context.textAlign = "left";
  context.fillStyle = fg;
  const units = props.spec.units ? props.spec.units : "value";
  // The units read leftwards from the figure's right edge, over the plot's
  // top margin: room for long units without cutting them.
  context.textAlign = "right";
  context.fillText(fit(context, units, width - 8), width - 4, MARGIN.top - 8);
  context.textAlign = "left";
  // Keys under the bar, each on one or two lines of the room beside it.
  const room = MARGIN.right - 27;
  context.font = "10px sans-serif";
  const keyNames = [
    "missing",
    ...(notes.hidden ? ["hidden on map"] : []),
    ...(notes.gaps ? ["no sample"] : []),
  ].map((label) => keyLines(context, label, room));
  const keysHeight = keyNames.reduce(
    (h, lines) => h + 7 + 11 * lines.length,
    0
  );
  context.font = "11px sans-serif";
  if (props.spec.unreadFrom === 0) {
    context.fillStyle = muted;
    context.fillText("reading", x, MARGIN.top + 10);
  } else {
    drawScaleBar(
      context,
      {
        x,
        top: MARGIN.top,
        height: Math.max(12, f.plotH - keysHeight - 8),
        room,
      },
      props.scale,
      props.spec.values,
      { fg, muted, colour, fit }
    );
  }
  let keyY = MARGIN.top + f.plotH - 12;
  context.font = "10px sans-serif";
  const key = (label: string, paint: () => void) => {
    const lines = keyLines(context, label, room);
    // A two-line key: its swatch beside the first line, the second below.
    keyY -= 11 * (lines.length - 1);
    paint();
    context.fillStyle = muted;
    lines.forEach((line, k) =>
      context.fillText(line, x + 15, keyY + 10 + 11 * k)
    );
    keyY -= 18;
  };
  key("missing", () => {
    for (let k = 0; k < 12; k++) {
      for (let j = 0; j < 12; j++) {
        context.fillStyle =
          (k + j) % 6 < 2 ? "rgb(100,100,100)" : "rgb(200,200,200)";
        context.fillRect(x + j, keyY + k, 1, 1);
      }
    }
  });
  if (notes.hidden) {
    // Hidden on the map below or above its limits: empty here too.
    key("hidden on map", () => {
      context.strokeStyle = muted;
      context.strokeRect(x + 0.5, keyY + 0.5, 11, 11);
    });
  }
  if (notes.gaps) {
    key("no sample", () => {
      context.strokeStyle = muted;
      context.strokeRect(x + 0.5, keyY + 0.5, 11, 11);
      context.fillStyle = "rgb(140,140,140)";
      for (let k = 0; k < 12; k += 4) {
        for (let j = 0; j < 12; j += 4) {
          context.fillRect(x + j, keyY + k, 1, 1);
        }
      }
    });
  }
}

/** Text cut with an ellipsis to fit a width. */
function fit(context: CanvasRenderingContext2D, text: string, max: number) {
  if (context.measureText(text).width <= max) {
    return text;
  }
  let cut = text;
  while (cut.length > 1 && context.measureText(`${cut}…`).width > max) {
    cut = cut.slice(0, -1);
  }
  return `${cut}…`;
}

/** How the figure is drawn, in words (after its cells are drawn). */
function drawingNotes() {
  return [
    ...(cells.value.rows.overlapping
      ? ["Time bounds overlap: steps drawn at their times"]
      : []),
    ...(notes.reduced > 1
      ? [`Each pixel shows the most extreme of up to ${notes.reduced} cells`]
      : []),
  ];
}

let shownNotes = "";

function drawNote(context: CanvasRenderingContext2D, f: TFrame) {
  const notices = drawingNotes();
  if (!notices.length) {
    return;
  }
  context.font = "10px sans-serif";
  context.fillStyle = plotColor(canvas.value, "--plot-muted", "#4b5563");
  context.textAlign = "left";
  context.fillText(
    fit(context, notices.join("; "), f.plotW),
    MARGIN.left,
    MARGIN.top - 8
  );
}

/**
 * Wind barbs on the cells (time–height): times and levels thinned apart,
 * outlined so they read on any colour.
 */
function drawWind(context: CanvasRenderingContext2D, f: TFrame) {
  const { spec } = props;
  const wind = spec.wind;
  if (!wind) {
    return;
  }
  const nCols = spec.axis.values.length;
  const readUntil = spec.unreadFrom ?? spec.time.raw.length;
  const across = spec.timeOn === "x";
  // Stations stay inside the frame, clear of the axes' labels.
  const inX = (x: number) =>
    x >= MARGIN.left + 8 && x <= MARGIN.left + f.plotW - 8 ? x : Number.NaN;
  const inY = (y: number) =>
    y >= MARGIN.top + 8 && y <= MARGIN.top + f.plotH - 8 ? y : Number.NaN;
  const [inTime, inAxis] = across ? [inX, inY] : [inY, inX];
  const timeAt = spec.time.raw.map((raw, row) =>
    row < readUntil ? inTime(f.time(raw)) : Number.NaN
  );
  const axisAt = spec.axis.values.map((value) => inAxis(f.axis(value)));
  drawBarbGrid(
    context,
    {
      rows: across ? timeAt : axisAt,
      columns: across ? axisAt : timeAt,
      gap: [30, 26],
      at: (a, b) => (across ? [timeAt[a], axisAt[b]] : [axisAt[a], timeAt[b]]),
      index: (a, b) => (across ? a * nCols + b : b * nCols + a),
      flip: () => wind.flip,
    },
    wind,
    {
      length: 13,
      color: plotColor(box.value, "--plot-fg", "#1f2937"),
      halo: plotColor(box.value, "--plot-bg", "#ffffff"),
    }
  );
}

/** Everything but the map-time marker, which moves on its own. */
/** The found level at each date, joined across dates that have one. */
function drawLine(context: CanvasRenderingContext2D, f: TFrame) {
  const line = props.line;
  const raw = props.spec.time.raw;
  if (!line || props.spec.timeOn !== "x") {
    return;
  }
  const order = raw
    .map((t, at) => ({ t, v: line.values[at] }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
  context.save();
  // A dark casing under a light line: seen over any colour of the cells.
  for (const [width, colour] of [
    [3.5, "rgba(15, 23, 42, 0.85)"],
    [1.6, "#ffffff"],
  ] as const) {
    context.beginPath();
    let open = false;
    for (const p of order) {
      if (!Number.isFinite(p.v)) {
        open = false;
        continue;
      }
      const [x, y] = [f.time(p.t), f.axis(p.v)];
      if (open) {
        context.lineTo(x, y);
      } else {
        context.moveTo(x, y);
        open = true;
      }
    }
    context.lineWidth = width;
    context.strokeStyle = colour;
    context.lineJoin = "round";
    context.stroke();
  }
  // Its name, at the upper left of the cells.
  context.font = "600 11px sans-serif";
  context.fillStyle = "#ffffff";
  context.strokeStyle = "rgba(15, 23, 42, 0.85)";
  context.lineWidth = 3;
  context.strokeText(`— ${line.label}`, MARGIN.left + 6, MARGIN.top + 14);
  context.fillText(`— ${line.label}`, MARGIN.left + 6, MARGIN.top + 14);
  context.restore();
}

function drawBase(
  element: HTMLCanvasElement,
  width: number,
  height: number,
  ratio: number,
  /**
   *  Print the drawing notes on the figure (exports; the window lists
   *  them in Read details).
   */
  printNotes = true
) {
  element.width = Math.max(1, Math.round(width * ratio));
  element.height = Math.max(1, Math.round(height * ratio));
  const context = element.getContext("2d")!;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  if (!props.spec.time.raw.length || !props.spec.axis.values.length) {
    return;
  }
  const f = frame(width, height);
  drawCells(context, f, ratio);
  drawWind(context, f);
  drawLine(context, f);
  drawUnread(context, f);
  // The picked row is drawn over the base in the window (draw), and here
  // only for exports (printNotes).
  if (printNotes) {
    drawPicked(context, f);
  }
  drawAxes(context, f, height);
  drawColourBar(context, f, width);
  if (printNotes) {
    drawNote(context, f);
  }
}

function drawOn(
  element: HTMLCanvasElement,
  width: number,
  height: number,
  ratio: number
) {
  drawBase(element, width, height, ratio);
  if (props.spec.time.raw.length && props.spec.axis.values.length) {
    drawMapTime(element.getContext("2d")!, frame(width, height));
  }
}

// The cells are drawn once per result and size; moving the map's time
// redraws only its marker over a copy.
let base: HTMLCanvasElement | undefined;
let baseKey = "";

function draw(rebuild = true) {
  if (!canvas.value || !box.value) {
    return;
  }
  const width = box.value.clientWidth;
  const height = box.value.clientHeight;
  const ratio = window.devicePixelRatio || 1;
  const key = `${width}x${height}@${ratio}`;
  if (rebuild || !base || key !== baseKey) {
    base ??= document.createElement("canvas");
    drawBase(base, width, height, ratio, false);
    shownRaster = lastRaster;
    baseKey = key;
    const now = drawingNotes();
    if (now.join("\n") !== shownNotes) {
      shownNotes = now.join("\n");
      emit("notes", now);
    }
  }
  const element = canvas.value;
  drawTick.value++;
  element.width = base.width;
  element.height = base.height;
  const context = element.getContext("2d")!;
  context.drawImage(base, 0, 0);
  if (props.spec.time.raw.length && props.spec.axis.values.length) {
    context.setTransform(ratio, 0, 0, ratio, 0, 0);
    const f = frame(width, height);
    drawPicked(context, f);
    drawMapTime(context, f);
  }
}

let drawn: Promise<void> = Promise.resolve();

function redraw() {
  drawn = (async () => {
    // Every choice, the kept one too: it ends a request for another.
    await palettes.load(props.scale.colormap);
    draw();
  })();
  return drawn;
}

/** The figure at a fixed export size, after its palette has loaded. */
async function renderExport(
  width: number,
  height: number,
  target?: HTMLCanvasElement,
  /** Image pixels per layout pixel (2 for the standard PNG). */
  ratio = 2
) {
  await drawn;
  const element = target ?? document.createElement("canvas");
  drawOn(element, width, height, ratio);
  return element;
}

/** The time row under a pointer position, if a read row is there. */
function rowAt(clientX: number, clientY: number) {
  if (!canvas.value || !box.value) {
    return undefined;
  }
  const rect = canvas.value.getBoundingClientRect();
  const f = frame(box.value.clientWidth, box.value.clientHeight);
  const x = clientX - rect.left;
  const y = clientY - rect.top;
  if (
    x < MARGIN.left ||
    x > MARGIN.left + f.plotW ||
    y < MARGIN.top ||
    y > MARGIN.top + f.plotH
  ) {
    return undefined;
  }
  const along = props.spec.timeOn === "x" ? x : y;
  const raw = props.spec.time.raw;
  const readUntil = props.spec.unreadFrom ?? raw.length;
  // Only a read row whose own time cell is under the pointer: an unread
  // date or a gap between samples opens no trace. The pixel is taken back
  // to a time (the axis is linear) and the rows searched there.
  const at = pointerTime(f.time, raw, along);
  if (!at) {
    return undefined;
  }
  const best = rowUnder(raw, cells.value.rows, readUntil, at.t, at.tolerance);
  return best < 0 ? undefined : best;
}

/** The value under the pointer, on one line: date | axis value | value. */
const hover = ref<{ lines: string[]; x: number; y: number }>();

/**
 * The readout box beside the pointer, inside the figure: right of it, or
 * left of it past the middle; above it, or below near the top.
 */
function readoutAt(at: { x: number; y: number }) {
  const width = box.value?.clientWidth ?? 0;
  const height = box.value?.clientHeight ?? 0;
  const top = Math.max(4, Math.min(at.y - 58, height - 64));
  const flip = at.x > width / 2;
  // As wide as the room on its side allows, never past the figure.
  const room = `${Math.max(120, (flip ? at.x : width - at.x) - 20)}px`;
  // One width while the pointer moves, as far as the room allows: the box
  // does not jump about (25 Nov).
  const minWidth = `min(17rem, ${room})`;
  return flip
    ? {
        right: `${width - at.x + 14}px`,
        top: `${top}px`,
        maxWidth: room,
        minWidth,
      }
    : { left: `${at.x + 14}px`, top: `${top}px`, maxWidth: room, minWidth };
}

/**
 * The axis cells in pixels, kept while the cells and the figure's size stay.
 */
let pixelsKept:
  { columns: object; size: string; lo: number[]; hi: number[] } | undefined;
function columnPixels(f: TFrame) {
  const { columns } = cells.value;
  const size = `${f.plotW}x${f.plotH}`;
  if (pixelsKept?.columns !== columns || pixelsKept.size !== size) {
    pixelsKept = {
      columns,
      size,
      lo: Array.from(columns.lo, (v) => f.axis(v)),
      hi: Array.from(columns.hi, (v) => f.axis(v)),
    };
  }
  return pixelsKept;
}

function hoverAt(event: PointerEvent) {
  const row = rowAt(event.clientX, event.clientY);
  if (row === undefined || !canvas.value || !box.value) {
    hover.value = undefined;
    return;
  }
  const { spec } = props;
  const rect = canvas.value.getBoundingClientRect();
  const [x, y] = [event.clientX - rect.left, event.clientY - rect.top];
  const f = frame(box.value.clientWidth, box.value.clientHeight);
  const across = spec.timeOn === "x" ? y : x;
  const { lo } = cells.value.columns;
  const pixels = columnPixels(f);
  const column = cellUnder(across, pixels.lo, pixels.hi);
  if (column === undefined) {
    hover.value = undefined;
    return;
  }
  const value = spec.values[row * lo.length + column];
  const place = spec.axis.values[column];
  const shown =
    notes.reduced > 1
      ? pixelExtreme(spec.timeOn === "x" ? x : y, across, f)
      : undefined;
  hover.value = {
    lines: [
      timeLabelAt(spec.time, row),
      titled(
        spec.axis.title,
        spec.axis.format ? spec.axis.format(place) : formatValue(place)
      ),
      Number.isFinite(value)
        ? titled(spec.valueTitle, formatValue(value))
        : "no value",
      // The wind there, when barbs are drawn (indexed as the values).
      ...(spec.wind ? [windLine(spec.wind, row * lo.length + column)] : []),
      // The pixel's colour, on one line that stays while the pointer moves
      // over a figure with several cells to a pixel (25 Nov: two lines
      // came and went, and the box blinked).
      ...(notes.reduced > 1 ? [pixelLine(row, column, shown)] : []),
    ],
    x,
    y,
  };
}

/**
 * What colours the pixel under the pointer: the cell read out above, or the
 * most extreme cell sharing the pixel.
 */
function pixelLine(
  row: number,
  column: number,
  shown: ReturnType<typeof pixelExtreme>
) {
  const { spec } = props;
  if (!shown) {
    return "Colour: this cell";
  }
  if (shown.row === row && shown.column === column) {
    return `Colour: this cell (most extreme of ${shown.n})`;
  }
  const place = spec.axis.values[shown.column];
  // The axis's unit from its title: "Distance along path (km)" → km.
  const unit = /\(([^)]+)\)\s*$/.exec(spec.axis.title)?.[1];
  const where = [
    shown.column !== column
      ? `${spec.axis.format ? spec.axis.format(place) : formatValue(place)}${unit ? ` ${unit}` : ""}`
      : "",
    shown.row !== row ? timeLabelAt(spec.time, shown.row) : "",
  ].filter(Boolean);
  return `Colour: ${formatValue(shown.value)}${where.length ? ` at ${where.join(", ")}` : ""} (most extreme of ${shown.n})`;
}

/**
 * The cell the pixel under the pointer shows when it holds several: the
 * renderer's own winner, read from the image as drawn, never computed again
 * from the cells. Undefined when the pixel holds one cell.
 */
function pixelExtreme(along: number, across: number, f: TFrame) {
  const raster = shownRaster;
  if (!raster) {
    return undefined;
  }
  const ratio = window.devicePixelRatio || 1;
  const timeX = props.spec.timeOn === "x";
  const [alongStart, acrossStart] = timeX
    ? [MARGIN.left, MARGIN.top]
    : [MARGIN.top, MARGIN.left];
  const [alongSize, acrossSize] = timeX
    ? [f.plotW, f.plotH]
    : [f.plotH, f.plotW];
  const pixel = (p: number, start: number, size: number) =>
    Math.min(
      Math.max(0, Math.round(size * ratio) - 1),
      Math.max(0, Math.floor((p - start) * ratio))
    );
  const won = raster.winner(
    pixel(along, alongStart, alongSize),
    pixel(across, acrossStart, acrossSize)
  );
  if (!won || won.rows * won.columns <= 1) {
    return undefined;
  }
  const width = props.spec.axis.values.length;
  return {
    row: won.row,
    column: won.column,
    value: props.spec.values[won.row * width + won.column],
    n: won.rows * won.columns,
    dates: won.rows,
    places: won.columns,
  };
}

function onClick(event: MouseEvent) {
  const row = rowAt(event.clientX, event.clientY);
  if (row !== undefined) {
    emit("pick", row);
  }
}

/** Arrow keys step through the read dates in time order; Enter shows one. */
const focusRow = ref<number>();

function stepRow(direction: number) {
  const raw = props.spec.time.raw;
  const readUntil = props.spec.unreadFrom ?? raw.length;
  if (!readUntil) {
    return;
  }
  // Dated rows in time order: an undated one has no place in it.
  const order = Array.from({ length: readUntil }, (_, at) => at)
    .filter((at) => Number.isFinite(raw[at]))
    .sort((a, b) => raw[a] - raw[b] || a - b);
  const current = props.picked ?? focusRow.value;
  const position = current === undefined ? -1 : order.indexOf(current);
  const next =
    order[Math.max(0, Math.min(order.length - 1, position + direction))];
  focusRow.value = next;
  if (next !== props.picked) {
    emit("pick", next);
  }
}

function onKey(event: KeyboardEvent) {
  const forward = props.spec.timeOn === "x" ? "ArrowRight" : "ArrowUp";
  const backward = props.spec.timeOn === "x" ? "ArrowLeft" : "ArrowDown";
  if (event.key === forward || event.key === backward) {
    event.preventDefault();
    stepRow(event.key === forward ? 1 : -1);
  }
}

const pickedLabel = computed(() =>
  props.picked === undefined
    ? "Use the arrow keys to choose a date and show its trace."
    : `Showing the trace at ${timeLabelAt(props.spec.time, props.picked)}.`
);

onMounted(redraw);
watch(() => [props.spec, props.scale, props.line], redraw);
// A trace picked (arrow keys, a click) moves its marker over the cells, as map
// time does: the cells are not drawn again.
watch(
  () => props.picked,
  () => draw(false)
);
watch(
  () => props.mapTime,
  () => draw(false)
);
useResizeObserver(box, () => draw());

defineExpose({ canvas: () => canvas.value, renderExport });
</script>

<template>
  <div ref="box" class="analysis-heatmap">
    <canvas
      ref="canvas"
      role="img"
      tabindex="0"
      :aria-label="`${spec.description}. ${pickedLabel}`"
      @click="onClick"
      @keydown="onKey"
      @pointermove="
        emit('hoverDistance', distanceAt($event.clientX));
        hoverAt($event);
      "
      @pointerleave="
        emit('hoverDistance', undefined);
        hover = undefined;
      "
    ></canvas>
    <div
      v-if="hover"
      class="cell-readout"
      :style="readoutAt(hover)"
      role="status"
    >
      <strong>{{ hover.lines[0] }}</strong>
      <span
        v-for="part in hover.lines.slice(1)"
        :key="part"
        :class="{ 'cell-readout-pixel': part.startsWith('Colour: ') }"
        >{{ part }}</span
      >
    </div>
    <div
      v-if="cursorLeft() !== undefined"
      class="map-cursor"
      :style="{
        left: `${cursorLeft()}px`,
        top: `${MARGIN.top}px`,
        bottom: `${MARGIN.bottom}px`,
      }"
      aria-hidden="true"
    ></div>
    <div v-if="levelAt" class="map-level" :style="levelAt" aria-hidden="true">
      <span>map level</span>
    </div>
  </div>
</template>

<style scoped>
.analysis-heatmap {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 160px;
}
.analysis-heatmap canvas {
  cursor: crosshair;
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
}
.analysis-heatmap canvas:focus-visible {
  outline: 2px solid var(--plot-accent);
  outline-offset: -2px;
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
/* The value under the pointer in a small box beside it (Zabbix-like):
 * the date or place, then the coordinate and the value. */
.cell-readout {
  position: absolute;
  z-index: 3;
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
.cell-readout strong {
  white-space: nowrap;
}
.cell-readout span {
  white-space: normal;
  overflow-wrap: anywhere;
}
/* The pixel's colour on one line, cut rather than wrapped: the box keeps
   its height as the pointer moves (25 Nov). */
.cell-readout span.cell-readout-pixel {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: var(--plot-muted, #64748b);
}
.cell-readout strong {
  font-weight: 600;
  color: var(--plot-muted, #64748b);
}
</style>
