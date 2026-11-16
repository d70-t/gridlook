/**
 * Geometry on Gridlook's drawing sphere. UI coordinates are geodetic
 * longitude and latitude in degrees; drawn edges are great-circle arcs and
 * distances use the spherical Earth documented in docs/Controls.md.
 */

// Same value as EARTH_RADIUS_METERS of the camera (IUGG mean radius).
export const DRAWING_SPHERE_RADIUS_METERS = 6_371_008.8;

export type TVec3 = [number, number, number];
export type TLatLon = { lat: number; lon: number };

const DEG = Math.PI / 180;

function normalizeLon(lon: number) {
  const wrapped = (((lon + 180) % 360) + 360) % 360;
  return wrapped - 180;
}

export function toVec(lat: number, lon: number): TVec3 {
  const phi = lat * DEG;
  const lambda = lon * DEG;
  const c = Math.cos(phi);
  return [c * Math.cos(lambda), c * Math.sin(lambda), Math.sin(phi)];
}

export function toLatLon(v: TVec3): TLatLon {
  const r = Math.hypot(v[0], v[1], v[2]);
  return {
    lat: Math.asin(Math.max(-1, Math.min(1, v[2] / r))) / DEG,
    lon: Math.atan2(v[1], v[0]) / DEG,
  };
}

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

function norm(v: TVec3) {
  return Math.hypot(v[0], v[1], v[2]);
}

/** Central angle in radians, accurate for tiny and near-antipodal angles. */
export function angleBetween(a: TVec3, b: TVec3) {
  return Math.atan2(norm(cross(a, b)), dot(a, b));
}

function distanceMeters(a: TLatLon, b: TLatLon) {
  return (
    angleBetween(toVec(a.lat, a.lon), toVec(b.lat, b.lon)) *
    DRAWING_SPHERE_RADIUS_METERS
  );
}

/** Angular distance from `p` to the minor great-circle arc `a`–`b`. */
function angleToArc(p: TVec3, a: TVec3, b: TVec3) {
  const n = cross(a, b);
  const length = norm(n);
  if (length < 1e-15) {
    return angleBetween(p, a);
  }
  const unit: TVec3 = [n[0] / length, n[1] / length, n[2] / length];
  const off = dot(p, unit);
  const foot: TVec3 = [
    p[0] - off * unit[0],
    p[1] - off * unit[1],
    p[2] - off * unit[2],
  ];
  // The foot lies on the arc when it is on the inner side of both ends.
  const onArc =
    norm(foot) > 1e-15 &&
    dot(cross(a, foot), n) >= 0 &&
    dot(cross(foot, b), n) >= 0;
  if (onArc) {
    return Math.abs(Math.asin(Math.max(-1, Math.min(1, off))));
  }
  const toA = angleBetween(p, a);
  const toB = angleBetween(p, b);
  return toA < toB ? toA : toB;
}

/** Points along the great-circle arc `a`–`b` at fractions in `[0, 1]`. */
export function interpolateArc(a: TVec3, b: TVec3, fraction: number): TVec3 {
  const omega = angleBetween(a, b);
  if (omega < 1e-15) {
    return a;
  }
  const s = Math.sin(omega);
  const wa = Math.sin((1 - fraction) * omega) / s;
  const wb = Math.sin(fraction * omega) / s;
  return [wa * a[0] + wb * b[0], wa * a[1] + wb * b[1], wa * a[2] + wb * b[2]];
}

export type TPathSample = TLatLon & { distance: number; segment: number };

/**
 * Samples a polyline at a fixed spacing along its great-circle segments.
 * The first sample is the first vertex; each segment's end vertex is
 * included, so distances are cumulative and exact at every vertex.
 */
export function samplePolyline(
  vertices: TLatLon[],
  spacingMeters: number,
  maxSamples: number
): TPathSample[] {
  if (vertices.length < 2) {
    throw new Error("A cross-section needs at least two vertices.");
  }
  if (!(spacingMeters > 0)) {
    throw new Error("The section sample spacing must be positive.");
  }
  const samples: TPathSample[] = [{ ...vertices[0], distance: 0, segment: 0 }];
  let travelled = 0;
  for (let segment = 0; segment + 1 < vertices.length; segment++) {
    const a = toVec(vertices[segment].lat, vertices[segment].lon);
    const b = toVec(vertices[segment + 1].lat, vertices[segment + 1].lon);
    const length = angleBetween(a, b) * DRAWING_SPHERE_RADIUS_METERS;
    const steps = Math.max(1, Math.ceil(length / spacingMeters - 1e-9));
    if (samples.length + steps > maxSamples) {
      throw new Error(
        `The section needs more than ${maxSamples} samples at ${Math.round(spacingMeters)} m spacing; increase the spacing.`
      );
    }
    for (let step = 1; step <= steps; step++) {
      const fraction = step / steps;
      const point =
        step === steps
          ? vertices[segment + 1]
          : toLatLon(interpolateArc(a, b, fraction));
      samples.push({
        lat: point.lat,
        lon: normalizeLon(point.lon),
        distance: travelled + length * fraction,
        segment,
      });
    }
    travelled += length;
  }
  return samples;
}

/**
 * Validate a drawn path: finite coordinates, valid latitudes, consecutive
 * repeats collapsed (revisits kept), at least two distinct vertices, a real
 * length, and no leg between antipodes (its great circle is ambiguous).
 */
export function preparePath(vertices: TLatLon[]): TLatLon[] {
  for (const v of vertices) {
    if (!Number.isFinite(v.lat) || !Number.isFinite(v.lon)) {
      throw new Error("Path coordinates must be finite numbers.");
    }
    if (Math.abs(v.lat) > 90) {
      throw new Error(`Latitude ${v.lat} is outside -90..90.`);
    }
  }
  const path = vertices.filter(
    (v, at) => at === 0 || distanceMeters(v, vertices[at - 1]) > 1e-6
  );
  if (path.length < 2) {
    throw new Error("A cross-section needs two distinct points.");
  }
  for (let at = 1; at < path.length; at++) {
    const angle = angleBetween(
      toVec(path[at - 1].lat, path[at - 1].lon),
      toVec(path[at].lat, path[at].lon)
    );
    if (angle > Math.PI - 1e-9) {
      throw new Error(
        `Points ${at} and ${at + 1} are opposite each other on the globe; add a point between them to choose the way round.`
      );
    }
  }
  return path;
}

export function polylineLengthMeters(vertices: TLatLon[]) {
  let total = 0;
  for (let at = 1; at < vertices.length; at++) {
    total += distanceMeters(vertices[at - 1], vertices[at]);
  }
  return total;
}

/** A lat/lon box from `west` eastward to `east`; `east < west` crosses 180°. */
export type TBox = { west: number; east: number; south: number; north: number };

/** Degrees east of `from`, in [0, 360), without rounding tiny spans up. */
function lonOffsetEast(from: number, to: number) {
  const d = (to - from) % 360;
  if (d >= 0) {
    return d;
  }
  const up = d + 360;
  return up >= 360 ? 0 : up;
}

export function boxLonSpan(box: TBox) {
  const span = lonOffsetEast(box.west, box.east);
  return span === 0 && box.east !== box.west ? 360 : span;
}

export function validateBox(box: TBox) {
  for (const value of [box.west, box.east, box.south, box.north]) {
    if (!Number.isFinite(value)) {
      throw new Error("Box coordinates must be finite numbers.");
    }
  }
  if (box.south < -90 || box.north > 90 || box.south >= box.north) {
    throw new Error("A box needs south < north within -90..90.");
  }
  if (boxLonSpan(box) === 0) {
    throw new Error("A box needs distinct west and east longitudes.");
  }
}

export function boxContains(box: TBox, lat: number, lon: number) {
  if (lat < box.south || lat > box.north) {
    return false;
  }
  return lonOffsetEast(box.west, lon) <= boxLonSpan(box);
}

/** Angular distance from `lon` to the box's longitude interval, in degrees. */
function lonGapToBox(box: TBox, lon: number) {
  const span = boxLonSpan(box);
  const offset = lonOffsetEast(box.west, lon);
  if (offset <= span) {
    return 0;
  }
  const pastEast = offset - span;
  const beforeWest = 360 - offset;
  return pastEast < beforeWest ? pastEast : beforeWest;
}

export const CAP_RELATION = {
  OUTSIDE: 0,
  INSIDE: 1,
  UNCERTAIN: 2,
} as const;

export type TCapRelation = (typeof CAP_RELATION)[keyof typeof CAP_RELATION];

/**
 * Conservative relation of a spherical cap (centre, angular radius in
 * radians) to a box: OUTSIDE and INSIDE are certain, anything else is
 * UNCERTAIN.
 */
export function capBoxRelation(
  box: TBox,
  lat: number,
  lon: number,
  radius: number
): TCapRelation {
  const r = radius / DEG;
  if (lat - r > box.north || lat + r < box.south) {
    return CAP_RELATION.OUTSIDE;
  }
  const touchesPole = Math.abs(lat) + r >= 90;
  // Longitudinal half-width of the cap, as seen from its centre's latitude.
  const sinRatio = Math.sin(radius) / Math.cos(lat * DEG);
  const halfWidth =
    touchesPole || sinRatio >= 1 ? 180 : Math.asin(sinRatio) / DEG;
  const gap = lonGapToBox(box, lon);
  if (!touchesPole && gap > halfWidth) {
    return CAP_RELATION.OUTSIDE;
  }
  const span = boxLonSpan(box);
  const offset = lonOffsetEast(box.west, lon);
  const insideLon =
    span >= 360 ||
    (!touchesPole && offset - halfWidth >= 0 && offset + halfWidth <= span);
  if (lat - r >= box.south && lat + r <= box.north && insideLon) {
    return CAP_RELATION.INSIDE;
  }
  return CAP_RELATION.UNCERTAIN;
}

/** A simple geodesic polygon prepared for repeated containment tests. */
export type TPreparedPolygon = {
  vertices: TVec3[];
  centre: TVec3;
  // gnomonic coordinates of the vertices on the tangent plane at `centre`
  planar: [number, number][];
  basis: [TVec3, TVec3];
};

function gnomonic(
  p: TVec3,
  centre: TVec3,
  basis: [TVec3, TVec3]
): [number, number] | null {
  const d = dot(p, centre);
  if (d <= 1e-12) {
    return null;
  }
  return [dot(p, basis[0]) / d, dot(p, basis[1]) / d];
}

function segmentsCross(
  a: [number, number],
  b: [number, number],
  c: [number, number],
  d: [number, number]
) {
  const orient = (
    p: [number, number],
    q: [number, number],
    r: [number, number]
  ) => (q[0] - p[0]) * (r[1] - p[1]) - (q[1] - p[1]) * (r[0] - p[0]);
  const o1 = orient(a, b, c);
  const o2 = orient(a, b, d);
  const o3 = orient(c, d, a);
  const o4 = orient(c, d, b);
  return o1 * o2 < 0 && o3 * o4 < 0;
}

/**
 * Validates and prepares a polygon. It must be simple and fit inside the
 * open hemisphere around its vertex mean; geodesic edges are then straight
 * lines in the gnomonic projection on that mean, which makes containment
 * exact and orientation-free.
 */
// eslint-disable-next-line max-lines-per-function
export function preparePolygon(vertices: TLatLon[]): TPreparedPolygon {
  const unique = vertices.filter(
    (v, at) =>
      at === 0 ||
      v.lat !== vertices[at - 1].lat ||
      normalizeLon(v.lon) !== normalizeLon(vertices[at - 1].lon)
  );
  if (
    unique.length > 1 &&
    unique[0].lat === unique[unique.length - 1].lat &&
    normalizeLon(unique[0].lon) === normalizeLon(unique[unique.length - 1].lon)
  ) {
    unique.pop();
  }
  if (unique.length < 3) {
    throw new Error("A polygon needs at least three distinct vertices.");
  }
  const vecs = unique.map((v) => toVec(v.lat, v.lon));
  const sum: TVec3 = [0, 0, 0];
  for (const v of vecs) {
    sum[0] += v[0];
    sum[1] += v[1];
    sum[2] += v[2];
  }
  const length = norm(sum);
  if (length < 1e-9) {
    throw new Error(
      "The polygon is too large: it must fit inside a hemisphere."
    );
  }
  const centre: TVec3 = [sum[0] / length, sum[1] / length, sum[2] / length];
  // Edges are minor arcs, so a hemisphere holding all vertices holds them too.
  for (const v of vecs) {
    if (dot(v, centre) <= 1e-6) {
      throw new Error(
        "The polygon is too large: it must fit inside a hemisphere."
      );
    }
  }
  const helper: TVec3 = Math.abs(centre[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const e1 = cross(helper, centre);
  const e1n = norm(e1);
  const basisX: TVec3 = [e1[0] / e1n, e1[1] / e1n, e1[2] / e1n];
  const basisY = cross(centre, basisX);
  const basis: [TVec3, TVec3] = [basisX, basisY];
  const planar = vecs.map((v) => gnomonic(v, centre, basis)!);
  const n = planar.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      const adjacent = j === i + 1 || (i === 0 && j === n - 1);
      if (
        !adjacent &&
        segmentsCross(
          planar[i],
          planar[(i + 1) % n],
          planar[j],
          planar[(j + 1) % n]
        )
      ) {
        throw new Error(
          `Polygon edges ${i + 1} and ${j + 1} cross; edit the vertices so the outline does not intersect itself.`
        );
      }
    }
  }
  return { vertices: vecs, centre, planar, basis };
}

/**
 * Conservative latitude/longitude extent of a prepared polygon, from the
 * smallest cap about its centre that holds every vertex: the cap is convex
 * (radius below 90 degrees), so it holds the edges and the interior too.
 * `lonHalfWidth` is 180 when the cap reaches a pole.
 */
export function polygonExtent(polygon: TPreparedPolygon) {
  let radius = 0;
  for (const v of polygon.vertices) {
    radius = Math.max(radius, angleBetween(polygon.centre, v));
  }
  const pad = 1e-9;
  const r = radius / DEG + pad;
  const centre = toLatLon(polygon.centre);
  const touchesPole = Math.abs(centre.lat) + r >= 90;
  const ratio = Math.sin(radius) / Math.cos(centre.lat * DEG);
  return {
    south: Math.max(-90, centre.lat - r),
    north: Math.min(90, centre.lat + r),
    lonCentre: centre.lon,
    lonHalfWidth:
      touchesPole || ratio >= 1 ? 180 : Math.asin(ratio) / DEG + pad,
  };
}

function polygonContainsVec(polygon: TPreparedPolygon, p: TVec3) {
  const q = gnomonic(p, polygon.centre, polygon.basis);
  if (!q) {
    return false;
  }
  const { planar } = polygon;
  let inside = false;
  for (let i = 0, j = planar.length - 1; i < planar.length; j = i++) {
    const [xi, yi] = planar[i];
    const [xj, yj] = planar[j];
    if (
      yi > q[1] !== yj > q[1] &&
      q[0] < ((xj - xi) * (q[1] - yi)) / (yj - yi) + xi
    ) {
      inside = !inside;
    }
  }
  return inside;
}

export function polygonContains(
  polygon: TPreparedPolygon,
  lat: number,
  lon: number
) {
  return polygonContainsVec(polygon, toVec(lat, lon));
}

/** Conservative relation of a cap to a prepared polygon. */
export function capPolygonRelation(
  polygon: TPreparedPolygon,
  lat: number,
  lon: number,
  radius: number
): TCapRelation {
  const p = toVec(lat, lon);
  const { vertices } = polygon;
  let nearest = Number.POSITIVE_INFINITY;
  for (let i = 0; i < vertices.length; i++) {
    const d = angleToArc(p, vertices[i], vertices[(i + 1) % vertices.length]);
    if (d < nearest) {
      nearest = d;
    }
  }
  if (nearest <= radius) {
    return CAP_RELATION.UNCERTAIN;
  }
  return polygonContainsVec(polygon, p)
    ? CAP_RELATION.INSIDE
    : CAP_RELATION.OUTSIDE;
}

/** Whether point `c` (on the arc's great circle) lies on arc `a`–`b`. */
function onArc(a: TVec3, b: TVec3, c: TVec3) {
  const n = cross(a, b);
  return dot(cross(a, c), n) >= -1e-15 && dot(cross(c, b), n) >= -1e-15;
}

/** Whether the great-circle arcs `a1`–`a2` and `b1`–`b2` cross. */
function arcsCross(a1: TVec3, a2: TVec3, b1: TVec3, b2: TVec3) {
  const line = cross(cross(a1, a2), cross(b1, b2));
  const length = norm(line);
  if (length < 1e-15) {
    return false; // on one great circle: overlapping, not crossing
  }
  const p: TVec3 = [line[0] / length, line[1] / length, line[2] / length];
  const q: TVec3 = [-p[0], -p[1], -p[2]];
  return [p, q].some((c) => onArc(a1, a2, c) && onArc(b1, b2, c));
}

/**
 * Pairs of edges of a drawn polygon (great-circle arcs, the closing edge from
 * the last vertex to the first included) that cross: edge k runs from vertex k
 * to vertex k + 1. Neighbouring edges share a vertex and are not compared. A
 * crossed outline has no single inside (a bow tie's lobes cancel in signed
 * area), so it is not plotted as drawn.
 */
export function polygonCrossings(vertices: TLatLon[]): [number, number][] {
  const n = vertices.length;
  if (n < 4) {
    return [];
  }
  const v = vertices.map((p) => toVec(p.lat, p.lon));
  const found: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) {
        continue; // they share the first vertex
      }
      if (arcsCross(v[i], v[(i + 1) % n], v[j], v[(j + 1) % n])) {
        found.push([i, j]);
      }
    }
  }
  return found;
}
