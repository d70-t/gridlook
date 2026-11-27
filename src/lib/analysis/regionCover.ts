import type { Grid } from "healpix-geo";

import {
  capCountryRelation,
  countryContains,
  type TCountryRegion,
} from "./countryRegion.ts";
import {
  childRange,
  idRangeCellCount,
  mergeIdRanges,
  type TIdRange,
} from "./healpixIds.ts";
import {
  angleBetween,
  boxContains,
  CAP_RELATION,
  capBoxRelation,
  capPolygonRelation,
  polygonContains,
  toVec,
  type TBox,
  type TCapRelation,
  type TPreparedPolygon,
} from "./sphere.ts";

export const REGION_KINDS = {
  BOX: "box",
  POLYGON: "polygon",
  COUNTRY: "country",
} as const;

export type TRegion =
  | { kind: typeof REGION_KINDS.BOX; box: TBox }
  | { kind: typeof REGION_KINDS.POLYGON; polygon: TPreparedPolygon }
  | { kind: typeof REGION_KINDS.COUNTRY; country: TCountryRegion };

export function regionContains(region: TRegion, lat: number, lon: number) {
  if (region.kind === REGION_KINDS.COUNTRY) {
    return countryContains(region.country, lat, lon);
  }
  return region.kind === REGION_KINDS.BOX
    ? boxContains(region.box, lat, lon)
    : polygonContains(region.polygon, lat, lon);
}

function capRegionRelation(
  region: TRegion,
  lat: number,
  lon: number,
  radius: number
): TCapRelation {
  if (region.kind === REGION_KINDS.COUNTRY) {
    return capCountryRelation(region.country, lat, lon, radius);
  }
  return region.kind === REGION_KINDS.BOX
    ? capBoxRelation(region.box, lat, lon, radius)
    : capPolygonRelation(region.polygon, lat, lon, radius);
}

/** A block of at most this many cells is tested cell by cell. */
const LEAF_CELLS = 16;

/**
 * The cells of a latitude/longitude grid (candidate rows and columns) that can
 * hold a region's centres, in no particular order: blocks of rows and columns
 * whose enclosing cap is outside the region are skipped whole, so a thin region
 * is not tested across its bounding rectangle. The caller still tests each cell
 * given.
 */
// eslint-disable-next-line max-lines-per-function
export function* cellsNear(
  region: TRegion,
  lats: ArrayLike<number>,
  lons: ArrayLike<number>,
  rows: number[],
  cols: number[]
): Generator<[number, number]> {
  // Longitudes as offsets from the first column's, so a block is one arc.
  const reference = cols.length ? lons[cols[0]] : 0;
  const offset = (j: number) => ((lons[j] - reference + 540) % 360) - 180;
  const byLat = rows.slice().sort((a, b) => lats[a] - lats[b]);
  const byLon = cols.slice().sort((a, b) => offset(a) - offset(b));
  const stack = [[0, byLat.length, 0, byLon.length]];
  while (stack.length) {
    const [r0, r1, c0, c1] = stack.pop()!;
    if (r1 <= r0 || c1 <= c0) {
      continue;
    }
    if ((r1 - r0) * (c1 - c0) <= LEAF_CELLS) {
      for (let r = r0; r < r1; r++) {
        for (let c = c0; c < c1; c++) {
          yield [byLat[r], byLon[c]];
        }
      }
      continue;
    }
    // On a sphere the point of a latitude/longitude block farthest from its
    // centre is a corner (distance grows with the longitude difference and
    // is unimodal along a meridian), for blocks under half a turn wide.
    const [south, north] = [lats[byLat[r0]], lats[byLat[r1 - 1]]];
    const [west, east] = [offset(byLon[c0]), offset(byLon[c1 - 1])];
    if (east - west < 180) {
      const lat = (south + north) / 2;
      const lon = reference + (west + east) / 2;
      const centre = toVec(lat, lon);
      let radius = 0;
      for (const y of [south, north]) {
        for (const x of [west, east]) {
          radius = Math.max(
            radius,
            angleBetween(centre, toVec(y, reference + x))
          );
        }
      }
      if (
        capRegionRelation(region, lat, lon, radius * (1 + 1e-9) + 1e-12) ===
        CAP_RELATION.OUTSIDE
      ) {
        continue;
      }
    }
    // Split the longer side.
    if (r1 - r0 >= c1 - c0) {
      const mid = (r0 + r1) >> 1;
      stack.push([r0, mid, c0, c1], [mid, r1, c0, c1]);
    } else {
      const mid = (c0 + c1) >> 1;
      stack.push([r0, r1, c0, mid], [r0, r1, mid, c1]);
    }
  }
}

// Cell boundaries are curved; the radius is the largest distance to a sample
// of boundary and interior points, widened by this factor (both directions
// of the classification stay conservative for a larger cap).
const CAP_SAFETY_FACTOR = 1.5;

function cellRadius(grid: Grid, cell: bigint, centre: [number, number]) {
  const steps = grid.level <= 2 ? 7 : 3;
  const points = grid.vertices(cell, steps);
  const c = toVec(centre[1], centre[0]);
  let radius = 0;
  for (let at = 0; at < points.length; at += 2) {
    const d = angleBetween(c, toVec(points[at + 1], points[at]));
    if (d > radius) {
      radius = d;
    }
  }
  return radius * CAP_SAFETY_FACTOR + 1e-12;
}

export type TCoverOptions = {
  /** Refuse once a level holds more undecided cells than this. */
  maxBoundaryCells?: number;
  isCancelled?: () => boolean;
};

export type TRegionCover = {
  /** Merged nested id ranges at the analysis order. */
  ranges: TIdRange[];
  cellCount: bigint;
  /** Cells whose classification needed an explicit test. */
  testedCells: number;
};

const YIELD_EVERY = 8192;

function yieldTask() {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/**
 * Conservative hierarchical cover of the cells whose centres lie in `region`
 * at the order of `grid` (nested). Cells whose cap is certainly inside or
 * outside are decided at once; undecided cells are refined, and at the
 * analysis order the centre itself is tested.
 */
// eslint-disable-next-line max-lines-per-function
export async function coverHealpixRegion(
  grid: Grid,
  region: TRegion,
  options: TCoverOptions = {}
): Promise<TRegionCover> {
  if (grid.scheme !== "nested") {
    throw new Error("Region analysis needs a nested HEALPix grid.");
  }
  const maxBoundaryCells = options.maxBoundaryCells ?? 2_000_000;
  const target = grid.level;
  const ranges: TIdRange[] = [];
  let testedCells = 0;
  let current = new BigUint64Array(12).map((_, at) => BigInt(at));
  for (let level = 0; level <= target && current.length > 0; level++) {
    if (current.length > maxBoundaryCells) {
      throw new Error(
        `The region outline crosses more than ${maxBoundaryCells} cells at order ${level}; use a coarser preview order or a simpler outline.`
      );
    }
    const levelGrid = level === target ? grid : grid.replace({ level });
    try {
      const centres = levelGrid.healpixToLonLat(current);
      const next: bigint[] = [];
      for (let at = 0; at < current.length; at++) {
        if (at % YIELD_EVERY === YIELD_EVERY - 1) {
          await yieldTask();
          if (options.isCancelled?.()) {
            throw new DOMException("Cancelled", "AbortError");
          }
        }
        testedCells++;
        const cell = current[at];
        const lon = centres[2 * at];
        const lat = centres[2 * at + 1];
        if (level === target) {
          if (regionContains(region, lat, lon)) {
            ranges.push([cell, cell + 1n]);
          }
          continue;
        }
        const radius = cellRadius(levelGrid, cell, [lon, lat]);
        const relation = capRegionRelation(region, lat, lon, radius);
        if (relation === CAP_RELATION.INSIDE) {
          ranges.push(childRange(cell, level, target));
        } else if (relation === CAP_RELATION.UNCERTAIN) {
          // Refuse before the next generation grows past the limit.
          if (next.length + 4 > maxBoundaryCells) {
            throw new Error(
              `The region outline crosses more than ${maxBoundaryCells} cells at order ${level + 1}; use a coarser preview order or a simpler outline.`
            );
          }
          const first = cell * 4n;
          next.push(first, first + 1n, first + 2n, first + 3n);
        }
      }
      current = BigUint64Array.from(next);
    } finally {
      if (levelGrid !== grid) {
        levelGrid.free();
      }
    }
  }
  const merged = mergeIdRanges(ranges);
  return { ranges: merged, cellCount: idRangeCellCount(merged), testedCells };
}
