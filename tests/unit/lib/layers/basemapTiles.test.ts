import { describe, expect, it } from "vitest";

import {
  BasemapZoom,
  buildPageTable,
  chooseTileWindow,
  formatTileUrl,
  getAtlasLayout,
  getTileRequests,
  getWindowReference,
  getWindowTiles,
  latToMercatorY,
  lonToMercatorX,
  mercatorYToLat,
  WEB_MERCATOR_LAT_LIMIT,
  type TGeoPoint,
} from "@/lib/layers/basemapTiles.ts";

function makeGrid(
  south: number,
  west: number,
  step: number,
  rows: number,
  columns: number
): TGeoPoint[][] {
  return Array.from({ length: rows }, (_, row) =>
    Array.from({ length: columns }, (_, column) => ({
      lat: south + row * step,
      lon: ((west + column * step + 540) % 360) - 180,
    }))
  );
}

describe("Web-Mercator coordinates", () => {
  it("maps the antimeridian, equator and Mercator limit to tile edges", () => {
    expect(lonToMercatorX(-180)).toBe(0);
    expect(lonToMercatorX(180)).toBe(0);
    expect(lonToMercatorX(0)).toBe(0.5);
    expect(latToMercatorY(0)).toBeCloseTo(0.5, 12);
    expect(latToMercatorY(WEB_MERCATOR_LAT_LIMIT)).toBeCloseTo(0, 12);
    expect(latToMercatorY(-90)).toBeCloseTo(1, 12);
  });
});

describe("formatTileUrl", () => {
  it("fills placeholders in any order and rejects unknown ones", () => {
    expect(formatTileUrl("https://t/{z}/{y}/{x}.png", 3, 5, 2)).toBe(
      "https://t/3/2/5.png"
    );
    expect(() => formatTileUrl("https://{s}.t/{z}", 1, 0, 0)).toThrow(/"s"/);
  });
});

describe("getAtlasLayout", () => {
  it("fits the atlas to the GPU and keeps a quarter free for parents", () => {
    expect(getAtlasLayout(16384)).toEqual({
      columns: 32,
      rows: 16,
      maxWindowTiles: 384,
    });
    expect(getAtlasLayout(4096)).toEqual({
      columns: 16,
      rows: 16,
      maxWindowTiles: 192,
    });
  });
});

const { maxWindowTiles } = getAtlasLayout(8192);

describe("chooseTileWindow", () => {
  it("leaves zoomed-out views to the base texture", () => {
    expect(
      chooseTileWindow(makeGrid(-40, -60, 30, 4, 5), 100, maxWindowTiles)
    ).toBe(undefined);
  });

  it("picks the zoom nearest to tile pixels matching CSS pixels", () => {
    const grid = makeGrid(0, 170, 5, 3, 5);
    // 5° samples 1120 px apart match tile pixels at zoom 8.30, 1400 px apart
    // at 8.62.
    expect(chooseTileWindow(grid, 1120, 1000)?.zoom).toBe(8);
    expect(chooseTileWindow(grid, 1400, 1000)?.zoom).toBe(9);
  });

  it("wraps windows across the antimeridian and shrinks them to the cap", () => {
    // 5° samples 1000 px apart ask for zoom 8: 18 x 11 tiles.
    const grid = makeGrid(0, 170, 5, 3, 5);
    expect(chooseTileWindow(grid, 1000, maxWindowTiles)).toEqual({
      zoom: 8,
      x: 247,
      y: 119,
      width: 18,
      height: 11,
    });
    const window = chooseTileWindow(grid, 1000, 100);
    expect(window).toEqual({ zoom: 7, x: 123, y: 59, width: 10, height: 7 });
    const columns = getWindowTiles(window!).map((tile) => tile.x);
    expect(new Set(columns)).toEqual(
      new Set([123, 124, 125, 126, 127, 0, 1, 2, 3, 4])
    );
  });
});

describe("chooseTileWindow limits", () => {
  it("caps the zoom and the window size", () => {
    const fine = makeGrid(0, 0, 1e-5, 3, 3);
    expect(chooseTileWindow(fine, 100, maxWindowTiles)?.zoom).toBe(
      BasemapZoom.MAX
    );

    // Asks for zoom 7 over 340° of longitude; zoom 5 already needs 416 tiles.
    const wide = chooseTileWindow(
      makeGrid(-60, -170, 0.5, 240, 680),
      50,
      maxWindowTiles
    );
    expect(wide?.zoom).toBe(4);
    expect(wide!.width * wide!.height).toBeLessThanOrEqual(maxWindowTiles);
  });

  it("ignores screen samples that miss the Earth", () => {
    const grid: (TGeoPoint | null)[][] = makeGrid(0, 170, 5, 3, 5);
    grid[0][0] = null;
    grid[2] = grid[2].map(() => null);
    expect(chooseTileWindow(grid, 1000, maxWindowTiles)?.zoom).toBe(8);
    expect(chooseTileWindow([[null, null]], 1000, maxWindowTiles)).toBe(
      undefined
    );
  });
});

describe("buildPageTable", () => {
  it("points each tile at itself, else at its nearest loaded parent", () => {
    // Columns 14, 15 and (wrapped) 0 of zoom 4.
    const window = { zoom: 4, x: 14, y: 5, width: 3, height: 1 };
    const slots = new Map([
      ["4/15/5", 33],
      ["3/0/2", 2],
      // Below the base zoom, so never used.
      ["2/3/1", 7],
    ]);
    const { data, used } = buildPageTable(window, (key) => slots.get(key), 32);
    expect([...data]).toEqual([
      ...[0, 0, 0, 0],
      ...[1, 1, 0, 255],
      ...[2, 0, 1, 255],
    ]);
    expect(used).toEqual(new Set(["4/15/5", "3/0/2"]));
  });
});

describe("getTileRequests", () => {
  it("loads each parent level once, coarsest first, then centre tiles", () => {
    // Columns 62, 63 and (wrapped) 0, 1 of zoom 6; parents two levels up.
    const window = { zoom: 6, x: 62, y: 20, width: 4, height: 1 };
    // One sample at each tile centre, 256 px apart: one tile pixel per pixel.
    const grid = [
      [62.5, 63.5, 0.5, 1.5].map((x) => ({
        lat: mercatorYToLat(20.5 / 64),
        lon: (x / 64) * 360 - 180,
      })),
    ];
    const keys = getTileRequests(window, grid, 256).map(
      (request) => request.key
    );
    expect(keys).toEqual([
      "4/15/5",
      "4/0/5",
      "6/63/20",
      "6/0/20",
      "6/62/20",
      "6/1/20",
    ]);
  });
});

describe("getTileRequests per view", () => {
  it("skips window tiles that no sample shows", () => {
    const grid: (TGeoPoint | null)[][] = makeGrid(0, 170, 5, 3, 5);
    grid[2][3] = null;
    grid[2][4] = null;
    grid[1][4] = null;
    const window = chooseTileWindow(grid, 1000, maxWindowTiles)!;
    const keys = new Set(
      getTileRequests(window, grid, 1000).map((request) => request.key)
    );
    const tileKey = (lat: number, lon: number) =>
      `8/${Math.floor(lonToMercatorX(lon) * 256)}/${Math.floor(latToMercatorY(lat) * 256)}`;
    expect(keys.has(tileKey(0, 170))).toBe(true);
    expect(keys.has(tileKey(10, -170))).toBe(false);
  });

  it("loads coarser tiles where the screen shows less detail", () => {
    // 0.1° samples on the left and 2° samples on the right, 100 px apart:
    // zoom 10 (capped to the window's 9), and 4.3 levels less on the right.
    const grid = [0, 1, 2].map((row) => [
      ...[0, 0.1, 0.2].map((lon) => ({ lat: row * 0.1, lon })),
      ...[10, 12, 14].map((lon) => ({ lat: row * 2, lon })),
    ]);
    const window = chooseTileWindow(grid, 100, maxWindowTiles)!;
    expect(window.zoom).toBe(9);
    const requests = getTileRequests(window, grid, 100);
    const zoomsAt = (lat: number, lon: number) =>
      requests
        .filter(
          (request) =>
            request.x === Math.floor(lonToMercatorX(lon) * 2 ** request.z) &&
            request.y === Math.floor(latToMercatorY(lat) * 2 ** request.z)
        )
        .map((request) => request.z);
    expect(zoomsAt(0.1, 0.1)).toContain(9);
    expect(zoomsAt(2, 12)).toContain(6);
    expect(zoomsAt(2, 12).every((zoom) => zoom <= 6)).toBe(true);
    expect(requests.length).toBeLessThan(window.width * window.height);
  });

  it("keeps one zoom where the detail differs by less than a level", () => {
    // 0.1° and 0.12° samples 106 px apart ask for zoom 10.55 and 10.29,
    // which round differently.
    const grid = [0, 1, 2].map((row) => [
      ...[0, 0.1, 0.2].map((lon) => ({ lat: row * 0.1, lon })),
      ...[0.4, 0.52, 0.64].map((lon) => ({ lat: row * 0.12, lon })),
    ]);
    const window = chooseTileWindow(grid, 106, maxWindowTiles)!;
    expect(window.zoom).toBe(11);
    const zooms = getTileRequests(window, grid, 106).map(
      (request) => request.z
    );
    // Parents are at 9 and below.
    expect(zooms).not.toContain(10);
  });
});

describe("getWindowReference", () => {
  it("wraps the window centre around the antimeridian", () => {
    expect(
      getWindowReference({ zoom: 3, x: 7, y: 2, width: 2, height: 2 })
    ).toEqual({ mercatorX: 0, mercatorY: 3 / 8, tileX: 1, tileY: 1 });
  });
});
