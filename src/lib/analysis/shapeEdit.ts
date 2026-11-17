/**
 * Editing a plot's shape on the map: handles on a box's corners and edges,
 * on a polygon's or path's points (and between them, to add one), on a
 * point. Moving a handle gives the new shape; nothing is read until Apply.
 */
import { extentOf, frameWithCorner } from "./screenFrame.ts";
import { shapeIdentity } from "./shapeImport.ts";
import { boxLonSpan, toLatLon, toVec, type TLatLon } from "./sphere.ts";
import { GEOMETRY_KINDS, type TGeometry } from "./types.ts";

type TBoxGeometry = Extract<TGeometry, { kind: typeof GEOMETRY_KINDS.BOX }>;

export type THandle = TLatLon & {
  key: string;
  /** A corner or an edge of a box, a point, or a place to add one. */
  role: "corner" | "edge" | "vertex" | "insert";
  /** The vertex (or, for "insert", the vertex after which one is added). */
  index?: number;
  /** Which box sides the handle moves. */
  sides?: ("north" | "south" | "east" | "west")[];
  /** Read out to a screen reader and in the tooltip. */
  label: string;
};

const wrap = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;

/** The point halfway along the great circle from `a` to `b`. */
function midpoint(a: TLatLon, b: TLatLon): TLatLon {
  const [p, q] = [toVec(a.lat, a.lon), toVec(b.lat, b.lon)];
  const sum: [number, number, number] = [p[0] + q[0], p[1] + q[1], p[2] + q[2]];
  // Antipodes have no midpoint: take a's side.
  return Math.hypot(...sum) < 1e-9 ? a : toLatLon(sum);
}

/** Whether a shape can be edited by handles (a plain box, drawn lines). */
export function editable(geometry: TGeometry) {
  return (
    geometry.kind === GEOMETRY_KINDS.POINT ||
    geometry.kind === GEOMETRY_KINDS.POLYGON ||
    geometry.kind === GEOMETRY_KINDS.POLYLINE ||
    (geometry.kind === GEOMETRY_KINDS.BOX && boxLonSpan(geometry) < 360)
  );
}

/** A box's corners and the middles of its edges. */
function boxHandles(geometry: TBoxGeometry): THandle[] {
  const { west, east, south, north } = geometry;
  const mid = wrap(west + boxLonSpan(geometry) / 2);
  const middle = (south + north) / 2;
  type TSide = NonNullable<THandle["sides"]>[number];
  const at = (
    key: string,
    role: "corner" | "edge",
    [lat, lon]: [number, number],
    sides: TSide[],
    label: string
  ): THandle => ({ key, role, lat, lon, sides, label });
  return [
    at("nw", "corner", [north, west], ["north", "west"], "North-west corner"),
    at("ne", "corner", [north, east], ["north", "east"], "North-east corner"),
    at("se", "corner", [south, east], ["south", "east"], "South-east corner"),
    at("sw", "corner", [south, west], ["south", "west"], "South-west corner"),
    at("n", "edge", [north, mid], ["north"], "North edge"),
    at("e", "edge", [middle, east], ["east"], "East edge"),
    at("s", "edge", [south, mid], ["south"], "South edge"),
    at("w", "edge", [middle, west], ["west"], "West edge"),
  ];
}

/** The angle (degrees) a ring turns at `b`, between arcs a→b and b→c. */
function turnAt(a: TLatLon, b: TLatLon, c: TLatLon) {
  const [p, q, r] = [a, b, c].map((v) => toVec(v.lat, v.lon));
  const cross = (u: number[], v: number[]) => [
    u[1] * v[2] - u[2] * v[1],
    u[2] * v[0] - u[0] * v[2],
    u[0] * v[1] - u[1] * v[0],
  ];
  const [m, k] = [cross(p, q), cross(q, r)];
  const dot = m[0] * k[0] + m[1] * k[1] + m[2] * k[2];
  const size = Math.hypot(...m) * Math.hypot(...k);
  return size
    ? (Math.acos(Math.max(-1, Math.min(1, dot / size))) * 180) / Math.PI
    : 0;
}

type TShapeGeometry = Extract<TGeometry, { kind: typeof GEOMETRY_KINDS.SHAPE }>;

/** A rectangle drawn on the map, one ring, no pole inside: editable. */
function tracedBox(geometry: TGeometry): geometry is TShapeGeometry {
  return (
    geometry.kind === GEOMETRY_KINDS.SHAPE &&
    !!geometry.drawn &&
    !geometry.poles?.north &&
    !geometry.poles?.south &&
    geometry.polygons.length === 1 &&
    geometry.polygons[0].length === 1 &&
    geometry.polygons[0][0].length >= 4
  );
}

/** The trace's points (the ring without its closing point). */
const tracePoints = (geometry: TShapeGeometry) =>
  geometry.polygons[0][0].slice(0, -1).map(([lon, lat]) => ({ lat, lon }));

/** Where the trace turns: its corners (ring indices), in ring order. */
function traceCorners(points: TLatLon[]) {
  const n = points.length;
  return points.flatMap((point, at) =>
    turnAt(points[(at - 1 + n) % n], point, points[(at + 1) % n]) > 12
      ? [at]
      : []
  );
}

/**
 * The shape as it is edited by handles: itself (a drawn rectangle keeps
 * its traced sides, handles at its corners), or undefined (a country, an
 * imported shape, a drawn box round a pole).
 */
export function editableForm(geometry: TGeometry): TGeometry | undefined {
  if (editable(geometry)) {
    return geometry;
  }
  return tracedBox(geometry) && traceCorners(tracePoints(geometry)).length >= 3
    ? geometry
    : undefined;
}

/**
 * A drawn rectangle with corner `k` moved to `to`: only the two sides that meet
 * there change, each point shifted by the corner's move times its share of the
 * way along the side; the other sides stay as traced.
 */
// eslint-disable-next-line max-lines-per-function
function moveTracedCorner(
  geometry: TShapeGeometry,
  k: number,
  to: TLatLon
): TGeometry {
  const points = tracePoints(geometry);
  const start = points[k];
  const n = points.length;
  const corners = [...new Set([...traceCorners(points), k])].sort(
    (a, b) => a - b
  );
  const at = corners.indexOf(k);
  const before = corners[(at - 1 + corners.length) % corners.length];
  const after = corners[(at + 1) % corners.length];
  const dLat = to.lat - points[k].lat;
  const dLon = ((((to.lon - points[k].lon + 180) % 360) + 360) % 360) - 180;
  const shift = (index: number, t: number) => {
    const p = points[index];
    points[index] = {
      lat: Math.max(-90, Math.min(90, p.lat + t * dLat)),
      lon: p.lon + t * dLon,
    };
  };
  const steps = (from: number, until: number) => (until - from + n) % n || n;
  const toK = steps(before, k);
  for (let s = 1; s < toK; s++) {
    shift((before + s) % n, s / toK);
  }
  const fromK = steps(k, after);
  for (let s = 1; s < fromK; s++) {
    shift((k + s) % n, 1 - s / fromK);
  }
  points[k] = {
    lat: Math.max(-90, Math.min(90, to.lat)),
    lon: points[k].lon + dLon,
  };
  const ring = [...points, points[0]].map((p) => [p.lon, p.lat]);
  const polygons = [[ring]];
  // The drawing view's rectangle with that corner moved: the two sides that
  // meet there move, the others stay the frame's exactly. Where the corner does
  // not show in that view, the shape is decided by its own rings. Decided by
  // that quadrilateral wherever it and the moved trace could differ, within the
  // shape's extent of its outline.
  const { frame: old, ...edited } = geometry;
  const moved = old && frameWithCorner(old, start, to);
  const frame = moved && {
    ...moved,
    band: Math.max(moved.band, extentOf(points)),
  };
  return {
    ...edited,
    polygons,
    edited: true,
    ...(frame ? { frame } : {}),
    digest: shapeIdentity(polygons, geometry.poles, frame),
  };
}

/** A drawn rectangle's handles: its corners (moved, never deleted). */
function tracedHandles(geometry: TShapeGeometry): THandle[] {
  const points = tracePoints(geometry);
  return traceCorners(points).map((index, c) => ({
    key: `c${index}`,
    role: "corner",
    index,
    ...points[index],
    label: `Corner ${c + 1}`,
  }));
}

/** The handles of a shape, in drawing order. */
export function editHandles(geometry: TGeometry): THandle[] {
  if (geometry.kind === GEOMETRY_KINDS.POINT) {
    return [
      {
        key: "p",
        role: "vertex",
        lat: geometry.lat,
        lon: geometry.lon,
        label: "The point",
      },
    ];
  }
  if (geometry.kind === GEOMETRY_KINDS.BOX) {
    return boxHandles(geometry);
  }
  if (tracedBox(geometry)) {
    return tracedHandles(geometry);
  }
  if (
    geometry.kind !== GEOMETRY_KINDS.POLYGON &&
    geometry.kind !== GEOMETRY_KINDS.POLYLINE
  ) {
    return [];
  }
  const points = geometry.vertices;
  const closed = geometry.kind === GEOMETRY_KINDS.POLYGON;
  const handles: THandle[] = points.map((p, index) => ({
    key: `v${index}`,
    role: "vertex",
    index,
    lat: p.lat,
    lon: p.lon,
    label: `Point ${index + 1}`,
  }));
  const gaps = closed ? points.length : points.length - 1;
  for (let index = 0; index < gaps; index++) {
    const m = midpoint(points[index], points[(index + 1) % points.length]);
    handles.push({
      key: `i${index}`,
      role: "insert",
      index,
      ...m,
      label: `Add a point between ${index + 1} and ${((index + 1) % points.length) + 1}`,
    });
  }
  return handles;
}

/**
 * A box's side dragged from where it was when the drag began: `start` is the
 * box then, `lat` the pointer's latitude and `lon` its longitude followed
 * continuously from the dragged side (no wrap). Each update is computed from
 * `start`, never from the last draft, so one or a hundred pointer moves give
 * the same box; past the fixed side the two swap, in latitude and in longitude.
 */
export function dragBox(
  start: TBoxGeometry,
  sides: NonNullable<THandle["sides"]>,
  lat: number,
  lon: number
): TBoxGeometry {
  const box = { ...start };
  const y = Math.max(-90, Math.min(90, lat));
  // Its eastward extent in one frame: the west edge, then east beyond it.
  let [west, east] = [start.west, start.west + eastwardSpan(start)];
  let [south, north] = [start.south, start.north];
  if (sides.includes("north")) {
    north = y;
  }
  if (sides.includes("south")) {
    south = y;
  }
  if (sides.includes("east")) {
    east = lon;
  }
  if (sides.includes("west")) {
    west = lon;
  }
  box.north = Math.max(north, south);
  box.south = Math.min(north, south);
  if (west > east) {
    [west, east] = [east, west];
  }
  // At most once round: a whole turn is the widest box.
  if (east - west >= 360) {
    [box.west, box.east] = [-180, 180];
    return box;
  }
  box.west = wrap(west);
  box.east = wrap(east);
  return box;
}

/** A box's eastward width in degrees, (0, 360]. */
function eastwardSpan(box: TBoxGeometry) {
  const span = (((box.east - box.west) % 360) + 360) % 360;
  return span === 0 && box.east !== box.west ? 360 : span;
}

/**
 * Where a dragged side starts in dragBox's frame: the west edge as it is,
 * the east edge beyond it.
 */
export function dragStartLon(start: TBoxGeometry, handle: THandle) {
  return handle.sides?.includes("east") && !handle.sides.includes("west")
    ? start.west + eastwardSpan(start)
    : start.west;
}

/** The next longitude of a pointer followed without wrapping. */
export function followLon(previous: number, lon: number) {
  const step = ((((lon - previous + 180) % 360) + 360) % 360) - 180;
  return previous + step;
}

/** Screen pixels between the map positions a pointer move is followed at. */
const FOLLOW_PX = 8;

/**
 * The longitude a pointer reaches moving on screen from `from` to `to`,
 * followed along its path a few pixels at a time (`pick` the map position under
 * a screen point): a move of more than half a turn between two events keeps its
 * direction.
 */
export function followPointer(
  previous: number,
  from: { x: number; y: number },
  to: { x: number; y: number },
  pick: (x: number, y: number) => TLatLon | undefined
) {
  const steps = Math.max(
    1,
    Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / FOLLOW_PX)
  );
  let lon = previous;
  for (let k = 1; k <= steps; k++) {
    const at = pick(
      from.x + ((to.x - from.x) * k) / steps,
      from.y + ((to.y - from.y) * k) / steps
    );
    if (at) {
      lon = followLon(lon, at.lon);
    }
  }
  return lon;
}

/** The shape with `handle` moved to `to` (an insert handle adds a point). */
export function moveHandle(
  geometry: TGeometry,
  handle: THandle,
  to: TLatLon
): TGeometry {
  const lat = Math.max(-90, Math.min(90, to.lat));
  const lon = wrap(to.lon);
  if (geometry.kind === GEOMETRY_KINDS.POINT) {
    return { ...geometry, lat, lon };
  }
  if (tracedBox(geometry) && handle.index !== undefined) {
    return moveTracedCorner(geometry, handle.index, { lat, lon });
  }
  if (geometry.kind === GEOMETRY_KINDS.BOX) {
    const box = { ...geometry };
    for (const side of handle.sides ?? []) {
      if (side === "north" || side === "south") {
        box[side] = lat;
      } else {
        box[side] = lon;
      }
    }
    // Dragged past the opposite edge: the edges swap, the box stays a box.
    if (box.north < box.south) {
      [box.north, box.south] = [box.south, box.north];
    }
    return box;
  }
  if (
    (geometry.kind === GEOMETRY_KINDS.POLYGON ||
      geometry.kind === GEOMETRY_KINDS.POLYLINE) &&
    handle.index !== undefined
  ) {
    const vertices = [...geometry.vertices];
    if (handle.role === "insert") {
      vertices.splice(handle.index + 1, 0, { lat, lon });
    } else {
      vertices[handle.index] = { lat, lon };
    }
    return { ...geometry, vertices };
  }
  return geometry;
}

/** The handle that an insert became once its point was added. */
export function insertedHandle(handle: THandle): THandle {
  return handle.role === "insert" && handle.index !== undefined
    ? {
        ...handle,
        key: `v${handle.index + 1}`,
        role: "vertex",
        index: handle.index + 1,
        label: `Point ${handle.index + 2}`,
      }
    : handle;
}

/**
 * The shape without point `index`, or undefined when it would be too few
 * (an area keeps three points, a path two).
 */
export function removeVertex(geometry: TGeometry, index: number) {
  if (
    geometry.kind !== GEOMETRY_KINDS.POLYGON &&
    geometry.kind !== GEOMETRY_KINDS.POLYLINE
  ) {
    return undefined;
  }
  const least = geometry.kind === GEOMETRY_KINDS.POLYGON ? 3 : 2;
  if (geometry.vertices.length <= least) {
    return undefined;
  }
  return {
    ...geometry,
    vertices: geometry.vertices.filter((_, at) => at !== index),
  };
}

/**
 * A box side moved by keys, as a pointer drags it (dragBox): from the box as it
 * was at the first press, the side followed without wrapping, so a press past
 * the opposite side swaps them and later presses go on.
 */
export type TKeyDrag = {
  sides: string;
  start: TBoxGeometry;
  lat: number;
  lon: number;
};

export function keyedBox(
  drag: TKeyDrag | undefined,
  box: TBoxGeometry,
  handle: THandle,
  north: number,
  east: number
): { drag: TKeyDrag; box: TBoxGeometry } {
  const sides = handle.sides ?? [];
  const next: TKeyDrag =
    drag?.sides === sides.join()
      ? { ...drag }
      : {
          sides: sides.join(),
          start: box,
          lat: handle.lat,
          lon: dragStartLon(box, handle),
        };
  next.lat = Math.max(-90, Math.min(90, next.lat + north));
  next.lon += east;
  return { drag: next, box: dragBox(next.start, sides, next.lat, next.lon) };
}

/** A handle nudged by the arrow keys: `step` degrees north or east. */
export function nudged(handle: THandle, north: number, east: number): TLatLon {
  return { lat: handle.lat + north, lon: handle.lon + east };
}
