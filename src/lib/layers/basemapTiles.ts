// Web-Mercator (XYZ) tile maths for the basemap layer. Mercator coordinates
// are normalised to [0, 1] with y = 0 at the northern edge, like tile indices.

import { BasemapTileSize, type TBasemapEntry } from "@/utils/basemap.ts";

export const TILE_SIZE = 256;

export const BasemapZoom = {
  // The base texture covers the world at this zoom (4x4 tiles).
  BASE: 2,
  // ponytail: OSM's limit; move into the catalog once a provider needs more.
  MAX: 19,
} as const;

// Step for the finite differences in getFlatMercatorExpansion, in Mercator
// units (about 40 m).
const EXPANSION_STEP = 1e-6;
// Larger derivatives of map position by Mercator position only occur when
// the differences straddle the projection's cut.
const MAX_EXPANSION_DERIVATIVE = 1e3;
// Flat views whose corners all lie within this distance of the reference
// point (map units, about 19 km) use the expansion everywhere; it stays
// within about 0.1 px there, even at high latitudes. Wider views use the
// shader's inverse projection everywhere: mixing both shows a seam.
export const EXPANSION_VIEW_RADIUS = 0.003;

// Parents every this many levels up load before a window's own tiles, so
// the view fills quickly and then sharpens.
const PARENT_LEVEL_STEP = 2;

// Atlas side in tiles: 8192 x 4096 px (512 tiles, 128 MB) where the GPU
// allows, else 4096 x 4096 px.
const ATLAS_TILES = { COLUMNS: 32, ROWS: 16 } as const;

export const WEB_MERCATOR_LAT_LIMIT = 85.0511287798066;

export type TGeoPoint = { lat: number; lon: number };

export type TTileWindow = {
  zoom: number;
  // Tile column of the window's left edge; columns wrap at 2^zoom.
  x: number;
  y: number;
  width: number;
  height: number;
};

export type TTile = {
  z: number;
  x: number;
  y: number;
  // Position inside the window, in tiles.
  column: number;
  row: number;
};

export function lonToMercatorX(lon: number) {
  const x = (lon + 180) / 360;
  return x - Math.floor(x);
}

export function latToMercatorY(lat: number) {
  const limited = Math.min(
    Math.max(lat, -WEB_MERCATOR_LAT_LIMIT),
    WEB_MERCATOR_LAT_LIMIT
  );
  const latRad = (limited * Math.PI) / 180;
  return 0.5 - Math.log(Math.tan(Math.PI / 4 + latRad / 2)) / (2 * Math.PI);
}

export function formatTileUrl(
  template: string,
  z: number,
  x: number,
  y: number
) {
  const values: Record<string, number> = { z, x, y };
  return template.replace(/\{(\w+)\}/g, (_match, key: string) => {
    if (!(key in values)) {
      throw new Error(`Unknown tile URL parameter: "${key}"`);
    }
    return String(values[key]);
  });
}

export type TTileSource = {
  url: string;
  // The provider's tile holding the requested one.
  z: number;
  x: number;
  y: number;
  // The requested tile's part of it, in fractions of its side.
  region: { x: number; y: number; size: number };
};

/**
 * Where a provider serves a 256 px tile: in a tile of its own one level up
 * for 512 px tiles, and at its deepest zoom beyond that.
 */
export function getTileSource(
  provider: Pick<TBasemapEntry, "url" | "tileSize" | "maxZoom">,
  z: number,
  x: number,
  y: number
): TTileSource {
  const largeTiles = provider.tileSize === BasemapTileSize.LARGE ? 1 : 0;
  // The catalog is user input; ignore unusable values.
  const maxZoom =
    Number.isInteger(provider.maxZoom) && provider.maxZoom! >= 0
      ? provider.maxZoom!
      : Infinity;
  const sourceZ = Math.min(z - largeTiles, maxZoom);
  const up = z - sourceZ;
  const sourceX = x >> up;
  const sourceY = y >> up;
  const size = 1 / 2 ** up;
  return {
    url: formatTileUrl(provider.url, sourceZ, sourceX, sourceY),
    z: sourceZ,
    x: sourceX,
    y: sourceY,
    region: {
      x: (x - sourceX * 2 ** up) * size,
      y: (y - sourceY * 2 ** up) * size,
      size,
    },
  };
}

function wrappedDelta(a: number, b: number) {
  const delta = Math.abs(a - b);
  return Math.min(delta, 1 - delta);
}

/**
 * Mercator distance per screen pixel from a sample to its nearest
 * neighbouring sample; Infinity without neighbours.
 */
function getLocalMercatorPerPixel(
  grid: (TGeoPoint | null)[][],
  row: number,
  column: number,
  pixelStep: number
) {
  const point = grid[row][column];
  let finest = Infinity;
  if (!point) {
    return finest;
  }
  const neighbours = [
    grid[row][column - 1],
    grid[row][column + 1],
    grid[row - 1]?.[column],
    grid[row + 1]?.[column],
  ];
  for (const neighbour of neighbours) {
    if (!neighbour) {
      continue;
    }
    const dx = wrappedDelta(
      lonToMercatorX(point.lon),
      lonToMercatorX(neighbour.lon)
    );
    const dy = latToMercatorY(point.lat) - latToMercatorY(neighbour.lat);
    const perPixel = Math.hypot(dx, dy) / pixelStep;
    if (perPixel > 0 && perPixel < finest) {
      finest = perPixel;
    }
  }
  return finest;
}

/**
 * Smallest Mercator distance per screen pixel between neighbouring samples,
 * i.e. the finest detail anywhere in the view.
 */
function getMercatorPerPixel(grid: (TGeoPoint | null)[][], pixelStep: number) {
  let finest = Infinity;
  for (let row = 0; row < grid.length; row++) {
    for (let column = 0; column < grid[row].length; column++) {
      const perPixel = getLocalMercatorPerPixel(grid, row, column, pixelStep);
      if (perPixel < finest) {
        finest = perPixel;
      }
    }
  }
  return finest;
}

/**
 * The zoom whose tile pixels come closest to the given screen pixel size,
 * not capped at BasemapZoom.MAX.
 */
function getIdealZoom(mercatorPerPixel: number) {
  return Math.round(Math.log2(1 / (mercatorPerPixel * TILE_SIZE)));
}

/**
 * The zoom matching the finest detail of the view, unrounded; see
 * chooseTileWindow for the grid.
 */
export function getViewZoom(grid: (TGeoPoint | null)[][], pixelStep: number) {
  return Math.log2(1 / (getMercatorPerPixel(grid, pixelStep) * TILE_SIZE));
}

/**
 * Shortest longitude arc containing all points, as Mercator start and span.
 * The arc starts after the largest gap between neighbouring longitudes.
 */
function getMercatorXRange(xs: number[]) {
  const sorted = [...xs].sort((a, b) => a - b);
  let largestGap = sorted[0] + 1 - sorted[sorted.length - 1];
  let start = sorted[0];
  for (let index = 1; index < sorted.length; index++) {
    const gap = sorted[index] - sorted[index - 1];
    if (gap > largestGap) {
      largestGap = gap;
      start = sorted[index];
    }
  }
  return { start, span: 1 - largestGap };
}

function getWindowAtZoom(
  zoom: number,
  xRange: { start: number; span: number },
  yMin: number,
  yMax: number
): TTileWindow {
  const tiles = 2 ** zoom;
  // One tile of margin covers the area between the screen samples.
  const left = Math.floor(xRange.start * tiles) - 1;
  const right = Math.floor((xRange.start + xRange.span) * tiles) + 1;
  const top = Math.max(Math.floor(yMin * tiles) - 1, 0);
  const bottom = Math.min(Math.floor(yMax * tiles) + 1, tiles - 1);
  return {
    zoom,
    x: ((left % tiles) + tiles) % tiles,
    y: top,
    width: Math.min(right - left + 1, tiles),
    height: bottom - top + 1,
  };
}

/**
 * Atlas size in tiles for the GPU, and how many tiles a view may need: a
 * quarter of the slots stays free for parents shown while children load.
 */
export function getAtlasLayout(maxTextureSize: number) {
  const maxSide = Math.floor(maxTextureSize / TILE_SIZE);
  const columns = Math.min(ATLAS_TILES.COLUMNS, maxSide);
  const rows = Math.min(ATLAS_TILES.ROWS, maxSide);
  return {
    columns,
    rows,
    maxWindowTiles: Math.floor((columns * rows * 3) / 4),
  };
}

/**
 * Picks the tiles for the current view from a grid of geographic points
 * sampled `pixelStep` CSS pixels apart (null where the screen shows no
 * Earth). Returns undefined when the base texture is detailed enough.
 *
 * Like web maps, the zoom shows tile pixels at 0.71x to 1.41x CSS pixels:
 * tiles are designed for that size, so labels stay readable on any screen.
 */
export function chooseTileWindow(
  grid: (TGeoPoint | null)[][],
  pixelStep: number,
  maxTiles: number
): TTileWindow | undefined {
  const mercatorPerPixel = getMercatorPerPixel(grid, pixelStep);
  if (!Number.isFinite(mercatorPerPixel)) {
    return undefined;
  }
  let zoom = Math.min(getIdealZoom(mercatorPerPixel), BasemapZoom.MAX);

  const xs: number[] = [];
  let yMin = 1;
  let yMax = 0;
  for (const point of grid.flat()) {
    if (!point) {
      continue;
    }
    xs.push(lonToMercatorX(point.lon));
    const y = latToMercatorY(point.lat);
    if (y < yMin) {
      yMin = y;
    }
    if (y > yMax) {
      yMax = y;
    }
  }
  const xRange = getMercatorXRange(xs);

  // ponytail: one zoom for the whole view. Views spanning very different
  // scales (globe horizon, high latitudes) drop a level everywhere once the
  // window outgrows the cap; a second window at full zoom around the view
  // centre would keep the centre sharp.
  while (zoom > BasemapZoom.BASE) {
    const window = getWindowAtZoom(zoom, xRange, yMin, yMax);
    if (window.width * window.height <= maxTiles) {
      return window;
    }
    zoom--;
  }
  return undefined;
}

export function getWindowTiles(window: TTileWindow): TTile[] {
  const tiles = 2 ** window.zoom;
  const result: TTile[] = [];
  for (let row = 0; row < window.height; row++) {
    for (let column = 0; column < window.width; column++) {
      result.push({
        z: window.zoom,
        x: (window.x + column) % tiles,
        y: window.y + row,
        column,
        row,
      });
    }
  }
  return result;
}

function getTileKey(z: number, x: number, y: number) {
  return `${z}/${x}/${y}`;
}

export type TTileRequest = { z: number; x: number; y: number; key: string };

/**
 * Mercator box around a sample reaching half the way to its farthest
 * neighbour on each axis.
 */
function getSampleBox(
  grid: (TGeoPoint | null)[][],
  row: number,
  column: number
) {
  const point = grid[row][column]!;
  const x = lonToMercatorX(point.lon);
  const y = latToMercatorY(point.lat);
  let reachX = 0;
  let reachY = 0;
  for (let rowOffset = -1; rowOffset <= 1; rowOffset++) {
    for (let columnOffset = -1; columnOffset <= 1; columnOffset++) {
      const neighbour = grid[row + rowOffset]?.[column + columnOffset];
      if (!neighbour) {
        continue;
      }
      const dx = wrappedDelta(x, lonToMercatorX(neighbour.lon));
      const dy = Math.abs(y - latToMercatorY(neighbour.lat));
      reachX = Math.max(reachX, dx / 2);
      reachY = Math.max(reachY, dy / 2);
    }
  }
  return {
    left: x - reachX,
    right: x + reachX,
    top: y - reachY,
    bottom: y + reachY,
  };
}

/**
 * The zoom each window tile needs (0 where nothing visible needs it), indexed
 * row by row: the ideal zoom of the finest detail in the view, one level less
 * for each halving of the detail the samples on it show, at most the window
 * zoom. Rounding each sample's own scale instead would split views of nearly
 * uniform scale (e.g. by latitude) into two zooms. Each sample covers half
 * the way to its neighbours, so tiles between samples are found too.
 */
function getNeededZooms(
  window: TTileWindow,
  grid: (TGeoPoint | null)[][],
  pixelStep: number
) {
  const tiles = 2 ** window.zoom;
  const finest = getMercatorPerPixel(grid, pixelStep);
  const finestZoom = getIdealZoom(finest);
  // Clamped below, as y can round to just outside [0, 1] at the poles.
  const lastRow = window.y + window.height - 1;
  const zooms = new Uint8Array(window.width * window.height);
  for (let row = 0; row < grid.length; row++) {
    for (let column = 0; column < grid[row].length; column++) {
      const point = grid[row][column];
      if (!point) {
        continue;
      }
      const local = getLocalMercatorPerPixel(grid, row, column, pixelStep);
      // Above the base: samples across the poles can't tell the scale.
      const zoom = Math.min(
        Math.max(
          finestZoom - Math.floor(Math.log2(local / finest)),
          BasemapZoom.BASE + 1
        ),
        window.zoom
      );
      const box = getSampleBox(grid, row, column);
      const left = Math.floor(box.left * tiles);
      const right = Math.floor(box.right * tiles);
      const top = Math.max(Math.floor(box.top * tiles), window.y);
      const bottom = Math.min(
        Math.max(Math.floor(box.bottom * tiles), window.y),
        lastRow
      );
      for (let tileY = top; tileY <= bottom; tileY++) {
        // Covering the window width once is enough, however far it reaches.
        for (
          let tileX = left;
          tileX <= right && tileX - left < window.width;
          tileX++
        ) {
          const windowColumn = (((tileX - window.x) % tiles) + tiles) % tiles;
          if (windowColumn < window.width) {
            const index = (tileY - window.y) * window.width + windowColumn;
            zooms[index] = Math.max(zooms[index], zoom);
          }
        }
      }
    }
  }
  return zooms;
}

/**
 * Tiles to load for a window, from the screen samples it was chosen from:
 * only tiles the view shows, each at the zoom it needs there. Parents every
 * PARENT_LEVEL_STEP levels below the window zoom come first, coarsest first,
 * then the tiles nearest the window centre first.
 */
export function getTileRequests(
  window: TTileWindow,
  grid: (TGeoPoint | null)[][],
  pixelStep: number
): TTileRequest[] {
  const zooms = getNeededZooms(window, grid, pixelStep);
  const neededZoom = (tile: TTile) =>
    zooms[tile.row * window.width + tile.column];
  const centerColumn = (window.width - 1) / 2;
  const centerRow = (window.height - 1) / 2;
  const distance = (tile: TTile) =>
    (tile.column - centerColumn) ** 2 + (tile.row - centerRow) ** 2;
  const tiles = getWindowTiles(window)
    .filter((tile) => neededZoom(tile) > 0)
    .sort((a, b) => distance(a) - distance(b));

  const levelsUp: number[] = [];
  for (
    let up = PARENT_LEVEL_STEP;
    window.zoom - up > BasemapZoom.BASE;
    up += PARENT_LEVEL_STEP
  ) {
    levelsUp.unshift(up);
  }
  const requests = new Map<string, TTileRequest>();
  for (const up of [...levelsUp, 0]) {
    for (const tile of tiles) {
      const z = Math.min(tile.z - up, neededZoom(tile));
      const x = tile.x >> (tile.z - z);
      const y = tile.y >> (tile.z - z);
      const key = getTileKey(z, x, y);
      if (!requests.has(key)) {
        requests.set(key, { z, x, y, key });
      }
    }
  }
  return [...requests.values()];
}

/**
 * `requests` with each tile the provider lacks replaced by its nearest parent
 * not known to be missing, keeping the order; tiles without one are dropped,
 * as the base texture covers them.
 */
export function replaceMissingTiles(
  requests: TTileRequest[],
  missing: Set<string>
): TTileRequest[] {
  const result = new Map<string, TTileRequest>();
  for (let tile of requests) {
    while (missing.has(tile.key) && tile.z - 1 > BasemapZoom.BASE) {
      const z = tile.z - 1;
      const x = tile.x >> 1;
      const y = tile.y >> 1;
      tile = { z, x, y, key: getTileKey(z, x, y) };
    }
    if (!missing.has(tile.key) && !result.has(tile.key)) {
      result.set(tile.key, tile);
    }
  }
  return [...result.values()];
}

/**
 * The window centre as Mercator coordinates and as window tile coordinates;
 * the shader works relative to it.
 */
export function getWindowReference(window: TTileWindow) {
  const tiles = 2 ** window.zoom;
  const x = (window.x + window.width / 2) / tiles;
  return {
    mercatorX: x - Math.floor(x),
    mercatorY: (window.y + window.height / 2) / tiles,
    tileX: window.width / 2,
    tileY: window.height / 2,
  };
}

export function mercatorYToLat(y: number) {
  return (Math.atan(Math.sinh(Math.PI * (1 - 2 * y))) * 180) / Math.PI;
}

/**
 * Page table for the shader: one RGBA texel per window tile holding the atlas
 * slot (column, row) of the tile or of its nearest loaded parent, how many
 * levels up that parent is, and 255 in alpha when anything was found. Also
 * returns the keys of the tiles it points to.
 */
export function buildPageTable(
  window: TTileWindow,
  getSlot: (key: string) => number | undefined,
  atlasColumns: number
) {
  const data = new Uint8Array(window.width * window.height * 4);
  const used = new Set<string>();
  for (const tile of getWindowTiles(window)) {
    for (let up = 0; tile.z - up > BasemapZoom.BASE; up++) {
      const key = getTileKey(tile.z - up, tile.x >> up, tile.y >> up);
      const slot = getSlot(key);
      if (slot === undefined) {
        continue;
      }
      const offset = (tile.row * window.width + tile.column) * 4;
      data[offset] = slot % atlasColumns;
      data[offset + 1] = Math.floor(slot / atlasColumns);
      data[offset + 2] = up;
      data[offset + 3] = 255;
      used.add(key);
      break;
    }
  }
  return { data, used };
}

export function isSameTileWindow(a?: TTileWindow, b?: TTileWindow) {
  return (
    a?.zoom === b?.zoom &&
    a?.x === b?.x &&
    a?.y === b?.y &&
    a?.width === b?.width &&
    a?.height === b?.height
  );
}

/**
 * Second-order expansion of the inverse of a flat projection around a
 * reference point, for the shader: a map-plane offset `d` from the
 * reference becomes the Mercator offset `u - [uᵀQx u, uᵀQy u]` with
 * `u = jacobian · d`. Computed in double precision from the forward
 * projection, so the shader needs no trigonometry near the view. Undefined
 * where the projection is cut or degenerate at the reference.
 *
 * `project` maps latitude/longitude (degrees) to map-plane coordinates.
 */
export function getFlatMercatorExpansion(
  project: (lat: number, lon: number) => readonly number[],
  mercatorX: number,
  mercatorY: number
) {
  const h = EXPANSION_STEP;
  const at = (dx: number, dy: number) =>
    project(mercatorYToLat(mercatorY + dy), (mercatorX + dx) * 360 - 180);
  const center = at(0, 0);
  const east = at(h, 0);
  const west = at(-h, 0);
  const south = at(0, h);
  const north = at(0, -h);
  const corners = [at(h, h), at(h, -h), at(-h, h), at(-h, -h)];

  // Derivatives of map coordinate k by Mercator x and y.
  const dx = [0, 1].map((k) => (east[k] - west[k]) / (2 * h));
  const dy = [0, 1].map((k) => (south[k] - north[k]) / (2 * h));
  const det = dx[0] * dy[1] - dy[0] * dx[1];
  if (
    ![...dx, ...dy, det].every(Number.isFinite) ||
    det === 0 ||
    [...dx, ...dy].some((d) => Math.abs(d) > MAX_EXPANSION_DERIVATIVE)
  ) {
    return undefined;
  }
  // Inverse Jacobian, row-major.
  const jacobian = [dy[1] / det, -dy[0] / det, -dx[1] / det, dx[0] / det];

  // Hessian of map coordinate k as (xx, xy, yy).
  const hessians = [0, 1].map((k) => [
    (east[k] - 2 * center[k] + west[k]) / h ** 2,
    (corners[0][k] - corners[1][k] - corners[2][k] + corners[3][k]) /
      (4 * h ** 2),
    (south[k] - 2 * center[k] + north[k]) / h ** 2,
  ]);
  // Q_i = 1/2 * sum_k jacobian[i][k] * hessian_k
  const curvature = [0, 1].map((i) =>
    [0, 1, 2].map(
      (term) =>
        0.5 *
        (jacobian[i * 2] * hessians[0][term] +
          jacobian[i * 2 + 1] * hessians[1][term])
    )
  );
  return {
    projected: [center[0], center[1]],
    jacobian,
    curvatureX: curvature[0],
    curvatureY: curvature[1],
  };
}
