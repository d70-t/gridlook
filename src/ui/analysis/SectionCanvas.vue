<script lang="ts" setup>
import { useResizeObserver } from "@vueuse/core";
import { computed, onMounted, ref, watch } from "vue";

import { cellUnder, titled } from "./chartZoom.ts";
import { drawScaleBar, keyLines } from "./colourBar.ts";
import { HIDDEN, paletteIndex, type TColourScale } from "./colourScale.ts";
import { plotColor } from "./figure.ts";
import {
  columnMembers,
  moreExtreme,
  niceTicks,
  sameMembers,
} from "./heatmapRaster.ts";
import {
  axisMarks,
  curtainEdges,
  drawAxisMarks,
  edgesFromBounds,
  layerSpans,
} from "./pathMarks.ts";
import { drawBarbGrid, windLine } from "./windBarbs.ts";

import {
  ANALYSIS_KINDS,
  SAMPLE_STATUS,
  type TAnalysisResult,
} from "@/lib/analysis/types.ts";
import { formatValue } from "@/utils/formatValue.ts";

const props = defineProps<{
  result: TAnalysisResult;
  /** The map's colour scale (or this plot's own range, labelled). */
  scale: TColourScale;
  /** Vertical axis title, e.g. "Depth (m)" or "Model level (index)". */
  verticalTitle: string;
  /** Colour bar title: the quantity and its units. */
  valueTitle: string;
  /** Wind barbs per sample and level (indexed as the values). */
  wind?: { u: number[]; v: number[]; units?: string };
  /** A distance (m) pointed at on the map's path: a line marks it here. */
  cursor?: number;
  /** The path's samples drawn against latitude (one that does not turn). */
  alongLatitude?: boolean;
  /** The map's level (index): a line marks it, moving as the level plays. */
  mapLevel?: number;
}>();
/** The distance (m) along the path under the pointer, or undefined. */
const emit = defineEmits<{ hoverDistance: [meters: number | undefined] }>();

const canvas = ref<HTMLCanvasElement>();
const box = ref<HTMLDivElement>();
let palette: Uint8ClampedArray | undefined;
let paletteName = "";

const MARGIN = { left: 58, right: 72, top: 26, bottom: 46 };

function loadPalette(name: string): Promise<void> {
  return new Promise((resolve) => {
    const image = new Image();
    image.onload = () => {
      const scratch = document.createElement("canvas");
      scratch.width = 256;
      scratch.height = 1;
      const context = scratch.getContext("2d")!;
      context.drawImage(image, 0, 0, 256, 1);
      palette = context.getImageData(0, 0, 256, 1).data;
      paletteName = name;
      resolve();
    };
    image.onerror = () => resolve();
    image.src = `${import.meta.env.BASE_URL}static/colormaps/${name}.webp`;
  });
}

/** The palette at a position 0–1 (already inverted and stepped). */
function colour(t: number) {
  const index = Math.max(0, Math.min(255, Math.round(t * 255)));
  if (!palette) {
    return `rgb(${index},${index},${index})`;
  }
  return `rgb(${palette[4 * index]},${palette[4 * index + 1]},${palette[4 * index + 2]})`;
}

function edges(centres: ArrayLike<number>) {
  const n = centres.length;
  const out = new Array<number>(n + 1);
  for (let at = 1; at < n; at++) {
    out[at] = (centres[at - 1] + centres[at]) / 2;
  }
  out[0] = n > 1 ? centres[0] - (out[1] - centres[0]) : centres[0] - 0.5;
  out[n] =
    n > 1 ? centres[n - 1] + (centres[n - 1] - out[n - 1]) : centres[0] + 0.5;
  return out;
}

function finiteRange(values: ArrayLike<number>) {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (let at = 0; at < values.length; at++) {
    const value = values[at];
    if (Number.isFinite(value)) {
      low = value < low ? value : low;
      high = value > high ? value : high;
    }
  }
  return { low, high, empty: low > high };
}

function columnEdgeRange(ns: number, zEdges: (s: number) => number[]) {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (let s = 0; s < ns; s++) {
    const range = finiteRange(zEdges(s));
    low = Math.min(low, range.low);
    high = Math.max(high, range.high);
  }
  return { low, high };
}

type TPrepared = {
  ns: number;
  nk: number;
  xEdges: number[];
  /** Per column vertical edges (length nk + 1), or one shared set. */
  zEdges: (s: number) => number[];
  /** One layer's [z0, z1]: its own published bounds, else its edges. */
  zSpan: (s: number, k: number) => [number, number];
  zLow: number;
  zHigh: number;
  value: { low: number; high: number; empty: boolean };
  /**
   * Palette index per cell (the map's scale), -1 missing in a stored
   * column, -2 no cell, -3 hidden by the map's limits (left empty).
   */
  shade: Int16Array;
  /** Palette index of the mean value: extremes are measured from it. */
  centre: number;
  down: boolean;
  /** Which kinds of absence occur, each with its own key entry. */
  hasMissing: boolean;
  hasNoCell: boolean;
  hasHidden: boolean;
  /** Cells not read yet (a section filling in). */
  hasPending: boolean;
};

/** A cell a section filling in has not read yet: left empty. */
const PENDING = -4;

let prepared: TPrepared | undefined;

/** Geometry and colour indices, once per result (not per resize). */
// eslint-disable-next-line max-lines-per-function
function prepare(): TPrepared {
  const { result } = props;
  const [ns, nk] = result.shape;
  const vertical = result.vertical!;
  const perColumn = result.columnVertical;
  let xEdges: number[];
  if (binnedMode()) {
    // Latitude bins on their true (clipped) edges.
    const axis = result.axis!;
    xEdges =
      axis.bounds?.length === ns + 1 ? [...axis.bounds] : edges(axis.values);
  } else {
    xEdges = curtainEdges(result.samples!, ns, Boolean(props.alongLatitude));
  }
  const common = vertical.physical
    ? vertical.values
    : vertical.values.map((_, k) => k);
  // Published layer bounds when they join up; midpoints otherwise.
  const commonEdges =
    (vertical.physical
      ? edgesFromBounds(vertical.bounds, common.length)
      : undefined) ?? edges(common);
  // Independently bounded layers (not joined) keep their own intervals,
  // so a real gap between them is not filled.
  const spans =
    vertical.physical && !perColumn && !edgesFromBounds(vertical.bounds, nk)
      ? layerSpans(vertical.bounds, nk)
      : undefined;
  const columnEdges = new Map<number, number[]>();
  const zEdges = (s: number) => {
    if (!perColumn) {
      return commonEdges;
    }
    let cached = columnEdges.get(s);
    if (!cached) {
      cached = edges(perColumn.slice(s * nk, s * nk + nk));
      columnEdges.set(s, cached);
    }
    return cached;
  };
  // The frame spans the cells' edges, not their centres, so the top and
  // bottom layers are drawn whole and nothing spills past the frame.
  const zSpan = (s: number, k: number): [number, number] => {
    if (spans) {
      return [spans[2 * k], spans[2 * k + 1]];
    }
    const e = zEdges(s);
    return [e[k], e[k + 1]];
  };
  const zRange = perColumn
    ? columnEdgeRange(ns, zEdges)
    : spans
      ? finiteRange(Array.from(spans))
      : {
          low: Math.min(commonEdges[0], commonEdges[nk]),
          high: Math.max(commonEdges[0], commonEdges[nk]),
        };
  const value = finiteRange(result.values);
  const status = result.samples?.status ?? [];
  const shade = new Int16Array(ns * nk);
  let hasMissing = false;
  let hasNoCell = false;
  let hasHidden = false;
  let hasPending = false;
  let sum = 0;
  let valid = 0;
  // Cells still to come are left empty under their own key, never hatched as
  // missing.
  const pending = (at: number) =>
    Boolean(result.partial?.chunks && !result.cellRead?.[at]);
  for (let s = 0; s < ns; s++) {
    for (let k = 0; k < nk; k++) {
      const v = result.values[s * nk + k];
      shade[s * nk + k] = Number.isFinite(v)
        ? paletteIndex(props.scale, v)
        : status[s] === "no stored cell"
          ? -2
          : pending(s * nk + k)
            ? PENDING
            : -1;
      hasPending ||= shade[s * nk + k] === PENDING;
      hasMissing ||= shade[s * nk + k] === -1;
      hasNoCell ||= shade[s * nk + k] === -2;
      hasHidden ||= shade[s * nk + k] === HIDDEN;
      if (shade[s * nk + k] >= 0) {
        sum += shade[s * nk + k];
        valid++;
      }
    }
  }
  return {
    ns,
    nk,
    xEdges,
    zEdges,
    zSpan,
    zLow: zRange.low,
    zHigh: zRange.high,
    value,
    shade,
    centre: valid ? sum / valid : 127.5,
    // Depth and pressure grow downwards; heights and indices upwards.
    down: vertical.positive === "down",
    hasMissing,
    hasPending,
    hasNoCell,
    hasHidden,
  };
}

function hatch(context: CanvasRenderingContext2D, stroke: string) {
  const tile = document.createElement("canvas");
  tile.width = 6;
  tile.height = 6;
  const t = tile.getContext("2d")!;
  t.strokeStyle = stroke;
  t.lineWidth = 1;
  t.beginPath();
  t.moveTo(0, 6);
  t.lineTo(6, 0);
  t.stroke();
  return context.createPattern(tile, "repeat")!;
}

/** "#rrggbb", "#rgb" or "rgb(r, g, b)" as bytes (slate grey otherwise). */
function rgbBytes(colour: string): number[] {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(colour.trim());
  if (hex) {
    const h =
      hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join("") : hex[1];
    return [0, 2, 4].map((at) => parseInt(h.slice(at, at + 2), 16));
  }
  const rgb = colour.match(/\d+(\.\d+)?/g);
  return rgb && rgb.length >= 3 ? rgb.slice(0, 3).map(Number) : [100, 116, 139];
}

/** Palette colour of a shade code as RGB bytes. */
function rgbOf(code: number): [number, number, number] {
  const index = Math.max(0, Math.min(255, Math.round(code)));
  return palette
    ? [palette[4 * index], palette[4 * index + 1], palette[4 * index + 2]]
    : [index, index, index];
}

/**
 * The cells as one image at device resolution, bounded by pixels. Every
 * pixel column shows the most extreme value among exactly the samples whose
 * extent intersects it: a narrow peak keeps its own pixel, and a wide cell
 * beside it paints the rest of its width from its own value. Per pixel row
 * the most extreme level wins (farthest from the plot's mean value, ties to
 * the larger), so a thin peak survives; a missing value only where no valid level is
 * there. Neighbouring columns with the same samples reuse one reduction.
 */
function drawCells(
  context: CanvasRenderingContext2D,
  p: TPrepared,
  px: (d: number) => number,
  py: (z: number) => number,
  frame: { plotW: number; plotH: number; ratio: number; hatch: string }
) {
  const { ratio } = frame;
  const W = Math.max(1, Math.round(frame.plotW * ratio));
  const H = Math.max(1, Math.round(frame.plotH * ratio));
  const image = context.createImageData(W, H);
  const devX = (d: number) => (px(d) - MARGIN.left) * ratio;
  const devY = (z: number) => (py(z) - MARGIN.top) * ratio;
  const columns = columnMembers(p.xEdges, devX, W);
  const best = new Int16Array(H);
  let previous = -1;
  for (let x = 0; x < W; x++) {
    const [from, to] = [columns.start[x], columns.start[x + 1]];
    if (from === to) {
      previous = -1;
      continue;
    }
    if (previous < 0 || !sameMembers(columns, previous, x)) {
      best.fill(-3);
      for (let k = from; k < to; k++) {
        mergeLevels(p, columns.items[k], best, devY, H);
      }
    }
    paintColumns(image, best, x, x + 1, frame.hatch);
    previous = x;
  }
  context.putImageData(
    image,
    Math.round(MARGIN.left * ratio),
    Math.round(MARGIN.top * ratio)
  );
}

/** Fold one sample's levels into the per-row extremes. */
function mergeLevels(
  p: TPrepared,
  s: number,
  best: Int16Array,
  devY: (z: number) => number,
  H: number
) {
  // -3: nothing; -2: no stored cell; -1: missing; ≥0: palette index.
  for (let k = 0; k < p.nk; k++) {
    const code = p.shade[s * p.nk + k];
    const [z0, z1] = p.zSpan(s, k);
    if (!Number.isFinite(z0) || !Number.isFinite(z1)) {
      continue;
    }
    const [ya, yb] = [devY(z0), devY(z1)];
    const y0 = Math.max(0, Math.floor(Math.min(ya, yb)));
    const y1 = Math.min(H, Math.max(y0 + 1, Math.ceil(Math.max(ya, yb))));
    for (let y = y0; y < y1; y++) {
      const held = best[y];
      if (code >= 0 ? moreExtreme(code, held, p.centre) : code > held) {
        best[y] = code;
      }
    }
  }
}

/** Paint pixel columns [from, to) with the per-row codes. */
function paintColumns(
  image: ImageData,
  best: Int16Array,
  from: number,
  to: number,
  hatchColour: string
) {
  const { data: pixels, width: W } = image;
  const hatchRgb = rgbBytes(hatchColour);
  for (let y = 0; y < best.length; y++) {
    const code = best[y];
    if (code <= -2) {
      continue; // no stored cell: the background shows through
    }
    const [r, g, bl] = code >= 0 ? rgbOf(code) : hatchRgb;
    for (let x = from; x < to; x++) {
      if (code === -1 && (x + y) % 6 !== 0) {
        continue;
      }
      const at = 4 * (y * W + x);
      pixels[at] = r;
      pixels[at + 1] = g;
      pixels[at + 2] = bl;
      pixels[at + 3] = 255;
    }
  }
}

/** A latitude or longitude × vertical section rather than a path curtain. */
function binnedMode() {
  return (
    props.result.kind === ANALYSIS_KINDS.LAT_VERTICAL ||
    props.result.kind === ANALYSIS_KINDS.LON_VERTICAL
  );
}

/**
 * Drawn against latitude (or longitude): a binned section, or a curtain's
 * samples by their latitudes, still a path's.
 */
function latitudeMode() {
  return binnedMode() || Boolean(props.alongLatitude);
}

/** The sample nearest a latitude on the curtain's axis. */
function sampleAtLatitude(lat: number) {
  const lats = props.result.samples?.lats ?? [];
  let [best, at] = [Infinity, -1];
  lats.forEach((value, k) => {
    if (Math.abs(value - lat) < best) {
      [best, at] = [Math.abs(value - lat), k];
    }
  });
  return at;
}

const alongLongitude = () => props.result.kind === ANALYSIS_KINDS.LON_VERTICAL;

/** A bin's place: 10° N, or 150° W along a longitude section. */
function latitudeText(value: number) {
  if (alongLongitude()) {
    const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
    const r = Math.round(wrapped * 100) / 100;
    return r === 0 || Math.abs(r) === 180
      ? `${formatValue(Math.abs(r))}°`
      : `${formatValue(Math.abs(r))}° ${r > 0 ? "E" : "W"}`;
  }
  const rounded = Math.round(value * 100) / 100;
  return rounded === 0
    ? "0°"
    : `${formatValue(Math.abs(rounded))}° ${rounded > 0 ? "N" : "S"}`;
}

function drawXAxis(
  context: CanvasRenderingContext2D,
  p: TPrepared,
  size: { width: number; height: number; plotW: number; plotH: number },
  px: (d: number) => number
) {
  const fg = plotColor(canvas.value, "--plot-fg", "#1f2937");
  const x0 = p.xEdges[0];
  const x1 = p.xEdges[p.ns];
  const below = MARGIN.top + size.plotH + 13;
  context.textAlign = "center";
  if (latitudeMode()) {
    for (const value of niceTicks(Math.min(x0, x1), Math.max(x0, x1), 4)) {
      context.fillText(latitudeText(value), px(value), below);
    }
    context.fillStyle = fg;
    context.fillText(
      alongLongitude() ? "Longitude" : "Latitude",
      MARGIN.left + size.plotW / 2,
      size.height - 4
    );
    return;
  }
  for (const km of niceTicks(x0 / 1000, x1 / 1000, 4)) {
    context.fillText(formatValue(km), px(km * 1000), below + 6);
  }
  context.fillStyle = fg;
  context.fillText(
    "Distance along path (km)",
    MARGIN.left + size.plotW / 2,
    size.height - 4
  );
  // The path's numbered points, as on the map.
  drawAxisMarks(
    context,
    axisMarks(props.result.samples?.vertices),
    px,
    MARGIN.top + size.plotH,
    {
      fill: plotColor(canvas.value, "--plot-bg", "#ffffff"),
      text: fg,
      ring: plotColor(canvas.value, "--plot-line", "#1d4ed8"),
    },
    [MARGIN.left, MARGIN.left + size.plotW]
  );
}

/** The path distance (m) under a pointer position, if over the plot. */
/** The map's level across the section (levels the same in every column). */
/** Bumped on every draw: overlays placed from the drawing follow it. */
const drawTick = ref(0);
const levelAt = computed(() => {
  void drawTick.value;
  const p = prepared;
  const k = props.mapLevel;
  const vertical = props.result.vertical;
  const height = box.value?.clientHeight;
  const width = box.value?.clientWidth;
  if (
    k === undefined ||
    !p ||
    !vertical ||
    props.result.columnVertical ||
    !height ||
    !width
  ) {
    return undefined;
  }
  const z = vertical.physical ? vertical.values[k] : k;
  const t = (z - p.zLow) / (p.zHigh - p.zLow || 1);
  if (!(t >= 0 && t <= 1)) {
    return undefined;
  }
  const plotH = height - MARGIN.top - MARGIN.bottom;
  return {
    top: `${MARGIN.top + (p.down ? t : 1 - t) * plotH}px`,
    left: `${MARGIN.left}px`,
    width: `${width - MARGIN.left - MARGIN.right}px`,
  };
});

/** Where the map's pointer is along the path, as a left offset (px). */
function cursorLeft() {
  const p = prepared;
  const width = box.value?.clientWidth;
  if (props.cursor === undefined || !p || !width || binnedMode()) {
    return undefined;
  }
  // Against latitude: at the sample nearest the map's distance.
  let along = props.cursor;
  if (props.alongLatitude) {
    const distances = props.result.samples?.distances ?? [];
    let [best, at] = [Infinity, -1];
    distances.forEach((d, k) => {
      if (Math.abs(d - props.cursor!) < best) {
        [best, at] = [Math.abs(d - props.cursor!), k];
      }
    });
    if (at < 0) {
      return undefined;
    }
    along = props.result.samples!.lats[at];
  }
  const f = (along - p.xEdges[0]) / (p.xEdges[p.ns] - p.xEdges[0] || 1);
  return f >= 0 && f <= 1
    ? MARGIN.left + f * (width - MARGIN.left - MARGIN.right)
    : undefined;
}

function distanceAt(clientX: number) {
  const p = prepared;
  const element = canvas.value;
  if (!p || !element || binnedMode()) {
    return undefined;
  }
  const rect = element.getBoundingClientRect();
  const plotW = rect.width - MARGIN.left - MARGIN.right;
  const f = (clientX - rect.left - MARGIN.left) / plotW;
  if (!(f >= 0 && f <= 1)) {
    return undefined;
  }
  const x = p.xEdges[0] + f * (p.xEdges[p.ns] - p.xEdges[0]);
  // Against latitude: the distance of the sample there, not degrees.
  if (props.alongLatitude) {
    const at = sampleAtLatitude(x);
    return at >= 0 ? props.result.samples!.distances[at] : undefined;
  }
  return x;
}

/** Sample `s`'s level `k` as drawn: its own height, the shared one or an index. */
function levelValue(s: number, k: number, nk: number) {
  const { result } = props;
  return result.columnVertical
    ? result.columnVertical[s * nk + k]
    : result.vertical!.physical
      ? result.vertical!.values[k]
      : k;
}

/** The value under the pointer, on one line: place | level | value. */
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
  return flip
    ? { right: `${width - at.x + 14}px`, top: `${top}px`, maxWidth: room }
    : { left: `${at.x + 14}px`, top: `${top}px`, maxWidth: room };
}

// eslint-disable-next-line max-lines-per-function
function hoverAt(event: PointerEvent) {
  const p = prepared;
  const element = canvas.value;
  hover.value = undefined;
  if (!p || !element || p.value.empty) {
    return;
  }
  const rect = element.getBoundingClientRect();
  const [x, y] = [event.clientX - rect.left, event.clientY - rect.top];
  const fx = (x - MARGIN.left) / (rect.width - MARGIN.left - MARGIN.right);
  const fy = (y - MARGIN.top) / (rect.height - MARGIN.top - MARGIN.bottom);
  if (!(fx >= 0 && fx <= 1 && fy >= 0 && fy <= 1)) {
    return;
  }
  const d = p.xEdges[0] + fx * (p.xEdges[p.ns] - p.xEdges[0]);
  const z = p.zLow + (p.down ? fy : 1 - fy) * (p.zHigh - p.zLow);
  const s = cellUnder(d, p.xEdges.slice(0, p.ns), p.xEdges.slice(1));
  if (s === undefined) {
    return;
  }
  const spans = Array.from({ length: p.nk }, (_, k) => p.zSpan(s, k));
  const k = cellUnder(
    z,
    spans.map(([a]) => a),
    spans.map(([, b]) => b)
  );
  if (k === undefined) {
    return;
  }
  const { result } = props;
  const level = levelValue(s, k, p.nk);
  const value = result.values[s * p.nk + k];
  hover.value = {
    lines: [
      binnedMode()
        ? latitudeText(result.axis!.values[s])
        : props.alongLatitude
          ? `${latitudeText(result.samples!.lats[s])} (${formatValue(result.samples!.distances[s] / 1000)} km)`
          : `${formatValue(result.samples!.distances[s] / 1000)} km`,
      // The level the value is of, and the pointer's own where it differs.
      titled(props.verticalTitle, formatValue(level)) +
        (formatValue(z) !== formatValue(level)
          ? ` (pointer at ${formatValue(z)})`
          : ""),
      Number.isFinite(value)
        ? titled(props.valueTitle, formatValue(value))
        : cellStatus(result, s, s * p.nk + k),
      // The wind there, when barbs are drawn (as they are indexed).
      ...(props.wind && !binnedMode()
        ? [windLine(props.wind, s * p.nk + k)]
        : []),
    ],
    x,
    y,
  };
}

function drawAxes(
  context: CanvasRenderingContext2D,
  p: TPrepared,
  size: { width: number; height: number; plotW: number; plotH: number },
  px: (d: number) => number,
  py: (z: number) => number
) {
  const fg = plotColor(canvas.value, "--plot-fg", "#1f2937");
  const muted = plotColor(canvas.value, "--plot-muted", "#4b5563");
  context.strokeStyle = plotColor(canvas.value, "--plot-border", "#94a3b8");
  context.strokeRect(MARGIN.left, MARGIN.top, size.plotW, size.plotH);
  context.font = "11px sans-serif";
  context.fillStyle = muted;
  drawXAxis(context, p, size, px);
  context.textAlign = "right";
  context.fillStyle = muted;
  const integerLevels = props.verticalTitle.startsWith("Model level");
  for (const z of niceTicks(p.zLow, p.zHigh, 4)) {
    if (integerLevels && !Number.isInteger(z)) {
      continue;
    }
    context.fillText(formatValue(z), MARGIN.left - 6, py(z) + 4);
  }
  context.save();
  context.translate(12, MARGIN.top + size.plotH / 2);
  context.rotate(-Math.PI / 2);
  context.textAlign = "center";
  context.fillStyle = fg;
  context.fillText(props.verticalTitle, 0, 0);
  context.restore();
  context.textAlign = "left";
}

// eslint-disable-next-line max-lines-per-function
function drawColourBar(
  context: CanvasRenderingContext2D,
  p: TPrepared,
  plotH: number,
  width: number,
  missing: CanvasPattern
) {
  const fg = plotColor(canvas.value, "--plot-fg", "#1f2937");
  const muted = plotColor(canvas.value, "--plot-muted", "#4b5563");
  const barX = width - MARGIN.right + 12;
  context.font = "11px sans-serif";
  if (p.value.empty) {
    context.fillStyle = missing;
    context.fillRect(barX, MARGIN.top, 12, 12);
    context.fillStyle = muted;
    context.fillText("No data", barX - 2, MARGIN.top + 26);
    return;
  }
  // Distinct entries: a stored cell without a value, and no stored cell;
  // each key on one or two lines of the room beside the bar, the bar
  // above them (24 Nov: keys ran off a narrow figure).
  const room = MARGIN.right - 29;
  context.font = "10px sans-serif";
  const keys: { label: string; paint: (y: number) => void }[] = [
    ...(p.hasNoCell
      ? [
          {
            label: "no cell",
            paint: (y: number) => {
              context.strokeStyle = muted;
              context.strokeRect(barX + 0.5, y + 0.5, 11, 11);
            },
          },
        ]
      : []),
    ...(p.hasHidden
      ? [
          {
            label: "hidden on map",
            paint: (y: number) => {
              context.strokeStyle = muted;
              context.setLineDash([2, 2]);
              context.strokeRect(barX + 0.5, y + 0.5, 11, 11);
              context.setLineDash([]);
            },
          },
        ]
      : []),
    ...(p.hasPending
      ? [
          {
            label: "not read yet",
            paint: (y: number) => {
              context.strokeStyle = muted;
              context.setLineDash([1, 2]);
              context.strokeRect(barX + 0.5, y + 0.5, 11, 11);
              context.setLineDash([]);
            },
          },
        ]
      : []),
    // Only where a value is missing (a complete section has no such key).
    ...(p.hasMissing
      ? [
          {
            label: "missing",
            paint: (y: number) => {
              context.fillStyle = missing;
              context.fillRect(barX, y, 12, 12);
            },
          },
        ]
      : []),
  ];
  const lines = keys.map((key) => keyLines(context, key.label, room));
  const keysHeight = lines.reduce((h, l) => h + 5 + 11 * l.length, 0);
  context.font = "11px sans-serif";
  drawScaleBar(
    context,
    {
      x: barX,
      top: MARGIN.top,
      height: Math.max(12, plotH - keysHeight - 8),
      room,
    },
    props.scale,
    props.result.values,
    { fg, muted, colour, fit: fitText }
  );
  context.font = "10px sans-serif";
  let keyY = MARGIN.top + plotH - 12;
  keys.forEach((key, k) => {
    keyY -= 11 * (lines[k].length - 1);
    key.paint(keyY);
    context.fillStyle = muted;
    lines[k].forEach((line, n) =>
      context.fillText(line, barX + 15, keyY + 10 + 11 * n)
    );
    keyY -= 16;
  });
  context.font = "11px sans-serif";
  // The caption reads horizontally above the bar, cut to fit small windows.
  context.fillStyle = fg;
  context.textAlign = "right";
  context.fillText(
    fitText(context, props.valueTitle, width - 8),
    width - 4,
    MARGIN.top - 10
  );
  context.textAlign = "left";
}

function fitText(context: CanvasRenderingContext2D, text: string, max: number) {
  if (context.measureText(text).width <= max) {
    return text;
  }
  let cut = text.length;
  while (cut > 1 && context.measureText(`${text.slice(0, cut)}…`).width > max) {
    cut--;
  }
  return `${text.slice(0, cut)}…`;
}

function draw() {
  const container = box.value;
  if (canvas.value && container) {
    drawOn(
      canvas.value,
      container.clientWidth,
      container.clientHeight,
      window.devicePixelRatio || 1
    );
    drawTick.value++;
  }
}

function drawOn(
  element: HTMLCanvasElement,
  width: number,
  height: number,
  ratio: number
) {
  prepared ??= prepare();
  const p = prepared;
  element.width = Math.max(1, Math.round(width * ratio));
  element.height = Math.max(1, Math.round(height * ratio));
  const context = element.getContext("2d")!;
  context.setTransform(ratio, 0, 0, ratio, 0, 0);
  context.clearRect(0, 0, width, height);
  const plotW = width - MARGIN.left - MARGIN.right;
  const plotH = height - MARGIN.top - MARGIN.bottom;
  const x0 = p.xEdges[0];
  const x1 = p.xEdges[p.ns];
  const px = (d: number) => MARGIN.left + ((d - x0) / (x1 - x0 || 1)) * plotW;
  const py = (z: number) => {
    const t = (z - p.zLow) / (p.zHigh - p.zLow || 1);
    return MARGIN.top + (p.down ? t : 1 - t) * plotH;
  };
  const missing = hatch(context, plotColor(element, "--plot-muted", "#64748b"));
  if (p.value.empty) {
    context.fillStyle = plotColor(element, "--plot-muted", "#4b5563");
    context.font = "12px sans-serif";
    context.textAlign = "center";
    context.fillText(
      "No valid values along this path at this time.",
      MARGIN.left + plotW / 2,
      MARGIN.top + plotH / 2
    );
    context.textAlign = "left";
  } else {
    drawCells(context, p, px, py, {
      plotW,
      plotH,
      ratio,
      hatch: plotColor(element, "--plot-muted", "#64748b"),
    });
    drawWind(context, px, py, element, { plotW, plotH });
  }
  drawAxes(context, p, { width, height, plotW, plotH }, px, py);
  drawColourBar(context, p, plotH, width, missing);
}

/**
 * Wind barbs along the path: samples and levels thinned apart, in map sense
 * (north up), each mirrored by its own sample's hemisphere, with stations
 * inside the frame (clear of the axes' labels).
 */
function drawWind(
  context: CanvasRenderingContext2D,
  px: (d: number) => number,
  py: (z: number) => number,
  element: HTMLCanvasElement,
  frame: { plotW: number; plotH: number }
) {
  const { result, wind } = props;
  const samples = result.samples;
  const vertical = result.vertical;
  if (!wind || !samples || !vertical || binnedMode()) {
    return;
  }
  const [ns, nk] = result.shape;
  const levelOf = (s: number, k: number) =>
    result.columnVertical
      ? result.columnVertical[s * nk + k]
      : vertical.physical
        ? vertical.values[k]
        : k;
  const inside = (value: number, start: number, size: number) =>
    value >= start + 8 && value <= start + size - 8 ? value : Number.NaN;
  // Against latitude, at each sample's latitude.
  const xs = (props.alongLatitude ? samples.lats : samples.distances)
    .slice(0, ns)
    .map((d) => inside(px(d), MARGIN.left, frame.plotW));
  const yOf = (s: number, k: number) =>
    inside(py(levelOf(s, k)), MARGIN.top, frame.plotH);
  // Levels thinned along a representative (middle) column.
  const ys = Array.from({ length: nk }, (_, k) => yOf(Math.floor(ns / 2), k));
  drawBarbGrid(
    context,
    {
      rows: xs,
      columns: ys,
      // Levels at an even stride, a barb's length apart (13 px barbs).
      gap: [32, 20],
      even: true,
      at: (s, k) => [xs[s], yOf(s, k)],
      index: (s, k) => s * nk + k,
      flip: (s) => samples.lats[s] < 0,
    },
    wind,
    {
      length: 13,
      color: plotColor(element, "--plot-fg", "#1f2937"),
      halo: plotColor(element, "--plot-bg", "#ffffff"),
    }
  );
}

/**
 * A cell without a value: not read yet (still to come), missing (read, no
 * value, in a column that has some), or its column's own status (outside the
 * source, all missing).
 */
function cellStatus(result: TAnalysisResult, s: number, at: number) {
  const column = result.samples?.status?.[s];
  if (column === SAMPLE_STATUS.OUTSIDE) {
    return column;
  }
  if (result.partial && !result.cellRead?.[at]) {
    return "not read yet";
  }
  if (result.partial) {
    return "missing";
  }
  return column === SAMPLE_STATUS.OK ? "missing" : (column ?? "no value");
}

let drawn: Promise<void> = Promise.resolve();

function redraw() {
  drawn = (async () => {
    prepared = undefined;
    if (paletteName !== props.scale.colormap) {
      await loadPalette(props.scale.colormap);
    }
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

onMounted(redraw);
watch(
  () => [props.result, props.scale, props.wind, props.alongLatitude],
  redraw
);
useResizeObserver(box, draw);

defineExpose({ canvas: () => canvas.value, renderExport });
</script>

<template>
  <div ref="box" class="analysis-section">
    <canvas
      ref="canvas"
      role="img"
      :aria-label="`Cross-section of ${valueTitle}: ${alongLatitude ? 'latitude' : 'distance along the path'} against ${verticalTitle}`"
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
      <span v-for="line in hover.lines.slice(1)" :key="line">{{ line }}</span>
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
.analysis-section {
  position: relative;
  width: 100%;
  height: 100%;
  min-height: 140px;
}
.analysis-section canvas {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
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
.cell-readout strong {
  font-weight: 600;
  color: var(--plot-muted, #64748b);
}
</style>
