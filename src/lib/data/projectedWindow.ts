import {
  axisRange,
  shrink,
  type TAxis,
  type TAxisRange,
} from "./viewWindow.ts";

import {
  longitudeArc,
  type TViewFootprint,
} from "@/lib/projection/viewFootprint.ts";

/**
 * The part of a projected level that is loaded: index ranges on its `y`
 * (rows) and `x` (columns) axes, in storage order whichever way an axis
 * runs. A projected grid is regular in its own CRS, so the view is one
 * rectangle of it: no seam, no pole to thin around.
 */
export type TProjectedWindow = {
  y: TAxisRange;
  x: TAxisRange;
};

export type TProjectedWindowOptions = {
  /** Grow the view's box by this fraction of its size on every side. */
  margin?: number;
  /** Shrink the window around the point below the camera to this many cells. */
  maxCells?: number;
};

/** Converts a lon/lat pair (degrees) to and from the grid's x/y (CRS units). */
export type TProjection = {
  forward: (lonLat: [number, number]) => [number, number];
  inverse: (xy: [number, number]) => [number, number];
};

/** A lat/lon box, as the view footprint states one. */
export type TGeoExtent = Pick<
  TViewFootprint,
  "latMin" | "latMax" | "lonStart" | "lonSpan"
>;

/** The one-dimensional axes of a projected level, with their projection. */
export type TProjectedAxes = {
  x: TAxis;
  y: TAxis;
  projection: TProjection;
  /**
   * The lat/lon box the level covers (see projectedExtent): a view outside
   * it loads nothing, however its points project. Without one, a view of the
   * far side of a polar projection, which projects to the whole grid, loads
   * what the budget allows.
   */
  extent?: TGeoExtent;
};

export type TProjectedBounds = {
  xMin: number;
  xMax: number;
  yMin: number;
  yMax: number;
};

const SAMPLES_PER_AXIS = 9;
const EXTENT_SAMPLES_PER_EDGE = 64;

function tryProject<T>(convert: (point: T) => [number, number], point: T) {
  try {
    const [a, b] = convert(point);
    return Number.isFinite(a) && Number.isFinite(b) ? [a, b] : null;
  } catch {
    return null;
  }
}

/**
 * The x/y box of a lat/lon footprint in the grid's CRS: a lattice over the
 * footprint, its edges included, transformed forward. Points the projection
 * cannot place (the antipode of a stereographic pole, say) are left out;
 * null when it places none. A footprint that wraps a pole (every
 * longitude) samples a ring of its far latitude, which in a polar
 * projection is the disc around the pole: nine samples per turn are 45°
 * apart, so the box of the ring falls short of the disc by up to
 * 1 - cos(22.5°), about 7.6 % of its radius, when the projection's central
 * meridian is not a multiple of 45°; the margin a window is loaded with
 * covers that.
 */
export function projectedBounds(
  footprint: TGeoExtent,
  forward: TProjection["forward"]
): TProjectedBounds | null {
  let bounds: TProjectedBounds | null = null;
  for (let i = 0; i < SAMPLES_PER_AXIS; i++) {
    const lat =
      footprint.latMin +
      ((footprint.latMax - footprint.latMin) * i) / (SAMPLES_PER_AXIS - 1);
    for (let j = 0; j < SAMPLES_PER_AXIS; j++) {
      const lon =
        footprint.lonStart + (footprint.lonSpan * j) / (SAMPLES_PER_AXIS - 1);
      const point = tryProject(forward, [lon, lat]);
      if (!point) {
        continue;
      }
      const [x, y] = point;
      bounds = bounds
        ? {
            xMin: Math.min(bounds.xMin, x),
            xMax: Math.max(bounds.xMax, x),
            yMin: Math.min(bounds.yMin, y),
            yMax: Math.max(bounds.yMax, y),
          }
        : { xMin: x, xMax: x, yMin: y, yMax: y };
    }
  }
  return bounds;
}

function axisSamples(values: TAxis) {
  const count = Math.min(values.length, EXTENT_SAMPLES_PER_EDGE);
  return Array.from({ length: count }, (_, i) =>
    count < 2
      ? values[0]
      : values[Math.round((i * (values.length - 1)) / (count - 1))]
  );
}

/** The poles that lie within a box of x/y, as latitudes. */
function polesWithin(
  bounds: TProjectedBounds,
  forward: TProjection["forward"]
) {
  return [-90, 90].filter((pole) => {
    const point = tryProject(forward, [0, pole]);
    return (
      point !== null &&
      point[0] >= bounds.xMin &&
      point[0] <= bounds.xMax &&
      point[1] >= bounds.yMin &&
      point[1] <= bounds.yMax
    );
  });
}

/** The edges of the grid, as x/y points: up to 64 along each. */
function edgePoints(x: TAxis, y: TAxis): [number, number][] {
  const xs = axisSamples(x);
  const ys = axisSamples(y);
  return [
    ...xs.flatMap((a): [number, number][] => [
      [a, ys[0]],
      [a, ys[ys.length - 1]],
    ]),
    ...ys.flatMap((b): [number, number][] => [
      [xs[0], b],
      [xs[xs.length - 1], b],
    ]),
  ];
}

/**
 * The lat/lon box a projected grid covers: its edges, sampled and inverted.
 * A grid holding a pole reaches that pole and every longitude; so does one
 * whose edges span more than half a turn, which the samples cannot place
 * on one side of the globe. Undefined when no edge point can be inverted.
 */
export function projectedExtent(
  x: TAxis,
  y: TAxis,
  projection: TProjection
): TGeoExtent | undefined {
  if (x.length === 0 || y.length === 0) {
    return undefined;
  }
  const samples = edgePoints(x, y)
    .map((point) => tryProject(projection.inverse, point))
    .filter((geo) => geo !== null);
  if (samples.length === 0) {
    return undefined;
  }
  const lats = samples.map((geo) => geo[1]);
  const poles = polesWithin(
    {
      xMin: Math.min(x[0], x[x.length - 1]),
      xMax: Math.max(x[0], x[x.length - 1]),
      yMin: Math.min(y[0], y[y.length - 1]),
      yMax: Math.max(y[0], y[y.length - 1]),
    },
    projection.forward
  );
  const latMin = Math.min(...lats, ...poles);
  const latMax = Math.max(...lats, ...poles);
  const arc = longitudeArc(samples.map((geo) => geo[0]));
  return poles.length > 0 || arc.lonSpan > 180
    ? { latMin, latMax, lonStart: -180, lonSpan: 360 }
    : { latMin, latMax, ...arc };
}

/** Whether two lat/lon boxes share any point; longitude arcs are periodic. */
export function extentsOverlap(a: TGeoExtent, b: TGeoExtent) {
  if (a.latMax < b.latMin || b.latMax < a.latMin) {
    return false;
  }
  const turn = (degrees: number) => ((degrees % 360) + 360) % 360;
  return (
    a.lonSpan >= 360 ||
    b.lonSpan >= 360 ||
    turn(b.lonStart - a.lonStart) <= a.lonSpan ||
    turn(a.lonStart - b.lonStart) <= b.lonSpan
  );
}

/** Index of the cell whose centre is nearest `value`, on either kind of axis. */
function nearestIndex(values: TAxis, value: number) {
  const count = values.length;
  const ascending = values[0] <= values[count - 1];
  let lo = 0;
  let hi = count - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ascending ? values[mid] < value : values[mid] > value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo > 0 &&
    Math.abs(values[lo - 1] - value) < Math.abs(values[lo] - value)
    ? lo - 1
    : lo;
}

/**
 * The index window of a projected level that covers a view footprint; null
 * when the level holds nothing of the view. Over `maxCells` the window is
 * shrunk around the point below the camera, so a pole or a horizon in view,
 * which project to most of the grid, still load what the budget allows.
 */
export function projectedWindow(
  axes: TProjectedAxes,
  footprint: TViewFootprint,
  options: TProjectedWindowOptions = {}
): TProjectedWindow | null {
  const { x, y, projection, extent } = axes;
  if (extent && !extentsOverlap(extent, footprint)) {
    return null;
  }
  const bounds = projectedBounds(footprint, projection.forward);
  if (!bounds) {
    return null;
  }
  const margin = options.margin ?? 0;
  const xMargin = (bounds.xMax - bounds.xMin) * margin;
  const yMargin = (bounds.yMax - bounds.yMin) * margin;
  const columns = axisRange(x, bounds.xMin - xMargin, bounds.xMax + xMargin);
  const rows = axisRange(y, bounds.yMin - yMargin, bounds.yMax + yMargin);
  if (!columns || !rows) {
    return null;
  }
  const cells = (columns.end - columns.start) * (rows.end - rows.start);
  if (options.maxCells === undefined || cells <= options.maxCells) {
    return { y: rows, x: columns };
  }
  const factor = Math.sqrt(options.maxCells / cells);
  const centre = tryProject(projection.forward, [
    footprint.centreLon,
    footprint.centreLat,
  ]);
  return {
    y: shrink(rows, factor, centre ? nearestIndex(y, centre[1]) : undefined),
    x: shrink(columns, factor, centre ? nearestIndex(x, centre[0]) : undefined),
  };
}

function contains(outer: TAxisRange, inner: TAxisRange) {
  return outer.start <= inner.start && inner.end <= outer.end;
}

/** Whether `loaded` holds every cell of `needed`. */
export function projectedWindowCovers(
  loaded: TProjectedWindow,
  needed: TProjectedWindow
) {
  return contains(loaded.y, needed.y) && contains(loaded.x, needed.x);
}
