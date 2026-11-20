import type { Grid } from "healpix-geo";

import type { TAxisRange } from "@/lib/data/viewWindow.ts";
import type { TViewFootprint } from "@/lib/projection/viewFootprint.ts";

/**
 * A view window of a nested HEALPix level is made of blocks: the cells below
 * one cell this many orders up. A block is 4^6 = 4096 cells, contiguous in
 * nested order and a square on its face.
 */
// ponytail: a fixed block size. Derive it from the chunk length if stores
// with much larger chunks make single blocks wasteful.
const HEALPIX_BLOCK_DEPTH = 6;

// side of one of the 12 base faces, sqrt(4π / 12) in degrees
const FACE_SIDE_DEGREES = 58.63;
const RADIANS = Math.PI / 180;

function normalizeLon(lon: number) {
  return ((((lon + 180) % 360) + 360) % 360) - 180;
}

/** Order of the cells a level's view window is made of. */
export function healpixBlockLevel(level: number) {
  return level > HEALPIX_BLOCK_DEPTH ? level - HEALPIX_BLOCK_DEPTH : 0;
}

/** Order cells of `blockGrid` by their distance to a point, nearest first. */
function nearestFirst(
  blockGrid: Grid,
  blocks: number[],
  lon: number,
  lat: number
) {
  const centres = blockGrid.healpixToLonLat(
    BigUint64Array.from(blocks, (block) => BigInt(block))
  );
  const distance = blocks.map((_, index) => {
    const dLon = (centres[2 * index] - lon) * RADIANS;
    const blockLat = centres[2 * index + 1] * RADIANS;
    // great-circle distance through its cosine
    return -(
      Math.sin(blockLat) * Math.sin(lat * RADIANS) +
      Math.cos(blockLat) * Math.cos(lat * RADIANS) * Math.cos(dLon)
    );
  });
  return blocks
    .map((block, index) => ({ block, index }))
    .sort((a, b) => distance[a.index] - distance[b.index])
    .map(({ block }) => block);
}

/**
 * The cells of `blockGrid` that a view footprint touches, grown by `margin`
 * (a fraction of the footprint's size) on every side, nearest the point below
 * the camera first. A footprint of more than `maxBlocks` is `cut` to those
 * nearest that point.
 */
function footprintBlocks(
  blockGrid: Grid,
  footprint: TViewFootprint,
  margin: number,
  maxBlocks: number
) {
  const side = FACE_SIDE_DEGREES / 2 ** blockGrid.level;
  const latMargin = (footprint.latMax - footprint.latMin) * margin;
  let south = Math.max(footprint.latMin - latMargin, -90);
  let north = Math.min(footprint.latMax + latMargin, 90);
  let span = Math.min(footprint.lonSpan * (1 + 2 * margin), 360);
  let west = footprint.lonStart - (span - footprint.lonSpan) / 2;
  // blocks the box holds, by area
  const estimate =
    (span * (Math.sin(north * RADIANS) - Math.sin(south * RADIANS))) /
    RADIANS /
    side ** 2;
  let cut = estimate > maxBlocks;
  if (cut) {
    // Over the budget, sample only a square around the point below the
    // camera, wide enough to hold the circle of the budget's nearest blocks.
    // A square that reaches a pole is the band up to it: the cells on the
    // other side of the pole are among the nearest.
    // ponytail: the square is not clipped to the view. A view much longer
    // than wide then loads blocks beside it; clip the square to the box if
    // such views matter.
    const half = 0.6 * Math.sqrt(maxBlocks) * side;
    const edge = Math.abs(footprint.centreLat) + half;
    south = Math.max(footprint.centreLat - half, -90);
    north = Math.min(footprint.centreLat + half, 90);
    span =
      edge < 90 ? Math.min((2 * half) / Math.cos(edge * RADIANS), 360) : 360;
    west = footprint.centreLon - span / 2;
  }
  // Four samples per block side: a block is only missed where less than a
  // quarter of its side reaches into the box.
  const spacing = side / 4;
  const rows = Math.ceil((north - south) / spacing) + 1;
  const coordinates: number[] = [];
  for (let row = 0; row < rows; row++) {
    const lat =
      rows > 1
        ? Math.min(south + ((north - south) * row) / (rows - 1), north)
        : south;
    const columns = Math.ceil((span * Math.cos(lat * RADIANS)) / spacing) + 1;
    for (let column = 0; column < columns; column++) {
      const offset = columns > 1 ? (span * column) / (columns - 1) : span / 2;
      coordinates.push(normalizeLon(west + offset), lat);
    }
  }
  const sampled = blockGrid.lonLatToHealpix(Float64Array.from(coordinates));
  const blocks = nearestFirst(
    blockGrid,
    [...new Set(Array.from(sampled, Number))],
    footprint.centreLon,
    footprint.centreLat
  );
  cut ||= blocks.length > maxBlocks;
  return { blocks: blocks.slice(0, maxBlocks), cut };
}

/**
 * Ids of the blocks of a nested level to load for a view footprint,
 * ascending: the blocks the footprint touches and then, as far as
 * `maxBlocks` allows, those within `margin` (a fraction of the footprint's
 * size) of it. A footprint of more than `maxBlocks` gives those nearest the
 * point below the camera.
 */
export function healpixViewBlocks(
  grid: Grid,
  footprint: TViewFootprint,
  margin = 0,
  maxBlocks = Infinity
) {
  using blockGrid = grid.replace({
    level: healpixBlockLevel(grid.level),
    scheme: "nested",
  });
  const view = footprintBlocks(blockGrid, footprint, 0, maxBlocks);
  let blocks = view.blocks;
  if (!view.cut && margin > 0) {
    const inView = new Set(blocks);
    blocks = blocks.concat(
      footprintBlocks(blockGrid, footprint, margin, maxBlocks)
        .blocks.filter((block) => !inView.has(block))
        .slice(0, maxBlocks - blocks.length)
    );
  }
  return blocks.sort((a, b) => a - b);
}

/**
 * The blocks a view cannot do without: every block its footprint touches,
 * or the nearest half of `maxBlocks` when it touches more than `maxBlocks`,
 * so that such a view does not reload on every move. They are the first of
 * the blocks `healpixViewBlocks` loads for the same view: a window just
 * loaded always holds them.
 */
export function healpixNeededBlocks(
  grid: Grid,
  footprint: TViewFootprint,
  maxBlocks = Infinity
) {
  using blockGrid = grid.replace({
    level: healpixBlockLevel(grid.level),
    scheme: "nested",
  });
  const view = footprintBlocks(blockGrid, footprint, 0, maxBlocks);
  return view.cut
    ? view.blocks.slice(0, Math.floor(maxBlocks / 2))
    : view.blocks;
}

/** Nested cell ranges of ascending block ids, runs of neighbours merged. */
export function healpixBlockRanges(blocks: number[], cellsPerBlock: number) {
  const ranges: TAxisRange[] = [];
  for (const block of blocks) {
    const last = ranges[ranges.length - 1];
    if (last && last.end === block * cellsPerBlock) {
      last.end += cellsPerBlock;
    } else {
      ranges.push({
        start: block * cellsPerBlock,
        end: (block + 1) * cellsPerBlock,
      });
    }
  }
  return ranges;
}
