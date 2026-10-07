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

/** Keep the `count` cells of `blockGrid` nearest to a point. */
function nearestBlocks(
  blockGrid: Grid,
  blocks: number[],
  lon: number,
  lat: number,
  count: number
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
    .slice(0, count)
    .map(({ block }) => block);
}

/**
 * Ids of the blocks of a nested level that a view footprint touches, grown
 * by `margin` (a fraction of the footprint's size) on every side, ascending.
 * At most `maxBlocks` are returned, those nearest the centre of the view.
 */
// eslint-disable-next-line max-lines-per-function
export function healpixViewBlocks(
  grid: Grid,
  footprint: TViewFootprint,
  margin = 0,
  maxBlocks = Infinity
) {
  const blockLevel = healpixBlockLevel(grid.level);
  const side = FACE_SIDE_DEGREES / 2 ** blockLevel;
  const latMargin = (footprint.latMax - footprint.latMin) * margin;
  let south = Math.max(footprint.latMin - latMargin, -90);
  let north = Math.min(footprint.latMax + latMargin, 90);
  let span = Math.min(footprint.lonSpan * (1 + 2 * margin), 360);
  let west = footprint.lonStart - (span - footprint.lonSpan) / 2;
  // Over the budget, sample only around the point below the camera. A band
  // that still reaches a pole keeps every longitude: the cells on the other
  // side of the pole are among the nearest.
  for (let pass = 0; pass < 3; pass++) {
    // blocks the box holds, by area
    const estimate =
      (span * (Math.sin(north * RADIANS) - Math.sin(south * RADIANS))) /
      RADIANS /
      side ** 2;
    if (estimate <= maxBlocks) {
      break;
    }
    const factor = Math.sqrt(maxBlocks / estimate);
    const half = ((north - south) / 2) * factor;
    south = Math.max(footprint.centreLat - half, -90);
    north = Math.min(footprint.centreLat + half, 90);
    if (south > -90 && north < 90) {
      span *= factor;
      west = footprint.centreLon - span / 2;
    }
  }
  // Four samples per block side: a block is only missed where less than a
  // quarter of its side reaches into the box, and the margin covers that.
  const spacing = side / 4;
  const rows = Math.ceil((north - south) / spacing) + 1;
  const coordinates: number[] = [];
  for (let row = 0; row < rows; row++) {
    const lat = rows > 1 ? south + ((north - south) * row) / (rows - 1) : south;
    const columns = Math.ceil((span * Math.cos(lat * RADIANS)) / spacing) + 1;
    for (let column = 0; column < columns; column++) {
      const offset = columns > 1 ? (span * column) / (columns - 1) : span / 2;
      coordinates.push(normalizeLon(west + offset), lat);
    }
  }
  using blockGrid = grid.replace({ level: blockLevel, scheme: "nested" });
  const sampled = blockGrid.lonLatToHealpix(Float64Array.from(coordinates));
  let blocks = [...new Set(Array.from(sampled, Number))];
  if (blocks.length > maxBlocks) {
    blocks = nearestBlocks(
      blockGrid,
      blocks,
      footprint.centreLon,
      footprint.centreLat,
      maxBlocks
    );
  }
  return blocks.sort((a, b) => a - b);
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
