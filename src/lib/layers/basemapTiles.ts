// Web-Mercator (XYZ) tile maths for the basemap layer. Mercator coordinates
// are normalised to [0, 1] with y = 0 at the northern edge, like tile indices.

export const TILE_SIZE = 256;

export const BasemapZoom = {
  // The base texture covers the world at this zoom (4x4 tiles).
  BASE: 2,
  // ponytail: OSM's limit; move into the catalog once a provider needs more.
  MAX: 19,
  // ponytail: flat projections resolve absolute Mercator per fragment in
  // float32, which only holds about a pixel at zoom 16. Higher zooms need
  // offsets from a CPU-side reference, as the globe does.
  MAX_FLAT: 16,
} as const;

// Parents every this many levels up load before a window's own tiles, so
// the view fills quickly and then sharpens.
const PARENT_LEVEL_STEP = 2;

// Atlas side in tiles: 8192 x 4096 px (512 tiles, 128 MB) where the GPU
// allows, else 4096 x 4096 px.
const ATLAS_TILES = { COLUMNS: 32, ROWS: 16 } as const;

// Zoom levels added to the one whose tile pixels match device pixels. Tiles
// are designed for 256 CSS pixels, so matching device pixels shrinks labels
// on HiDPI screens and needs 4x the tiles. -0.75 shows tile pixels at 1.19x
// to 2.38x device pixels, one level coarser on average.
const ZOOM_BIAS = -0.75;

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

function wrappedDelta(a: number, b: number) {
  const delta = Math.abs(a - b);
  return Math.min(delta, 1 - delta);
}

/**
 * Smallest Mercator distance per screen pixel between neighbouring samples,
 * i.e. the finest detail anywhere in the view.
 */
function getMercatorPerPixel(grid: (TGeoPoint | null)[][], pixelStep: number) {
  let finest = Infinity;
  for (let row = 0; row < grid.length; row++) {
    for (let column = 0; column < grid[row].length; column++) {
      const point = grid[row][column];
      if (!point) {
        continue;
      }
      const neighbours = [grid[row][column + 1], grid[row + 1]?.[column]];
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
    }
  }
  return finest;
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
 * sampled `pixelStep` device pixels apart (null where the screen shows no
 * Earth). Returns undefined when the base texture is detailed enough.
 */
export function chooseTileWindow(
  grid: (TGeoPoint | null)[][],
  pixelStep: number,
  maxTiles: number,
  maxZoom: number
): TTileWindow | undefined {
  const mercatorPerPixel = getMercatorPerPixel(grid, pixelStep);
  if (!Number.isFinite(mercatorPerPixel)) {
    return undefined;
  }
  let zoom = Math.min(
    Math.round(Math.log2(1 / (mercatorPerPixel * TILE_SIZE)) + ZOOM_BIAS),
    maxZoom
  );

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
 * Tiles to load for a window: parents every PARENT_LEVEL_STEP levels up,
 * coarsest first, then the window's tiles nearest its centre first.
 */
export function getTileRequests(window: TTileWindow): TTileRequest[] {
  const centerColumn = (window.width - 1) / 2;
  const centerRow = (window.height - 1) / 2;
  const distance = (tile: TTile) =>
    (tile.column - centerColumn) ** 2 + (tile.row - centerRow) ** 2;
  const tiles = getWindowTiles(window).sort(
    (a, b) => distance(a) - distance(b)
  );

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
      const z = tile.z - up;
      const x = tile.x >> up;
      const y = tile.y >> up;
      const key = getTileKey(z, x, y);
      if (!requests.has(key)) {
        requests.set(key, { z, x, y, key });
      }
    }
  }
  return [...requests.values()];
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
