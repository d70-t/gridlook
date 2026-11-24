import {
  angleBetween,
  DRAWING_SPHERE_RADIUS_METERS,
  interpolateArc,
  toLatLon,
  toVec,
  type TLatLon,
} from "@/lib/analysis/sphere.ts";
import { tornBetween } from "@/ui/analysis/outlinePaths.ts";

/**
 * Contiguous cell edges (n + 1) from CF bounds ([low, high] per cell), or
 * undefined when the layers do not join (then midpoints stand in).
 */
export function edgesFromBounds(bounds: number[] | undefined, n: number) {
  if (!bounds || bounds.length !== 2 * n || n === 0) {
    return undefined;
  }
  const lo = (k: number) => Math.min(bounds[2 * k], bounds[2 * k + 1]);
  const hi = (k: number) => Math.max(bounds[2 * k], bounds[2 * k + 1]);
  const near = (a: number, b: number) =>
    Math.abs(a - b) <= 1e-9 * Math.max(1, Math.abs(a));
  // Levels ascending (each layer starts at the previous top) or descending.
  const ascending = n === 1 || near(lo(1), hi(0));
  const edges = [ascending ? lo(0) : hi(0)];
  for (let k = 0; k < n; k++) {
    const [start, end] = ascending ? [lo(k), hi(k)] : [hi(k), lo(k)];
    if (!near(start, edges[k])) {
      return undefined;
    }
    edges.push(end);
  }
  return edges;
}

/**
 * Each layer's own [low, high] from CF bounds (2n values), joined or not:
 * a gap between independently bounded layers stays a gap.
 */
/**
 * A curtain's column edges: halfway between samples along the path, or along
 * their latitudes (offered only when they do not turn), each end at its sample.
 */
export function curtainEdges(
  samples: { distances: number[]; lats: number[] },
  n: number,
  byLatitude: boolean
) {
  const along = byLatitude ? samples.lats : samples.distances;
  const out = new Array<number>(n + 1);
  for (let at = 1; at < n; at++) {
    out[at] = (along[at - 1] + along[at]) / 2;
  }
  out[0] = along[0];
  out[n] = along[n - 1];
  return out;
}

export function layerSpans(bounds: number[] | undefined, n: number) {
  if (!bounds || bounds.length !== 2 * n || n === 0) {
    return undefined;
  }
  // Each layer on its own: one damaged pair leaves that layer unknown (not
  // drawn), not every layer on midpoints.
  const spans = new Float64Array(2 * n);
  let known = 0;
  for (let k = 0; k < n; k++) {
    const [a, b] = [bounds[2 * k], bounds[2 * k + 1]];
    const usable = Number.isFinite(a) && Number.isFinite(b) && a !== b;
    spans[2 * k] = usable ? Math.min(a, b) : Number.NaN;
    spans[2 * k + 1] = usable ? Math.max(a, b) : Number.NaN;
    known += usable ? 1 : 0;
  }
  return known ? spans : undefined;
}

/** Distance (m) of each path point from the first, along great circles. */
export function vertexDistances(vertices: TLatLon[]) {
  const out = [0];
  for (let at = 1; at < vertices.length; at++) {
    const a = toVec(vertices[at - 1].lat, vertices[at - 1].lon);
    const b = toVec(vertices[at].lat, vertices[at].lon);
    out.push(out[at - 1] + angleBetween(a, b) * DRAWING_SPHERE_RADIUS_METERS);
  }
  return out;
}

/** The place `meters` along a path (clamped to its ends). */
export function pointAlongPath(
  vertices: TLatLon[],
  meters: number
): TLatLon | undefined {
  if (!vertices.length || !Number.isFinite(meters)) {
    return undefined;
  }
  const marks = vertexDistances(vertices);
  if (meters <= 0 || vertices.length === 1) {
    return vertices[0];
  }
  for (let at = 1; at < vertices.length; at++) {
    if (meters <= marks[at]) {
      const leg = marks[at] - marks[at - 1];
      const f = leg > 0 ? (meters - marks[at - 1]) / leg : 0;
      return toLatLon(
        interpolateArc(
          toVec(vertices[at - 1].lat, vertices[at - 1].lon),
          toVec(vertices[at].lat, vertices[at].lon),
          f
        )
      );
    }
  }
  return vertices[vertices.length - 1];
}

/** Numbered path points on a chart's distance axis (`scale`: m → axis). */
export function axisMarks(vertices: TLatLon[] | undefined, scale = 1) {
  return (vertices ?? []).length > 1
    ? vertexDistances(vertices!).map((d, at) => ({
        value: d * scale,
        label: String(at + 1),
      }))
    : [];
}

export type TAxisMark = { value: number; label: string };

/**
 * Draw numbered badges for path points on a horizontal axis at `y`: the
 * same numbers as on the map, so a bend in the chart can be found there.
 */
export function drawAxisMarks(
  context: CanvasRenderingContext2D,
  marks: TAxisMark[],
  xOf: (value: number) => number,
  y: number,
  colors: { fill: string; text: string; ring: string },
  range: [number, number]
) {
  if (marks.length < 2) {
    return;
  }
  context.save();
  context.font = "600 10px sans-serif";
  context.textAlign = "center";
  context.textBaseline = "middle";
  let lastX = Number.NEGATIVE_INFINITY;
  for (const mark of marks) {
    const x = xOf(mark.value);
    // Badges never overlap: a crowded point is skipped, the last one kept.
    const last = mark === marks[marks.length - 1];
    if (x < range[0] - 1 || x > range[1] + 1 || (x - lastX < 16 && !last)) {
      continue;
    }
    context.fillStyle = colors.fill;
    context.strokeStyle = colors.ring;
    context.lineWidth = 1.5;
    context.beginPath();
    context.arc(x, y, 7, 0, 2 * Math.PI);
    context.fill();
    context.stroke();
    context.fillStyle = colors.text;
    context.fillText(mark.label, x, y + 0.5);
    lastX = x;
  }
  context.restore();
}

type TXY = { x: number; y: number };

/** The place on a screen segment nearest `at`: its fraction and gap. */
function nearestOnSegment(from: TXY, to: TXY, at: TXY) {
  const [dx, dy] = [to.x - from.x, to.y - from.y];
  const length2 = dx * dx + dy * dy;
  const t = length2
    ? Math.max(
        0,
        Math.min(1, ((at.x - from.x) * dx + (at.y - from.y) * dy) / length2)
      )
    : 0;
  return { t, gap: Math.hypot(from.x + t * dx - at.x, from.y + t * dy - at.y) };
}

/** A route on screen: its segments (distances in m) and their extents. */
export type TScreenRoute = {
  segments: { from: TXY; to: TXY; m0: number; m1: number }[];
  /** Per leg: its segments' range and screen box; the whole route's box. */
  legs: { first: number; last: number; box: TBox }[];
  box: TBox;
};
type TBox = { left: number; top: number; right: number; bottom: number };

const EMPTY_BOX: TBox = {
  left: Infinity,
  top: Infinity,
  right: -Infinity,
  bottom: -Infinity,
};
function grow(box: TBox, p: TXY): TBox {
  return {
    left: Math.min(box.left, p.x),
    top: Math.min(box.top, p.y),
    right: Math.max(box.right, p.x),
    bottom: Math.max(box.bottom, p.y),
  };
}
const near = (box: TBox, at: TXY, pixels: number) =>
  at.x >= box.left - pixels &&
  at.x <= box.right + pixels &&
  at.y >= box.top - pixels &&
  at.y <= box.bottom + pixels;

/**
 * A path as drawn on screen, projected once for a view: followed in steps
 * of at most 1/64 of each leg, along great circles. A step torn by a flat
 * map's seam is no segment on screen (it is not drawn either:
 * outlinePaths), so a route across ±180° does not answer a hover at
 * Greenwich.
 */
export function screenRoute(
  vertices: TLatLon[],
  project: (p: TLatLon) => { x: number; y: number } | undefined
): TScreenRoute {
  const marks = vertexDistances(vertices);
  const segments: TScreenRoute["segments"] = [];
  const legs: TScreenRoute["legs"] = [];
  let box = EMPTY_BOX;
  const steps = 64;
  const onScreen = (lat: number, lon: number) => {
    const q = project({ lat, lon });
    return q ? { ...q, visible: true } : null;
  };
  for (let leg = 1; leg < vertices.length; leg++) {
    const a = toVec(vertices[leg - 1].lat, vertices[leg - 1].lon);
    const b = toVec(vertices[leg].lat, vertices[leg].lon);
    const [leg0, span] = [marks[leg - 1], marks[leg] - marks[leg - 1]];
    let place: TLatLon = vertices[leg - 1];
    let previous = project(place);
    const first = segments.length;
    let legBox = EMPTY_BOX;
    for (let k = 1; k <= steps; k++) {
      const here = toLatLon(interpolateArc(a, b, k / steps));
      const point = project(here);
      const torn =
        previous &&
        point &&
        tornBetween(onScreen, place, here, [previous, point]);
      if (previous && point && !torn) {
        segments.push({
          from: previous,
          to: point,
          m0: leg0 + ((k - 1) / steps) * span,
          m1: leg0 + (k / steps) * span,
        });
        legBox = grow(grow(legBox, previous), point);
      }
      previous = point;
      place = here;
    }
    legs.push({ first, last: segments.length, box: legBox });
    box = grow(grow(box, { x: legBox.left, y: legBox.top }), {
      x: legBox.right,
      y: legBox.bottom,
    });
  }
  return { segments, legs, box };
}

/**
 * The distance (m) along a route of the place nearest a screen point,
 * when the route passes within `pixels` of it there (two-way cursor: the
 * map's pointer on a cross-section's route is marked on its chart). Legs
 * whose screen box is farther are passed over without a look.
 */
export function routeDistanceNear(
  route: TScreenRoute,
  at: { x: number; y: number },
  pixels = 10
) {
  if (!near(route.box, at, pixels)) {
    return undefined;
  }
  let best: { gap: number; meters: number } | undefined;
  for (const leg of route.legs) {
    if (!near(leg.box, at, pixels)) {
      continue;
    }
    for (let s = leg.first; s < leg.last; s++) {
      const { from, to, m0, m1 } = route.segments[s];
      const { t, gap } = nearestOnSegment(from, to, at);
      if (gap <= pixels && (!best || gap < best.gap)) {
        best = { gap, meters: m0 + t * (m1 - m0) };
      }
    }
  }
  return best?.meters;
}

/** The same, projecting the path for this one question. */
export function distanceNear(
  vertices: TLatLon[],
  project: (p: TLatLon) => { x: number; y: number } | undefined,
  at: { x: number; y: number },
  pixels = 10
) {
  return routeDistanceNear(screenRoute(vertices, project), at, pixels);
}
