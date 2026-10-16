// Country and city names of vector basemaps. They are drawn into one image
// of the shown tile window, which the basemap shader lays onto the map like
// its tiles, instead of into each tile, where tile edges would cut them.

import {
  latToMercatorY,
  lonToMercatorX,
  mercatorYToLat,
  TILE_SIZE,
  type TTileWindow,
} from "./basemapTiles.ts";

// Ordered by importance: where labels overlap, the earlier kind wins.
export const BasemapLabelKind = {
  COUNTRY: "country",
  CAPITAL: "capital",
  STATE_CAPITAL: "state_capital",
  CITY: "city",
} as const;

export type TBasemapLabelKind =
  (typeof BasemapLabelKind)[keyof typeof BasemapLabelKind];

const KIND_ORDER = Object.values(BasemapLabelKind);

// Zoom of the shown tiles from which each kind appears. Fewer labels also
// mean less work whenever the label image is redrawn.
const LABEL_MIN_ZOOM: Record<TBasemapLabelKind, number> = {
  [BasemapLabelKind.COUNTRY]: 0,
  [BasemapLabelKind.CAPITAL]: 6,
  [BasemapLabelKind.STATE_CAPITAL]: 8,
  [BasemapLabelKind.CITY]: 10,
};

export type TBasemapLabel = {
  name: string;
  kind: TBasemapLabelKind;
  // Importance within the kind (area, population); larger wins.
  rank: number;
  lat: number;
  lon: number;
};

export type TScreenPoint = { x: number; y: number };

type TBox = { left: number; top: number; right: number; bottom: number };

export type TPlacedLabel = TBasemapLabel & TScreenPoint & { box: TBox };

// Sizes in CSS pixels.
const LABEL_STYLES: Record<
  TBasemapLabelKind,
  { size: number; weight: number; color: string; dot: boolean }
> = {
  [BasemapLabelKind.COUNTRY]: {
    size: 13,
    weight: 600,
    color: "#555555",
    dot: false,
  },
  [BasemapLabelKind.CAPITAL]: {
    size: 13,
    weight: 600,
    color: "#333333",
    dot: true,
  },
  [BasemapLabelKind.STATE_CAPITAL]: {
    size: 12,
    weight: 400,
    color: "#333333",
    dot: true,
  },
  [BasemapLabelKind.CITY]: {
    size: 12,
    weight: 400,
    color: "#333333",
    dot: true,
  },
};
const DOT_RADIUS = 2.5;
const DOT_GAP = 4;
const HALO_WIDTH = 3;
// Free space kept around each label.
const LABEL_PADDING = 3;

/**
 * Labels shown at `zoom` (see LABEL_MIN_ZOOM), without repeats, most
 * important first. Tiles repeat the labels near their edges, and parents
 * those of their children.
 */
export function prepareLabels(labels: Iterable<TBasemapLabel>, zoom: number) {
  const unique = new Map<string, TBasemapLabel>();
  for (const label of labels) {
    if (zoom < LABEL_MIN_ZOOM[label.kind]) {
      continue;
    }
    // ponytail: equal names of one kind within about 1° count as one place;
    // the rare repeat across a rounding edge is hidden as an overlap.
    const key = `${label.kind}/${label.name}/${Math.round(label.lat)}/${Math.round(label.lon)}`;
    if (!unique.has(key)) {
      unique.set(key, label);
    }
  }
  return [...unique.values()].sort(
    (a, b) =>
      KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || b.rank - a.rank
  );
}

// Largest side of a label image; larger windows get a coarser one.
const MAX_LABEL_IMAGE_SIZE = 4096;
// Most label image pixels per tile pixel.
const MAX_LABEL_OVERSAMPLING = 2;
// Tile pixels show at least this many screen pixels within a tile window.
const MIN_DISPLAY_RATIO = Math.SQRT1_2;
// Near the poles, text stops growing with the Mercator scale.
const MAX_LATITUDE_SCALE = 3;

function getLabelBox(
  label: TBasemapLabel,
  point: TScreenPoint,
  textWidth: number,
  scale: number
): TBox {
  const style = LABEL_STYLES[label.kind];
  const halfHeight = (style.size * scale) / 2;
  const padding = LABEL_PADDING * scale;
  // Cities have a dot with the name to its right; countries are centred.
  const left = style.dot
    ? point.x - DOT_RADIUS * scale
    : point.x - textWidth / 2;
  const right = style.dot
    ? point.x + (DOT_RADIUS + DOT_GAP) * scale + textWidth
    : point.x + textWidth / 2;
  return {
    left: left - padding,
    top: point.y - halfHeight - padding,
    right: right + padding,
    bottom: point.y + halfHeight + padding,
  };
}

function overlaps(a: TBox, b: TBox) {
  return (
    a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom
  );
}

/**
 * Places `labels` (from `prepareLabels`) in order wherever they don't overlap
 * one placed before. `project` gives a label's position in the image,
 * undefined outside it; `measure` the width of its text and `getScale` the
 * size of its text and dot relative to LABEL_STYLES.
 */
export function layoutLabels(
  labels: TBasemapLabel[],
  project: (lat: number, lon: number) => TScreenPoint | undefined,
  measure: (label: TBasemapLabel) => number,
  getScale: (label: TBasemapLabel) => number
): TPlacedLabel[] {
  const placed: TPlacedLabel[] = [];
  for (const label of labels) {
    const point = project(label.lat, label.lon);
    if (!point) {
      continue;
    }
    const box = getLabelBox(label, point, measure(label), getScale(label));
    // ponytail: O(n²) overlap checks; fine for the few hundred labels of a
    // view, a grid index would scale further.
    if (!placed.some((other) => overlaps(box, other.box))) {
      placed.push({ ...label, ...point, box });
    }
  }
  return placed;
}

function getFont(kind: TBasemapLabelKind, scale: number) {
  const style = LABEL_STYLES[kind];
  return `${style.weight} ${style.size * scale}px sans-serif`;
}

/** Draws `labels` into `ctx`; see layoutLabels for the arguments. */
function drawLabels(
  ctx: CanvasRenderingContext2D,
  labels: TBasemapLabel[],
  project: (lat: number, lon: number) => TScreenPoint | undefined,
  getScale: (label: TBasemapLabel) => number
) {
  const placed = layoutLabels(
    labels,
    project,
    (label) => {
      ctx.font = getFont(label.kind, getScale(label));
      return ctx.measureText(label.name).width;
    },
    getScale
  );
  ctx.textBaseline = "middle";
  ctx.lineJoin = "round";
  ctx.strokeStyle = "rgba(255, 255, 255, 0.85)";
  for (const label of placed) {
    const style = LABEL_STYLES[label.kind];
    const scale = getScale(label);
    ctx.font = getFont(label.kind, scale);
    ctx.fillStyle = style.color;
    ctx.lineWidth = HALO_WIDTH * scale;
    let textX = label.x;
    if (style.dot) {
      ctx.beginPath();
      ctx.arc(label.x, label.y, DOT_RADIUS * scale, 0, 2 * Math.PI);
      ctx.stroke();
      ctx.fill();
      ctx.textAlign = "left";
      textX += (DOT_RADIUS + DOT_GAP) * scale;
    } else {
      ctx.textAlign = "center";
    }
    ctx.strokeText(label.name, textX, label.y);
    ctx.fillText(label.name, textX, label.y);
  }
}

/**
 * Pixels per tile side of the label image of `window`, and how much its text
 * is enlarged, for tile pixels shown `displayRatio` screen pixels wide: text
 * keeps its size on screen at any zoom between tile zooms. Where tiles are
 * magnified, the image gets twice the pixels so text stays sharp; only two
 * sizes, so zooming can reuse the texture.
 */
export function getLabelImageScale(window: TTileWindow, displayRatio: number) {
  // Below the base zoom the globe shrinks, and its labels with it.
  const ratio = Number.isFinite(displayRatio)
    ? Math.max(displayRatio, MIN_DISPLAY_RATIO)
    : 1;
  const oversampling = Math.min(
    ratio > 1 ? MAX_LABEL_OVERSAMPLING : 1,
    MAX_LABEL_IMAGE_SIZE / (window.width * TILE_SIZE),
    MAX_LABEL_IMAGE_SIZE / (window.height * TILE_SIZE)
  );
  return {
    tilePixels: TILE_SIZE * oversampling,
    textScale: oversampling / ratio,
  };
}

/**
 * Draws the labels lying in `window` into `canvas`, as an image of the window
 * in Web-Mercator tile layout (see getLabelImageScale). Mercator stretches
 * the map by 1/cos(latitude), so text is stretched alike, relative to the
 * window centre, to keep its size on the globe.
 */
export function drawLabelImage(
  canvas: HTMLCanvasElement,
  labels: TBasemapLabel[],
  window: TTileWindow,
  displayRatio: number
) {
  const { tilePixels, textScale } = getLabelImageScale(window, displayRatio);
  const width = Math.round(window.width * tilePixels);
  const height = Math.round(window.height * tilePixels);
  if (canvas.width !== width || canvas.height !== height) {
    canvas.width = width;
    canvas.height = height;
  }
  const ctx = canvas.getContext("2d")!;
  ctx.clearRect(0, 0, width, height);
  const tiles = 2 ** window.zoom;
  const centerCos = Math.cos(
    (mercatorYToLat((window.y + window.height / 2) / tiles) * Math.PI) / 180
  );
  drawLabels(
    ctx,
    labels,
    (lat, lon) => {
      const column =
        (((lonToMercatorX(lon) * tiles - window.x) % tiles) + tiles) % tiles;
      const row = latToMercatorY(lat) * tiles - window.y;
      return column < window.width && row >= 0 && row < window.height
        ? { x: column * tilePixels, y: row * tilePixels }
        : undefined;
    },
    (label) =>
      textScale *
      Math.min(
        centerCos / Math.cos((label.lat * Math.PI) / 180),
        MAX_LATITUDE_SCALE
      )
  );
}
