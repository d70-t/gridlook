import { nextTick } from "vue";

import { drawnName } from "./boxFootprint.ts";
import { REGION_MODES, regionModeOf } from "./regionModes.ts";

import { instantKey, parseTimeAxis } from "@/lib/analysis/calendar.ts";
import { countriesName } from "@/lib/analysis/countryAtlas.ts";
import { boxLonSpan } from "@/lib/analysis/sphere.ts";
import {
  readsIndices,
  rowsBefore,
  type TTimeSelection,
} from "@/lib/analysis/timeRows.ts";
import {
  ANALYSIS_KINDS,
  PATH_KINDS,
  GEOMETRY_KINDS,
  geometryKey,
  TIME_RANGE_KINDS,
  type TAnalysisKind,
  type TAnalysisQuery,
  type TGeometry,
  countryIds,
} from "@/lib/analysis/types.ts";
import { converter } from "@/lib/analysis/unitConvert.ts";
import {
  buildValueCodec,
  decodeStoredBigInt,
  decodeStoredValue,
} from "@/lib/analysis/valueDecoding.ts";
import {
  PLOT_STATUS,
  type TMapSettings,
  type TPlotWindow,
} from "@/store/analysisStore.ts";
import type { useGlobeControlStore } from "@/store/store.ts";
import {
  CONTROL_PANEL_WIDTH,
  MOBILE_BREAKPOINT,
  TITLE_BAR_HEIGHT,
} from "@/ui/common/viewConstants.ts";

/** The map's size; `top` is how far the app's title bar reaches into it. */
type TArea = { width: number; height: number; top?: number };

const INITIAL_SIZES: Record<TAnalysisKind, { w: number; h: number }> = {
  // Room for the title, the toolbar, the figure, the read status and the view
  // tabs underneath.
  [ANALYSIS_KINDS.POINT_SERIES]: { w: 480, h: 340 },
  [ANALYSIS_KINDS.REGION_SERIES]: { w: 500, h: 360 },
  [ANALYSIS_KINDS.PROFILE]: { w: 360, h: 420 },
  [ANALYSIS_KINDS.SECTION]: { w: 540, h: 380 },
  [ANALYSIS_KINDS.TIME_DEPTH]: { w: 540, h: 400 },
  [ANALYSIS_KINDS.HOVMOLLER_LON]: { w: 500, h: 460 },
  [ANALYSIS_KINDS.HOVMOLLER_LAT]: { w: 540, h: 420 },
  [ANALYSIS_KINDS.HOVMOLLER_PATH]: { w: 500, h: 460 },
  // Taller and wider: Curve, Range and Above over the bars.
  [ANALYSIS_KINDS.DISTRIBUTION]: { w: 560, h: 460 },
  [ANALYSIS_KINDS.LAT_VERTICAL]: { w: 540, h: 440 },
  [ANALYSIS_KINDS.LON_VERTICAL]: { w: 580, h: 440 },
};

export function isNarrow(area: TArea) {
  return area.width < MOBILE_BREAKPOINT;
}

/** New windows cascade from the right edge, leaving the map's left visible. */
export function cascadeRect(kind: TAnalysisKind, area: TArea, open: number) {
  if (isNarrow(area)) {
    return { x: 0, y: 0, w: area.width, h: area.height };
  }
  const size = INITIAL_SIZES[kind];
  const w = Math.min(size.w, area.width - 24);
  const h = Math.min(size.h, area.height - 24);
  const step = (open % 6) * 28;
  // Cascaded, but wholly inside a short or narrow map (e.g. 900 × 300).
  return clampRect(
    {
      x: Math.max(12, area.width - w - 24 - step),
      y: Math.min(Math.max(12, 64 + step), area.height - h - 12),
      w,
      h,
    },
    area
  );
}

/**
 * Expand in map: the whole map, below the app's title bar where that floats
 * over it (sidebar collapsed), so the dataset title and the sidebar toggle
 * stay in reach.
 */
/**
 * Room kept under a maximized window for the Plotting tools button (18 px from
 * the edge, 40–44 px tall), so it never covers the window's footer.
 */
const LAUNCHER_ROOM = 68;

export function maximizedRect(area: TArea) {
  const top = Math.min(Math.max(0, area.top ?? 0), area.height / 2);
  const bottom = area.height - top > 3 * LAUNCHER_ROOM ? LAUNCHER_ROOM : 0;
  return { x: 0, y: top, w: area.width, h: area.height - top - bottom };
}

/**
 * How far the fixed title bar (top-left, one sidebar wide) reaches into a
 * map placed at `left`, `top` in the page: none when the map starts to its
 * right or below it.
 */
export function titleBarInset(map: { left: number; top: number }) {
  return map.left < CONTROL_PANEL_WIDTH
    ? Math.max(0, TITLE_BAR_HEIGHT - map.top)
    : 0;
}

/** Windows stay wholly inside the map, so Close and Export stay in reach. */
export function clampRect(rect: TPlotWindow["rect"], area: TArea) {
  const w = Math.min(Math.max(220, rect.w), area.width);
  const h = Math.min(Math.max(160, rect.h), area.height);
  return {
    w,
    h,
    x: Math.min(Math.max(0, rect.x), area.width - w),
    y: Math.min(Math.max(0, rect.y), area.height - h),
  };
}

/** What each ID letter stands for (A1 is the first area time series). */
const ID_LETTERS: Record<string, string> = {
  P: "point",
  A: "area",
  V: "vertical profile",
  S: "cross-section along a path",
  T: "time–vertical",
  H: "Hovmöller",
  D: "distribution",
  L: "latitude or longitude–vertical section",
};

/**
 * A plot's ID spelled out: "A1: Area time series no. 1 (A = area)". The
 * letter names the kind of plot and the number counts them.
 */
export function idMeaning(label: string, kindName: string) {
  const match = /^([A-Z])(\d+)$/.exec(label);
  if (!match) {
    return `${label}: ${kindName}`;
  }
  const [, letter, number] = match;
  const word = ID_LETTERS[letter];
  return `${label}: ${kindName} no. ${number}${word ? ` (${letter} = ${word})` : ""}`;
}

/** Which edges a resize gesture moves: any side or corner, or the window. */
export type TResizeEdge =
  "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

/**
 * The window's rectangle after dragging `edge` by (dx, dy): the far side
 * stays where it is (a left edge stops at the narrowest window, it does
 * not push the window right), and the window stays on the map.
 */
export function resizedRect(
  start: TPlotWindow["rect"],
  edge: TResizeEdge,
  dx: number,
  dy: number,
  area: TArea
) {
  const next = { ...start };
  if (edge === "move") {
    return clampRect({ ...next, x: next.x + dx, y: next.y + dy }, area);
  }
  if (edge.includes("e")) {
    next.w = start.w + dx;
  }
  if (edge.includes("s")) {
    next.h = start.h + dy;
  }
  if (edge.includes("w")) {
    // Not past the narrowest window, nor off the map's left side.
    const right = start.x + start.w;
    next.x = Math.max(0, Math.min(start.x + dx, right - 220));
    next.w = right - next.x;
  }
  if (edge.includes("n")) {
    const bottom = start.y + start.h;
    next.y = Math.max(0, Math.min(start.y + dy, bottom - 160));
    next.h = bottom - next.y;
  }
  return clampRect(next, area);
}

/** The map's current variable and dimension indices, by dimension name. */
export function mapSettingsFromStore(
  globe: ReturnType<typeof useGlobeControlStore>
): TMapSettings {
  const indices: Record<string, number> = {};
  (globe.varinfo?.dimRanges ?? []).forEach((range, at) => {
    const value = globe.dimSlidersValues[at];
    if (range?.name && typeof value === "number") {
      indices[range.name] = value;
    }
  });
  return { variable: globe.varnameSelector, indices };
}

/** A coordinate axis: its raw values, units and calendar. */
type TCoordinate = {
  values: ArrayLike<number | bigint | string>;
  units?: string;
  calendar?: string;
  /** A vertical coordinate's direction ("up" or "down"), when declared. */
  positive?: string;
  /** The stored rows the plot reads (full-axis indices), when known. */
  rows?: TTimeSelection;
};

/** Each time's instant key on an axis, kept per values array. */
const instantKeys = new WeakMap<
  object,
  { meta: string; keys: (string | undefined)[] }
>();

/**
 * Keys by content too: the map reads its dimension afresh into a new array at
 * each step, the same values. A full pass over the values names them; the last
 * few axes are kept.
 */
const keysByContent = new Map<
  string,
  { values: TCoordinate["values"]; keys: (string | undefined)[] }
>();

const hashBits = new Float64Array(1);
const hashWords = new Uint32Array(hashBits.buffer);

function contentKey(axis: TCoordinate) {
  let hash = 2166136261;
  const n = axis.values.length;
  const words = hashWords;
  for (let at = 0; at < n; at++) {
    // FNV-1a over each value's low and high 32 bits.
    hashBits[0] = Number(axis.values[at]);
    hash = Math.imul(hash ^ words[0], 16777619);
    hash = Math.imul(hash ^ words[1], 16777619);
  }
  return `${n}|${hash >>> 0}|${axis.units}|${axis.calendar}`;
}

function keysOf(axis: TCoordinate) {
  // The same numbers in another origin or calendar are other instants.
  const meta = `${axis.units}|${axis.calendar}`;
  const kept = instantKeys.get(axis.values);
  if (kept?.meta === meta) {
    return kept.keys;
  }
  const content = axis.values.length > 1024 ? contentKey(axis) : undefined;
  // A hash names a candidate; the values themselves decide.
  const kept2 = content ? keysByContent.get(content) : undefined;
  const same =
    kept2 &&
    kept2.values.length === axis.values.length &&
    Array.prototype.every.call(
      axis.values,
      (value: unknown, at: number) => value === kept2.values[at]
    )
      ? kept2.keys
      : undefined;
  if (same) {
    instantKeys.set(axis.values, { meta, keys: same });
    return same;
  }
  const parsed = parseTimeAxis(axis.units, axis.calendar);
  const keys = Array.from(axis.values, (value) => {
    const raw = Number(value);
    return Number.isFinite(raw)
      ? "unsupported" in parsed
        ? `${raw}|${axis.units}|${axis.calendar}`
        : instantKey(parsed, raw)
      : undefined;
  });
  instantKeys.set(axis.values, { meta, keys });
  if (content) {
    keysByContent.delete(content);
    keysByContent.set(content, { values: axis.values, keys });
    if (keysByContent.size > 4) {
      keysByContent.delete(keysByContent.keys().next().value!);
    }
  }
  return keys;
}

/**
 * The index on a plot's axis of the map's coordinate at `index`: by the decoded
 * instant for time (calendar and units included), by the value in the plot's
 * units for a level; not by position, which another store may order otherwise.
 * Undefined when no single row corresponds.
 */
/** The map's coordinate along a dimension (its values, units, calendar). */
export function mapCoordinateOf(
  globe: ReturnType<typeof useGlobeControlStore>,
  dimension: string
) {
  const info = globe.varinfo;
  const at = info?.dimRanges.findIndex((range) => range?.name === dimension);
  const dim = at !== undefined && at >= 0 ? info?.dimInfo?.[at] : undefined;
  if (!dim || !("values" in dim)) {
    return undefined;
  }
  // As the plot's are, decoded by the same rules: unpacked, 64-bit ticks
  // exactly and a declared fill missing.
  const attrs = (dim.attrs ?? {}) as Record<string, unknown>;
  const decodes = DECODING_ATTRS.some((key) => attrs[key] !== undefined);
  return {
    values: decodes ? decodedOnce(dim.values, attrs) : dim.values,
    units: dim.units ?? (attrs.units as string | undefined),
    calendar: attrs.calendar as string | undefined,
    positive: attrs.positive as string | undefined,
  };
}
/** Attributes that make stored coordinate values other numbers. */
// Every one the plot's decoder reads.
const DECODING_ATTRS = [
  "scale_factor",
  "add_offset",
  "_FillValue",
  "fillValue",
  "fill_value",
  "_fillvalue",
  "missing_value",
  "missingValue",
  "valid_min",
  "valid_max",
  "valid_range",
  "valid_ranges",
  "_Unsigned",
];

/** The stored type of a coordinate array, as the decoder names it. */
function dtypeOf(values: unknown) {
  return values instanceof BigInt64Array
    ? "int64"
    : values instanceof BigUint64Array
      ? "uint64"
      : values instanceof Float32Array
        ? "float32"
        : values instanceof Int32Array
          ? "int32"
          : values instanceof Uint32Array
            ? "uint32"
            : values instanceof Int16Array
              ? "int16"
              : values instanceof Uint16Array
                ? "uint16"
                : values instanceof Int8Array
                  ? "int8"
                  : values instanceof Uint8Array
                    ? "uint8"
                    : "float64";
}

/**
 * The map's coordinate decoded once per array: the same values each step, so
 * what is kept for them (their instants) is found again.
 */
const decoded = new WeakMap<object, { key: string; values: number[] }>();
function decodedOnce(
  values: TCoordinate["values"],
  attrs: Record<string, unknown>
) {
  const key = DECODING_ATTRS.map((name) => String(attrs[name])).join("|");
  const kept = decoded.get(values as object);
  if (kept?.key === key) {
    return kept.values;
  }
  const codec = buildValueCodec(attrs, null, dtypeOf(values), 2);
  const out = Array.from(values, (v) =>
    typeof v === "bigint"
      ? decodeStoredBigInt(codec, v)
      : decodeStoredValue(codec, Number(v))
  );
  decoded.set(values as object, { key, values: out });
  return out;
}

/** Whether two axes hold the same coordinate, decided once per pair. */
const sameAxes = new WeakMap<object, WeakMap<object, Map<string, boolean>>>();
function sameCoordinate(map: TCoordinate, plot: TCoordinate) {
  // The same numbers up and down are other places.
  const direction = (c: TCoordinate) => c.positive?.toLowerCase() ?? "";
  if (direction(map) !== direction(plot)) {
    return false;
  }
  if (
    map.values === plot.values &&
    map.units === plot.units &&
    (map.calendar ?? "standard") === (plot.calendar ?? "standard")
  ) {
    return true;
  }
  const meta = `${map.units}|${map.calendar ?? "standard"}|${plot.units}|${plot.calendar ?? "standard"}`;
  const byPlot =
    sameAxes.get(map.values as object) ??
    sameAxes
      .set(map.values as object, new WeakMap())
      .get(map.values as object)!;
  const verdicts =
    byPlot.get(plot.values as object) ??
    byPlot.set(plot.values as object, new Map()).get(plot.values as object)!;
  let same = verdicts.get(meta);
  if (same === undefined) {
    same =
      map.values.length === plot.values.length &&
      map.units === plot.units &&
      (map.calendar ?? "standard") === (plot.calendar ?? "standard") &&
      Array.prototype.every.call(
        map.values,
        (value: unknown, at: number) =>
          Number(value) === Number(plot.values[at])
      );
    verdicts.set(meta, same);
  }
  return same;
}

/** Each instant's row on an axis, -2 where several rows hold it. */
const rowsByKey = new WeakMap<object, Map<string, number>>();
function rowOfKey(axis: TCoordinate, key: string) {
  // By its keys, shared by every array of the same values (keysOf).
  const keys = keysOf(axis);
  let rows = rowsByKey.get(keys);
  if (!rows) {
    rows = new Map();
    keys.forEach((k, at) => {
      if (k !== undefined) {
        rows!.set(k, rows!.has(k) ? -2 : at);
      }
    });
    rowsByKey.set(keys, rows);
  }
  return rows.get(key) ?? -1;
}

export function correspondingIndex(
  map: TCoordinate | undefined,
  index: number,
  plot: TCoordinate,
  kind: "time" | "level"
) {
  if (!map || index < 0 || index >= map.values.length) {
    return undefined;
  }
  // The same coordinate (the map's own dataset): its position.
  if (sameCoordinate(map, plot)) {
    return index;
  }
  if (kind === "time") {
    const wanted = keysOf(map)[index];
    // A date the map's axis holds twice names no one row: only the same stored
    // row is the map's sample.
    if (wanted !== undefined && rowOfKey(map, wanted) === -2) {
      const at =
        plot.rows && readsIndices(plot.rows, index, index)
          ? rowsBefore(plot.rows, index)
          : -1;
      return at >= 0 && keysOf(plot)[at] === wanted ? at : undefined;
    }
    const at = wanted === undefined ? -1 : rowOfKey(plot, wanted);
    return at >= 0 ? at : undefined;
  }
  const convert =
    map.units && plot.units ? converter(map.units, plot.units) : undefined;
  if (map.units && plot.units && !convert) {
    return undefined;
  }
  // Heights up and depths down: 100 m above is −100 m of depth, not 100 m
  // below.
  const flip =
    map.positive &&
    plot.positive &&
    map.positive.toLowerCase() !== plot.positive.toLowerCase()
      ? -1
      : 1;
  const value = flip * (convert ?? Number)(Number(map.values[index]));
  const found: number[] = [];
  Array.from(plot.values, Number).forEach((level, at) => {
    if (Math.abs(level - value) <= 1e-6 * Math.max(1, Math.abs(value))) {
      found.push(at);
    }
  });
  return found.length === 1 ? found[0] : undefined;
}

export function mapSettingsDiffer(w: TPlotWindow, map: TMapSettings) {
  const query = w.committed;
  if (!query) {
    return false;
  }
  if (
    query.variable !== map.variable &&
    query.analysisOrder === w.summary?.order
  ) {
    return true;
  }
  for (const [dimension, index] of Object.entries(query.fixed)) {
    if (
      map.indices[dimension] !== undefined &&
      map.indices[dimension] !== index
    ) {
      return true;
    }
  }
  // The level too: a plot at one level, the map moved to another, offers
  // Use map settings.
  const vertical = w.summary?.vertical?.dimension;
  if (
    vertical &&
    query.level !== undefined &&
    map.indices[vertical] !== undefined &&
    map.indices[vertical] !== query.level
  ) {
    return true;
  }
  const time = w.summary?.time?.dimension;
  const single = !TIME_RANGE_KINDS.includes(w.kind);
  return Boolean(
    single &&
    time &&
    map.indices[time] !== undefined &&
    map.indices[time] !== query.time?.start
  );
}

function lat(value: number, digits = 2) {
  return `${Math.abs(value).toFixed(digits)}° ${value < 0 ? "S" : "N"}`;
}

function lon(value: number, digits = 2) {
  const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
  return `${Math.abs(wrapped).toFixed(digits)}° ${wrapped < 0 ? "W" : "E"}`;
}

/**
 * Decimals that keep two distinct edges distinct: two, or up to six as needed.
 */
export function edgeDigits(a: number, b: number, least = 2) {
  for (let d = least; d < 6; d++) {
    const scale = 10 ** d;
    // "-0.00" and "0.00" read the same: compare the rounded numbers.
    if (a === b || Math.round(a * scale) !== Math.round(b * scale)) {
      return d;
    }
  }
  return 6;
}

/**
 * A box's longitudes in words: "all longitudes" for a full turn, else west to
 * east with enough decimals to tell them apart.
 */
export function lonSpanText(west: number, east: number, fixed = true) {
  if (boxLonSpan({ west, east, south: 0, north: 0 }) >= 360) {
    return "all longitudes";
  }
  if (fixed) {
    const d = edgeDigits(west, east);
    return `${lon(west, d)} to ${lon(east, d)}`;
  }
  // Short: as few decimals as tell them apart, trailing zeros dropped.
  const d = edgeDigits(west, east, 1);
  const short = (value: number) => {
    const wrapped = ((((value + 180) % 360) + 360) % 360) - 180;
    const size = Number(Math.abs(wrapped).toFixed(d));
    return `${size}°${size === 0 || size === 180 ? "" : wrapped < 0 ? " W" : " E"}`;
  };
  return `${short(west)} to ${short(east)}`;
}

/** A box, or the band, cap or globe it is (all longitudes). */
function describeBox(box: {
  west: number;
  east: number;
  south: number;
  north: number;
}) {
  switch (regionModeOf(box)) {
    case REGION_MODES.GLOBE:
      return "whole globe";
    case REGION_MODES.CAP:
      return box.north >= 90
        ? `polar cap north of ${lat(box.south)}`
        : `polar cap south of ${lat(box.north)}`;
    case REGION_MODES.BAND:
      return `latitude band ${lat(box.south)} to ${lat(box.north)}`;
    default: {
      const ns = edgeDigits(box.south, box.north);
      return `box ${lonSpanText(box.west, box.east)}, ${lat(box.south, ns)} to ${lat(box.north, ns)}`;
    }
  }
}

/**
 * The selection in words: "48.30° N, 16.20° W", "box 10° W–5° E, …". A point
 * with as many decimals as the grid's `spacing` (degrees between cells) needs
 * to tell its cell from the next.
 */
export function describeGeometry(geometry: TGeometry, spacing?: number) {
  switch (geometry.kind) {
    case GEOMETRY_KINDS.COUNTRY:
      return `${countriesName(countryIds(geometry), geometry.resolution)} (1:${parseInt(geometry.resolution)} million)`;
    case GEOMETRY_KINDS.POINT: {
      const d =
        spacing && spacing > 0
          ? Math.min(9, Math.max(2, Math.ceil(-Math.log10(spacing)) + 1))
          : 2;
      return `${lat(geometry.lat, d)}, ${lon(geometry.lon, d)}`;
    }
    case GEOMETRY_KINDS.BOX:
      return describeBox(geometry);
    case GEOMETRY_KINDS.POLYGON:
      return `polygon of ${geometry.vertices.length} points`;
    case GEOMETRY_KINDS.SHAPE:
      // A box drawn on the globe or a curved map: its footprint there. An
      // edited Box by its rings now, not the name of the first drawing.
      return geometry.drawn
        ? `box ${geometry.edited ? drawnName(geometry.polygons, geometry.poles) : geometry.name}`
        : `${geometry.name} (imported shape)`;
    case GEOMETRY_KINDS.POLYLINE:
      return `path 1 → ${geometry.vertices.length}`;
  }
}

function capitalize(text: string) {
  return text ? text[0].toUpperCase() + text.slice(1) : text;
}

/** "Sea surface temperature (°C)": the measured quantity and its units. */
export function quantityTitle(
  name: string,
  longName: string | undefined,
  units: string | undefined
) {
  const label = capitalize(longName || name.split("/").pop() || name);
  return units ? `${label} (${units})` : label;
}

/**
 * A quantity short enough for a rotated axis title: the long name when it
 * fits, otherwise the variable's own name; units always.
 */
export function axisQuantity(
  name: string,
  longName: string | undefined,
  units: string | undefined
) {
  const short = name.split("/").pop() || name;
  const label =
    longName && longName.length <= 24 ? capitalize(longName) : short;
  return units ? `${label} (${units})` : label;
}

type TVerticalLike = {
  label: string;
  units?: string;
  physical: boolean;
};

/**
 * A model axis's own coordinate values when they say something (hybrid
 * coefficients [1, 0.5, 0.1], not the index 0, 1, 2), strictly monotonic: drawn
 * as published.
 */
export function nativeLevels(
  vertical: (TVerticalLike & { values: number[] }) | undefined
) {
  const v = vertical?.values;
  if (!vertical || vertical.physical || !v || v.length < 2) {
    return undefined;
  }
  const index = v.every((value, k) => value === k);
  const up = v.every((value, k) => k === 0 || value > v[k - 1]);
  const down = v.every((value, k) => k === 0 || value < v[k - 1]);
  return !index && v.every(Number.isFinite) && (up || down) ? v : undefined;
}

/** "Depth (m)", "Air pressure (Pa)" or "Model level (index)". */
export function verticalTitle(
  vertical: (TVerticalLike & { values?: number[] }) | undefined
) {
  if (
    vertical &&
    !vertical.physical &&
    nativeLevels(vertical as TVerticalLike & { values: number[] })
  ) {
    return `${capitalize(vertical.label)} (native values)`;
  }
  if (!vertical || !vertical.physical) {
    return "Model level (index)";
  }
  const name = vertical.label.replace(/\s*\(.*\)\s*$/, "").replace(/_/g, " ");
  return `${capitalize(name)}${vertical.units ? ` (${vertical.units})` : ""}`;
}

/** A level as a reader names it: "depth 5 m" or "model level 3". */
export function levelText(
  vertical: (TVerticalLike & { values: number[] }) | undefined,
  level: number | undefined,
  format: (value: number) => string
) {
  if (!vertical || level === undefined) {
    return "";
  }
  if (!vertical.physical) {
    return `model level ${level}`;
  }
  const name = verticalTitle(vertical)
    .replace(/\s*\(.*\)$/, "")
    .toLowerCase();
  return `${name} ${format(vertical.values[level])}${vertical.units ? ` ${vertical.units}` : ""}`;
}

/** Plots with a bin width (°): Hovmöllers and the latitude section. */
export function usesDegreeBins(kind: TAnalysisKind) {
  return (
    kind === ANALYSIS_KINDS.HOVMOLLER_LON ||
    kind === ANALYSIS_KINDS.HOVMOLLER_LAT ||
    kind === ANALYSIS_KINDS.LAT_VERTICAL ||
    kind === ANALYSIS_KINDS.LON_VERTICAL
  );
}

/** What differs between the edited draft and the committed query. */

export function pendingChanges(w: TPlotWindow) {
  // A preview's first dates are not an edit: compare with the request.
  const query = w.preview?.intent ?? w.committed;
  if (!query) {
    return [];
  }
  const changes: string[] = [];
  const same = (a: unknown, b: unknown) =>
    JSON.stringify(a ?? null) === JSON.stringify(b ?? null);
  if (geometryKey(w.draft.geometry) !== geometryKey(query.geometry)) {
    changes.push("selection");
  }
  if (w.draft.variable !== query.variable) {
    changes.push("variable");
  }
  // No range is every date: the same request as the whole range written out.
  const steps = (w.committedBinding?.summary ?? w.summary)?.time?.raw.length;
  const whole = (time: typeof query.time) =>
    time ?? (steps ? { start: 0, stop: steps } : undefined);
  if (!same(whole(w.draft.time), whole(query.time))) {
    changes.push("time");
  }
  if (!same(w.draft.level, query.level)) {
    changes.push("level");
  }
  if (!same(w.draft.fixed, query.fixed)) {
    changes.push("fixed dimensions");
  }
  if (
    PATH_KINDS.includes(w.kind) &&
    w.draft.sectionSamples !== query.sectionSamples
  ) {
    changes.push("samples");
  }
  if (usesDegreeBins(w.kind) && !same(w.draft.binDegrees, query.binDegrees)) {
    changes.push("bin width");
  }
  if (
    w.kind === ANALYSIS_KINDS.DISTRIBUTION &&
    (w.draft.valueBins ?? 30) !== query.valueBins
  ) {
    changes.push("value bins");
  }
  if (
    w.kind === ANALYSIS_KINDS.REGION_SERIES &&
    !same(w.draft.minCoverage, query.minCoverage)
  ) {
    changes.push("coverage threshold");
  }
  return changes;
}

/** The box between two opposite corners, the shorter way round. */
export function boxFrom(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number }
): TGeometry {
  let west = Math.min(a.lon, b.lon);
  let east = Math.max(a.lon, b.lon);
  if (east - west > 180) {
    [west, east] = [east, west];
  }
  return {
    kind: GEOMETRY_KINDS.BOX,
    west,
    east,
    south: Math.min(a.lat, b.lat),
    north: Math.max(a.lat, b.lat),
  };
}

/** An imported shape's extent as four corners (it may have many points). */
function shapeCorners(polygons: number[][][][]) {
  let [west, east, south, north] = [180, -180, 90, -90];
  for (const polygon of polygons) {
    for (const [lon, lat] of polygon[0] ?? []) {
      west = Math.min(west, lon);
      east = Math.max(east, lon);
      south = Math.min(south, lat);
      north = Math.max(north, lat);
    }
  }
  return [
    { lat: south, lon: west },
    { lat: south, lon: east },
    { lat: north, lon: east },
    { lat: north, lon: west },
  ];
}

/** Geometry vertices in drawing order (boxes as their four corners). */
export function geometryVertices(geometry: TGeometry) {
  switch (geometry.kind) {
    case GEOMETRY_KINDS.POINT:
      return [{ lat: geometry.lat, lon: geometry.lon }];
    case GEOMETRY_KINDS.BOX:
      return [
        { lat: geometry.south, lon: geometry.west },
        { lat: geometry.south, lon: geometry.east },
        { lat: geometry.north, lon: geometry.east },
        { lat: geometry.north, lon: geometry.west },
      ];
    case GEOMETRY_KINDS.COUNTRY:
      return [];
    case GEOMETRY_KINDS.SHAPE:
      return shapeCorners(geometry.polygons);
    default:
      return geometry.vertices;
  }
}

/**
 * The variable summary of what the window shows: the displayed result's
 * own while one is shown (an applied replacement still running does not
 * relabel it), else the committed one.
 */
export function displayedSummary(w: TPlotWindow) {
  return w.result && w.resultSummary
    ? w.resultSummary
    : (w.committedBinding?.summary ?? w.summary);
}

/** A window's state in words, for the Plots list and announcements. */
export function humanStatus(w: TPlotWindow) {
  const phase = phaseText(w);
  // The chart still shows the previous selection while the new one runs.
  const replacing =
    w.result &&
    w.committed &&
    w.result.query !== w.committed &&
    selectionOf(w.result.query) !== selectionOf(w.committed) &&
    w.status !== PLOT_STATUS.DONE;
  return replacing ? `Updating selection: ${phase}` : phase;
}

/** What a query selects, apart from display-only settings. */
function selectionOf(query: TAnalysisQuery) {
  return JSON.stringify({
    ...query,
    geometry: geometryKey(query.geometry),
    minCoverage: undefined,
  });
}

/** A minimized row still says when its plot failed or stopped part-way. */
/** Still reading or planning: closing it stops that, so it asks first. */
export function isReading(w: TPlotWindow) {
  return (
    [
      PLOT_STATUS.PLANNING,
      PLOT_STATUS.QUEUED,
      PLOT_STATUS.RUNNING,
      PLOT_STATUS.LOADING,
    ] as string[]
  ).includes(w.status);
}

export function minimizedStatus(w: TPlotWindow) {
  return w.status === PLOT_STATUS.DONE
    ? "Minimized"
    : `${humanStatus(w)} (minimized)`;
}

function phaseText(w: TPlotWindow) {
  switch (w.status) {
    case PLOT_STATUS.LOADING:
      return "Reading metadata";
    case PLOT_STATUS.PLANNING:
      return "Planning";
    case PLOT_STATUS.CONFIRM:
      return "Waiting for Compute";
    case PLOT_STATUS.QUEUED:
      return "Queued";
    case PLOT_STATUS.RUNNING:
      if (w.progress) {
        return `${w.paused ? "Paused" : "Reading"} ${w.progress.done}/${w.progress.total}`;
      }
      return "Reading";
    case PLOT_STATUS.DONE:
      return w.snapshot ? "Snapshot" : "Ready";
    case PLOT_STATUS.ERROR:
      return "Error";
    case PLOT_STATUS.CANCELLED:
      return w.result?.partial ? "Stopped (partial)" : "Cancelled";
    default:
      return "Unavailable";
  }
}

/** The first of `selector` that is rendered (not hidden or collapsed). */
function visible(selector: string) {
  return [...document.querySelectorAll<HTMLElement>(selector)].find(
    (element) => element.getClientRects().length > 0
  );
}

/**
 * Move keyboard focus once the DOM has caught up: a button revealed by
 * minimizing a compact window, or a window just restored.
 */
async function focusWhenShown(selector: string) {
  await nextTick();
  let target = visible(selector);
  if (!target) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
    target = visible(selector);
  }
  target?.focus();
}

/** Back to map, minimize: focus returns to the visible Plots button. */
export function focusPlotsButton() {
  return focusWhenShown(".analysis-plots-button");
}

/** Restoring a plot moves keyboard focus into that plot's window. */
export function focusPlotWindow(id: string) {
  return focusWhenShown(`[data-plot-id="${CSS.escape(id)}"]`);
}
