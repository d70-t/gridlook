// Draws Shortbread vector tiles (e.g. VersaTiles) as 256 px basemap tiles:
// water, and land with country borders, in muted colours so data layers
// stand out. Their country and city labels are returned for basemapLabels.ts.

import { VectorTile, type VectorTileLayer } from "@mapbox/vector-tile";
import Pbf from "pbf";

import {
  BasemapLabelKind,
  type TBasemapLabel,
  type TBasemapLabelKind,
} from "./basemapLabels.ts";
import { mercatorYToLat, TILE_SIZE, type TTileSource } from "./basemapTiles.ts";

import type { TBasemapOptions } from "@/utils/basemap.ts";

export type TVectorDrawOptions = Pick<TBasemapOptions, "water" | "land">;

const PALETTE = {
  land: "#e4e4e1",
  water: "#b9cde0",
  border: "#9c9c99",
};

// Glaciers are land here, though Shortbread files them with the water.
const isWater = (properties: Record<string, unknown>) =>
  properties.kind !== "glacier";
const COUNTRY_ADMIN_LEVEL = 2;
const BORDER_WIDTH = 1;
// Shortbread `place_labels` kinds shown; label kinds use the same names.
const PLACE_KINDS: string[] = [
  BasemapLabelKind.CAPITAL,
  BasemapLabelKind.STATE_CAPITAL,
  BasemapLabelKind.CITY,
];

/** Maps tile coordinates of `source` to pixels of the requested tile. */
function getPixelMapper(source: TTileSource, extent: number) {
  const { x, y, size } = source.region;
  return (point: { x: number; y: number }) => [
    ((point.x / extent - x) / size) * TILE_SIZE,
    ((point.y / extent - y) / size) * TILE_SIZE,
  ];
}

/** Adds the geometry of every feature passing `filter` to the current path. */
function traceLayer(
  ctx: OffscreenCanvasRenderingContext2D,
  layer: VectorTileLayer | undefined,
  source: TTileSource,
  filter: (properties: Record<string, unknown>) => boolean = () => true
) {
  if (!layer) {
    return;
  }
  const toPixels = getPixelMapper(source, layer.extent);
  for (let index = 0; index < layer.length; index++) {
    const feature = layer.feature(index);
    if (!filter(feature.properties)) {
      continue;
    }
    for (const ring of feature.loadGeometry()) {
      ring.forEach((point, pointIndex) => {
        const [x, y] = toPixels(point);
        if (pointIndex === 0) {
          ctx.moveTo(x, y);
        } else {
          ctx.lineTo(x, y);
        }
      });
    }
  }
}

function getName(properties: Record<string, unknown>) {
  const name = properties.name_en ?? properties.name;
  return typeof name === "string" ? name : "";
}

/** Labels of the points in `layer` that `classify` gives a kind and rank. */
function extractLayerLabels(
  layer: VectorTileLayer | undefined,
  source: TTileSource,
  classify: (
    properties: Record<string, unknown>
  ) => { kind: TBasemapLabelKind; rank: number } | undefined
): TBasemapLabel[] {
  const labels: TBasemapLabel[] = [];
  const tiles = 2 ** source.z;
  for (let index = 0; layer && index < layer.length; index++) {
    const feature = layer.feature(index);
    const name = getName(feature.properties);
    const label = classify(feature.properties);
    const point = feature.loadGeometry()[0]?.[0];
    if (!name || !label || !point) {
      continue;
    }
    const lon = ((source.x + point.x / layer.extent) / tiles) * 360 - 180;
    labels.push({
      name,
      ...label,
      lat: mercatorYToLat((source.y + point.y / layer.extent) / tiles),
      lon: ((((lon + 180) % 360) + 360) % 360) - 180,
    });
  }
  return labels;
}

function extractLabels(tile: VectorTile, source: TTileSource) {
  return [
    ...extractLayerLabels(tile.layers.boundary_labels, source, (properties) =>
      properties.admin_level === COUNTRY_ADMIN_LEVEL
        ? { kind: BasemapLabelKind.COUNTRY, rank: Number(properties.way_area) }
        : undefined
    ),
    ...extractLayerLabels(tile.layers.place_labels, source, (properties) => {
      const kind = String(properties.kind);
      return PLACE_KINDS.includes(kind)
        ? {
            kind: kind as TBasemapLabelKind,
            rank: Number(properties.population),
          }
        : undefined;
    }),
  ];
}

/**
 * Draws the part `source.region` of a vector tile into a 256 px canvas. Land
 * is everything but water, so without land the water is drawn alone, and
 * without water it is cut out of the land; what is off stays transparent.
 */
export function drawVectorTile(
  data: ArrayBuffer,
  source: TTileSource,
  options: TVectorDrawOptions
) {
  const tile = new VectorTile(new Pbf(data));
  const canvas = new OffscreenCanvas(TILE_SIZE, TILE_SIZE);
  const ctx = canvas.getContext("2d")!;

  if (options.land) {
    ctx.fillStyle = PALETTE.land;
    ctx.fillRect(0, 0, TILE_SIZE, TILE_SIZE);
  }
  if (options.water || options.land) {
    ctx.globalCompositeOperation = options.water
      ? "source-over"
      : "destination-out";
    ctx.fillStyle = PALETTE.water;
    ctx.beginPath();
    traceLayer(ctx, tile.layers.ocean, source);
    traceLayer(ctx, tile.layers.water_polygons, source, isWater);
    ctx.fill();
    ctx.globalCompositeOperation = "source-over";
  }
  if (options.land) {
    ctx.strokeStyle = PALETTE.border;
    ctx.lineWidth = BORDER_WIDTH;
    ctx.beginPath();
    traceLayer(
      ctx,
      tile.layers.boundaries,
      source,
      (properties) =>
        properties.admin_level === COUNTRY_ADMIN_LEVEL && !properties.maritime
    );
    ctx.stroke();
  }
  return { canvas, labels: extractLabels(tile, source) };
}
