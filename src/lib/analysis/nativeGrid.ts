/**
 * Native locators for grids that are not HEALPix or a latitude/longitude
 * product: irregular sites or cells (`lat(n), lon(n)`), UGRID meshes (face
 * or node data) and curvilinear cells (`lat(j,i), lon(j,i)`, rotated grids
 * with true coordinates included).
 *
 * Metadata is resolved when a variable is described; the geometry (centres,
 * cell outlines, areas and a sphere-aware bucket index) loads on first use
 * and is shared by every variable on the same coordinates.
 */
import { AnalysisInputError } from "./analysisErrors.ts";
import {
  axisSides,
  containingIndex,
  containingPeriodic,
  type TAxisLocator,
} from "./axisLocate.ts";
import {
  chunkByteSize,
  wholeIndexBytes,
  raceAbort,
  throwIfAborted,
  yieldIfBusy,
  type TAnalysisArray,
  type TStoredChunk,
} from "./chunkVisitor.ts";
import { countryContains, type TCountryRegion } from "./countryRegion.ts";
import {
  isProjectedAxis,
  metresPer,
  projectedCoordinateArrays,
  projectedCrsOf,
} from "./projectedGrid.ts";
import {
  rotatedPoleOf,
  trueCoordinates,
  trueToRotated,
} from "./rotatedPole.ts";
import { SharedReads } from "./sharedRead.ts";
import {
  isMissing,
  openReferenced,
  type TAnalysisDataset,
} from "./sourceAdapter.ts";
import {
  boxContains,
  polygonContains,
  toVec,
  type TBox,
  type TPreparedPolygon,
  type TVec3,
} from "./sphere.ts";
import { MAX_WORKING_BYTES } from "./types.ts";
import { isAreaUnit } from "./unitConvert.ts";
import {
  buildValueCodec,
  decodeStoredBigInt,
  decodeStoredValue,
} from "./valueDecoding.ts";
import { looksEnsemble, looksVertical } from "./vertical.ts";

import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";

type TAttrs = Record<string, unknown>;

const NATIVE_FAMILIES = {
  SITES: "sites",
  CELLS: "cells",
  MESH_FACES: "mesh-faces",
  MESH_NODES: "mesh-nodes",
  CURVILINEAR: "curvilinear",
} as const;

type TNativeFamily = (typeof NATIVE_FAMILIES)[keyof typeof NATIVE_FAMILIES];

/** Most cells whose geometry is loaded for plots. */
const MAX_NATIVE_CELLS = 4_194_304;
/** Most corner values (cells × corners) read for cell outlines. */
const MAX_CORNER_VALUES = 16_777_216;
const DEG = Math.PI / 180;

/** What is read to build the geometry, all decoded to degrees. */
type TGeometrySource = {
  lat: TAnalysisArray;
  lon: TAnalysisArray;
  /**
   * Native dimension order (the field's axis order). Each coordinate, bounds
   * and measure array is permuted from its own named dimensions into it.
   */
  nativeDims: string[];
  bounds?: { lat: TAnalysisArray; lon: TAnalysisArray };
  mesh?: {
    connectivity: TAnalysisArray;
    /** Axis of the connectivity holding faces. */
    faceAxis: number;
    startIndex: number;
    nodeLat: TAnalysisArray;
    nodeLon: TAnalysisArray;
    /** Published face centres (`face_coordinates`), when given. */
    faceLat?: TAnalysisArray;
    faceLon?: TAnalysisArray;
  };
  measure?: TAnalysisArray;
  /** Points located by the grid's own 1-D axes (TFoundCoordinates). */
  locate?: TAxisLocator;
  refinedAreas?: TRefinedAreas;
  axisAreas?: TRefinedAreas;
};

/** Cell areas from corners too large to keep, loaded for area plots. */
type TCornerAreas = {
  /** Peak working bytes of the load (centres, areas and decoding). */
  bytes: number;
  /** Largest decoded corner chunk (the per-chunk limit applies). */
  chunkBytes: number;
  /** Corner chunks still to read (none once loaded). */
  readsNow: () => number;
  /**
   * What those reads decode: each array's chunks at its own chunk size, not
   * every read at the largest.
   */
  decodedNow: () => number;
  /** Area per cell (0: none from its corners), cached per grid. */
  load: (signal?: AbortSignal) => Promise<Float64Array>;
};

export type TNativeContext = {
  /** Identity of the geometry: country masks are reused across fields. */
  regionKey?: string;
  kind: "native";
  family: TNativeFamily;
  /** Field axes of the native position, ascending (one or two). */
  axes: number[];
  /** Sizes along `axes`; the flat cell index is row-major over them. */
  shape: number[];
  count: number;
  /** How a location picks its cell, in words. */
  method: string;
  label: string;
  /** Area weights, when defensible; otherwise why not. */
  weighting?: string;
  noWeights?: string;
  /** Its declared areas could not be read now: described again later. */
  areasUnreachable?: boolean;
  /**
   * Sites without areas: an area time series is the plain mean of the
   * sites inside (each counts once), said in these words; other area plots
   * stay refused (a site list has no area to share out).
   */
  siteMean?: string;
  geometry: (signal?: AbortSignal) => Promise<TNativeGeometry>;
  /**
   * Outlines too large to hold: the cells are located by their centres
   * alone (points and paths read no corners), and area plots load each
   * cell's area from its corners on demand, read once and not kept.
   */
  cornerAreas?: TCornerAreas;
  /**
   * Bytes the loaded geometry holds (centres, areas, spacing, bucket
   * index, corner vectors or face nodes), for the memory estimate.
   */
  geometryBytes: number;
  /** Stored chunks read to build the geometry when it is not cached. */
  geometryReads: number;
  /** Largest decoded chunk of any geometry array (its declared shape). */
  geometryChunkBytes: number;
  /** Whether the geometry is already loaded (no reads, nothing new held). */
  geometryReady: () => boolean;
  /** Coordinate chunks still to read before a locator can answer. */
  geometryReadsNow: () => number;
  /** Stored bytes those reads fetch for an axis locator (its sides). */
  geometryBytesNow?: () => number;
};

/**
 * What loading the geometry costs before any field read, from every array
 * it reads: stored chunks (requests); the largest declared chunk (a padded
 * edge chunk decodes whole: this is what the per-chunk limit applies to);
 * and the transient workspace, that chunk plus its Float64 conversion of
 * only the array's own extent (a two-value axis converts two values).
 */
function geometryCostOf(arrays: (TAnalysisArray | undefined)[]) {
  let reads = 0;
  let peak = 0;
  let workspace = 0;
  for (const array of arrays) {
    if (!array) {
      continue;
    }
    reads += array.shape.reduce(
      (p, n, d) => p * Math.ceil(n / Math.max(1, array.chunks[d])),
      1
    );
    // A computed coordinate's stored chunks, as read to make it.
    const declared = Math.max(
      chunkByteSize(array),
      array.backingChunkBytes ?? 0
    );
    const converted =
      Math.min(
        array.chunks.reduce((p, n) => p * Math.max(1, n), 1),
        array.shape.reduce((p, n) => p * n, 1)
      ) * 8;
    peak = Math.max(peak, declared);
    workspace = Math.max(
      workspace,
      Math.max(declared, array.backingHeldBytes ?? 0) + converted
    );
  }
  return {
    geometryReads: reads,
    geometryChunkBytes: peak,
    geometryWorkspace: workspace,
  };
}

/**
 * Per cell: lat, lon, area, spacing (8 B each), the spatial index's bucket,
 * item and count slots, and the decoded copy kept while it is built (56 B
 * measured on a million sites, where 40 B undercounted).
 */
function geometryBytesOf(count: number, cornerValues: number, faces = 0) {
  // Cells with corners also keep each radius, its chord and a subtree
  // maximum for containment (12 bytes); faces the same.
  return (
    count * 56 +
    (cornerValues ? count * 12 : 0) +
    cornerValues * 2 * 8 +
    faces * 60
  );
}

/**
 * The peak of reading cell areas from corners without keeping them: the
 * centres and index (as geometryBytesOf without corners), an area per
 * cell, the first corner array held as float32 offsets from its centre
 * while the second is decoded (its chunk and conversion) and copied.
 */
export function areasOnlyBytes(
  count: number,
  cornerValues: number,
  arrays: TAnalysisArray[]
) {
  return (
    geometryBytesOf(count, 0) +
    count * 8 +
    // The corner latitudes kept as float32 offsets while the longitudes are
    // decoded: the read and its converted copy, both float64, live at once.
    cornerValues * 4 +
    cornerValues * 8 * 2 +
    geometryCostOf(arrays).geometryWorkspace
  );
}

type TFaceCentres = {
  lat: Float64Array;
  lon: Float64Array;
  index: SphereIndex;
};

export type TNativeGeometry = {
  count: number;
  /** Centre of each cell or site (degrees); NaN marks an invalid cell. */
  lat: Float64Array;
  lon: Float64Array;
  /**
   * Cell outlines, `corners` per cell, with each corner's unit vector made
   * on demand: corner latitude/longitude as read (cells with bounds) or
   * node ids into the node coordinates (meshes). Nothing per corner is
   * copied into vectors, which keeps an 830,305-cell, 16-corner grid at
   * its decoded bounds instead of 1.5 times more.
   */
  outline?: TOutline;
  /** Area weight per cell (steradians or declared measure). */
  areas?: Float64Array;
  /** Refines `areas` in place before their first use (nativeAreas). */
  refine?: () => Promise<void>;
  /** Mesh nodes: each face's node indices (−1 padding) for nodal data. */
  faceNodes?: { corners: number; nodes: Int32Array; faceCount: number };
  /** Face centres and their index, when the cells are nodes. */
  faceCentres?: TFaceCentres;
  index: SphereIndex;
  /** Largest centre-to-corner angle, degrees (containment search radius). */
  maxRadius: number;
  /** The cell holding a point by the grid's own axes, or −1. */
  nativeLocate?: (lat: number, lon: number) => number;
  /** Each cell's centre-to-corner angle, degrees (indexed by `index`). */
  radii?: Float32Array;
  invalid: number;
  /**
   * Cells repeating another cell (a curvilinear grid's halo columns or
   * tripolar fold row): kept out of every selection, so each place counts
   * once.
   */
  duplicates?: number;
  /**
   * Each kept cell's dropped copies: a value missing in the kept one may be
   * measured in a copy (area series read both, counting one).
   */
  copies?: Map<number, number[]>;
  /** Nearest-neighbour spacing per site, computed on demand (degrees). */
  spacing: Float64Array;
};

// ---------------------------------------------------------------------------
// Sphere-aware bucket index on centres.

/**
 * A spherical point index that adapts to density: a k-d tree over unit
 * vectors (Float32 for the tree; exact angles from the stored degrees for
 * every candidate). Ten thousand stations packed into one square degree
 * cost a few dozen candidates per pick, as uniform sites do, instead of
 * every station sharing one coarse bucket.
 */
export class SphereIndex {
  /** Candidates tested exactly by the last nearest (cost check). */
  lastCandidates = 0;
  /** Item ids, ordered so each subtree is a contiguous range. */
  private order!: Int32Array;
  private xyz!: Float32Array;
  /** Each item's reach as a chord (its own radius), when given. */
  private reach?: Float32Array;
  /** The largest reach in each subtree, by the subtree's middle position. */
  private subtreeReach?: Float32Array;

  constructor(
    private readonly lat: Float64Array,
    private readonly lon: Float64Array,
    /** Each item's own radius (centre to farthest corner), degrees. */
    radii?: Float32Array,
    /** Built by `create` instead, in steps. */
    later = false
  ) {
    if (!later) {
      const steps = this.steps(radii);
      while (!steps.next().done) {
        // At once.
      }
    }
  }

  /**
   * The index built in steps that yield to the worker and honour a cancel:
   * 830,305 cells no longer hold the worker for half a second after their
   * last read, nor finish building once nobody waits.
   */
  static async create(
    lat: Float64Array,
    lon: Float64Array,
    radii?: Float32Array,
    signal?: AbortSignal
  ) {
    const index = new SphereIndex(lat, lon, radii, true);
    const steps = index.steps(radii);
    while (!steps.next().done) {
      await yieldIfBusy(signal);
    }
    return index;
  }

  private *steps(radii?: Float32Array): Generator<void, void> {
    const { lat, lon } = this;
    const ids: number[] = [];
    for (let at = 0; at < lat.length; at++) {
      if (Number.isFinite(lat[at]) && Number.isFinite(lon[at])) {
        ids.push(at);
      }
    }
    this.order = Int32Array.from(ids);
    this.xyz = new Float32Array(3 * lat.length);
    for (const [k, at] of ids.entries()) {
      if (k % INDEX_BATCH === INDEX_BATCH - 1) {
        yield;
      }
      const v = toVec(lat[at], lon[at]);
      this.xyz[3 * at] = v[0];
      this.xyz[3 * at + 1] = v[1];
      this.xyz[3 * at + 2] = v[2];
    }
    yield* this.build(0, this.order.length, 0);
    if (radii) {
      this.reach = radii.map(
        (r) => 2 * Math.sin((Math.min(180, r) * DEG) / 2) + 1e-6
      );
      yield;
      this.subtreeReach = this.reaches(this.reach);
    }
  }

  /** Median split along x, y, z in turn (iterative, no recursion depth). */
  private *build(lo: number, hi: number, depth: number) {
    const stack: [number, number, number][] = [[lo, hi, depth]];
    let work = 0;
    while (stack.length) {
      const [from, to, level] = stack.pop()!;
      if (to - from <= LEAF_ITEMS) {
        continue;
      }
      const mid = (from + to) >> 1;
      this.select(from, to, mid, level % 3);
      // A pause after about a batch of items partitioned.
      work += to - from;
      if (work >= INDEX_BATCH) {
        work = 0;
        yield;
      }
      stack.push([from, mid, level + 1], [mid + 1, to, level + 1]);
    }
  }

  /** The largest reach of each internal subtree (children before parents). */
  private reaches(reach: Float32Array) {
    const { order } = this;
    const out = new Float32Array(order.length);
    const nodes: [number, number][] = [];
    const stack: [number, number][] = [[0, order.length]];
    while (stack.length) {
      const [from, to] = stack.pop()!;
      if (to - from > LEAF_ITEMS) {
        nodes.push([from, to]);
        const mid = (from + to) >> 1;
        stack.push([from, mid], [mid + 1, to]);
      }
    }
    for (let k = nodes.length - 1; k >= 0; k--) {
      const [from, to] = nodes[k];
      const mid = (from + to) >> 1;
      out[mid] = Math.max(
        reach[order[mid]],
        this.rangeReach(out, from, mid),
        this.rangeReach(out, mid + 1, to)
      );
    }
    return out;
  }

  private rangeReach(subtree: Float32Array, from: number, to: number) {
    if (to - from > LEAF_ITEMS) {
      return subtree[(from + to) >> 1];
    }
    let most = 0;
    for (let k = from; k < to; k++) {
      most = Math.max(most, this.reach![this.order[k]]);
    }
    return most;
  }

  get hasRadii() {
    return this.reach !== undefined;
  }

  /**
   * Every item whose own radius reaches the point: a subtree is entered
   * only when its largest radius reaches across the splitting plane, so
   * one large cell far away widens only the subtrees that hold it (not
   * the search for every cell). Needs the radii; callers test exactly.
   */
  covering(lat: number, lon: number, visit: (item: number) => void) {
    const p = toVec(lat, lon);
    const { order, xyz } = this;
    const reach = this.reach!;
    const subtree = this.subtreeReach!;
    this.lastCandidates = 0;
    const test = (at: number) => {
      const dx = xyz[3 * at] - p[0];
      const dy = xyz[3 * at + 1] - p[1];
      const dz = xyz[3 * at + 2] - p[2];
      if (dx * dx + dy * dy + dz * dz <= reach[at] * reach[at]) {
        this.lastCandidates++;
        visit(at);
      }
    };
    const stack: [number, number, number][] = [[0, order.length, 0]];
    while (stack.length) {
      const [from, to, level] = stack.pop()!;
      if (to - from <= LEAF_ITEMS) {
        for (let k = from; k < to; k++) {
          test(order[k]);
        }
        continue;
      }
      const mid = (from + to) >> 1;
      test(order[mid]);
      const diff = p[level % 3] - xyz[3 * order[mid] + (level % 3)];
      const [near, far] =
        diff <= 0
          ? [
              [from, mid],
              [mid + 1, to],
            ]
          : [
              [mid + 1, to],
              [from, mid],
            ];
      if (Math.abs(diff) <= this.rangeReach(subtree, far[0], far[1])) {
        stack.push([far[0], far[1], level + 1]);
      }
      stack.push([near[0], near[1], level + 1]);
    }
  }

  /** Quickselect: the `k`-th item by coordinate `d` lands at `k`. */
  private select(lo: number, hi: number, k: number, d: number) {
    const { order, xyz } = this;
    let [left, right] = [lo, hi - 1];
    while (right > left) {
      const pivot = xyz[3 * order[(left + right) >> 1] + d];
      let [i, j] = [left, right];
      while (i <= j) {
        while (xyz[3 * order[i] + d] < pivot) {
          i++;
        }
        while (xyz[3 * order[j] + d] > pivot) {
          j--;
        }
        if (i <= j) {
          [order[i], order[j]] = [order[j], order[i]];
          i++;
          j--;
        }
      }
      if (k <= j) {
        right = j;
      } else if (k >= i) {
        left = i;
      } else {
        return;
      }
    }
  }

  /**
   * Every item whose centre may be within `radius` degrees of the point
   * (a chord bound with a small Float32 tolerance; callers test exactly).
   */
  near(
    lat: number,
    lon: number,
    radius: number,
    visit: (item: number) => void
  ) {
    const p = toVec(lat, lon);
    const r = Math.min(180, radius);
    const chord = 2 * Math.sin((r * DEG) / 2) + 1e-6;
    this.walk(
      p,
      () => chord,
      (item, d2) => {
        if (d2 <= chord * chord) {
          visit(item);
        }
      }
    );
  }

  /** Visit items in subtrees whose splitting plane is within `bound`. */
  private walk(
    p: TVec3,
    bound: () => number,
    visit: (item: number, d2: number) => void
  ) {
    const { order, xyz } = this;
    const stack: [number, number, number][] = [[0, order.length, 0]];
    while (stack.length) {
      const [from, to, level] = stack.pop()!;
      if (to - from <= LEAF_ITEMS) {
        for (let k = from; k < to; k++) {
          const at = order[k];
          const dx = xyz[3 * at] - p[0];
          const dy = xyz[3 * at + 1] - p[1];
          const dz = xyz[3 * at + 2] - p[2];
          visit(at, dx * dx + dy * dy + dz * dz);
        }
        continue;
      }
      const mid = (from + to) >> 1;
      const d = level % 3;
      const at = order[mid];
      const diff = p[d] - xyz[3 * at + d];
      const ex = xyz[3 * at] - p[0];
      const ey = xyz[3 * at + 1] - p[1];
      const ez = xyz[3 * at + 2] - p[2];
      visit(at, ex * ex + ey * ey + ez * ez);
      // Nearer side first; the far side only if the plane is within reach.
      const [near, far] =
        diff <= 0
          ? [
              [from, mid],
              [mid + 1, to],
            ]
          : [
              [mid + 1, to],
              [from, mid],
            ];
      if (Math.abs(diff) <= bound()) {
        stack.push([far[0], far[1], level + 1]);
      }
      stack.push([near[0], near[1], level + 1]);
    }
  }

  /** Nearest item within `maxDegrees`, other than `except`; −1 if none. */
  nearest(lat: number, lon: number, maxDegrees: number, except = -1) {
    const p = toVec(lat, lon);
    const limit = Math.min(180, maxDegrees);
    let best = -1;
    let bestAngle = Number.POSITIVE_INFINITY;
    let reach = 2 * Math.sin((limit * DEG) / 2) + 1e-6;
    this.lastCandidates = 0;
    this.walk(
      p,
      () => reach,
      (item, d2) => {
        if (item === except || d2 > reach * reach) {
          return;
        }
        // Exact angle from the stored degrees (Float32 only prunes).
        this.lastCandidates++;
        const a = angle(p, toVec(this.lat[item], this.lon[item]));
        if (a < bestAngle || (a === bestAngle && item < best)) {
          best = item;
          bestAngle = a;
          reach = Math.min(reach, 2 * Math.sin(a / 2) + 1e-6);
        }
      }
    );
    return best >= 0 && bestAngle / DEG <= maxDegrees
      ? { item: best, degrees: bestAngle / DEG }
      : undefined;
  }
}

/** Items per k-d tree leaf. */
const LEAF_ITEMS = 8;
/** Items handled between pauses while an index is built. */
const INDEX_BATCH = 1 << 16;

function dot(a: TVec3, b: TVec3) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

function cross(a: TVec3, b: TVec3): TVec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

function angle(a: TVec3, b: TVec3) {
  const c = cross(a, b);
  return Math.atan2(Math.hypot(c[0], c[1], c[2]), dot(a, b));
}

type TOutline = {
  corners: number;
  /** Corner `at` (cell × corners + k) as a unit vector, or undefined. */
  vertex: (at: number) => TVec3 | undefined;
};

/** Outlines from corner latitudes/longitudes (degrees, NaN padding). */
function cornerOutline(
  corners: number,
  lat: Float64Array,
  lon: Float64Array
): TOutline & { lat: Float64Array; lon: Float64Array } {
  return {
    corners,
    lat,
    lon,
    vertex: (at) =>
      Number.isFinite(lat[at]) && Number.isFinite(lon[at])
        ? toVec(lat[at], lon[at])
        : undefined,
  };
}

/** Outlines from face-node ids (−1 padding) into node coordinates. */
function nodeOutline(
  corners: number,
  nodes: Int32Array,
  nodeLat: Float64Array,
  nodeLon: Float64Array
): TOutline & {
  nodes: Int32Array;
  nodeLat: Float64Array;
  nodeLon: Float64Array;
} {
  return {
    corners,
    nodes,
    nodeLat,
    nodeLon,
    vertex: (at) => {
      const node = nodes[at];
      return node >= 0 &&
        Number.isFinite(nodeLat[node]) &&
        Number.isFinite(nodeLon[node])
        ? toVec(nodeLat[node], nodeLon[node])
        : undefined;
    },
  };
}

/** Corners of one cell (padding skipped). */
function cornersOf(
  outline: NonNullable<TNativeGeometry["outline"]>,
  cell: number
) {
  const out: TVec3[] = [];
  for (let k = 0; k < outline.corners; k++) {
    const v = outline.vertex(cell * outline.corners + k);
    if (v) {
      const last = out[out.length - 1];
      if (!last || angle(last, v) > 1e-12) {
        out.push(v);
      }
    }
  }
  if (out.length > 1 && angle(out[0], out[out.length - 1]) <= 1e-12) {
    out.pop();
  }
  return out;
}

/**
 * Whether a convex spherical cell holds the point: every edge plane has
 * the point on the same side as the cell centre (edges count as inside).
 */
/**
 * Whether a cell (corners joined by great-circle arcs) contains `p`. The
 * gnomonic projection about the cell centre maps those arcs to straight
 * lines, so an even–odd test there is exact for convex and concave cells
 * smaller than a hemisphere, in either winding.
 */
function cellContains(corners: TVec3[], centre: TVec3, p: TVec3) {
  if (dot(p, centre) <= 1e-12) {
    return false;
  }
  const helper: TVec3 = Math.abs(centre[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const u = normalized(cross(helper, centre));
  const v = cross(centre, u);
  const plane = (q: TVec3): [number, number] | undefined => {
    const d = dot(q, centre);
    return d > 1e-12 ? [dot(q, u) / d, dot(q, v) / d] : undefined;
  };
  const [x, y] = plane(p)!;
  let inside = false;
  let previous = plane(corners[corners.length - 1]);
  for (const corner of corners) {
    const current = plane(corner);
    if (!current || !previous) {
      return false; // a corner on the far side: not a supported cell
    }
    const [x0, y0] = previous;
    const [x1, y1] = current;
    // On an edge counts as inside: a shared edge goes to the lowest index.
    const dx = x1 - x0;
    const dy = y1 - y0;
    const along = (x - x0) * dx + (y - y0) * dy;
    const length2 = dx * dx + dy * dy;
    if (
      Math.abs((x - x0) * dy - (y - y0) * dx) <= 1e-12 * Math.sqrt(length2) &&
      along >= -1e-24 &&
      along <= length2 + 1e-24
    ) {
      return true;
    }
    if (y0 > y !== y1 > y && x < ((x1 - x0) * (y - y0)) / (y1 - y0) + x0) {
      inside = !inside;
    }
    previous = current;
  }
  return inside;
}

function normalized(a: TVec3): TVec3 {
  const n = Math.hypot(a[0], a[1], a[2]);
  return [a[0] / n, a[1] / n, a[2] / n];
}

/**
 * Spherical excess of a simple polygon: signed triangles fanned from its
 * first corner, so concave cells and both windings give their true area.
 */
export function sphericalArea(corners: TVec3[]) {
  let total = 0;
  for (let k = 1; k + 1 < corners.length; k++) {
    const a = corners[0];
    const b = corners[k];
    const c = corners[k + 1];
    // a·((b − a) × (c − a)), equal to a·(b × c): from the small sides of a fine
    // cell, not from nearly parallel unit vectors, whose product loses the
    // cell's excess.
    const u: TVec3 = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    const v: TVec3 = [c[0] - a[0], c[1] - a[1], c[2] - a[2]];
    const triple = dot(a, cross(u, v));
    total += 2 * Math.atan2(triple, 1 + dot(a, b) + dot(b, c) + dot(c, a));
  }
  return Math.abs(total);
}

function centreOf(corners: TVec3[]): TVec3 | undefined {
  const sum: TVec3 = [0, 0, 0];
  for (const v of corners) {
    sum[0] += v[0];
    sum[1] += v[1];
    sum[2] += v[2];
  }
  const n = Math.hypot(sum[0], sum[1], sum[2]);
  return n > 1e-12 ? [sum[0] / n, sum[1] / n, sum[2] / n] : undefined;
}

function latLonOf(v: TVec3) {
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG,
    lon: Math.atan2(v[1], v[0]) / DEG,
  };
}

// ---------------------------------------------------------------------------
// Reading coordinates.

/** An array, or undefined when it does not exist; a cancel propagates. */
/**
 * An optional array, or undefined when the source does not have it. A failed
 * request (HTTP 503) is no such answer: it is thrown, so the variable is
 * described again later rather than kept as unsupported.
 */
async function tryOpen(dataset: TAnalysisDataset, path: string) {
  try {
    return await dataset.openArray(path);
  } catch (error) {
    if ((error as Error)?.name === "AbortError" || !isMissing(error)) {
      throw error;
    }
    return undefined;
  }
}

function unitScale(attrs: TAttrs) {
  return /^rad(ian)?s?$/i.test(String(attrs.units ?? "").trim()) ? 1 / DEG : 1;
}

/**
 * Whole decoded geometry arrays, shared between families on the same
 * coordinates (a mesh's face, node and weighted-face fields read its nodes
 * and connectivity once). Only completed reads are kept, within a byte
 * limit; callers get a copy, since loaders mask invalid entries in place.
 */
const decoded = new SharedReads(128 * 2 ** 20);

/**
 * A whole array decoded once for every geometry that needs it, also while
 * being read (three views of one mesh read its topology once). The read
 * runs on the unguarded array and stops when every geometry load waiting
 * for it has been cancelled.
 */
export async function readAllShared(
  dataset: TAnalysisDataset,
  array: TAnalysisArray,
  signal: AbortSignal | undefined = array.guard,
  units: TAttrs = array.attrs
) {
  const key = `${dataset.key}|${array.key}|${unitScale(units)}`;
  const total = array.shape.reduce((p, n) => p * n, 1);
  const values = await decoded.share(
    key,
    total * 8,
    (own) => readAllDecoded(dataset, array.unguarded ?? array, own, units),
    signal
  );
  return values.slice();
}

/** A whole array, decoded, row-major in its own dimension order. */
// eslint-disable-next-line max-lines-per-function
async function readAllDecoded(
  dataset: TAnalysisDataset,
  array: TAnalysisArray,
  signal?: AbortSignal,
  /** Whose `units` apply: CF bounds without units inherit their parent's. */
  units: TAttrs = array.attrs
) {
  const total = array.shape.reduce((p, n) => p * n, 1);
  const codec = buildValueCodec(
    array.attrs,
    array.fillValue,
    array.dtype,
    dataset.format
  );
  const scale = unitScale(units);
  const out = new Float64Array(total);
  const grid = array.shape.map((n, d) => Math.ceil(n / array.chunks[d]));
  const strides = array.shape.map((_, d) =>
    array.shape.slice(d + 1).reduce((p, n) => p * n, 1)
  );
  const coord = grid.map(() => 0);
  const chunkCount = grid.reduce((p, n) => p * n, 1);
  for (let c = 0; c < chunkCount; c++) {
    throwIfAborted(signal);
    let rest = c;
    for (let d = grid.length - 1; d >= 0; d--) {
      coord[d] = rest % grid[d];
      rest = Math.floor(rest / grid[d]);
    }
    const chunk = await array.readChunk(coord.slice(), signal);
    const extent = array.shape.map((n, d) =>
      Math.min(array.chunks[d], n - coord[d] * array.chunks[d])
    );
    const inner = extent.reduce((p, n) => p * n, 1);
    const local = extent.map(() => 0);
    for (let at = 0; at < inner; at++) {
      let r = at;
      for (let d = extent.length - 1; d >= 0; d--) {
        local[d] = r % extent[d];
        r = Math.floor(r / extent[d]);
      }
      let target = 0;
      let source = 0;
      for (let d = 0; d < extent.length; d++) {
        target += (coord[d] * array.chunks[d] + local[d]) * strides[d];
        source += local[d] * chunk.stride[d];
      }
      const value = chunk.absent
        ? codec.absentValue
        : typeof chunk.data[source] === "bigint"
          ? decodeStoredBigInt(codec, chunk.data[source] as bigint)
          : decodeStoredValue(codec, Number(chunk.data[source]));
      out[target] = value * scale;
    }
  }
  return out;
}

function isLat(name: string, attrs: TAttrs) {
  return (
    attrs.standard_name === "latitude" ||
    /degrees?_?(n|north)\b/i.test(String(attrs.units ?? "")) ||
    /^(lat|latitude|clat|nav_lat|vlat|elat|y_lat)$/i.test(
      name.split("/").pop() ?? name
    )
  );
}

function isLon(name: string, attrs: TAttrs) {
  return (
    attrs.standard_name === "longitude" ||
    /degrees?_?(e|east)\b/i.test(String(attrs.units ?? "")) ||
    /^(lon|longitude|clon|nav_lon|vlon|elon|x_lon)$/i.test(
      name.split("/").pop() ?? name
    )
  );
}

/** Latitude and longitude named by the field's `coordinates` or usual names. */
/** True coordinates found for a field: stored, or computed with corners. */
type TFoundCoordinates = {
  lat: { name: string; array: TAnalysisArray };
  lon: { name: string; array: TAnalysisArray };
  /** Corners computed with the centres (a projected grid). */
  bounds?: { lat: TAnalysisArray; lon: TAnalysisArray };
  /** The projection they were computed through, in words. */
  projection?: string;
  /** Points located by the grid's own 1-D axes (projected, rotated). */
  locate?: TAxisLocator;
  /** Areas of large cells along their true sides (projected grids). */
  refinedAreas?: TRefinedAreas;
  /** Every cell's area from published 1-D sides (rotated grids). */
  axisAreas?: TRefinedAreas;
};

/** Large cells' areas, keyed by row × columns + column along `dims`. */
type TRefinedAreas = {
  dims: [string, string];
  read: (apply: (key: number, area: number) => void) => Promise<void>;
};

async function auxiliaryCoordinates(
  dataset: TAnalysisDataset,
  variable: string,
  array: TAnalysisArray
): Promise<TFoundCoordinates | undefined> {
  const named = String(array.attrs.coordinates ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const guesses = [
    "lat",
    "lon",
    "latitude",
    "longitude",
    "clat",
    "clon",
    "nav_lat",
    "nav_lon",
  ];
  let lat: { name: string; array: TAnalysisArray } | undefined;
  let lon: { name: string; array: TAnalysisArray } | undefined;
  for (const name of [...named, ...guesses]) {
    if ((lat && lon) || name === variable) {
      continue;
    }
    const found = await tryOpen(
      dataset,
      ZarrDataManager.resolveVariablePath(variable, name)
    );
    if (
      !found ||
      found.dimensionNames.some((dim) => !array.dimensionNames.includes(dim))
    ) {
      continue;
    }
    if (!lat && isLat(name, found.attrs)) {
      lat = { name, array: found };
    } else if (!lon && isLon(name, found.attrs)) {
      lon = { name, array: found };
    }
  }
  return lat && lon
    ? { lat, lon }
    : ((await rotatedCoordinates(dataset, variable, array)) ??
        (await projectedCoordinates(dataset, variable, array)));
}

/** A field's 1-D projection x and y axes, found by their attributes. */
async function projectedAxes(
  dataset: TAnalysisDataset,
  variable: string,
  array: TAnalysisArray
) {
  const axes: Partial<Record<"x" | "y", TAnalysisArray>> = {};
  for (const dim of array.dimensionNames) {
    const axis = await tryOpen(
      dataset,
      ZarrDataManager.resolveVariablePath(variable, dim)
    );
    if (!axis || axis.shape.length !== 1) {
      continue;
    }
    for (const which of ["x", "y"] as const) {
      if (!axes[which] && isProjectedAxis(dim, axis.attrs, which)) {
        axes[which] = axis;
      }
    }
  }
  return axes;
}

/**
 * The grid mapping variable a `grid_mapping` attribute names: the plain form
 * ("rotated") or the first of the expanded form ("rotated: rlon rlat"), CF
 * §5.6.
 */
function gridMappingName(attribute: unknown) {
  if (typeof attribute !== "string") {
    return undefined;
  }
  const first = attribute.trim().split(/\s+/)[0] ?? "";
  return first.replace(/:$/, "") || undefined;
}

/**
 * A projected grid naming no true coordinates (Sentinel-2 L2A: x/y in
 * metres and a CRS): its centres and corners computed from its 1-D axes
 * through the CRS (projectedGrid.ts).
 */
// eslint-disable-next-line max-lines-per-function
async function projectedCoordinates(
  dataset: TAnalysisDataset,
  variable: string,
  array: TAnalysisArray
) {
  const mappingName = gridMappingName(array.attrs.grid_mapping);
  const mapping = mappingName
    ? await tryOpen(
        dataset,
        ZarrDataManager.resolveVariablePath(variable, mappingName)
      )
    : undefined;
  const crs = projectedCrsOf(mapping?.attrs);
  if (!crs || !mapping) {
    return undefined;
  }
  const { x, y } = await projectedAxes(dataset, variable, array);
  const [mx, my] = [metresPer(x?.attrs.units), metresPer(y?.attrs.units)];
  if (!x || !y || !mx || !my) {
    return undefined;
  }
  // Each axis's published bounds, read with it: cells as wide as they say.
  const boundsOf = async (axis: TAnalysisArray) => {
    const name = axis.attrs.bounds;
    const bounds =
      typeof name === "string"
        ? await tryOpen(
            dataset,
            ZarrDataManager.resolveVariablePath(variable, name)
          )
        : undefined;
    return bounds?.shape.length === 2 &&
      bounds.shape[0] === axis.shape[0] &&
      bounds.shape[1] === 2
      ? bounds
      : undefined;
  };
  const [bx, by] = [await boundsOf(x), await boundsOf(y)];
  const lazy = (
    axis: TAnalysisArray,
    metres: number,
    bounds?: TAnalysisArray
  ) => ({
    dim: axis.dimensionNames[0],
    key: `${axis.key}${bounds ? `|${bounds.key}` : ""}`,
    length: axis.shape[0],
    metres,
    values: () => readAllShared(dataset, axis),
    ...(bounds
      ? { bounds: () => readAllShared(dataset, bounds, undefined, axis.attrs) }
      : {}),
    coldReads: () =>
      (isDecoded(dataset, axis) ? 0 : chunkCount(axis)) +
      (bounds && !isDecoded(dataset, bounds) ? chunkCount(bounds) : 0),
    chunkBytes: chunkByteSize(axis) + (bounds ? chunkByteSize(bounds) : 0),
  });
  const computed = projectedCoordinateArrays(
    { x: lazy(x, mx, bx), y: lazy(y, my, by) },
    crs,
    mapping.key
  );
  const name = String(
    mapping.attrs.projected_crs_name ?? mapping.attrs.grid_mapping_name
  );
  // Said when cell edges are inferred, not published.
  const edges =
    bx && by
      ? ""
      : "; cell edges halfway between centres where no bounds are published";
  return {
    lat: { name: `latitude (from x/y, ${name}${edges})`, array: computed.lat },
    lon: { name: `longitude (from x/y, ${name}${edges})`, array: computed.lon },
    bounds: computed.bounds,
    projection: name,
    // Its x/y axes and their bounds, read before a point is located.
    locate: {
      ...computed.locate,
      coldBytes: () =>
        [x, bx, y, by].reduce(
          (total, array) => total + storedColdBytes(dataset, array),
          0
        ),
    },
    refinedAreas: {
      dims: computed.locate.dims,
      read: computed.refinedAreas,
    },
  };
}

/** The field's 1-D rotated axes (grid_latitude/grid_longitude, rlat/rlon). */
async function rotatedAxesOf(
  dataset: TAnalysisDataset,
  variable: string,
  array: TAnalysisArray
) {
  const axes: Record<"lat" | "lon", TAnalysisArray | undefined> = {
    lat: undefined,
    lon: undefined,
  };
  for (const dim of array.dimensionNames) {
    const axis = await tryOpen(
      dataset,
      ZarrDataManager.resolveVariablePath(variable, dim)
    );
    const standard = String(axis?.attrs.standard_name ?? "");
    if (!axis || axis.shape.length !== 1) {
      continue;
    }
    if (standard === "grid_latitude" || /^rlat$/i.test(dim)) {
      axes.lat = axis;
    } else if (standard === "grid_longitude" || /^rlon$/i.test(dim)) {
      axes.lon = axis;
    }
  }
  return axes;
}

/**
 * A rotated-pole grid naming no true coordinates: computed from its 1-D
 * rotated axes and the grid mapping's pole (rotatedPole.ts).
 */
// eslint-disable-next-line max-lines-per-function
async function rotatedCoordinates(
  dataset: TAnalysisDataset,
  variable: string,
  array: TAnalysisArray
) {
  const mappingName = gridMappingName(array.attrs.grid_mapping);
  const mapping = mappingName
    ? await tryOpen(
        dataset,
        ZarrDataManager.resolveVariablePath(variable, mappingName)
      )
    : undefined;
  const pole = rotatedPoleOf(mapping?.attrs);
  if (!pole) {
    return undefined;
  }
  const axes = await rotatedAxesOf(dataset, variable, array);
  if (!axes.lat || !axes.lon) {
    return undefined;
  }
  // Each axis's published sides, opened now: the locator reads them, so
  // their chunks are counted with the axis's before admission.
  const sidesArray = async (axis: TAnalysisArray) => {
    const name = axis.attrs.bounds;
    const bounds =
      typeof name === "string"
        ? await tryReferenced(dataset, axis, name, variable)
        : undefined;
    return bounds?.shape.length === 2 &&
      bounds.shape[0] === axis.shape[0] &&
      bounds.shape[1] === 2
      ? bounds
      : undefined;
  };
  const [latSides, lonSides] = await Promise.all([
    sidesArray(axes.lat),
    sidesArray(axes.lon),
  ]);
  const cold = (array: TAnalysisArray | undefined) =>
    !array || isDecoded(dataset, array) ? 0 : chunkCount(array);
  const coldBytes = (array: TAnalysisArray | undefined) =>
    storedColdBytes(dataset, array);
  // Read when the coordinates are first needed (after admission), and counted
  // before.
  const lazy = (axis: TAnalysisArray, sides?: TAnalysisArray) => ({
    dim: axis.dimensionNames[0],
    key: axis.key,
    length: axis.shape[0],
    values: () => readAllShared(dataset, axis),
    coldReads: () => cold(axis) + cold(sides),
    chunkBytes: chunkByteSize(axis),
  });
  const computed = trueCoordinates(
    { lat: lazy(axes.lat, latSides), lon: lazy(axes.lon, lonSides) },
    pole
  );
  // Points located by their rotated coordinates, against the axes' published
  // sides there.
  const [rlat, rlon] = [axes.lat, axes.lon];
  const sidesOf = async (
    axis: TAnalysisArray,
    bounds?: TAnalysisArray,
    period?: number
  ) => {
    const [values, edges] = await Promise.all([
      readAllShared(dataset, axis),
      bounds
        ? readAllShared(dataset, bounds, undefined, axis.attrs)
        : undefined,
    ]);
    return axisSides(values, edges, period);
  };
  const locate: TAxisLocator = {
    dims: [rlat.dimensionNames[0], rlon.dimensionNames[0]],
    coldBytes: () =>
      coldBytes(rlat) +
      coldBytes(latSides) +
      coldBytes(rlon) +
      coldBytes(lonSides),
    make: async () => {
      const [sy, sx] = await Promise.all([
        sidesOf(rlat, latSides),
        sidesOf(rlon, lonSides, 360),
      ]);
      const toRotated = trueToRotated(pole);
      return (lat: number, lon: number) => {
        const p = toRotated(lat, lon);
        const [j, i] = [
          containingIndex(sy, p.rlat),
          containingPeriodic(sx, p.rlon),
        ];
        return j >= 0 && i >= 0 ? ([j, i] as [number, number]) : undefined;
      };
    },
  };
  return {
    lat: { name: "latitude (from the rotated pole)", array: computed.lat },
    lon: { name: "longitude (from the rotated pole)", array: computed.lon },
    locate,
    // Both axes' sides published: each cell is a band between two rotated
    // parallels and meridians, its area unchanged by the rotation.
    ...(latSides && lonSides
      ? {
          axisAreas: {
            dims: locate.dims,
            read: async (apply: (key: number, area: number) => void) => {
              const [sy, sx] = await Promise.all([
                sidesOf(rlat, latSides),
                sidesOf(rlon, lonSides, 360),
              ]);
              const DEG = Math.PI / 180;
              const sin = (v: number) =>
                Math.sin(Math.max(-90, Math.min(90, v)) * DEG);
              const nx = sx.low.length;
              for (let j = 0; j < sy.low.length; j++) {
                const band = sin(sy.high[j]) - sin(sy.low[j]);
                for (let i = 0; i < nx; i++) {
                  apply(j * nx + i, band * (sx.high[i] - sx.low[i]) * DEG);
                }
              }
            },
          },
        }
      : {}),
  };
}

async function boundsOf(
  dataset: TAnalysisDataset,
  variable: string,
  lat: TAnalysisArray,
  lon: TAnalysisArray
) {
  const latName = lat.attrs.bounds;
  const lonName = lon.attrs.bounds;
  if (typeof latName !== "string" || typeof lonName !== "string") {
    return undefined;
  }
  // CF bounds are named relative to the coordinate that declares them,
  // in its group and its store (a grid store beside the data).
  const owned = (coordinate: TAnalysisArray, name: string) =>
    tryReferenced(dataset, coordinate, name, variable);
  const [latB, lonB] = await Promise.all([
    owned(lat, latName),
    owned(lon, lonName),
  ]);
  if (!latB || !lonB) {
    return `The cell bounds ${latName} and ${lonName} declared on the coordinates cannot be read.`;
  }
  const rank = lat.shape.length + 1;
  if (
    latB.shape.length !== rank ||
    lonB.shape.length !== rank ||
    !sameDims(latB.dimensionNames.slice(0, -1), lat.dimensionNames) ||
    !sameDims(lonB.dimensionNames.slice(0, -1), lat.dimensionNames) ||
    latB.shape[rank - 1] !== lonB.shape[rank - 1] ||
    latB.shape[rank - 1] < 3
  ) {
    return undefined;
  }
  return { lat: latB, lon: lonB };
}

/** An array `from` names, from `from`'s own store and group first. */
async function tryReferenced(
  dataset: TAnalysisDataset,
  from: TAnalysisArray,
  name: string,
  context: string
) {
  try {
    return await openReferenced(dataset, from, name, context);
  } catch (error) {
    if ((error as Error)?.name === "AbortError" || !isMissing(error)) {
      throw error;
    }
    return undefined;
  }
}

/**
 * A declared measure, or why it cannot be read now: a failed request keeps area
 * plots back, never a point.
 */
async function measureOrUnreachable(
  ...args: Parameters<typeof measureOf>
): Promise<{ found?: TAnalysisArray; unreachable?: string }> {
  try {
    return { found: await measureOf(...args) };
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      throw error;
    }
    return { unreachable: (error as Error).message };
  }
}

/** Why a declared measure cannot weigh cells: units that are no area. */
function measureUnitsProblem(measure: TAnalysisArray | undefined) {
  if (!measure || isAreaUnit(measure.attrs.units)) {
    return undefined;
  }
  const name = measure.key.split("|").pop() ?? "";
  // CF requires a measure's units: none is no area either, as on rectilinear
  // grids.
  return measure.attrs.units === undefined
    ? `The declared cell areas ${name} have no units, so they cannot be taken as areas.`
    : `The declared cell areas ${name} are in "${String(measure.attrs.units)}", not an area.`;
}

/** A declared `cell_measures: area: name` over the native dimensions. */
async function measureOf(
  dataset: TAnalysisDataset,
  variable: string,
  array: TAnalysisArray,
  dims: string[]
) {
  const match = /area:\s*(\S+)/.exec(String(array.attrs.cell_measures ?? ""));
  if (!match) {
    return undefined;
  }
  // Absent (CF allows it in another file): areas from the sphere. A failed
  // request is no such answer: it is reported, and asked again later.
  let measure: TAnalysisArray | undefined;
  try {
    measure = await openReferenced(dataset, array, match[1], variable);
  } catch (error) {
    if (!isMissing(error)) {
      throw new Error(
        `The declared cell areas ${match[1]} could not be read: ${(error as Error).message}`,
        { cause: error }
      );
    }
  }
  // The measure's dimensions are some or all of the grid's, matched by
  // name: area(j) broadcasts along i (CF cell measures). A scalar (rank 0)
  // is one area for every cell.
  return measure &&
    measure.dimensionNames.length <= dims.length &&
    measure.shape.length === measure.dimensionNames.length &&
    measure.dimensionNames.every((dim) => dims.includes(dim))
    ? measure
    : undefined;
}

/**
 * A cell measure over some of the grid's dimensions, broadcast by name to
 * every cell (area(j) on a (j, i) grid gives each row's area to its cells).
 * Each named dimension must have the grid's length there.
 */
async function readBroadcast(
  dataset: TAnalysisDataset,
  measure: TAnalysisArray,
  nativeDims: string[],
  shape: number[]
) {
  const own = measure.dimensionNames;
  own.forEach((dim, d) => {
    if (measure.shape[d] !== shape[nativeDims.indexOf(dim)]) {
      throw new AnalysisInputError(
        `${measure.key.split("|").pop()} has ${measure.shape[d]} values along ${dim}; the grid has ${shape[nativeDims.indexOf(dim)]}.`
      );
    }
  });
  const values = await readAllShared(dataset, measure);
  if (!own.length && !(values[0] > 0 && Number.isFinite(values[0]))) {
    throw new AnalysisInputError(
      `The declared cell area ${values[0]} is not a positive number.`
    );
  }
  const count = shape.reduce((p, n) => p * n, 1);
  const out = new Float64Array(count);
  const strides = own.map((_, d) =>
    measure.shape.slice(d + 1).reduce((p, n) => p * n, 1)
  );
  const index = new Array<number>(shape.length).fill(0);
  for (let cell = 0; cell < count; cell++) {
    let rest = cell;
    for (let d = shape.length - 1; d >= 0; d--) {
      index[d] = rest % shape[d];
      rest = Math.floor(rest / shape[d]);
    }
    let at = 0;
    own.forEach(
      (dim, d) => (at += index[nativeDims.indexOf(dim)] * strides[d])
    );
    out[cell] = values[at];
  }
  return out;
}

// ---------------------------------------------------------------------------
// Resolution from metadata.

type TResolved = TNativeContext | { reason: string } | undefined;

function tooLarge(count: number) {
  return {
    reason: `This grid has ${count.toLocaleString("en-US")} cells; plots load native grids of up to ${MAX_NATIVE_CELLS.toLocaleString("en-US")} cells.`,
  };
}

/** A time or vertical dimension among the coordinates' dimensions. */
async function movingDimension(
  dataset: TAnalysisDataset,
  variable: string,
  dims: string[],
  /** The field's own `coordinates`: auxiliary time, level or member. */
  auxiliary: string[] = []
) {
  const moves = (dim: string, attrs: TAttrs) => {
    const axis = String(attrs.axis ?? "").toUpperCase();
    return (
      axis === "T" ||
      /\bsince\b/.test(String(attrs.units ?? "")) ||
      attrs.standard_name === "time" ||
      looksVertical(attrs) ||
      looksEnsemble(dim, attrs)
    );
  };
  for (const dim of dims) {
    const coordinate = await tryOpen(
      dataset,
      ZarrDataManager.resolveVariablePath(variable, dim)
    );
    if (
      (coordinate && moves(dim, coordinate.attrs)) ||
      (!coordinate && /^(time|t|plev|lev|level|depth)$/i.test(dim))
    ) {
      return dim;
    }
  }
  return auxiliaryMotion(dataset, variable, dims, auxiliary);
}

const isTimeAttrs = (attrs: TAttrs) =>
  String(attrs.axis ?? "").toUpperCase() === "T" ||
  /\bsince\b/.test(String(attrs.units ?? "")) ||
  attrs.standard_name === "time";

/**
 * Auxiliary coordinates on the position dimensions. A time stamp there
 * (time(record) beside lat(record, site), or an acquisition time per
 * observation) makes the positions move with time. A level or member
 * coordinate moves them only along a dimension other than the features:
 * station_elevation(station) describes each station, it moves nothing.
 */
async function auxiliaryMotion(
  dataset: TAnalysisDataset,
  variable: string,
  dims: string[],
  auxiliary: string[]
) {
  const isTime = isTimeAttrs;
  for (const name of new Set([...auxiliary, "time"])) {
    const found = await tryOpen(
      dataset,
      ZarrDataManager.resolveVariablePath(variable, name)
    );
    const own = found?.dimensionNames ?? [];
    const shared = own.filter((dim) => dims.includes(dim));
    if (!found || !shared.length) {
      continue;
    }
    if (isTime(found.attrs)) {
      return shared[0];
    }
    const describesFeatures = dims.every((dim) => own.includes(dim));
    if (
      !describesFeatures &&
      own.length === 1 &&
      (looksVertical(found.attrs) || looksEnsemble(own[0], found.attrs))
    ) {
      return own[0];
    }
  }
  return undefined;
}

/**
 * Node and face-centre coordinates must each be one-dimensional, on one
 * dimension, with equal lengths: an inconsistent array (three latitudes
 * beside 80 million longitudes) is refused before anything is read.
 */
function meshShapeProblem(
  nodeLat: TAnalysisArray,
  nodeLon: TAnalysisArray,
  faceLat?: TAnalysisArray,
  faceLon?: TAnalysisArray
) {
  const pairs: [string, TAnalysisArray, TAnalysisArray | undefined][] = [
    ["node", nodeLat, nodeLon],
    ["face-centre", faceLat!, faceLon],
  ];
  for (const [what, a, b] of pairs) {
    if (!a || !b) {
      continue;
    }
    if (
      a.shape.length !== 1 ||
      b.shape.length !== 1 ||
      a.shape[0] !== b.shape[0] ||
      a.dimensionNames[0] !== b.dimensionNames[0]
    ) {
      return `The mesh ${what} latitude and longitude disagree: (${a.dimensionNames.join(", ")}) [${a.shape.join(", ")}] and (${b.dimensionNames.join(", ")}) [${b.shape.join(", ")}].`;
    }
  }
  return undefined;
}

/** The same dimensions, in any order. */
function sameDims(a: string[], b: string[]) {
  return a.length === b.length && a.every((dim) => b.includes(dim));
}

function axesOf(fieldDims: string[], coordDims: string[]) {
  const axes = coordDims.map((dim) => fieldDims.indexOf(dim));
  return axes.some((axis) => axis < 0) ? undefined : axes;
}

/**
 * A native grid for the variable, `{ reason }` when it is one but cannot be
 * used, or undefined when it is not one (latitude/longitude axes, HEALPix).
 */
// eslint-disable-next-line max-lines-per-function
export async function resolveNativeGrid(
  dataset: TAnalysisDataset,
  variable: string,
  array: TAnalysisArray
): Promise<TResolved> {
  const dims = array.dimensionNames;
  const mesh = await resolveMesh(dataset, variable, array);
  if (mesh) {
    return mesh;
  }
  const found = await auxiliaryCoordinates(dataset, variable, array);
  if (!found) {
    return undefined;
  }
  const { lat, lon } = found;
  const latDims = lat.array.dimensionNames;
  const lonDims = lon.array.dimensionNames;
  if (!sameDims(latDims, lonDims)) {
    return undefined;
  }
  // Positions that move with time or level are not a fixed grid.
  const moving = await movingDimension(
    dataset,
    variable,
    latDims,
    String(array.attrs.coordinates ?? "")
      .split(/\s+/)
      .filter(Boolean)
  );
  if (moving) {
    return {
      reason: `Latitude and longitude vary along ${moving} (${found.lat.name}(${latDims.join(", ")})); plots need positions fixed in time, level and member.`,
    };
  }
  // Axes on their own dimensions are a product grid, not a native one.
  if (latDims.length !== 1 && latDims.length !== 2) {
    return undefined;
  }
  const coordAxes = axesOf(dims, latDims);
  if (!coordAxes) {
    return undefined;
  }
  const axes = [...coordAxes].sort((a, b) => a - b);
  const shape = axes.map((axis) => array.shape[axis]);
  const count = shape.reduce((p, n) => p * n, 1);
  if (count > MAX_NATIVE_CELLS) {
    return tooLarge(count);
  }
  // A projected grid's corners are computed with its centres.
  const computedBounds = found.bounds;
  const declared: Awaited<ReturnType<typeof boundsOf>> =
    computedBounds ?? (await boundsOf(dataset, variable, lat.array, lon.array));
  if (typeof declared === "string") {
    return { reason: declared };
  }
  // Outlines too large to hold (AWI-CM-1-1-MR: 830,305 cells × 16 corners
  // in one chunk, about 551 MiB with the index): cells are then located by
  // their nearest centre, which needs the centres only, and area means say
  // why they are not offered.
  const outlineBytes = declared
    ? geometryBytesOf(count, count * declared.lat.shape.at(-1)!) +
      count * declared.lat.shape.at(-1)! * 8 +
      geometryCostOf([lat.array, lon.array, declared.lat, declared.lon])
        .geometryWorkspace
    : 0;
  const tooBig = outlineBytes > MAX_WORKING_BYTES;
  const bounds = tooBig ? undefined : declared;
  const { found: declaredFound, unreachable } = await measureOrUnreachable(
    dataset,
    variable,
    array,
    latDims
  );
  const measureProblem = unreachable ?? measureUnitsProblem(declaredFound);
  const declaredMeasure = measureProblem ? undefined : declaredFound;
  // Outlines too large to hold still give the areas: the corners stream
  // through once and only an area per cell stays (AWI-CM-1-1-MR: about
  // 405 MiB at the peak against 561 MiB for the outlines; 23 Nov).
  const areaBytes = declared
    ? areasOnlyBytes(count, count * declared.lat.shape.at(-1)!, [
        declared.lat,
        declared.lon,
      ])
    : 0;
  const areasOnly =
    tooBig && !declaredMeasure && areaBytes <= MAX_WORKING_BYTES;
  // One area for every site is no footprint: sites keep needing corners
  // or per-site areas. Cells (with declared corners, even when too large to
  // load, or a curvilinear grid) take it.
  const measure =
    declaredMeasure?.shape.length === 0 && !declared && latDims.length === 1
      ? undefined
      : declaredMeasure;
  const corners = bounds ? bounds.lat.shape[bounds.lat.shape.length - 1] : 0;
  if (count * corners > MAX_CORNER_VALUES) {
    return tooLarge(count);
  }
  const curvilinear = latDims.length === 2;
  const family = curvilinear
    ? NATIVE_FAMILIES.CURVILINEAR
    : declared
      ? NATIVE_FAMILIES.CELLS
      : NATIVE_FAMILIES.SITES;
  const skipped = tooBig
    ? `the cell outlines would need about ${Math.round(outlineBytes / 2 ** 20)} MiB; plots load at most ${MAX_WORKING_BYTES / 2 ** 20} MiB`
    : "";
  const source: TGeometrySource = {
    lat: lat.array,
    lon: lon.array,
    nativeDims: axes.map((axis) => dims[axis]),
    bounds,
    measure,
    ...(found.locate ? { locate: found.locate } : {}),
    ...(found.refinedAreas ? { refinedAreas: found.refinedAreas } : {}),
    ...(found.axisAreas && !bounds ? { axisAreas: found.axisAreas } : {}),
  };
  const cost = geometryCostOf([lat.array, lon.array, bounds?.lat, bounds?.lon]);
  const loader = geometryLoader(dataset, source, count, shape, family);
  const weighting = measureProblem
    ? undefined
    : measure
      ? `declared cell areas (${String(array.attrs.cell_measures)})`
      : bounds
        ? "spherical cell areas from the cell corners"
        : found.axisAreas
          ? "spherical cell areas from the rotated cells' published sides"
          : areasOnly
            ? "spherical cell areas from the cell corners (read once for the areas; the outlines are not kept)"
            : undefined;
  return {
    kind: "native",
    family,
    axes,
    shape,
    count,
    // Plus decoding workspace for the corner arrays (latitude, longitude)
    // and the decoded chunk being converted.
    // The decoded corner latitudes/longitudes are kept as the outline
    // (16 B per corner); one of them may be copied once to reorder it.
    geometryBytes:
      geometryBytesOf(count, count * corners) +
      count * corners * 8 +
      cost.geometryWorkspace,
    geometryReads: cost.geometryReads,
    geometryChunkBytes: cost.geometryChunkBytes,
    method: found.locate
      ? `containing cell, by the grid's own ${found.projection ? "x/y" : "rotated coordinates"} (its sides published or halfway between centres)`
      : bounds
        ? "containing cell (from cell corners)"
        : family === NATIVE_FAMILIES.SITES
          ? "nearest site, within its distance to the next site"
          : `nearest cell centre, within one local grid spacing${skipped ? ` (${skipped})` : ""}`,
    label:
      family === NATIVE_FAMILIES.CURVILINEAR
        ? found.projection
          ? `${found.projection} ${shape.join(" × ")} (latitude and longitude from x/y)`
          : `curvilinear ${shape.join(" × ")}${bounds ? ", with corners" : ", centres only"}`
        : family === NATIVE_FAMILIES.CELLS
          ? `irregular cells (${count}), ${bounds ? "with corners" : areasOnly ? "located by centre, areas from corners" : "located by centre"}`
          : `irregular sites (${count})`,
    weighting,
    siteMean:
      !weighting && family === NATIVE_FAMILIES.SITES ? SITE_MEAN : undefined,
    noWeights: weighting
      ? undefined
      : measureProblem
        ? measureProblem
        : skipped
          ? `Area means need the cell outlines: ${skipped}.`
          : family === NATIVE_FAMILIES.SITES
            ? "Sites have no implied area: area means need cell corners or a declared cell area."
            : "Area means need cell corners or a declared cell area, which this source does not publish.",
    ...(unreachable ? { areasUnreachable: true } : {}),
    ...loader,
    ...(measure
      ? { cornerAreas: measureAreaLoader(dataset, source, shape, loader) }
      : areasOnly && declared
        ? {
            cornerAreas: cornerAreaLoader(
              dataset,
              { ...source, bounds: declared },
              shape,
              loader,
              areaBytes
            ),
          }
        : {}),
  };
}

// eslint-disable-next-line max-lines-per-function
async function resolveMesh(
  dataset: TAnalysisDataset,
  variable: string,
  array: TAnalysisArray
): Promise<TResolved> {
  const meshName = array.attrs.mesh;
  if (typeof meshName !== "string") {
    return undefined;
  }
  const mesh = await tryOpen(
    dataset,
    ZarrDataManager.resolveVariablePath(variable, meshName)
  );
  const attrs =
    mesh?.attrs ??
    (await dataset.groupAttrs(
      ZarrDataManager.resolveVariablePath(variable, meshName)
    ));
  if (
    !attrs ||
    attrs.cf_role !== "mesh_topology" ||
    Number(attrs.topology_dimension) !== 2
  ) {
    return { reason: `The mesh ${meshName} is not a 2-D UGRID mesh topology.` };
  }
  const location = String(array.attrs.location ?? "");
  if (location !== "face" && location !== "node") {
    return {
      reason: `Plots read UGRID data on faces or nodes; this variable is on ${location || "an undeclared location"}.`,
    };
  }
  // Names in the topology are relative to the mesh's own group first
  // (e.g. a field in / pointing at topology/mesh), then to the field's.
  const meshPath = ZarrDataManager.resolveVariablePath(variable, meshName);
  const open = async (name: unknown) =>
    typeof name === "string"
      ? ((mesh
          ? await tryReferenced(dataset, mesh, name, meshPath)
          : await tryOpen(
              dataset,
              ZarrDataManager.resolveVariablePath(meshPath, name)
            )) ?? (await tryReferenced(dataset, array, name, variable)))
      : undefined;
  const connectivity = await open(attrs.face_node_connectivity);
  const nodeNames = String(attrs.node_coordinates ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const nodes = await Promise.all(nodeNames.map(open));
  const nodeLat = nodes.find((n, at) => n && isLat(nodeNames[at], n.attrs));
  const nodeLon = nodes.find((n, at) => n && isLon(nodeNames[at], n.attrs));
  const faceNames = String(attrs.face_coordinates ?? "")
    .split(/\s+/)
    .filter(Boolean);
  const faceCoords = await Promise.all(faceNames.map(open));
  const faceLat = faceCoords.find(
    (n, at) => n && isLat(faceNames[at], n.attrs)
  );
  const faceLon = faceCoords.find(
    (n, at) => n && isLon(faceNames[at], n.attrs)
  );
  if (
    !connectivity ||
    connectivity.shape.length !== 2 ||
    !nodeLat ||
    !nodeLon
  ) {
    return {
      reason:
        "The UGRID mesh lacks face-node connectivity or node coordinates.",
    };
  }
  const problem = meshShapeProblem(nodeLat, nodeLon, faceLat, faceLon);
  if (problem) {
    return { reason: problem };
  }
  const nodeDim = nodeLat.dimensionNames[0];
  const faceDim =
    typeof attrs.face_dimension === "string"
      ? attrs.face_dimension
      : (connectivity.dimensionNames.find(
          (dim) => dim !== nodeDim && array.dimensionNames.includes(dim)
        ) ?? connectivity.dimensionNames[0]);
  const faceAxis = connectivity.dimensionNames.indexOf(faceDim);
  if (faceAxis < 0) {
    return { reason: "The UGRID face dimension is not on the connectivity." };
  }
  const spatialDim = location === "face" ? faceDim : nodeDim;
  const axis = array.dimensionNames.indexOf(spatialDim);
  if (axis < 0) {
    return {
      reason: `The variable is not on the mesh's ${location} dimension ${spatialDim}.`,
    };
  }
  const faceCount = connectivity.shape[faceAxis];
  const corners = connectivity.shape[1 - faceAxis];
  const count = array.shape[axis];
  // Published face centres must be one per face.
  if (faceLat && faceLon && faceLat.shape[0] !== faceCount) {
    return {
      reason: `The mesh face centres hold ${faceLat.shape[0]} values for ${faceCount} faces.`,
    };
  }
  // The field must hold one value per face (or node): a field longer than
  // the mesh would leave values without a place, silently.
  if (location === "face" && count !== faceCount) {
    return {
      reason: `The variable has ${count} values on ${faceDim}, the mesh ${faceCount} faces.`,
    };
  }
  if (location !== "face" && count !== nodeLat.shape[0]) {
    return {
      reason: `The variable has ${count} values on ${nodeDim}, the mesh ${nodeLat.shape[0]} nodes.`,
    };
  }
  // Every node coordinate is read in full: its own length counts, not the
  // faces that refer to it.
  const nodeCount = nodeLat.shape.reduce((p, n) => p * n, 1);
  if (
    Math.max(faceCount, count, nodeCount) > MAX_NATIVE_CELLS ||
    faceCount * corners > MAX_CORNER_VALUES
  ) {
    return tooLarge(Math.max(faceCount, count, nodeCount));
  }
  const startIndex = Number(connectivity.attrs.start_index ?? 0);
  if (startIndex !== 0 && startIndex !== 1) {
    return { reason: "UGRID start_index must be 0 or 1." };
  }
  const faces = location === "face";
  const { found, unreachable } = await measureOrUnreachable(
    dataset,
    variable,
    array,
    [spatialDim]
  );
  const measureProblem = unreachable ?? measureUnitsProblem(found);
  const measure = measureProblem ? undefined : found;
  // A declared measure is read for area plots only (measureAreaLoader):
  // locating a point needs the mesh alone.
  const meshCost = geometryCostOf([
    nodeLat,
    nodeLon,
    connectivity,
    faceLat,
    faceLon,
  ]);
  const meshSource: TGeometrySource = {
    lat: nodeLat,
    lon: nodeLon,
    nativeDims: [spatialDim],
    mesh: {
      connectivity,
      faceAxis,
      startIndex,
      nodeLat,
      nodeLon,
      ...(faceLat && faceLon ? { faceLat, faceLon } : {}),
    },
  };
  const loader = geometryLoader(
    dataset,
    meshSource,
    count,
    [count],
    faces ? NATIVE_FAMILIES.MESH_FACES : NATIVE_FAMILIES.MESH_NODES
  );
  const weighting = measureProblem
    ? undefined
    : measure
      ? `declared cell areas (${String(array.attrs.cell_measures)})`
      : faces
        ? "spherical face areas from the node coordinates"
        : NODE_WEIGHTING;
  return {
    kind: "native",
    family: faces ? NATIVE_FAMILIES.MESH_FACES : NATIVE_FAMILIES.MESH_NODES,
    axes: [axis],
    shape: [count],
    count,
    method: faces
      ? "containing mesh face"
      : "nearest node of the containing mesh face",
    label: `UGRID mesh, ${faceCount} faces, data on ${location}s`,
    // Node coordinates, face corners as vectors and node ids, face centres.
    geometryBytes:
      // Outlines are face-node ids into the node coordinates (4 B each).
      geometryBytesOf(Math.max(count, nodeCount), 0, faceCount) +
      faceCount * corners * 4 +
      // Decoding workspace: one full node array at a time (Float64), and
      // the decoded chunk being converted.
      nodeCount * 8 +
      meshCost.geometryWorkspace,
    geometryReads: meshCost.geometryReads,
    geometryChunkBytes: meshCost.geometryChunkBytes,
    weighting,
    // Node values are weighted by lumped areas (NODE_WEIGHTING) when no
    // measure is declared, so every mesh can average.
    noWeights: measureProblem,
    ...(unreachable ? { areasUnreachable: true } : {}),
    ...loader,
    // Masks and weights follow the declared measure, the mesh shared.
    ...(measure ? { regionKey: `${loader.regionKey}|${measure.key}` } : {}),
    ...(measure
      ? {
          cornerAreas: measureAreaLoader(
            dataset,
            { ...meshSource, measure },
            [count],
            loader
          ),
        }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// Geometry, shared by every variable on the same coordinates.

const geometryCache = new Map<string, TGeometryEntry>();
const GEOMETRY_CACHE_ENTRIES = 4;

// eslint-disable-next-line max-lines-per-function
function geometryLoader(
  dataset: TAnalysisDataset,
  source: TGeometrySource,
  count: number,
  shape: number[],
  family: TNativeFamily
) {
  // Every array the geometry reads, plus how it is laid out: two variables
  // with the same centres but different bounds or face centres differ.
  const key = [
    dataset.key,
    family,
    source.lat.key,
    source.lon.key,
    source.bounds?.lat.key,
    source.bounds?.lon.key,
    source.mesh?.connectivity.key,
    source.mesh?.faceAxis,
    source.mesh?.startIndex,
    source.mesh?.nodeLat.key,
    source.mesh?.nodeLon.key,
    source.mesh?.faceLat?.key,
    source.mesh?.faceLon?.key,
    source.measure?.key,
    source.nativeDims.join(","),
    shape.join(","),
  ].join("|");
  return {
    regionKey: key,
    geometry(signal?: AbortSignal) {
      let entry = geometryCache.get(key);
      if (!entry) {
        entry = startGeometry(key, source, (guarded) =>
          loadGeometry(dataset, guarded, count, shape, family)
        );
      } else {
        // Most recently used last.
        geometryCache.delete(key);
        geometryCache.set(key, entry);
      }
      return waitForGeometry(key, entry, signal);
    },
    geometryReady: () => geometryCache.get(key)?.bytes !== undefined,
    // Reads still to make: none while loaded or being loaded by another
    // plot; otherwise only arrays whose decoded values are not shared yet.
    // Their stored bytes and shard indexes, an axis locator's sides too.
    geometryBytesNow: () =>
      geometryCache.has(key)
        ? 0
        : sourceArrays(source).reduce(
            (total, array) => total + storedColdBytes(dataset, array),
            source.locate?.coldBytes?.() ?? 0
          ),
    geometryReadsNow: () =>
      geometryCache.has(key)
        ? 0
        : sourceArrays(source).reduce(
            (total, array) =>
              total +
              (array.coldReads
                ? array.coldReads()
                : isDecoded(dataset, array)
                  ? 0
                  : chunkCount(array)),
            0
          ),
  };
}

function sourceArrays(source: TGeometrySource) {
  return [
    source.mesh ? undefined : source.lat,
    source.mesh ? undefined : source.lon,
    source.bounds?.lat,
    source.bounds?.lon,
    source.mesh?.nodeLat,
    source.mesh?.nodeLon,
    source.mesh?.connectivity,
    source.mesh?.faceLat,
    source.mesh?.faceLon,
    // A measure is read for area plots only (measureAreaLoader).
  ].filter((array): array is TAnalysisArray => Boolean(array));
}

/**
 * What reading a stored array whole fetches while it is not decoded yet: its
 * whole declared chunks (padding included) and the shard indexes in front of
 * them. Nothing for a computed one (its stored arrays say theirs).
 */
function storedColdBytes(
  dataset: TAnalysisDataset,
  array: TAnalysisArray | undefined
) {
  return !array || array.coldReads || isDecoded(dataset, array)
    ? 0
    : chunkCount(array) * chunkByteSize(array) + wholeIndexBytes(array);
}

function chunkCount(array: TAnalysisArray) {
  return array.shape.reduce(
    (p, n, d) => p * Math.ceil(n / Math.max(1, array.chunks[d])),
    1
  );
}

function isDecoded(dataset: TAnalysisDataset, array: TAnalysisArray) {
  return decoded.holdsUnder(`${dataset.key}|${array.key}|`);
}

/** Total bytes of a loaded geometry's typed arrays. */
function bytesOfGeometry(value: unknown, seen = new Set<unknown>()): number {
  if (!value || typeof value !== "object" || seen.has(value)) {
    return 0;
  }
  seen.add(value);
  if (ArrayBuffer.isView(value)) {
    return value.byteLength;
  }
  let total = 0;
  for (const item of Object.values(value)) {
    total += bytesOfGeometry(item, seen);
  }
  return total;
}

/**
 * A released source's geometries: loads stop and nothing stays cached for
 * it (reopened, it loads afresh). Keys begin with the dataset's key.
 */
export function forgetGeometries(datasetKey: string) {
  // Its whole decoded coordinates, read or reading.
  decoded.release(`${datasetKey}|`);
  tileReleases.push({ at: ++releaseCount, key: datasetKey });
  if (tileReleases.length > 256) {
    tileReleases.shift();
  }
  // Its area tiles too.
  for (let at = keptTiles.length - 1; at >= 0; at--) {
    const entry = keptTiles[at];
    if (entry.owner?.startsWith(`${datasetKey}|`)) {
      const gone = entry.cache.get(entry.key);
      keptTileBytes -= gone?.byteLength ?? 0;
      entry.cache.delete(entry.key);
      keptTiles.splice(at, 1);
    }
  }
  for (const [key, entry] of [...geometryCache]) {
    if (key.startsWith(`${datasetKey}|`)) {
      if (!entry.settled) {
        entry.controller.abort(
          new DOMException("Source released", "AbortError")
        );
      }
      geometryCache.delete(key);
    }
  }
  for (const key of [...cornerAreaCache.keys()]) {
    if (key.startsWith(`${datasetKey}|`)) {
      cornerAreaCache.delete(key);
    }
  }
}

/** Loaded geometries kept, by their typed-array bytes (oldest go first). */
const GEOMETRY_CACHE_BYTES = 384 * 2 ** 20;

function trimGeometryCache() {
  let total = 0;
  for (const entry of geometryCache.values()) {
    total += entry.bytes ?? 0;
  }
  for (const [key, entry] of geometryCache) {
    if (
      total <= GEOMETRY_CACHE_BYTES &&
      geometryCache.size <= GEOMETRY_CACHE_ENTRIES
    ) {
      break;
    }
    // Keep the newest entry and any load still being waited on.
    if (entry.bytes === undefined || key === [...geometryCache.keys()].pop()) {
      continue;
    }
    geometryCache.delete(key);
    total -= entry.bytes;
  }
}

/** Start a shared geometry load whose reads stop when it is abandoned. */
function startGeometry(
  key: string,
  source: TGeometrySource,
  load: (guarded: TGeometrySource) => Promise<TNativeGeometry>
) {
  const controller = new AbortController();
  const created: TGeometryEntry = {
    promise: load(guardedSource(source, controller.signal)),
    controller,
    waiters: 0,
    settled: false,
  };
  void created.promise.then(
    (geometry) => {
      created.settled = true;
      created.bytes = bytesOfGeometry(geometry);
      trimGeometryCache();
      return created.bytes;
    },
    () => {
      created.settled = true;
      if (geometryCache.get(key) === created) {
        geometryCache.delete(key);
      }
    }
  );
  geometryCache.set(key, created);
  trimGeometryCache();
  return created;
}

/**
 * Each waiter can stop waiting; the load itself stops reading once its
 * last waiter has gone. A waiter without a signal keeps it going.
 */
function waitForGeometry(
  key: string,
  shared: TGeometryEntry,
  signal?: AbortSignal
) {
  if (!signal) {
    shared.waiters = Number.POSITIVE_INFINITY;
    return shared.promise;
  }
  shared.waiters++;
  return new Promise<TNativeGeometry>((resolve, reject) => {
    const abort = () => {
      shared.waiters--;
      if (shared.waiters <= 0 && !shared.settled) {
        shared.controller.abort(signal.reason);
        if (geometryCache.get(key) === shared) {
          geometryCache.delete(key);
        }
      }
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) {
      abort();
      return;
    }
    signal.addEventListener("abort", abort, { once: true });
    void shared.promise
      .then(resolve, reject)
      .finally(() => signal.removeEventListener("abort", abort));
  });
}

type TGeometryEntry = {
  promise: Promise<TNativeGeometry>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
  /** Typed-array bytes once loaded. */
  bytes?: number;
};

/** The geometry arrays, reading nothing more once `signal` aborts. */
function guardedSource(
  source: TGeometrySource,
  signal: AbortSignal
): TGeometrySource {
  const guard = (array: TAnalysisArray): TAnalysisArray => ({
    ...array,
    unguarded: array.unguarded ?? array,
    guard: signal,
    readChunk(coords, readSignal) {
      throwIfAborted(signal);
      return array.readChunk(
        coords,
        readSignal ? AbortSignal.any([readSignal, signal]) : signal
      );
    },
  });
  const optional = (array?: TAnalysisArray) => array && guard(array);
  return {
    ...source,
    lat: guard(source.lat),
    lon: guard(source.lon),
    bounds: source.bounds && {
      lat: guard(source.bounds.lat),
      lon: guard(source.bounds.lon),
    },
    mesh: source.mesh && {
      ...source.mesh,
      connectivity: guard(source.mesh.connectivity),
      nodeLat: guard(source.mesh.nodeLat),
      nodeLon: guard(source.mesh.nodeLon),
      faceLat: optional(source.mesh.faceLat),
      faceLon: optional(source.mesh.faceLon),
    },
    measure: optional(source.measure),
  };
}

/** Where each native dimension is in a 2-D array's own order (or why not). */
function positionsOn(
  array: TAnalysisArray,
  nativeDims: string[],
  shape: number[]
) {
  const own = array.dimensionNames;
  const position = nativeDims.map((dim) => own.indexOf(dim));
  if (
    own.length !== 2 ||
    position.some((at) => at < 0) ||
    position.some((at, d) => array.shape[at] !== shape[d])
  ) {
    throw new AnalysisInputError(
      `${array.key} has dimensions (${own.join(", ")}) and shape [${array.shape.join(", ")}], which do not match the grid (${nativeDims.join(", ")}) [${shape.join(", ")}].`
    );
  }
  return position;
}

/** A stored 2-D chunk decoded into native (i, j) order, `ni` × `nj`. */
function decodeBlock(
  chunk: TStoredChunk,
  codec: ReturnType<typeof buildValueCodec>,
  position: number[],
  ni: number,
  nj: number
) {
  const values = new Float64Array(ni * nj);
  for (let i = 0; i < ni; i++) {
    for (let j = 0; j < nj; j++) {
      const local = [0, 0];
      [local[position[0]], local[position[1]]] = [i, j];
      const raw =
        chunk.data[local[0] * chunk.stride[0] + local[1] * chunk.stride[1]];
      values[i * nj + j] = chunk.absent
        ? codec.absentValue
        : typeof raw === "bigint"
          ? decodeStoredBigInt(codec, raw)
          : decodeStoredValue(codec, Number(raw));
    }
  }
  return values;
}

/**
 * A 2-D array's values at the cells (rows × cols of the native order) a
 * selection needs, its chunks read only where they hold such a cell, each once
 * per array, cancellable between chunks. `at(i, j)` is the value of native cell
 * (i, j).
 */
const blockChunks = new WeakMap<TAnalysisArray, Map<string, Float64Array>>();
/**
 * Tiles being read: one read for every waiter, stopped when the last waiter
 * leaves.
 */
const pendingTiles = new SharedReads(0);
/** Sources released (forgetGeometries), counted: a late tile is not kept. */
const tileReleases: { at: number; key: string }[] = [];
let releaseCount = 0;

/** Whether `owner`'s source was released after release count `since`. */
function releasedSince(since: number, owner: string) {
  return (
    ((tileReleases[0]?.at ?? Infinity) > since + 1 && since < releaseCount) ||
    tileReleases.some(
      (release) => release.at > since && owner.startsWith(`${release.key}|`)
    )
  );
}
/** Decoded chunks of 1-D arrays read along their axis, per array. */
const axisChunks = new WeakMap<TAnalysisArray, Map<number, Float64Array>>();

/**
 * Decoded area tiles kept for reuse, oldest let go first past 64 MiB in all. A
 * read keeps its own tiles while it uses them, whatever is let go.
 */
const TILE_BYTES = 64 * 2 ** 20;
const keptTiles: {
  cache: Map<unknown, Float64Array>;
  key: unknown;
  /** The array's key, so a released source lets its tiles go. */
  owner?: string;
}[] = [];
let keptTileBytes = 0;
function keepTile<K>(
  cache: Map<K, Float64Array>,
  key: K,
  tile: Float64Array,
  owner?: string
) {
  // Kept once: a tile read twice is one entry, not two. One tile past the whole
  // budget is not kept: the cache would hold it alone, above its limit.
  if (tile.byteLength > TILE_BYTES) {
    return;
  }
  const held = cache.get(key);
  if (held) {
    keptTileBytes += tile.byteLength - held.byteLength;
    cache.set(key, tile);
    return;
  }
  cache.set(key, tile);
  keptTiles.push({ cache: cache as Map<unknown, Float64Array>, key, owner });
  keptTileBytes += tile.byteLength;
  while (keptTileBytes > TILE_BYTES && keptTiles.length > 1) {
    const oldest = keptTiles.shift()!;
    const gone = oldest.cache.get(oldest.key);
    if (gone) {
      keptTileBytes -= gone.byteLength;
      oldest.cache.delete(oldest.key);
    }
  }
}

/**
 * A 1-D array's values at `indices` only: its chunks read where they hold one,
 * each once per array, cancellable between chunks. `at(index)` is the value
 * there.
 */
// eslint-disable-next-line max-lines-per-function
export async function readAlong(
  dataset: TAnalysisDataset,
  array: TAnalysisArray,
  indices: ArrayLike<number>,
  signal?: AbortSignal
) {
  const codec = buildValueCodec(
    array.attrs,
    array.fillValue,
    array.dtype,
    dataset.format
  );
  const cache =
    axisChunks.get(array) ?? axisChunks.set(array, new Map()).get(array)!;
  const size = array.chunks[0];
  const source = array.unguarded ?? array;
  const mine = new Map<number, Float64Array>();
  for (const c of new Set(Array.from(indices, (i) => Math.floor(i / size)))) {
    const kept = cache.get(c);
    if (kept) {
      mine.set(c, kept);
      continue;
    }
    throwIfAborted(signal);
    const n = Math.min(size, array.shape[0] - c * size);
    // As the two-dimensional tiles: one read whoever waits, stopped with its
    // last waiter, and not kept when it ends after its source was let go or its
    // reader stopped.
    const since = releaseCount;
    const values = await pendingTiles.share(
      `${array.key}|along ${c}`,
      n * 8,
      async (own) => {
        const chunk = await source.readChunk([c], own);
        throwIfAborted(own);
        const decoded = new Float64Array(n);
        for (let k = 0; k < n; k++) {
          const raw = chunk.data[k * (chunk.stride[0] ?? 1)];
          decoded[k] = chunk.absent
            ? codec.absentValue
            : typeof raw === "bigint"
              ? decodeStoredBigInt(codec, raw)
              : decodeStoredValue(codec, Number(raw));
        }
        if (!releasedSince(since, array.key)) {
          keepTile(cache, c, decoded, array.key);
        }
        return decoded;
      },
      signal
    );
    mine.set(c, values);
  }
  return (i: number) => mine.get(Math.floor(i / size))?.[i % size] ?? NaN;
}

/** The chunks `readAlong` would still read for `indices`, and their size. */
export function alongReadsNow(
  array: TAnalysisArray,
  indices: ArrayLike<number>
) {
  const size = array.chunks[0];
  const cache = axisChunks.get(array);
  let [reads, held] = [0, 0];
  const chunks = new Set(Array.from(indices, (i) => Math.floor(i / size)));
  const shards = new Set<number>();
  const per = array.shardIndex?.chunksPerShard[0] ?? 1;
  for (const c of chunks) {
    if (!cache?.has(c)) {
      reads += 1;
      shards.add(Math.floor(c / per));
    }
    held += Math.min(size, array.shape[0] - c * size) * 8;
  }
  return storedAndKept(array, reads, held, shards.size);
}

/**
 * What area reads cost: each stored chunk decodes at its own type and padded
 * size, one at a time; what is kept is the float64 values of the cells it
 * covers, cut at the grid's edge.
 */
function storedAndKept(
  array: TAnalysisArray,
  reads: number,
  held: number,
  /** Shards those reads find their chunks in: each index is read first. */
  shards = 0
) {
  const input = chunkByteSize(array);
  // A sharded measure's indexes are read before its values.
  const indexes = shards * (array.shardIndex?.bytes ?? 0);
  return {
    reads,
    bytes: reads * input + indexes,
    held,
    input: reads ? input : 0,
  };
}

/** Distinct shards of `chunk keys` ("a,b"), along two axes of `array`. */
function shardsOfKeys(
  array: TAnalysisArray,
  position: number[],
  keys: Iterable<string>
) {
  const index = array.shardIndex;
  if (!index) {
    return 0;
  }
  const [pa, pb] = position.map((at) => index.chunksPerShard[at] ?? 1);
  const shards = new Set<string>();
  for (const key of keys) {
    const [a, b] = key.split(",").map(Number);
    shards.add(`${Math.floor(a / pa)},${Math.floor(b / pb)}`);
  }
  return shards.size;
}

/**
 * The stored chunks `readNativeCells` would still read for these rows and
 * columns (none cached yet), and their decoded size: a price before any read.
 */
/**
 * The chunk keys (`a,b`) under some cells, given as (i, j) pairs: only the
 * chunks a region's selected cells are in, not every chunk of its rows and
 * columns.
 */
function chunksUnder(
  array: TAnalysisArray,
  nativeDims: string[],
  shape: number[],
  positions: ArrayLike<number>
) {
  const position = positionsOn(array, nativeDims, shape);
  const [ci, cj] = position.map((at) => array.chunks[at]);
  const keys = new Set<string>();
  for (let at = 0; at + 1 < positions.length; at += 2) {
    keys.add(
      `${Math.floor(positions[at] / ci)},${Math.floor(positions[at + 1] / cj)}`
    );
  }
  return keys;
}

/** Chunks still to read under some cells ((i, j) pairs), and their bytes. */
export function nativeCellReadsAt(
  array: TAnalysisArray,
  nativeDims: string[],
  shape: number[],
  positions: ArrayLike<number>
) {
  const position = positionsOn(array, nativeDims, shape);
  const [ci, cj] = position.map((at) => array.chunks[at]);
  const cache = blockChunks.get(array);
  let [reads, held] = [0, 0];
  const keys = chunksUnder(array, nativeDims, shape, positions);
  const unread: string[] = [];
  for (const key of keys) {
    if (!cache?.has(key)) {
      reads += 1;
      unread.push(key);
    }
    const [a, b] = key.split(",").map(Number);
    held += clipped(ci, shape[0], a) * clipped(cj, shape[1], b) * 8;
  }
  // Every tile is held while the cells are weighed, cached ones too.
  return storedAndKept(
    array,
    reads,
    held,
    shardsOfKeys(array, position, unread)
  );
}

/** A tile's extent along one axis, cut at the grid's edge. */
function clipped(size: number, length: number, at: number) {
  return Math.max(0, Math.min(size, length - at * size));
}

export function nativeCellReadsNow(
  array: TAnalysisArray,
  nativeDims: string[],
  shape: number[],
  rows: ArrayLike<number>,
  cols: ArrayLike<number>
) {
  const position = positionsOn(array, nativeDims, shape);
  const cache = blockChunks.get(array);
  const [ci, cj] = position.map((at) => array.chunks[at]);
  const chunkRows = new Set(Array.from(rows, (i) => Math.floor(i / ci)));
  const chunkCols = new Set(Array.from(cols, (j) => Math.floor(j / cj)));
  // Every pair, less the cached ones among them: counted from whichever is
  // smaller, the cache or the pairs.
  const pairs = chunkRows.size * chunkCols.size;
  let reads = pairs;
  if (cache?.size && cache.size < pairs) {
    for (const key of cache.keys()) {
      const [a, b] = key.split(",").map(Number);
      reads -= chunkRows.has(a) && chunkCols.has(b) ? 1 : 0;
    }
  } else if (cache?.size) {
    reads = 0;
    for (const a of chunkRows) {
      for (const b of chunkCols) {
        reads += cache.has(`${a},${b}`) ? 0 : 1;
      }
    }
  }
  const along = (chunks: Set<number>, size: number, length: number) =>
    [...chunks].reduce((n, c) => n + clipped(size, length, c), 0);
  const held =
    along(chunkRows, ci, shape[0]) * along(chunkCols, cj, shape[1]) * 8;
  // Shards of all the pairs: an upper bound where some are cached.
  const index = array.shardIndex;
  const shardsAlong = (chunks: Set<number>, at: number) =>
    new Set(
      [...chunks].map((c) => Math.floor(c / (index?.chunksPerShard[at] ?? 1)))
    ).size;
  const shards =
    index && reads
      ? shardsAlong(chunkRows, position[0]) *
        shardsAlong(chunkCols, position[1])
      : 0;
  return storedAndKept(array, reads, held, shards);
}

// eslint-disable-next-line max-lines-per-function
export async function readNativeCells(
  dataset: TAnalysisDataset,
  array: TAnalysisArray,
  nativeDims: string[],
  shape: number[],
  rows: ArrayLike<number>,
  cols: ArrayLike<number>,
  signal?: AbortSignal,
  /** Only the chunks under these cells ((i, j) pairs), when given. */
  positions?: ArrayLike<number>
) {
  const position = positionsOn(array, nativeDims, shape);
  const under = positions && chunksUnder(array, nativeDims, shape, positions);
  const codec = buildValueCodec(
    array.attrs,
    array.fillValue,
    array.dtype,
    dataset.format
  );
  const cache =
    blockChunks.get(array) ?? blockChunks.set(array, new Map()).get(array)!;
  const [ci, cj] = position.map((at) => array.chunks[at]);
  const chunkRows = new Set(Array.from(rows, (i) => Math.floor(i / ci)));
  const chunkCols = new Set(Array.from(cols, (j) => Math.floor(j / cj)));
  const source = array.unguarded ?? array;
  const mine = new Map<string, Float64Array>();
  // The tiles under the cells when known, not every pair of their rows and
  // columns.
  const keys = under
    ? [...under].filter((key) => {
        const [a, b] = key.split(",").map(Number);
        return chunkRows.has(a) && chunkCols.has(b);
      })
    : [...chunkRows].flatMap((a) => [...chunkCols].map((b) => `${a},${b}`));
  for (const key of keys) {
    const kept = cache.get(key);
    if (kept) {
      mine.set(key, kept);
      continue;
    }
    throwIfAborted(signal);
    const [a, b] = key.split(",").map(Number);
    const coord = [0, 0];
    [coord[position[0]], coord[position[1]]] = [a, b];
    const [ni, nj] = [
      Math.min(ci, shape[0] - a * ci),
      Math.min(cj, shape[1] - b * cj),
    ];
    // One read of a tile, whoever else waits for it; each waiter may still
    // cancel on its own, and the last one stops it.
    const since = releaseCount;
    const block = await pendingTiles.share(
      `${array.key}|${key}`,
      ni * nj * 8,
      async (own) => {
        const chunk = await source.readChunk(coord, own);
        throwIfAborted(own);
        const decoded = decodeBlock(chunk, codec, position, ni, nj);
        if (!releasedSince(since, array.key)) {
          keepTile(cache, key, decoded, array.key);
        }
        return decoded;
      },
      signal
    );
    mine.set(key, block);
  }
  return (i: number, j: number) => {
    const block = mine.get(`${Math.floor(i / ci)},${Math.floor(j / cj)}`);
    const nj = Math.min(cj, shape[1] - Math.floor(j / cj) * cj);
    return block ? block[(i % ci) * nj + (j % cj)] : Number.NaN;
  };
}

/**
 * Read an array over the native dimensions (plus `inner` trailing values per
 * cell, e.g. corners) and permute it from its own dimension order into the
 * native flat order. Each array carries its own order: a measure stored
 * (x, y) beside coordinates stored (y, x) is permuted on its own terms.
 */
export async function readNative(
  dataset: TAnalysisDataset,
  array: TAnalysisArray,
  nativeDims: string[],
  shape: number[],
  inner = 1,
  units: TAttrs = array.attrs,
  signal?: AbortSignal
) {
  const own = array.dimensionNames.slice(0, nativeDims.length);
  const position = nativeDims.map((dim) => own.indexOf(dim));
  if (
    position.some((at) => at < 0) ||
    position.some((at, d) => array.shape[at] !== shape[d]) ||
    array.shape.length !== nativeDims.length + (inner > 1 ? 1 : 0)
  ) {
    throw new AnalysisInputError(
      `${array.key} has dimensions (${array.dimensionNames.join(", ")}) and shape [${array.shape.join(", ")}], which do not match the grid (${nativeDims.join(", ")}) [${shape.join(", ")}].`
    );
  }
  const values = await readAllShared(dataset, array, signal, units);
  if (position.every((at, d) => at === d)) {
    return values;
  }
  // Two native dimensions (a, b) stored as (b, a).
  const [na, nb] = shape;
  const out = new Float64Array(values.length);
  for (let a = 0; a < na; a++) {
    for (let b = 0; b < nb; b++) {
      for (let k = 0; k < inner; k++) {
        out[(a * nb + b) * inner + k] = values[(b * na + a) * inner + k];
      }
    }
  }
  return out;
}

// eslint-disable-next-line max-lines-per-function
async function loadGeometry(
  dataset: TAnalysisDataset,
  source: TGeometrySource,
  count: number,
  shape: number[],
  family: TNativeFamily
): Promise<TNativeGeometry> {
  if (source.mesh) {
    return loadMeshGeometry(dataset, source, count, family);
  }
  const lat = await readNative(dataset, source.lat, source.nativeDims, shape);
  const lon = await readNative(dataset, source.lon, source.nativeDims, shape);
  let invalid = 0;
  for (let at = 0; at < count; at++) {
    if (
      !Number.isFinite(lat[at]) ||
      !Number.isFinite(lon[at]) ||
      Math.abs(lat[at]) > 90
    ) {
      lat[at] = Number.NaN;
      lon[at] = Number.NaN;
      invalid++;
    }
  }
  // Without corners, repeated centres are repeated cells; with corners,
  // only when their outlines match too (below).
  const dropped = new Map<number, number>();
  let duplicates =
    shape.length === 2 && !source.bounds
      ? dropFrameDuplicates(lat, lon, shape, undefined, undefined, dropped)
      : 0;
  let outline: TNativeGeometry["outline"];
  let areas: Float64Array | undefined;
  let radii: Float32Array | undefined;
  let maxRadius = 0;
  if (source.bounds) {
    const corners = source.bounds.lat.shape[source.bounds.lat.shape.length - 1];
    const native = [source.nativeDims, shape] as const;
    // CF bounds without units inherit their coordinate's (e.g. radians).
    const unitsOf = (bounds: TAnalysisArray, parent: TAnalysisArray) =>
      bounds.attrs.units === undefined ? parent.attrs : bounds.attrs;
    const { lat: latB, lon: lonB } = source.bounds;
    const bLat = await readNative(
      dataset,
      latB,
      ...native,
      corners,
      unitsOf(latB, source.lat)
    );
    const bLon = await readNative(
      dataset,
      lonB,
      ...native,
      corners,
      unitsOf(lonB, source.lon)
    );
    // The decoded bounds are the outline: no per-corner vector copy.
    outline = cornerOutline(corners, bLat, bLon);
    if (shape.length === 2) {
      const cells = outline;
      // Each cell's corners made once, not for every comparison.
      const made = new Map<number, TVec3[]>();
      const own = (at: number) => {
        let found = made.get(at);
        if (!found) {
          found = cornersOf(cells, at);
          made.set(at, found);
        }
        return found;
      };
      duplicates = dropFrameDuplicates(
        lat,
        lon,
        shape,
        (a, b) => sameOutline(own(a), own(b)),
        (at) => {
          const corners = own(at);
          if (!corners.length) {
            return undefined;
          }
          const mean: TVec3 = [0, 0, 0];
          for (const c of corners) {
            mean[0] += c[0] / corners.length;
            mean[1] += c[1] / corners.length;
            mean[2] += c[2] / corners.length;
          }
          return mean;
        },
        dropped
      );
    }
    areas = new Float64Array(count);
    radii = new Float32Array(count);
    for (let cell = 0; cell < count; cell++) {
      if (cell % 65536 === 65535) {
        await yieldIfBusy();
        throwIfAborted(source.lat.guard);
      }
      const shapeOf = cornersOf(outline, cell);
      const area = shapeOf.length >= 3 ? sphericalArea(shapeOf) : 0;
      if (!Number.isFinite(lat[cell]) || !(area > 1e-18)) {
        if (Number.isFinite(lat[cell])) {
          invalid++;
        }
        lat[cell] = Number.NaN;
        lon[cell] = Number.NaN;
        continue;
      }
      areas[cell] = area;
      const centre = toVec(lat[cell], lon[cell]);
      for (const corner of shapeOf) {
        radii[cell] = Math.max(radii[cell], angle(centre, corner) / DEG);
      }
      maxRadius = Math.max(maxRadius, radii[cell]);
    }
  }
  const nativeLocate = source.locate
    ? await nativeLocator(source.locate, source.nativeDims, shape)
    : undefined;
  // Cells without corners but with published rotated sides: their areas.
  if (!areas && source.axisAreas && shape.length === 2) {
    const own = new Float64Array(count);
    await placeAreas(source.axisAreas, source.nativeDims, shape, (cell, a) => {
      own[cell] = a;
    });
    areas = own;
  }
  // Large projected cells' areas along their own sides: refined when an area
  // plot first weighs them, not for a point.
  let refining: Promise<void> | undefined;
  const refine =
    areas && source.refinedAreas && shape.length === 2
      ? () =>
          (refining ??= placeAreas(
            source.refinedAreas!,
            source.nativeDims,
            shape,
            (cell, area) => {
              if (areas[cell] > 0) {
                areas[cell] = area;
              }
            }
          ))
      : undefined;
  // A declared measure is read for area plots only (measureAreaLoader):
  // locating a point needs the centres alone.
  return finishGeometry(
    {
      count,
      lat,
      lon,
      outline,
      areas,
      maxRadius,
      radii,
      invalid,
      ...(duplicates ? { duplicates, copies: copiesByKept(dropped) } : {}),
      ...(nativeLocate ? { nativeLocate } : {}),
      ...(refine ? { refine } : {}),
    },
    source.lat.guard
  );
}

/**
 * Each kept cell's dropped copies, from each copy's keeper (a keeper later
 * dropped in the other order hands its copies on).
 */
function copiesByKept(dropped: Map<number, number>) {
  const out = new Map<number, number[]>();
  for (const [copy, first] of dropped) {
    let keep = first;
    for (let hops = 0; dropped.has(keep) && hops < dropped.size; hops++) {
      keep = dropped.get(keep)!;
    }
    const list = out.get(keep);
    if (list) {
      list.push(copy);
    } else {
      out.set(keep, [copy]);
    }
  }
  return out;
}

/** Areas keyed along `areas.dims`, placed at each cell of the field's axes. */
async function placeAreas(
  areas: TRefinedAreas,
  nativeDims: string[],
  shape: number[],
  place: (cell: number, area: number) => void
) {
  const [rows, cols] = areas.dims.map((dim) => nativeDims.indexOf(dim));
  if (rows < 0 || cols < 0 || rows === cols) {
    return;
  }
  const stride = [shape[1], 1];
  const width = shape[cols];
  await areas.read((key, area) =>
    place(
      Math.floor(key / width) * stride[rows] + (key % width) * stride[cols],
      area
    )
  );
}

/** A located (row, column) as the flat index along the field's axes. */
async function nativeLocator(
  locate: TAxisLocator,
  nativeDims: string[],
  shape: number[]
) {
  const [rows, cols] = locate.dims.map((dim) => nativeDims.indexOf(dim));
  if (shape.length !== 2 || rows < 0 || cols < 0 || rows === cols) {
    return undefined;
  }
  const find = await locate.make();
  const stride = [shape[1], 1];
  return (lat: number, lon: number) => {
    const at = find(lat, lon);
    return at ? at[0] * stride[rows] + at[1] * stride[cols] : -1;
  };
}

/**
 * The area weight of every cell for an area plot: declared or from held
 * outlines with the geometry, else loaded from the corners on demand.
 */
export async function nativeAreas(
  grid: TNativeContext,
  geometry: TNativeGeometry,
  signal?: AbortSignal
) {
  if (grid.cornerAreas) {
    return grid.cornerAreas.load(signal);
  }
  // Shared with other plots of the grid: a Stop leaves the wait, not the
  // refinement the others may still need.
  if (geometry.refine) {
    await raceAbort(geometry.refine(), signal);
  }
  return geometry.areas;
}

/** Areas from corners or a declared measure per grid, newest kept. */
const cornerAreaCache = new Map<
  string,
  {
    promise: Promise<Float64Array>;
    controller: AbortController;
    waiting: number;
  }
>();
const CORNER_AREA_ENTRIES = 4;

/**
 * One load of a grid's areas shared by every plot asking: each brings its own
 * signal, and the read stops only when the last of them leaves.
 */
async function sharedAreaLoad(
  key: string,
  start: (signal: AbortSignal) => Promise<Float64Array>,
  signal?: AbortSignal
) {
  throwIfAborted(signal);
  let entry = cornerAreaCache.get(key);
  if (!entry) {
    const controller = new AbortController();
    const created = {
      promise: start(controller.signal),
      controller,
      waiting: 0,
    };
    entry = created;
    cornerAreaCache.set(key, created);
    while (cornerAreaCache.size > CORNER_AREA_ENTRIES) {
      cornerAreaCache.delete(cornerAreaCache.keys().next().value!);
    }
    created.promise.catch(() => {
      if (cornerAreaCache.get(key) === created) {
        cornerAreaCache.delete(key);
      }
    });
  }
  const own = entry;
  own.waiting++;
  let left = false;
  const leave = () => {
    if (!left) {
      left = true;
      if (--own.waiting <= 0) {
        own.controller.abort(signal?.reason);
      }
    }
  };
  signal?.addEventListener("abort", leave, { once: true });
  try {
    return await raceAbort(own.promise, signal);
  } finally {
    signal?.removeEventListener("abort", leave);
    if (!left) {
      left = true;
      own.waiting--;
    }
  }
}

/**
 * A declared cell measure, read when an area plot needs it (never to
 * locate a point), shared and cancelled as corner areas are.
 */
function measureAreaLoader(
  dataset: TAnalysisDataset,
  source: TGeometrySource,
  shape: number[],
  loader: { regionKey: string }
): TCornerAreas {
  const measure = source.measure!;
  // The mesh is shared; its areas are this measure's.
  const key = `${loader.regionKey}|measure|${measure.key}`;
  const count = shape.reduce((p, n) => p * n, 1);
  const cost = geometryCostOf([measure]);
  return {
    bytes: count * 8 + cost.geometryWorkspace,
    chunkBytes: cost.geometryChunkBytes,
    readsNow: () =>
      cornerAreaCache.has(key) || isDecoded(dataset, measure)
        ? 0
        : chunkCount(measure),
    decodedNow: () =>
      cornerAreaCache.has(key) || isDecoded(dataset, measure)
        ? 0
        : chunkCount(measure) * chunkByteSize(measure),
    load: (signal) =>
      sharedAreaLoad(
        key,
        async (own) => {
          const guarded = guardedSource(source, own).measure!;
          return guarded.dimensionNames.length === source.nativeDims.length
            ? readNative(dataset, guarded, source.nativeDims, shape)
            : readBroadcast(dataset, guarded, source.nativeDims, shape);
        },
        signal
      ),
  };
}

/**
 * The on-demand corner areas of a grid located by centres: its centres
 * first (shared with the locator), then one pass over the corners. A
 * cancelled or failed load is dropped, so the next plot starts afresh.
 */

function cornerAreaLoader(
  dataset: TAnalysisDataset,
  source: TGeometrySource,
  shape: number[],
  loader: { regionKey: string; geometry: TNativeContext["geometry"] },
  bytes: number
): TCornerAreas {
  const key = `${loader.regionKey}|areas`;
  const arrays = [source.bounds!.lat, source.bounds!.lon];
  return {
    bytes,
    chunkBytes: geometryCostOf(arrays).geometryChunkBytes,
    readsNow: () =>
      cornerAreaCache.has(key)
        ? 0
        : arrays.reduce(
            (total, array) =>
              total + (isDecoded(dataset, array) ? 0 : chunkCount(array)),
            0
          ),
    decodedNow: () =>
      cornerAreaCache.has(key)
        ? 0
        : arrays.reduce(
            (total, array) =>
              total +
              (isDecoded(dataset, array)
                ? 0
                : chunkCount(array) * chunkByteSize(array)),
            0
          ),
    load: (signal) =>
      sharedAreaLoad(
        key,
        async (own) => {
          const geometry = await loader.geometry(own);
          return areasFromCorners(
            dataset,
            guardedSource(source, own),
            shape,
            geometry.lat
          );
        },
        signal
      ),
  };
}

/** The corner latitudes as float32 offsets from each cell's centre. */
async function cornerLatOffsets(
  dataset: TAnalysisDataset,
  source: TGeometrySource,
  shape: number[],
  lat: Float64Array
) {
  const latB = source.bounds!.lat;
  const corners = latB.shape[latB.shape.length - 1];
  const count = lat.length;
  const offsets = new Float32Array(count * corners);
  const bLat = await readNative(
    dataset,
    latB,
    source.nativeDims,
    shape,
    corners,
    latB.attrs.units === undefined ? source.lat.attrs : latB.attrs
  );
  for (let cell = 0; cell < count; cell++) {
    for (let k = 0; k < corners; k++) {
      const at = cell * corners + k;
      offsets[at] = bLat[at] - lat[cell];
    }
  }
  return offsets;
}

/**
 * Each cell's spherical area from its corners, which are not kept: the
 * corner latitudes are held as float32 offsets from the cell's centre
 * (exact to far below a metre) while the longitudes are decoded, then
 * both go. Cells without a centre get no area.
 */
async function areasFromCorners(
  dataset: TAnalysisDataset,
  source: TGeometrySource,
  shape: number[],
  lat: Float64Array
) {
  const { lat: latB, lon: lonB } = source.bounds!;
  const corners = latB.shape[latB.shape.length - 1];
  const count = lat.length;
  const unitsOf = (bounds: TAnalysisArray, parent: TAnalysisArray) =>
    bounds.attrs.units === undefined ? parent.attrs : bounds.attrs;
  const offsets = await cornerLatOffsets(dataset, source, shape, lat);
  throwIfAborted(source.lat.guard);
  const bLon = await readNative(
    dataset,
    lonB,
    source.nativeDims,
    shape,
    corners,
    unitsOf(lonB, source.lon)
  );
  const areas = new Float64Array(count);
  const one = new Float64Array(corners);
  const oneLon = new Float64Array(corners);
  const outline = cornerOutline(corners, one, oneLon);
  for (let cell = 0; cell < count; cell++) {
    if (cell % 65536 === 65535) {
      await yieldIfBusy();
      throwIfAborted(source.lat.guard);
    }
    if (!Number.isFinite(lat[cell])) {
      continue;
    }
    for (let k = 0; k < corners; k++) {
      one[k] = lat[cell] + offsets[cell * corners + k];
      oneLon[k] = bLon[cell * corners + k];
    }
    const shapeOf = cornersOf(outline, 0);
    areas[cell] = shapeOf.length >= 3 ? sphericalArea(shapeOf) : 0;
  }
  return areas;
}

/**
 * Whether two outlines are the same ring: the same corners in the same cyclic
 * order, from any corner and in either direction. CF §7.1.3 defines an outline
 * by its traversal.
 */
function sameOutline(a: TVec3[], b: TVec3[]) {
  const n = a.length;
  if (n !== b.length) {
    return false;
  }
  const at = (k: number) => b[((k % n) + n) % n];
  for (let shift = 0; shift < n; shift++) {
    for (const step of [1, -1]) {
      let k = 0;
      while (k < n && angle(a[k], at(shift + step * k)) <= 1e-10) {
        k++;
      }
      if (k === n) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Whether two geometries' cells have the same outlines, cell by cell, in any
 * cyclic order or direction; true when neither publishes outlines.
 */
export function sameCellOutlines(x: TNativeGeometry, y: TNativeGeometry) {
  if (!x.outline || !y.outline) {
    return !x.outline && !y.outline;
  }
  for (let cell = 0; cell < x.count; cell++) {
    if (!sameOutline(cornersOf(x.outline, cell), cornersOf(y.outline, cell))) {
      return false;
    }
  }
  return true;
}

/** The rows where a tripolar fold repeats cells. */
const FRAME = 2;
/** Columns each side where a halo repeats a row's cells (ORCA: 1 or 2). */

/**
 * Curvilinear grids with halo columns (ORCA: the first and last columns repeat
 * the opposite edge) or a tripolar fold (the top row repeats its mirror half)
 * store some cells twice; a mean would count them twice. A cell near either
 * side of its row that repeats a cell anywhere in the same row (to 1e-9°, the
 * same outline when corners are published) is marked invalid, the inner one
 * kept; in the outer FRAME rows a repeat of any earlier frame cell is too (the
 * fold). With outlines, cells near a pole are compared as well: every longitude
 * names the pole, so without outlines they never are.
 */
// eslint-disable-next-line max-lines-per-function
export function dropFrameDuplicates(
  lat: Float64Array,
  lon: Float64Array,
  shape: number[],
  /**
   * Whether two cells are one stored twice: with published corners, the same
   * outline too.
   */
  same?: (first: number, other: number) => boolean,
  /**
   * A point a cell's outline is about, the same for its copies (their corners'
   * mean): cells at a pole are grouped by it, not all compared with all.
   */
  about?: (at: number) => TVec3 | undefined,
  /** Filled with each dropped copy's kept cell. */
  copies?: Map<number, number>
) {
  const grid = (at: number) => {
    const v = about?.(at);
    return v && v.map((x) => Math.round(x * 1e6));
  };
  const cells: TFrameCells = {
    lat,
    matches: same ?? (() => true),
    // Its own cube and the 26 around it: a copy rounding to a neighbour
    // is still found.
    nearKeys: (at: number, key: string) => {
      const g = key.startsWith("pole") ? grid(at) : undefined;
      if (!g) {
        return [key];
      }
      const base = key.slice(0, key.indexOf("|"));
      const out: string[] = [];
      for (const dx of [-1, 0, 1]) {
        for (const dy of [-1, 0, 1]) {
          for (const dz of [-1, 0, 1]) {
            out.push(`${base}|${g[0] + dx},${g[1] + dy},${g[2] + dz}`);
          }
        }
      }
      return out;
    },
    keyOf: (at: number) => {
      if (!Number.isFinite(lat[at])) {
        return undefined;
      }
      // Every longitude names the pole: no repeat by centre alone, and with
      // outlines one key for every longitude there.
      const pole = Math.abs(lat[at]) > 90 - 1e-6;
      if (!same && pole) {
        return undefined;
      }
      if (pole) {
        const g = grid(at);
        return `pole ${Math.sign(lat[at])}|${g ? g.join(",") : ""}`;
      }
      const wrapped = ((((lon[at] + 180) % 360) + 360) % 360) - 180;
      // To 1e-9°: copies are exact; centres 1e-7° apart are two cells.
      return `${Math.round(lat[at] * 1e9)},${Math.round(wrapped * 1e9)}`;
    },
    drop: (at: number, keep: number) => {
      lat[at] = Number.NaN;
      lon[at] = Number.NaN;
      copies?.set(at, keep);
    },
  };
  // Either dimension may run along the rows: CF permits the transposed order. A
  // cell dropped in one order is gone in the other. Halos go in both orders
  // before either fold check: a fold check across the other order's halo
  // columns would keep a copy, not its original.
  let dropped = 0;
  for (const fold of [false, true]) {
    for (const transposed of [false, true]) {
      const [ny, nx] = transposed ? [shape[1], shape[0]] : shape;
      const index = (j: number, i: number) =>
        transposed ? i * shape[1] + j : j * nx + i;
      dropped += dropAlongRows(cells, ny, nx, index, fold);
    }
  }
  return dropped;
}

type TFrameCells = {
  lat: Float64Array;
  matches: (first: number, other: number) => boolean;
  /** The keys a copy of the cell may have (its own among them). */
  nearKeys: (at: number, key: string) => string[];
  keyOf: (at: number) => string | undefined;
  drop: (at: number, keep: number) => void;
};

/**
 * The shortest period after which a row repeats its cells to its end (row[i] is
 * row[i + period] for every i past which both exist), or undefined. Tried at
 * the distance of each key's first repeat, any cell's.
 */
function rowPeriod(
  keys: (string | undefined)[],
  same: (p: number, q: number) => boolean
) {
  const nx = keys.length;
  const firstAt = new Map<string, number>();
  const candidates = new Set<number>();
  keys.forEach((key, at) => {
    if (key === undefined) {
      return;
    }
    const first = firstAt.get(key);
    if (first === undefined) {
      firstAt.set(key, at);
    } else if (candidates.size < MAX_PERIODS_TRIED) {
      candidates.add(at - first);
    }
  });
  for (const period of [...candidates].sort((a, b) => a - b)) {
    let periodic = period < nx;
    // A position missing on one side neither confirms nor breaks the period:
    // the pairs known still certify it.
    for (let i = 0; periodic && i + period < nx; i++) {
      const [x, y] = [keys[i], keys[i + period]];
      periodic =
        x === undefined || y === undefined || (x === y && same(i, i + period));
    }
    if (periodic) {
      return period;
    }
  }
  return undefined;
}

/** Distinct repeat distances a row's period is looked for among. */
const MAX_PERIODS_TRIED = 32;

/** One order's halo or fold copies (dropFrameDuplicates), counted. */
// eslint-disable-next-line max-lines-per-function
function dropAlongRows(
  cells: TFrameCells,
  ny: number,
  nx: number,
  index: (j: number, i: number) => number,
  fold: boolean
) {
  const { matches, keyOf, nearKeys } = cells;
  let dropped = 0;
  const drop = (at: number, keep: number) => {
    cells.drop(at, keep);
    dropped++;
  };
  const keepIn = (kept: Map<string, number[]>, at: number, key: string) => {
    for (const near of nearKeys(at, key)) {
      const first = kept.get(near)?.find((cell) => matches(cell, at));
      if (first !== undefined) {
        drop(at, first);
        return;
      }
    }
    const found = kept.get(key);
    if (found) {
      found.push(at);
    } else {
      kept.set(key, [at]);
    }
  };
  // Halos: a row that repeats itself after `period` cells holds its first cells
  // twice, at either end; of each copy pair the one nearer the middle stays.
  // The period is found from the row's own cells, whatever the halo's width.
  for (let j = 0; j < (fold ? 0 : ny); j++) {
    const keys = Array.from({ length: nx }, (_, i) => keyOf(index(j, i)));
    const period = rowPeriod(keys, (p, q) => matches(index(j, p), index(j, q)));
    if (!period) {
      continue;
    }
    const middle = (nx - 1) / 2;
    for (let i = 0; i + period < nx; i++) {
      const [p, q] = [i, i + period];
      if (keys[p] === undefined || keys[q] === undefined) {
        continue;
      }
      const [gone, kept] =
        Math.abs(p - middle) > Math.abs(q - middle) ? [p, q] : [q, p];
      drop(index(j, gone), index(j, kept));
    }
  }
  // The fold: a frame row's cell repeating an earlier frame row's.
  const seen = new Map<string, number[]>();
  for (let j = 0; j < (fold ? ny : 0); j++) {
    if (j >= FRAME && j < ny - FRAME) {
      continue;
    }
    for (let i = 0; i < nx; i++) {
      const at = index(j, i);
      const key = keyOf(at);
      if (key) {
        keepIn(seen, at, key);
      }
    }
  }
  return dropped;
}

/** The spatial index of loaded positions, unless the load was cancelled. */
async function finishGeometry(
  parts: Omit<TNativeGeometry, "index" | "spacing">,
  signal?: AbortSignal
): Promise<TNativeGeometry> {
  // The last waiter may have gone during the reads: no index then, and
  // none finished once it goes while the index is built.
  throwIfAborted(signal);
  const index = await SphereIndex.create(
    parts.lat,
    parts.lon,
    parts.radii,
    signal
  );
  return {
    ...parts,
    index,
    spacing: new Float64Array(parts.count).fill(Number.NaN),
  };
}

// eslint-disable-next-line max-lines-per-function
async function loadMeshGeometry(
  dataset: TAnalysisDataset,
  source: TGeometrySource,
  count: number,
  family: TNativeFamily
): Promise<TNativeGeometry> {
  const mesh = source.mesh!;
  const nodeLat = await readAllShared(dataset, mesh.nodeLat);
  const nodeLon = await readAllShared(dataset, mesh.nodeLon);
  const raw = await readAllShared(dataset, mesh.connectivity);
  const faceCount = mesh.connectivity.shape[mesh.faceAxis];
  const corners = mesh.connectivity.shape[1 - mesh.faceAxis];
  const nodes = new Int32Array(faceCount * corners).fill(-1);
  const broken = new Uint8Array(faceCount);
  const nodeCount = nodeLat.length;
  for (let face = 0; face < faceCount; face++) {
    for (let k = 0; k < corners; k++) {
      const value =
        mesh.faceAxis === 0
          ? raw[face * corners + k]
          : raw[k * faceCount + face];
      const node = value - mesh.startIndex;
      // Fill values (decoded to NaN) and negative entries are padding; a
      // reference past the last node is an error, and its face is dropped.
      if (Number.isInteger(node) && node >= nodeCount) {
        broken[face] = 1;
      } else if (Number.isInteger(node) && node >= 0) {
        nodes[face * corners + k] = node;
      }
    }
    if (broken[face]) {
      nodes.fill(-1, face * corners, (face + 1) * corners);
    }
  }
  // Corners stay node ids into the shared node coordinates.
  const outline = nodeOutline(corners, nodes, nodeLat, nodeLon);
  const publishedLat = mesh.faceLat
    ? await readAllShared(dataset, mesh.faceLat)
    : undefined;
  const publishedLon = mesh.faceLon
    ? await readAllShared(dataset, mesh.faceLon)
    : undefined;
  const faceLat = new Float64Array(faceCount).fill(Number.NaN);
  const faceLon = new Float64Array(faceCount).fill(Number.NaN);
  const faceAreas = new Float64Array(faceCount);
  const radii = new Float32Array(faceCount);
  let maxRadius = 0;
  let invalidFaces = 0;
  for (let face = 0; face < faceCount; face++) {
    if (face % 65536 === 65535) {
      await yieldIfBusy();
      throwIfAborted(mesh.nodeLat.guard);
    }
    const shapeOf = cornersOf(outline, face);
    // The published face centre is the face's representative position
    // (selections by centre); the computed one stands in without it.
    const published =
      publishedLat &&
      Number.isFinite(publishedLat[face]) &&
      publishedLon &&
      Number.isFinite(publishedLon[face])
        ? toVec(publishedLat[face], publishedLon[face])
        : undefined;
    const centre =
      shapeOf.length >= 3 ? (published ?? centreOf(shapeOf)) : undefined;
    const area = centre ? sphericalArea(shapeOf) : 0;
    if (!centre || !(area > 1e-18)) {
      invalidFaces++;
      continue; // degenerate or invalid face: never contains a point
    }
    const c = latLonOf(centre);
    faceLat[face] = c.lat;
    faceLon[face] = c.lon;
    faceAreas[face] = area;
    for (const corner of shapeOf) {
      radii[face] = Math.max(radii[face], angle(centre, corner) / DEG);
    }
    maxRadius = Math.max(maxRadius, radii[face]);
  }
  const faces = family === NATIVE_FAMILIES.MESH_FACES;
  if (faces) {
    return finishGeometry(
      {
        count: faceCount,
        lat: faceLat,
        lon: faceLon,
        outline,
        areas: faceAreas,
        maxRadius,
        radii,
        invalid: invalidFaces,
      },
      mesh.nodeLat.guard
    );
  }
  // Node data: faces locate, nodes answer. Centres are the nodes.
  const geometry = await finishGeometry(
    {
      count,
      lat: nodeLat.slice(0, count),
      lon: nodeLon.slice(0, count),
      areas: lumpedNodeAreas(count, faceAreas, nodes, corners),
      maxRadius: 0,
      invalid: 0,
    },
    mesh.nodeLat.guard
  );
  const faceIndex = await SphereIndex.create(
    faceLat,
    faceLon,
    radii,
    mesh.nodeLat.guard
  );
  return {
    ...geometry,
    outline,
    maxRadius,
    faceNodes: { corners, nodes, faceCount },
    faceCentres: { lat: faceLat, lon: faceLon, index: faceIndex },
  };
}

/** How an area time series weighs sites that have no area. */
const SITE_MEAN =
  "equal weight per site: the mean of the sites inside (sites have no area, so this is not an area mean)";

/** How node values are weighted when the mesh declares no node areas. */
const NODE_WEIGHTING =
  "node areas: each face's spherical area shared equally among its corner nodes (lumped)";

/**
 * Areas for values on mesh nodes: each valid face's spherical area split
 * equally among its corner nodes, summed per node (the lumped dual area of
 * finite elements). A node on no valid face has none (it is not counted).
 */
function lumpedNodeAreas(
  count: number,
  faceAreas: Float64Array,
  nodes: Int32Array,
  corners: number
) {
  const areas = new Float64Array(count);
  for (let face = 0; face < faceAreas.length; face++) {
    if (!(faceAreas[face] > 0)) {
      continue;
    }
    let used = 0;
    for (let k = 0; k < corners; k++) {
      used += nodes[face * corners + k] >= 0 ? 1 : 0;
    }
    for (let k = 0; k < corners; k++) {
      const node = nodes[face * corners + k];
      if (node >= 0 && node < count) {
        areas[node] += faceAreas[face] / used;
      }
    }
  }
  return areas;
}

// ---------------------------------------------------------------------------
// Location and membership.

export type TNativeHit =
  | { cell: number; degrees: number; face?: number }
  | { cell: -1; reason: string };

/** The containing outline among candidate cells (lowest index on a shared edge). */
function containing(
  geometry: TNativeGeometry,
  centres: { lat: Float64Array; lon: Float64Array; index: SphereIndex },
  lat: number,
  lon: number
) {
  const outline = geometry.outline!;
  const p = toVec(lat, lon);
  let found = -1;
  const test = (cell: number) => {
    if (found >= 0 && cell > found) {
      return;
    }
    const corners = cornersOf(outline, cell);
    if (
      corners.length >= 3 &&
      cellContains(corners, toVec(centres.lat[cell], centres.lon[cell]), p)
    ) {
      found = cell;
    }
  };
  // Each cell's own radius when indexed with them; else the largest.
  if (centres.index.hasRadii) {
    centres.index.covering(lat, lon, test);
  } else {
    centres.index.near(lat, lon, geometry.maxRadius + 1e-6, test);
  }
  return found;
}

/** Distance from a site to its nearest neighbouring site, degrees. */
function spacingOf(geometry: TNativeGeometry, cell: number) {
  if (Number.isNaN(geometry.spacing[cell])) {
    const next = geometry.index.nearest(
      geometry.lat[cell],
      geometry.lon[cell],
      180,
      cell
    );
    geometry.spacing[cell] = next ? next.degrees : 1;
  }
  return geometry.spacing[cell];
}

/** The native cell (flat index) of a location, with why when there is none. */
// eslint-disable-next-line max-lines-per-function
export function locateNative(
  native: TNativeContext,
  geometry: TNativeGeometry,
  lat: number,
  lon: number
): TNativeHit {
  if (native.family === NATIVE_FAMILIES.MESH_NODES) {
    const face = containing(geometry, geometry.faceCentres!, lat, lon);
    if (face < 0) {
      return { cell: -1, reason: "The location is outside the mesh." };
    }
    const { corners, nodes } = geometry.faceNodes!;
    const p = toVec(lat, lon);
    let best = -1;
    let bestAngle = Number.POSITIVE_INFINITY;
    for (let k = 0; k < corners; k++) {
      const node = nodes[face * corners + k];
      if (node >= 0 && node < geometry.count) {
        const a = angle(p, toVec(geometry.lat[node], geometry.lon[node]));
        if (a < bestAngle || (a === bestAngle && node < best)) {
          best = node;
          bestAngle = a;
        }
      }
    }
    return best >= 0
      ? { cell: best, degrees: bestAngle / DEG, face }
      : { cell: -1, reason: "The containing face has no stored node." };
  }
  // By the grid's own axes, where its cells are straight in them.
  if (geometry.nativeLocate) {
    const cell = geometry.nativeLocate(lat, lon);
    return cell >= 0 && Number.isFinite(geometry.lat[cell])
      ? {
          cell,
          degrees:
            angle(
              toVec(lat, lon),
              toVec(geometry.lat[cell], geometry.lon[cell])
            ) / DEG,
        }
      : { cell: -1, reason: "No cell of this grid contains the location." };
  }
  if (geometry.outline) {
    const cell = containing(geometry, geometry, lat, lon);
    return cell >= 0
      ? {
          cell,
          degrees:
            angle(
              toVec(lat, lon),
              toVec(geometry.lat[cell], geometry.lon[cell])
            ) / DEG,
        }
      : { cell: -1, reason: "No cell of this grid contains the location." };
  }
  const nearest = geometry.index.nearest(lat, lon, 180);
  if (!nearest) {
    return { cell: -1, reason: "The grid has no valid location." };
  }
  const cutoff = spacingOf(geometry, nearest.item);
  if (nearest.degrees > cutoff + 1e-9) {
    const km = Math.round(cutoff * DEG * 6371.0088);
    return {
      cell: -1,
      reason: `No ${native.family === NATIVE_FAMILIES.SITES ? "site" : "cell centre"} within ${km} km of the location (the local spacing).`,
    };
  }
  return { cell: nearest.item, degrees: nearest.degrees };
}

/** Field positions (along `axes`) of a flat native index. */
export function nativePositions(native: TNativeContext, cell: number) {
  if (native.shape.length === 1) {
    return [cell];
  }
  const inner = native.shape[1];
  return [Math.floor(cell / inner), cell % inner];
}

/** Readable id of a native cell: "site 3", "face 12", "j=1, i=2" style. */
export function nativeCellId(
  native: TNativeContext,
  dims: string[],
  cell: number
) {
  const positions = nativePositions(native, cell);
  return native.axes
    .map((axis, k) => `${dims[axis]}=${positions[k]}`)
    .join(", ");
}

export type TNativeRegion =
  { box: TBox } | { polygon: TPreparedPolygon } | { country: TCountryRegion };

/** Cells whose centres lie inside the region, with their area weights. */
export async function nativeMembers(
  geometry: TNativeGeometry,
  region: TNativeRegion,
  limit: number,
  signal?: AbortSignal
) {
  const cells: number[] = [];
  for (let cell = 0; cell < geometry.count; cell++) {
    if (cell % 65536 === 65535) {
      await yieldIfBusy(signal);
    }
    const lat = geometry.lat[cell];
    if (!Number.isFinite(lat)) {
      continue;
    }
    const lon = geometry.lon[cell];
    const inside =
      "box" in region
        ? boxContains(region.box, lat, lon)
        : "country" in region
          ? countryContains(region.country, lat, lon)
          : polygonContains(region.polygon, lat, lon);
    if (inside) {
      cells.push(cell);
      if (cells.length > limit) {
        break;
      }
    }
  }
  return cells;
}
