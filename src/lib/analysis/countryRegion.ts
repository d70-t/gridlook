import { CAP_RELATION, type TCapRelation } from "./sphere.ts";

type TBounds = { west: number; east: number; south: number; north: number };
type TEdgeBlock = TBounds & {
  start: number;
  end: number;
  left?: TEdgeBlock;
  right?: TEdgeBlock;
};
type TRing = { xy: number[]; index: TEdgeBlock };
type TPart = { outer: TRing; holes: TRing[] };

export type TCountryRegion = {
  parts: TPart[];
  /** Only parts touching a latitude band can contain a centre there. */
  bands: TPart[][];
  south: number;
  north: number;
  /** A drawn shape's own decision for centres at the poles. */
  poles?: { north: boolean; south: boolean };
  /**
   * A drawn Box's view: centres within `band` (radians) of the rings are
   * decided as that view showed them (screenFrame.ts).
   */
  frame?: { band: number; inside: (lat: number, lon: number) => boolean };
};

const DEG = Math.PI / 180;
const shiftNear = (lon: number, near: number) =>
  lon + 360 * Math.round((near - lon) / 360);

function block(xy: number[], start: number, end: number): TEdgeBlock {
  // Consecutive coastline segments form compact boxes. Query whole blocks
  // by bounds before examining individual edges, also at the finest scale.
  if (end - start > 16) {
    const mid = Math.floor((start + end) / 2);
    const left = block(xy, start, mid);
    const right = block(xy, mid, end);
    return {
      start,
      end,
      left,
      right,
      west: Math.min(left.west, right.west),
      east: Math.max(left.east, right.east),
      south: Math.min(left.south, right.south),
      north: Math.max(left.north, right.north),
    };
  }
  let west = Infinity,
    east = -Infinity,
    south = Infinity,
    north = -Infinity;
  for (let at = start; at <= end; at++) {
    west = Math.min(west, xy[2 * at]);
    east = Math.max(east, xy[2 * at]);
    south = Math.min(south, xy[2 * at + 1]);
    north = Math.max(north, xy[2 * at + 1]);
  }
  return { west, east, south, north, start, end };
}

function ringOf(vertices: number[][]): TRing | undefined {
  if (vertices.length < 3) {
    return undefined;
  }
  const xy: number[] = [];
  const closed = [...vertices, vertices[0]];
  for (const [lon, lat] of closed) {
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) {
      throw new Error("The country boundary has an invalid coordinate.");
    }
    const x = xy.length ? shiftNear(lon, xy[xy.length - 2]) : lon;
    if (x !== xy[xy.length - 2] || lat !== xy[xy.length - 1]) {
      xy.push(x, lat);
    }
  }
  if (xy.length < 8) {
    return undefined;
  }
  // A ring encircling a pole closes one longitude revolution away in the
  // unwrapped plane. Close it along the pole so the cap includes the pole.
  if (Math.abs(xy[xy.length - 2] - xy[0]) > 180) {
    const pole = xy[1] < 0 ? -90 : 90;
    xy.push(xy[xy.length - 2], pole, xy[0], pole, xy[0], xy[1]);
  }
  return { xy, index: block(xy, 0, xy.length / 2 - 1) };
}

const bandOf = (lat: number) =>
  Math.max(0, Math.min(179, Math.floor(lat + 90)));

/**
 *  Natural Earth rings are geographic line segments, including their holes.
 * Keep separate islands separate and unwrap each ring across the date line.
 */
export function prepareCountry(
  polygons: number[][][][],
  poles?: { north: boolean; south: boolean }
): TCountryRegion {
  const parts: TPart[] = [];
  const bands = Array.from({ length: 180 }, () => [] as TPart[]);
  let south = 90,
    north = -90;
  for (const [exterior, ...interiors] of polygons) {
    const outer = exterior && ringOf(exterior);
    if (!outer) {
      continue;
    }
    const part = {
      outer,
      holes: interiors.map(ringOf).filter((r): r is TRing => !!r),
    };
    parts.push(part);
    south = Math.min(south, outer.index.south);
    north = Math.max(north, outer.index.north);
    for (
      let b = bandOf(outer.index.south);
      b <= bandOf(outer.index.north);
      b++
    ) {
      bands[b].push(part);
    }
  }
  if (!parts.length) {
    throw new Error("This country has no boundary at this resolution.");
  }
  return { parts, bands, south, north, ...(poles ? { poles } : {}) };
}

function ringLongitude(ring: TRing, lon: number) {
  const { west, east } = ring.index;
  const x = shiftNear(lon, (west + east) / 2);
  // Our ray includes the western edge. Map a full-width ring's date line
  // onto that edge even if the incoming grid represents it as +180.
  return x >= west + 360 ? x - 360 : x;
}

export function countryHasLongitude(
  region: TCountryRegion,
  lon: number,
  /** Degrees beside the outline that count too (a Box's screen band). */
  margin = 0
) {
  return region.parts.some(({ outer }) => {
    const x = ringLongitude(outer, lon);
    return x >= outer.index.west - margin && x <= outer.index.east + margin;
  });
}

/** Crossings of an eastward ray, with a half-open edge convention. */
function rayParity(
  ring: TRing,
  node: TEdgeBlock,
  x: number,
  y: number
): number {
  if (node.east <= x || node.south > y || node.north <= y) {
    return 0;
  }
  if (node.left && node.right) {
    return rayParity(ring, node.left, x, y) ^ rayParity(ring, node.right, x, y);
  }
  const { xy } = ring;
  let parity = 0;
  for (let i = node.start * 2; i < node.end * 2; i += 2) {
    const ay = xy[i + 1],
      by = xy[i + 3];
    if (
      ay > y !== by > y &&
      x < xy[i] + ((xy[i + 2] - xy[i]) * (y - ay)) / (by - ay)
    ) {
      parity ^= 1;
    }
  }
  return parity;
}

/**
 * Inside a ring: odd crossings, over every copy of the longitude the ring
 * spans. A ring up to 360° wide (every country, Antarctica too) has one; a
 * drawn outline that loops back over itself near a pole can span more, and the
 * copies there cancel or add as they wind.
 */
function ringContains(ring: TRing, lat: number, lon: number) {
  const { west, east } = ring.index;
  let x = ringLongitude(ring, lon);
  while (x - 360 >= west) {
    x -= 360;
  }
  let parity = 0;
  for (; x < east; x += 360) {
    if (x >= west) {
      parity ^= rayParity(ring, ring.index, x, lat);
    }
  }
  return parity !== 0;
}

export function countryContains(
  region: TCountryRegion,
  pointLat: number,
  lon: number
) {
  // A grid centre at a pole: the inside next to it. A ring round a pole is
  // closed along it, and the crossing rule leaves its top line out. A drawn
  // shape says outright whether each pole is in.
  if (region.poles && Math.abs(pointLat) >= 90 - 1e-9) {
    return pointLat > 0 ? region.poles.north : region.poles.south;
  }
  const frame = region.frame;
  if (!frame) {
    return ringsContain(region, pointLat, lon);
  }
  // Away from the rings, by them; near them, as the drawing view showed it.
  const relation = capRings(region, pointLat, lon, frame.band);
  return relation === CAP_RELATION.UNCERTAIN
    ? frame.inside(pointLat, lon)
    : relation === CAP_RELATION.INSIDE;
}

/** Whether the rings hold a point (countryContains, without a frame). */
function ringsContain(region: TCountryRegion, pointLat: number, lon: number) {
  if (region.poles && Math.abs(pointLat) >= 90 - 1e-9) {
    return pointLat > 0 ? region.poles.north : region.poles.south;
  }
  const lat = Math.max(-90 + 1e-9, Math.min(90 - 1e-9, pointLat));
  if (
    !Number.isFinite(lat) ||
    !Number.isFinite(lon) ||
    lat < region.south ||
    lat > region.north
  ) {
    return false;
  }
  return region.bands[bandOf(lat)].some(
    ({ outer, holes }) =>
      ringContains(outer, lat, lon) &&
      !holes.some((hole) => ringContains(hole, lat, lon))
  );
}

/**
 *  True when a boundary edge's envelope intersects the cap envelope. False
 * guarantees the connected cap cannot change from inside to outside.
 */
function touchesBlock(ring: TRing, node: TEdgeBlock, area: TBounds): boolean {
  if (
    node.east < area.west ||
    node.west > area.east ||
    node.north < area.south ||
    node.south > area.north
  ) {
    return false;
  }
  if (node.left && node.right) {
    return (
      touchesBlock(ring, node.left, area) ||
      touchesBlock(ring, node.right, area)
    );
  }
  const { xy } = ring;
  const midX = (area.west + area.east) / 2,
    midY = (area.south + area.north) / 2;
  const halfX = (area.east - area.west) / 2,
    halfY = (area.north - area.south) / 2;
  for (let i = node.start * 2; i < node.end * 2; i += 2) {
    const ax = xy[i],
      ay = xy[i + 1],
      bx = xy[i + 2],
      by = xy[i + 3];
    if (
      Math.max(ax, bx) < area.west ||
      Math.min(ax, bx) > area.east ||
      Math.max(ay, by) < area.south ||
      Math.min(ay, by) > area.north
    ) {
      continue;
    }
    // The third separating axis is the segment normal. It prunes long
    // diagonal edges whose bounding boxes can contain many fine-grid cells.
    const dx = bx - ax,
      dy = by - ay;
    if (
      Math.abs(dx * (midY - ay) - dy * (midX - ax)) <=
      Math.abs(dx) * halfY + Math.abs(dy) * halfX + 1e-9
    ) {
      return true;
    }
  }
  return false;
}

function touchesRing(
  ring: TRing,
  lon: number,
  half: number,
  south: number,
  north: number
) {
  const x = ringLongitude(ring, lon);
  // A wide ring can meet both ends of a cap crossing its longitude seam.
  for (const offset of [0, -360, 360]) {
    const west = x + offset - half,
      east = x + offset + half;
    if (touchesBlock(ring, ring.index, { west, east, south, north })) {
      return true;
    }
  }
  return false;
}

export function capCountryRelation(
  region: TCountryRegion,
  lat: number,
  lon: number,
  radius: number
): TCapRelation {
  // A frame decides within its band: certain only beyond it.
  return capRings(region, lat, lon, radius + (region.frame?.band ?? 0));
}

/** The cap's relation to the rings alone (capCountryRelation). */
function capRings(
  region: TCountryRegion,
  lat: number,
  lon: number,
  radius: number
): TCapRelation {
  const r = radius / DEG + 1e-9;
  const south = lat - r,
    north = lat + r;
  if (south > region.north || north < region.south) {
    return CAP_RELATION.OUTSIDE;
  }
  const half =
    north >= 90 || south <= -90
      ? 180
      : Math.asin(Math.min(1, Math.sin(radius) / Math.cos(lat * DEG))) / DEG +
        1e-9;
  // The indexed band is sufficient when the whole cap fits in it.
  const parts =
    bandOf(south) === bandOf(north) ? region.bands[bandOf(lat)] : region.parts;
  for (const { outer, holes } of parts) {
    if (outer.index.north < south || outer.index.south > north) {
      continue;
    }
    if (
      touchesRing(outer, lon, half, south, north) ||
      holes.some((hole) => touchesRing(hole, lon, half, south, north))
    ) {
      return CAP_RELATION.UNCERTAIN;
    }
  }
  return ringsContain(region, lat, lon)
    ? CAP_RELATION.INSIDE
    : CAP_RELATION.OUTSIDE;
}
