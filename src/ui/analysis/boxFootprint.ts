/**
 * The Box tool: a rectangle on screen from corner 1 (where it was pressed) to
 * the pointer, and the selection is what it covers of the map. No angle, sweep
 * or pole lock: the outline decides, so a pole inside the rectangle is in, and
 * out as soon as the rectangle leaves it.
 *
 * - A map whose meridians run straight down and parallels straight across
 *   (equirectangular, Mercator, cylindrical equal-area centred on the
 *   equator): the rectangle is a latitude/longitude box, the same numbers
 *   links have always carried.
 * - Any other view (the globe, Robinson, Mollweide, azimuthal maps, an
 *   oblique centre): the rectangle's outline traced on the map, clipped to
 *   the map's edge or the globe's horizon, kept as a drawn shape (lon/lat
 *   rings: any size, across the date line, round a pole). Its inside is the
 *   side the rectangle holds.
 *
 * Only the map's own pick and projection are used: no data is read.
 */
import {
  countryContains,
  prepareCountry,
} from "@/lib/analysis/countryRegion.ts";
import type { TScreenFrame } from "@/lib/analysis/screenFrame.ts";
import { shapeIdentity } from "@/lib/analysis/shapeImport.ts";
import {
  angleBetween,
  boxLonSpan,
  toVec,
  type TLatLon,
} from "@/lib/analysis/sphere.ts";
import { GEOMETRY_KINDS, type TGeometry } from "@/lib/analysis/types.ts";

type TXY = { x: number; y: number };
type TPick = (x: number, y: number) => TLatLon | null;
type TProject = (
  lat: number,
  lon: number
) => { x: number; y: number; visible: boolean } | null;
type TBoxNumbers = { west: number; east: number; south: number; north: number };

/** A screen rectangle (px), left/top to right/bottom. */
export type TScreenRect = { x0: number; y0: number; x1: number; y1: number };
export type TBoxSelection = {
  geometry: TGeometry;
  label: string;
  /**
   * On a latitude/longitude map: the rectangle as clipped to the map, the box
   * exactly. A preview draws it as it is.
   */
  screen?: TScreenRect;
  /** Elsewhere: the rectangle clipped to the visible map, on screen. */
  outline?: TXY[];
};

/** Halvings to the map's edge: a small fraction of a pixel. */
const EDGE_STEPS = 14;
/** On commit: exact to the edge where the view foreshortens most. */
const EXACT_STEPS = 32;
/** A box's own sides: exact to the edge from any distance off the map. */
const SIDE_STEPS = 26;
/** A rectangle narrower than this (px) is not a box yet. */
const MIN_SIDE = 2;

const lerp = (a: TXY, b: TXY, t: number) => ({
  x: a.x + (b.x - a.x) * t,
  y: a.y + (b.y - a.y) * t,
});
/** Longitude step into (−180, 180]. */
const step = (from: number, to: number) =>
  180 - ((((180 - (to - from)) % 360) + 360) % 360);
const wrapped = (lon: number) => ((((lon + 180) % 360) + 360) % 360) - 180;
/** About a metre: links stay short, nothing moves on screen. */

/**
 * Rounded to keep a span's own shape: decimals 5 to 12 by that span, each axis
 * by its own.
 */
function roundFor(span: number) {
  const decimals = Math.min(
    12,
    Math.max(5, Math.ceil(-Math.log10(Math.max(Math.abs(span), 1e-12) / 1e4)))
  );
  const f = 10 ** decimals;
  return (value: number) => Math.round(value * f) / f || 0; // no −0
}

/** The last map point from `inside` toward `outside`, and its place. */
function edgeToward(
  pick: TPick,
  inside: TXY,
  outside: TXY,
  steps = EDGE_STEPS
) {
  let [lo, hi] = [0, 1];
  let geo = pick(inside.x, inside.y);
  for (let k = 0; k < steps; k++) {
    const t = (lo + hi) / 2;
    const at = lerp(inside, outside, t);
    const hit = pick(at.x, at.y);
    if (hit) {
      [lo, geo] = [t, hit];
    } else {
      hi = t;
    }
  }
  return { at: lerp(inside, outside, lo), geo };
}

/**
 * Whether meridians are vertical and parallels horizontal on screen near
 * `at`: then a screen rectangle is a latitude/longitude box.
 */
export function alignedWithGraticule(project: TProject, at: TLatLon) {
  const lats = [-40, 0, 40];
  const lons = [at.lon - 30, at.lon, at.lon + 30];
  const flat = (values: (number | undefined)[]) =>
    values.every((v) => v !== undefined) &&
    Math.max(...(values as number[])) - Math.min(...(values as number[])) <
      0.01;
  const seen = (lat: number, lon: number) => {
    const p = project(lat, lon);
    return p?.visible ? p : undefined;
  };
  return (
    lons.every((lon) => flat(lats.map((lat) => seen(lat, lon)?.x))) &&
    lats.every((lat) => flat(lons.map((lon) => seen(lat, lon)?.y)))
  );
}

/** "60°S", "0°", "12.5°N". */
const roundTo = (value: number, places: number) =>
  Math.round(value * 10 ** places) / 10 ** places;
/**
 * Decimals enough to tell two ends apart (one at least, five at most): a box
 * 0.01° across is not "40°N–40°N".
 */
function places(a: number, b: number) {
  let d = 1;
  while (
    d < 5 &&
    roundTo(Math.abs(a), d) === roundTo(Math.abs(b), d) &&
    a !== b
  ) {
    d++;
  }
  return d;
}
function latText(lat: number, decimals = 1) {
  const value = roundTo(Math.abs(lat), decimals);
  return value === 0 ? "0°" : `${value}°${lat > 0 ? "N" : "S"}`;
}
function lonText(lon: number, decimals = 1) {
  const value = roundTo(Math.abs(lon), decimals);
  return value === 0 || value === 180
    ? `${value}°`
    : `${value}°${lon > 0 ? "E" : "W"}`;
}
/** Latitudes from the equator outward: 10°N–40°N, 60°S–90°S. */
function latRange(south: number, north: number) {
  const [a, b] = north <= 0 ? [north, south] : [south, north];
  const d = places(a, b);
  return `${latText(a, d)}–${latText(b, d)}`;
}
function lonRange(west: number, east: number) {
  const d = places(west, east);
  return `${lonText(west, d)} to ${lonText(east, d)}`;
}

/** "270° of longitude, 10°N–40°N", "All longitudes, 60°S–90°S". */
function boxLabel(box: TBoxNumbers) {
  const span = boxLonSpan(box);
  // Near a full turn, enough digits to show the gap (359.21°), never
  // rounded up to 360°: that wording is for all longitudes.
  const digits = span > 359 ? 100 : span < 1 ? 10 ** places(0, span) : 10;
  const lons =
    span >= 360
      ? "All longitudes"
      : `${Math.min(Math.round(span * digits), 360 * digits - 1) / digits}° of longitude`;
  return `${lons}, ${latRange(box.south, box.north)}`;
}

/**
 * The rectangle as a latitude/longitude box on an aligned map, its far
 * corner kept to the map: below a flat map's bottom edge a sideways move
 * still changes the width, beyond a side edge an up-down move the height.
 */
function screenBox(pick: TPick, project: TProject, pressed: TXY, pointer: TXY) {
  const [corner, { x, y }] = boxCorners(pick, pressed, pointer);
  const a = pick(corner.x, corner.y);
  if (!a) {
    return undefined;
  }
  const b = pick(x, y);
  if (
    !b ||
    Math.abs(x - corner.x) < MIN_SIDE ||
    Math.abs(y - corner.y) < MIN_SIDE
  ) {
    return undefined;
  }
  const left = x < corner.x ? b : a;
  // The width from the screen (longitude is linear across these maps),
  // not from two wrapped longitudes: edge to edge from a seam is 360°.
  const perDegree = Math.min(
    ...[-1, 1].map((d) => {
      const p = project(a.lat, a.lon + d);
      return p ? Math.abs(p.x - corner.x) : Number.POSITIVE_INFINITY;
    })
  );
  const span = Math.abs(x - corner.x) / perDegree;
  // Up to a map's top or bottom edge where that edge is a pole, at either
  // end of the box.
  const dy = Math.sign(y - corner.y);
  const lats = [
    atPole(a.lat, !pick(corner.x, corner.y - dy)),
    atPole(b.lat, !pick(x, y + dy)),
  ];
  // Edge to edge: all longitudes, as links have always written it.
  const all = span >= 359.99;
  const [roundLon, roundLat] = [
    roundFor(span),
    roundFor(Math.max(...lats) - Math.min(...lats)),
  ];
  const box = {
    west: all ? -180 : roundLon(left.lon),
    east: all ? 180 : roundLon(wrapped(left.lon + span)),
    south: roundLat(Math.min(...lats)),
    north: roundLat(Math.max(...lats)),
  };
  const screen = {
    x0: Math.min(corner.x, x),
    y0: Math.min(corner.y, y),
    x1: Math.max(corner.x, x),
    y1: Math.max(corner.y, y),
  };
  return { box, screen };
}

/** A latitude on a map edge that is a pole: the pole itself. */
const atPole = (lat: number, onEdge: boolean) =>
  onEdge && Math.abs(lat) > 89.9 ? Math.sign(lat) * 90 : lat;

/**
 * A box's two corners on a latitude/longitude map: kept to the map, each on an
 * edge nearby; unless both snap to one edge, when a narrow strip there keeps
 * the width drawn.
 */
function boxCorners(pick: TPick, pressed: TXY, pointer: TXY): [TXY, TXY] {
  const along = (from: TXY, to: TXY) =>
    pick(to.x, to.y) ? to : edgeToward(pick, from, to, SIDE_STEPS).at;
  const far = (from: TXY) => ({
    x: along(from, { x: pointer.x, y: from.y }).x,
    y: along(from, { x: from.x, y: pointer.y }).y,
  });
  const snapped = onEdgeNearby(pick, pressed);
  const farSnapped = onEdgeNearby(pick, far(snapped));
  const collapsed =
    Math.abs(snapped.x - farSnapped.x) < MIN_SIDE ||
    Math.abs(snapped.y - farSnapped.y) < MIN_SIDE;
  return collapsed ? [pressed, far(pressed)] : [snapped, farSnapped];
}

/**
 * A box corner within a few pixels of a flat map's edge is on it, either
 * corner, either way round: a press must land on the map, and a box should
 * still reach the seam or a pole (all longitudes, not 359.2°). Further from an
 * edge, a gap the drag leaves stays.
 */
const EDGE_SNAP = 8;
function onEdgeNearby(pick: TPick, at: TXY) {
  const snap = (dx: number, dy: number) => {
    const to = { x: at.x + dx, y: at.y + dy };
    return pick(to.x, to.y)
      ? undefined
      : edgeToward(pick, at, to, SIDE_STEPS).at;
  };
  return {
    x: (snap(-EDGE_SNAP, 0) ?? snap(EDGE_SNAP, 0) ?? at).x,
    y: (snap(0, -EDGE_SNAP) ?? snap(0, EDGE_SNAP) ?? at).y,
  };
}

/**
 * How far (degrees) a committed outline may stray from the true one: along the
 * horizon a tenth of that elsewhere, where a lat/lon chord between two horizon
 * points sags onto the hidden side.
 */
const along = (ps: { on: boolean }, pt: { on: boolean }) =>
  ps.on || pt.on ? 0.005 : 0.0005;

/** Steps of about 10 px along one side of the rectangle. */
function alongEdge<T>(
  from: TXY,
  to: TXY,
  each: (s: TXY, t: TXY, ps: T, pt: T) => void,
  place: (at: TXY) => T
) {
  const n = Math.min(
    64,
    Math.max(4, Math.ceil(Math.hypot(to.x - from.x, to.y - from.y) / 10))
  );
  let [s, ps] = [from, place(from)];
  for (let k = 1; k <= n; k++) {
    const t = lerp(from, to, k / n);
    const pt = place(t);
    each(s, t, ps, pt);
    [s, ps] = [t, pt];
  }
}

/** Where the map draws a pole as one point (globe, Mollweide, azimuthal). */
function pointPole(project: TProject, lat: number): TXY | undefined {
  const at = [0, 90, -90].map((lon) => project(lat, lon));
  const [a] = at;
  return a &&
    at.every((q) => q?.visible && Math.hypot(q.x - a.x, q.y - a.y) < 0.01)
    ? { x: a.x, y: a.y }
    : undefined;
}
function polePoints(project: TProject) {
  return [-90, 90].flatMap((lat) => pointPole(project, lat) ?? []);
}

/**
 * Whether each pole is in the box, where the map draws it as one point:
 * strictly inside the rectangle (and on the map) or strictly outside.
 * Undefined on a side, or where a pole is a line (flat maps): decided by
 * the places around it then.
 */
function polesInside(pick: TPick, project: TProject, rect: TScreenRect) {
  const at = (lat: number) => {
    const q = pointPole(project, lat);
    // A pole on the map's own edge (Mollweide's top) is left to the
    // places around it.
    const onEdge =
      q && [-1, 1].some((d) => !pick(q.x + d, q.y) || !pick(q.x, q.y + d));
    if (!q || onEdge) {
      return undefined;
    }
    const margin = Math.min(
      q.x - rect.x0,
      rect.x1 - q.x,
      q.y - rect.y0,
      rect.y1 - q.y
    );
    // The pole is one point here: in or out by where it is drawn.
    return Math.abs(margin) < 1e-9 ? undefined : margin > 0;
  };
  return { south: at(-90), north: at(90) };
}

/**
 * Whether a step of the traced outline needs a point between: it crosses
 * the map's edge, bends away from the straight screen edge, passes over
 * a pole drawn as a point, or spans much of the globe.
 */
function finer(
  project: TProject,
  poles: TXY[],
  [s, t]: [TXY, TXY],
  [ps, pt]: { geo: TLatLon | null; on: boolean }[],
  depth: number
) {
  return (
    (ps.on !== pt.on && depth < 12) ||
    (ps.on && pt.on && depth < 10 && bends(project, [s, t], ps.geo, pt.geo)) ||
    passesPole(poles, s, t, depth) ||
    (far(ps.geo, pt.geo) && depth < 6)
  );
}

/**
 * The outline between two points off the true one at their middle by over
 * 0.005°: when committing, a finer outline there.
 */
function offTrack(
  g: TLatLon | null,
  h: TLatLon | null,
  m: TLatLon | null,
  tolerance: number
) {
  if (!g || !h || !m) {
    return false;
  }
  const mid = toVec((g.lat + h.lat) / 2, g.lon + step(g.lon, h.lon) / 2);
  return angleBetween(mid, toVec(m.lat, m.lon)) > (tolerance * Math.PI) / 180;
}

/**
 * Near a pole drawn as one point: steps shorter than their distance to it, so
 * longitudes stay clear as an edge passes, and onto it when it lies on the
 * edge.
 */
const passesPole = (poles: TXY[], s: TXY, t: TXY, depth: number) =>
  depth < 40 &&
  poles.some((q) => {
    const d = toSegment(q, s, t);
    return d < 0.75 && Math.hypot(t.x - s.x, t.y - s.y) > Math.max(1e-3, d);
  });

/** Screen distance from `q` to the segment `s`–`t`. */
function toSegment(q: TXY, s: TXY, t: TXY) {
  const [dx, dy] = [t.x - s.x, t.y - s.y];
  const f = Math.max(
    0,
    Math.min(
      1,
      ((q.x - s.x) * dx + (q.y - s.y) * dy) / (dx * dx + dy * dy || 1)
    )
  );
  return Math.hypot(s.x + f * dx - q.x, s.y + f * dy - q.y);
}

/** Places far apart on the globe, or longitudes far apart (near a pole). */
const far = (g: TLatLon | null, h: TLatLon | null) =>
  !!g &&
  !!h &&
  (angleBetween(toVec(g.lat, g.lon), toVec(h.lat, h.lon)) >
    (2 * Math.PI) / 180 ||
    Math.abs(step(g.lon, h.lon)) > 15);

/**
 * On the map the rectangle's edge is straight on screen; the stored outline is
 * straight in latitude/longitude between its points. Where the two part (near a
 * tilted map's pole) by over a quarter pixel, more points.
 */
function bends(
  project: TProject,
  [s, t]: [TXY, TXY],
  g: TLatLon | null,
  h: TLatLon | null,
  pixels = 0.25
) {
  return strayed(project, [s, t], g, h) > pixels;
}

/** How far (px) the outline between two points strays at their middle. */
function strayed(
  project: TProject,
  [s, t]: [TXY, TXY],
  g: TLatLon | null,
  h: TLatLon | null
) {
  if (!g || !h) {
    return 0;
  }
  const mid = project((g.lat + h.lat) / 2, g.lon + step(g.lon, h.lon) / 2);
  const m = lerp(s, t, 0.5);
  return mid ? Math.hypot(mid.x - m.x, mid.y - m.y) : Number.POSITIVE_INFINITY;
}

/**
 * How far (px) a committed outline may stray from the drawn rectangle's
 * straight edge: what the overlay lit is what is computed.
 */
const COMMIT_PIXELS = 1e-3;

/** A traced outline point: its place, on the map or not, and on screen. */
type TPlaced = { geo: TTraced | null; on: boolean; at: TXY };

/**
 * Where a point of the rectangle's outline is: picked on the map, or moved
 * in toward `inside` to the map's edge (more halvings when committing).
 */
function placer(pick: TPick, inside: TXY, exact: boolean) {
  return (s: TXY): TPlaced => {
    const hit = pick(s.x, s.y);
    if (hit) {
      return { geo: hit, on: true, at: s };
    }
    const edge = edgeToward(pick, inside, s, exact ? EXACT_STEPS : EDGE_STEPS);
    return {
      geo: edge.geo && { ...edge.geo, edge: true },
      on: false,
      at: edge.at,
    };
  };
}

/**
 * The rectangle's outline as traced on the map, clipped to it: points along
 * the screen rectangle, each off-map one moved in to the map's edge toward
 * `inside`, finer where the map bends (near a pole) or the edge is crossed.
 */
// eslint-disable-next-line max-lines-per-function
function tracedOutline(
  pick: TPick,
  project: TProject,
  [corner, pointer, inside]: [TXY, TXY, TXY],
  exact: boolean
) {
  const poles = polePoints(project);
  const place = placer(pick, inside, exact);
  const out: TTraced[] = [];
  const screen: TXY[] = [];
  type TPlace = TPlaced;
  const keep = (p: TPlace) => {
    if (p.geo) {
      out.push(p.geo);
      screen.push(p.at);
    }
  };
  const segment = (
    s: TXY,
    ps: TPlace,
    t: TXY,
    pt: TPlace,
    depth: number,
    /** The parent step's stray (px): refining must keep shrinking it. */
    parent = Number.POSITIVE_INFINITY
  ) => {
    const m = lerp(s, t, 0.5);
    let pm: TPlace | undefined;
    const off =
      exact && ps.on && pt.on ? strayed(project, [s, t], ps.geo, pt.geo) : 0;
    if (!finer(project, poles, [s, t], [ps, pt], depth)) {
      // Committing: also where the outline strays from the true one, on
      // the globe, or on screen while halving still brings it closer (a
      // pick near a pole is a fraction of a pixel off, which no point
      // between corrects).
      pm = exact && depth < 20 ? place(m) : undefined;
      const strays =
        pm &&
        ((depth < 14 && offTrack(ps.geo, pt.geo, pm.geo, along(ps, pt))) ||
          (off > COMMIT_PIXELS && off < parent * 0.6));
      if (!strays) {
        return;
      }
    }
    pm ??= place(m);
    segment(s, ps, m, pm, depth + 1, off || parent);
    keep(pm);
    segment(m, pm, t, pt, depth + 1, off || parent);
  };
  const corners = [
    corner,
    { x: pointer.x, y: corner.y },
    pointer,
    { x: corner.x, y: pointer.y },
  ];
  corners.forEach((from, at) =>
    alongEdge(
      from,
      corners[(at + 1) % 4],
      (s, t, ps, pt) => {
        keep(ps);
        segment(s, ps, t, pt, 0);
      },
      place
    )
  );
  return { points: out, screen };
}

/**
 * Whether a place is at a pole as the map shows it: within a few pixels of
 * where the map draws that pole (one point on the globe, a line on a flat map).
 * There its longitude is noise; on the map's own edge (near Mollweide's top) it
 * still swings round a pixel or two away, so a few pixels there. A fixed zone
 * in degrees would cut real outline away at close zoom.
 */
function nearPole(project: TProject, p: TLatLon, pixels: number) {
  if (Math.abs(p.lat) >= 90 - 1e-9) {
    return true;
  }
  const here = project(p.lat, p.lon);
  // The equator's nearest pole is a pole, not the equator.
  const pole = project(p.lat < 0 ? -90 : 90, p.lon);
  // A pole behind the globe is drawn nowhere: a place at the limb can land on
  // its would-be position without being near it.
  return (
    !!here &&
    !!pole?.visible &&
    Math.hypot(here.x - pole.x, here.y - pole.y) < pixels
  );
}

/** A traced outline point; `edge`: on the map's own edge, not the box's. */
type TTraced = TLatLon & { edge?: boolean };
type TEntry = TTraced | { pole: 1 | -1 };

/**
 * The outline with each run of points at a pole as one mark: where the
 * outline touches a pole (Mollweide's top, an azimuthal map's rim, an
 * edge across the pole) its longitudes are noise, and how far round the
 * pole it goes is settled by asking the map instead.
 */
function withPoleMarks(
  points: TTraced[],
  atPole: (p: TTraced) => boolean
): TEntry[] | undefined {
  const first = points.findIndex((p) => !atPole(p));
  if (first < 0) {
    return undefined;
  }
  const entries: TEntry[] = [];
  for (const p of [...points.slice(first), ...points.slice(0, first)]) {
    const last = entries.at(-1);
    if (!atPole(p)) {
      entries.push(p);
    } else if (!(last && "pole" in last && last.pole === Math.sign(p.lat))) {
      entries.push({ pole: p.lat > 0 ? 1 : -1 });
    }
  }
  return entries;
}

/** Steps of at most 90° along a pole, from `from` by `turn` degrees. */
function alongPole(from: number, turn: number, pole: number) {
  const steps = Math.max(1, Math.ceil(Math.abs(turn) / 90));
  return Array.from({ length: steps + 1 }, (_, k) => [
    from + (turn * k) / steps,
    pole,
  ]);
}

/**
 * The outline unwrapped (longitudes continuous), each pole mark a path
 * along the pole going `turns[j]` extra whole turns round it; and how many
 * degrees the whole outline goes round the poles' axis.
 */
function unwrapped(entries: TEntry[], turns: number[]) {
  const ring: number[][] = [];
  let x = 0;
  let previous: TLatLon | undefined;
  let mark = 0;
  entries.forEach((entry, k) => {
    if ("pole" in entry) {
      const next = entries[(k + 1) % entries.length] as TLatLon;
      const turn = step(previous!.lon, next.lon) + 360 * turns[mark++];
      ring.push(...alongPole(x, turn, entry.pole * 90));
      x += turn;
      previous = { lat: entry.pole * 90, lon: next.lon };
      return;
    }
    x = previous ? x + step(previous.lon, entry.lon) : entry.lon;
    ring.push([x, entry.lat]);
    previous = entry;
  });
  const first = entries[0] as TLatLon;
  const round = x + step(previous!.lon, first.lon) - ring[0][0];
  return { ring, round: Math.round(round / 360) * 360 };
}

/**
 * Rings in the shape form: longitudes wrapped, rounded to a ten-thousandth of
 * the outline's own size (0.00001° at least: about a metre). A box a few metres
 * across keeps its shape.
 */
function stored(
  rings: number[][][],
  decimals: [number, number] = [5, 5]
): number[][][][] {
  const [fx, fy] = decimals.map((d) => 10 ** d);
  const rx = (v: number) => Math.round(v * fx) / fx || 0; // no −0
  const ry = (v: number) => Math.round(v * fy) / fy || 0;
  return [rings.map((r) => r.map(([lon, lat]) => [rx(wrapped(lon)), ry(lat)]))];
}

/**
 * Decimals that keep an outline's shape, [longitude, latitude]: 5 to 12,
 * each by the outline's extent along it (see roundFor).
 */
function decimalsFor(ring: number[][]): [number, number] {
  let [x0, x1, y0, y1] = [Infinity, -Infinity, Infinity, -Infinity];
  for (const [x, y] of ring) {
    [x0, x1, y0, y1] = [
      Math.min(x0, x),
      Math.max(x1, x),
      Math.min(y0, y),
      Math.max(y1, y),
    ];
  }
  const of = (size: number) =>
    Math.min(
      12,
      Math.max(5, Math.ceil(-Math.log10(Math.max(size, 1e-12) / 1e4)))
    );
  return [of(x1 - x0), of(y1 - y0)];
}

/**
 * The ways an unwrapped outline can close: along the pole it goes round,
 * or (going round neither) as it is, or as the whole globe less it.
 */
function closings(ring: number[][], round: number) {
  const [x0, lat0] = ring[0];
  const decimals = decimalsFor(ring);
  if (Math.abs(round) === 360) {
    return [-90, 90].map((pole) =>
      stored(
        [
          [
            ...ring,
            [x0 + round, lat0],
            ...alongPole(x0 + round, -round, pole),
            ring[0],
          ],
        ],
        decimals
      )
    );
  }
  if (round !== 0) {
    return [];
  }
  const west = Math.min(...ring.map(([x]) => x));
  const world = [
    ...alongPole(west, 360, -90),
    ...alongPole(west + 360, -360, 90),
    [west, -90],
  ];
  return [
    stored([[...ring, ring[0]]], decimals),
    stored([world, [...ring, ring[0]]], decimals),
  ];
}

/** Every choice of extra turns at up to three pole marks. */
function turnChoices(marks: number) {
  let choices: number[][] = [[]];
  for (let k = 0; k < Math.min(marks, 3); k++) {
    choices = choices.flatMap((c) => [0, -1, 1].map((t) => [...c, t]));
  }
  return choices.map((c) => [...c, ...Array(Math.max(0, marks - 3)).fill(0)]);
}

/**
 * The traced outline as shape polygons whose inside is what the rectangle
 * covers: of the ways to close it, the one the map agrees with at the
 * rectangle's own inside point and next to both poles. `covers(lat, lon)`:
 * whether the map shows that place inside the rectangle.
 */
function footprintPolygons(
  points: TTraced[],
  inside: TLatLon,
  /** A place just outside the rectangle, when the map shows one. */
  outside: TLatLon | undefined,
  covers: (lat: number, lon: number) => boolean,
  atPole: (p: TTraced) => boolean,
  poleTruth: { south?: boolean; north?: boolean }
) {
  const entries = withPoleMarks(points, atPole);
  if (!entries) {
    return undefined;
  }
  const probes = [89.999, 89.9, 89, -89, -89.9, -89.999].flatMap((lat) =>
    [0, 45, 90, 135, 180, 225, 270, 315].map((lon) => ({
      lat,
      lon: wrapped(lon),
      truth: covers(lat, wrapped(lon)),
    }))
  );
  const marks = entries.filter((e) => "pole" in e).length;
  const best =
    bestClosing(entries, marks, inside, outside, probes, poleTruth) ??
    bestClosing(entries, marks, inside, outside, probes, {});
  return (
    best && {
      polygons: best.polygons,
      north: poleTruth.north ?? probes.slice(0, 8).every((p) => p.truth),
      south: poleTruth.south ?? probes.slice(-8).every((p) => p.truth),
    }
  );
}

/** Of the ways to close the outline, the one the map agrees with most. */
function bestClosing(
  entries: TEntry[],
  marks: number,
  inside: TLatLon,
  outside: TLatLon | undefined,
  probes: { lat: number; lon: number; truth: boolean }[],
  poleTruth: { south?: boolean; north?: boolean }
) {
  let best: { polygons: number[][][][]; score: number } | undefined;
  for (const turns of turnChoices(marks)) {
    const { ring, round } = unwrapped(entries, turns);
    for (const polygons of closings(ring, round)) {
      const region = prepareCountry(polygons);
      if (
        !countryContains(region, inside.lat, inside.lon) ||
        (outside && countryContains(region, outside.lat, outside.lon)) ||
        !agreesAtPoles(region, poleTruth)
      ) {
        continue; // its own inside in, its outside out, a known pole as it is
      }
      const score = probes.filter(
        (p) => countryContains(region, p.lat, p.lon) === p.truth
      ).length;
      if (!best || score > best.score) {
        best = { polygons, score };
      }
    }
  }
  return best;
}

/** A known pole in (or out) whichever longitude its grid centre has. */
function agreesAtPoles(
  region: ReturnType<typeof prepareCountry>,
  truth: { south?: boolean; north?: boolean }
) {
  return [
    [-90, truth.south],
    [90, truth.north],
  ].every(
    ([lat, known]) =>
      known === undefined ||
      // Between meridians: an outline can run along 0° or 180° up to
      // the pole (Mollweide's edge), where a centre is on the boundary.
      [22.5, 67.5, 112.5, 157.5, 202.5, 247.5, 292.5, 337.5].every(
        (lon) => countryContains(region, lat as number, wrapped(lon)) === known
      )
  );
}

/** What a footprint covers, in words and as box numbers. */
function footprintExtent(
  polygons: number[][][][],
  poles: { north: boolean; south: boolean }
) {
  const ring = polygons[0].at(-1)!;
  let [south, north] = [90, -90];
  for (const [, lat] of ring) {
    south = Math.min(south, lat);
    north = Math.max(north, lat);
  }
  // Longitudes from the outline's own edges: the path along a pole that closes
  // it (its turn) is no extent.
  const cover = longitudesCovered(ring);
  const all = poles.north || poles.south || !cover;
  const roundLat = roundFor(north - south);
  const roundLon = roundFor(cover?.span ?? 360);
  const box = all
    ? {
        west: -180,
        east: 180,
        south: poles.south ? -90 : roundLat(south),
        north: poles.north ? 90 : roundLat(north),
      }
    : {
        west: roundLon(cover.west),
        east: roundLon(wrapped(cover.west + cover.span)),
        south: roundLat(south),
        north: roundLat(north),
      };
  const where =
    poles.north && poles.south
      ? "holds both poles"
      : poles.north || poles.south
        ? `round the ${poles.north ? "North" : "South"} Pole`
        : all
          ? "all longitudes"
          : lonRange(box.west, box.east);
  return { box, words: `${latRange(box.south, box.north)} — ${where}` };
}

/**
 * The longitudes the outline's edges sweep (not those along a pole): the
 * smallest range eastward holding them all, or undefined for all of them.
 */
function longitudesCovered(ring: number[][]) {
  const spans: [number, number][] = [];
  for (let k = 1; k < ring.length; k++) {
    const [[a, la], [b, lb]] = [ring[k - 1], ring[k]];
    if (Math.abs(la) >= 90 || Math.abs(lb) >= 90) {
      continue;
    }
    const from = (wrapped(a) + 360) % 360;
    const d = step(a, b);
    const [lo, hi] = d >= 0 ? [from, from + d] : [from + d, from];
    // On a 0–360 circle: a span over 0 in two pieces.
    if (lo < 0) {
      spans.push([lo + 360, 360], [0, hi]);
    } else if (hi > 360) {
      spans.push([lo, 360], [0, hi - 360]);
    } else {
      spans.push([lo, hi]);
    }
  }
  if (!spans.length) {
    return undefined;
  }
  spans.sort((p, q) => p[0] - q[0]);
  // The widest stretch no edge sweeps, the 360° wrap included.
  let [gap, after] = [0, 0];
  let reach = spans[0][1];
  for (const [lo, hi] of spans.slice(1)) {
    if (lo - reach > gap) {
      [gap, after] = [lo - reach, lo];
    }
    reach = Math.max(reach, hi);
  }
  if (spans[0][0] + 360 - reach > gap) {
    [gap, after] = [spans[0][0] + 360 - reach, spans[0][0]];
  }
  return gap < 1e-6 ? undefined : { west: wrapped(after), span: 360 - gap };
}

/**
 * A point inside the rectangle near corner 1, on the map and clear of the
 * poles (where "inside" has no answer): the side the rectangle holds.
 * Off-map points of the outline move in toward it.
 */
function insidePoint(
  pick: TPick,
  project: TProject,
  corner: TXY,
  pointer: TXY
) {
  const depth = Math.min(
    20,
    Math.abs(pointer.x - corner.x) / 4,
    Math.abs(pointer.y - corner.y) / 4
  );
  const toward = (d: number) => ({
    x: corner.x + d * Math.sign(pointer.x - corner.x),
    y: corner.y + d * Math.sign(pointer.y - corner.y),
  });
  // Near corner 1 first; across the rectangle when corner 1 is a pole.
  const candidates = [
    ...[depth, depth / 3, depth / 9, 0.5].map(toward),
    ...[0.25, 0.5, 0.75].map((f) => lerp(corner, pointer, f)),
    { x: pointer.x, y: corner.y },
    { x: corner.x, y: pointer.y },
  ].map((p) => lerp(p, lerp(corner, pointer, 0.5), 0.02));
  return [...candidates, ...besideCorner(corner, pointer)].find((p) => {
    const geo = pick(p.x, p.y);
    return geo && !nearPole(project, geo, 0.05);
  });
}

/**
 * More places inside the rectangle, along corner 1's own row and column a
 * fraction of a pixel in: where corner 1 is a pole's width from a globe's limb,
 * the map is only that thin strip of the rectangle.
 */
function besideCorner(corner: TXY, pointer: TXY) {
  const [dx, dy] = [pointer.x - corner.x, pointer.y - corner.y];
  return [0.05, 0.1, 0.2, 0.35, 0.5, 0.75, 0.95].flatMap((f) =>
    [0.02, 0.1, 0.25].flatMap((d) => [
      { x: corner.x + f * dx, y: corner.y + d * Math.sign(dy) },
      { x: corner.x + d * Math.sign(dx), y: corner.y + f * dy },
    ])
  );
}

/**
 * A place just outside corner 1 (away from the rectangle), on the map, clear of
 * the poles and not covered: whichever way an outline closes, it must leave
 * this out.
 */
function outsidePoint(
  pick: TPick,
  project: TProject,
  corner: TXY,
  pointer: TXY,
  covers: (lat: number, lon: number) => boolean
) {
  const away = (d: number) => ({
    x: corner.x - d * Math.sign(pointer.x - corner.x),
    y: corner.y - d * Math.sign(pointer.y - corner.y),
  });
  for (const d of [4, 2, 1]) {
    const p = away(d);
    const geo = pick(p.x, p.y);
    if (geo && !nearPole(project, geo, 0.05) && !covers(geo.lat, geo.lon)) {
      return geo;
    }
  }
  return undefined;
}

/**
 * Whether the map hides a far side behind a horizon (the globe): there the edge
 * is placed exactly on the horizon, and a pole a fraction of a pixel inside it
 * is still degrees from the horizon's places.
 */
function hasHorizon(project: TProject, inside: TLatLon) {
  return project(-inside.lat, inside.lon + 180)?.visible === false;
}

/** Whether the map shows a place inside the rectangle: the reference. */
function coverage(pick: TPick, project: TProject, corner: TXY, pointer: TXY) {
  const [x0, x1] = [
    Math.min(corner.x, pointer.x),
    Math.max(corner.x, pointer.x),
  ];
  const [y0, y1] = [
    Math.min(corner.y, pointer.y),
    Math.max(corner.y, pointer.y),
  ];
  return (lat: number, lon: number) => {
    const p = project(lat, lon);
    return (
      !!p?.visible &&
      p.x >= x0 &&
      p.x <= x1 &&
      p.y >= y0 &&
      p.y <= y1 &&
      !!pick(p.x, p.y)
    );
  };
}

/**
 * The rectangle's footprint as traced on a map that is not a latitude/
 * longitude grid, and its outline on screen as clipped to the map.
 */
function tracedFootprint(
  pick: TPick,
  project: TProject,
  [corner, pointer]: [TXY, TXY],
  exact: boolean
) {
  const inside = insidePoint(pick, project, corner, pointer);
  if (!inside) {
    return undefined;
  }
  const covers = coverage(pick, project, corner, pointer);
  const horizon = hasHorizon(project, pick(inside.x, inside.y)!);
  const { points, screen } = tracedOutline(
    pick,
    project,
    [corner, pointer, inside],
    exact
  );
  const footprint =
    points.length >= 3
      ? footprintPolygons(
          points,
          pick(inside.x, inside.y)!,
          outsidePoint(pick, project, corner, pointer, covers),
          covers,
          // On a flat map's own edge longitudes swing for a few pixels
          // near a pole (Mollweide's top); on the rectangle, and on the
          // globe's horizon, only at the pole.
          (p) => nearPole(project, p, p.edge && !horizon ? 3 : 1e-3),
          polesInside(pick, project, {
            x0: Math.min(corner.x, pointer.x),
            y0: Math.min(corner.y, pointer.y),
            x1: Math.max(corner.x, pointer.x),
            y1: Math.max(corner.y, pointer.y),
          })
        )
      : undefined;
  return footprint && { footprint, screen, band: edgeBand(points, screen) };
}

/** The edge band, in screen pixels: far wider than the outline strays. */
const BAND_PIXELS = 0.05;

/**
 * The angle (radians) BAND_PIXELS covers at most along the traced outline:
 * a centre farther from it is on the same side of the drawn rectangle as of
 * the outline; a nearer one is decided on screen (screenFrame.ts).
 */
function edgeBand(points: TLatLon[], screen: TXY[]) {
  const vec = (p: TLatLon) => {
    const [a, b] = [(p.lat * Math.PI) / 180, (p.lon * Math.PI) / 180];
    return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)];
  };
  let most = 0;
  for (let k = 1; k < points.length; k++) {
    const px = Math.hypot(
      screen[k].x - screen[k - 1].x,
      screen[k].y - screen[k - 1].y
    );
    if (px > 1e-9) {
      const [u, v] = [vec(points[k]), vec(points[k - 1])];
      const dot = u[0] * v[0] + u[1] * v[1] + u[2] * v[2];
      most = Math.max(most, Math.acos(Math.min(1, Math.max(-1, dot))) / px);
    }
  }
  return BAND_PIXELS * most;
}

/** A drawn shape's name from its rings ("as drawn, 10°S–5°N, …"). */
export function drawnName(
  polygons: number[][][][],
  poles: { north: boolean; south: boolean } = { north: false, south: false }
) {
  return `as drawn, ${footprintExtent(polygons, poles).words}`;
}

/** A footprint as the drawn shape, or the box round it (`latLonBox`). */
function asSelection(
  footprint: NonNullable<ReturnType<typeof footprintPolygons>>,
  latLonBox: boolean,
  frame?: TScreenFrame
): TBoxSelection {
  const extent = footprintExtent(footprint.polygons, footprint);
  if (latLonBox) {
    return {
      geometry: { kind: GEOMETRY_KINDS.BOX, ...extent.box },
      label: boxLabel(extent.box),
    };
  }
  const name = `as drawn, ${extent.words}`;
  const poles = { north: footprint.north, south: footprint.south };
  return {
    geometry: {
      kind: GEOMETRY_KINDS.SHAPE,
      name,
      polygons: footprint.polygons,
      // The poles are part of what was drawn, and of its identity; so is
      // the view that decides centres at its edges.
      digest: shapeIdentity(footprint.polygons, poles, frame),
      drawn: true,
      poles,
      ...(frame ? { frame } : {}),
    },
    label: `Box ${name}`,
  };
}

/**
 * A flat map's pick past its top or bottom edge still answers, with a
 * latitude beyond ±90°: that is off the map.
 */
function onTheGlobe(pick: TPick): TPick {
  return (x, y) => {
    const geo = pick(x, y);
    return geo && Math.abs(geo.lat) <= 90 && Number.isFinite(geo.lon)
      ? geo
      : null;
  };
}

/**
 * The selection a rectangle from `corner` to `pointer` (screen) makes.
 * `latLonBox`: plots that need a latitude/longitude box (Hovmöller
 * diagrams, zonal or meridional sections) get the box around what the
 * rectangle covers, shown as that box while drawing.
 */
export function rectangleSelection(
  pick: TPick,
  project: TProject,
  corner: TXY,
  pointer: TXY,
  latLonBox = false,
  exact = false,
  /** The view (when committing): it decides centres at the edges. */
  view?: Omit<TScreenFrame, "rect" | "band">
): TBoxSelection | undefined {
  pick = onTheGlobe(pick);
  const start = pick(corner.x, corner.y);
  if (
    !start ||
    Math.abs(pointer.x - corner.x) < MIN_SIDE ||
    Math.abs(pointer.y - corner.y) < MIN_SIDE
  ) {
    return undefined;
  }
  if (alignedWithGraticule(project, start)) {
    const drawn = screenBox(pick, project, corner, pointer);
    return (
      drawn && {
        geometry: { kind: GEOMETRY_KINDS.BOX, ...drawn.box },
        label: boxLabel(drawn.box),
        screen: drawn.screen,
      }
    );
  }
  const traced = tracedFootprint(pick, project, [corner, pointer], exact);
  if (!traced) {
    return undefined;
  }
  const { footprint, screen, band } = traced;
  const rect = {
    x0: Math.min(corner.x, pointer.x),
    y0: Math.min(corner.y, pointer.y),
    x1: Math.max(corner.x, pointer.x),
    y1: Math.max(corner.y, pointer.y),
  };
  const frame =
    exact && view && band > 0 && Number.isFinite(band)
      ? { ...view, rect, band }
      : undefined;
  const selection = asSelection(footprint, latLonBox, frame);
  // The preview: the rectangle as clipped to the visible map, on screen
  // (exact, and nothing geographic to build per frame).
  return latLonBox ? selection : { ...selection, outline: screen };
}

/**
 * A run of outline points with others between them every degree or less,
 * straight in latitude/longitude as the calculation reads the edges: on
 * the globe or another map the outline then curves as the region does.
 */
function inDegreeSteps(run: TLatLon[]) {
  return run.flatMap((p, k) => {
    const next = run[k + 1];
    if (!next) {
      return [p];
    }
    const dLon = step(p.lon, next.lon);
    const n = Math.max(
      1,
      Math.ceil(Math.max(Math.abs(dLon), Math.abs(next.lat - p.lat)))
    );
    return Array.from({ length: n }, (_, j) => ({
      lat: p.lat + ((next.lat - p.lat) * j) / n,
      lon: wrapped(p.lon + (dLon * j) / n),
    }));
  });
}

/**
 * A drawn box's outline as seen: only its edges, where the region is on one
 * side and not the other. What only closes the stored rings (the way to an
 * enclosed pole and back, along a pole) or a flat map's seam inside the region
 * has the region on both sides, and is not drawn. An edge that ends at a pole
 * keeps its end there.
 */
export function drawnOutline(polygons: number[][][][]): TLatLon[][] {
  const region = prepareCountry(polygons);
  const holds = (lat: number, lon: number) => countryContains(region, lat, lon);
  const atPole = (p: number[]) => Math.abs(p[1]) >= 90;
  // The far probe stays within the region's own size: a box a few hundredths of
  // a degree across kept its cells and lost its outline.
  const across = regionSize(polygons);
  return polygons.flat().flatMap((ring) => {
    const n = ring.length - 1;
    const edge = (k: number) => {
      const [a, b] = [ring[k], ring[k + 1]];
      return !(atPole(a) && atPole(b)) && separates(a, b, holds, across);
    };
    // From a piece that is not an edge, so none is split across the start.
    const from = Math.max(
      0,
      Array.from({ length: n }, (_, k) => k).findIndex((k) => !edge(k))
    );
    const runs: TLatLon[][] = [[]];
    for (let j = 0; j < n; j++) {
      const k = (from + j) % n;
      const run = runs.at(-1)!;
      if (edge(k)) {
        if (!run.length) {
          run.push({ lat: ring[k][1], lon: ring[k][0] });
        }
        run.push({ lat: ring[k + 1][1], lon: ring[k + 1][0] });
      } else if (run.length) {
        runs.push([]);
      }
    }
    return runs.filter((run) => run.length > 1).map(inDegreeSteps);
  });
}

/**
 * The narrower of a shape's latitude and (scaled) longitude extents, in
 * degrees: how far beside an edge the shape can be looked for.
 */
function regionSize(polygons: number[][][][]) {
  let [south, north, west, east] = [90, -90, Infinity, -Infinity];
  for (const [lon, lat] of polygons.flat(2)) {
    [south, north] = [Math.min(south, lat), Math.max(north, lat)];
    [west, east] = [Math.min(west, lon), Math.max(east, lon)];
  }
  const c = Math.cos((((south + north) / 2) * Math.PI) / 180);
  return Math.max(1e-6, Math.min(north - south, (east - west) * c));
}

/**
 * Whether a piece of a ring (`a`–`b`, straight in latitude/longitude as the
 * calculation reads it) has the region on one side only: tested a
 * millionth of a degree either side of its middle.
 */
function separates(
  a: number[],
  b: number[],
  holds: (lat: number, lon: number) => boolean,
  across = Infinity
) {
  const dLon = step(a[0], b[0]);
  const lat = (a[1] + b[1]) / 2;
  const lon = a[0] + dLon / 2;
  const c = Math.max(1e-9, Math.cos((lat * Math.PI) / 180));
  const [dx, dy] = [dLon * c, b[1] - a[1]];
  const length = Math.hypot(dx, dy);
  if (length < 1e-12) {
    return false;
  }
  // Beside it, at two distances: a flat map's seam, traced on both sides to
  // within 0.005°, leaves a sliver under 0.01° between its copies, the region
  // beyond it on both sides. Near a pole, less than the way to it. A region
  // thinner than the far probe has it outside on both sides instead: that is an
  // edge.
  const far = Math.min(0.02, (90 - Math.abs(lat)) / 2, across / 4);
  const sides = (d: number) => {
    const [nx, ny] = [(-dy / length) * d, (dx / length) * d];
    return [holds(lat + ny, lon + nx / c), holds(lat - ny, lon - nx / c)];
  };
  const [a1, b1] = sides(1e-6);
  const [a2, b2] = sides(Math.max(1e-6, far));
  return a1 !== b1 && !(a2 && b2);
}

/**
 * A box being drawn on a latitude/longitude map, straight from its screen
 * rectangle (`at`: the overlay's corner): the sides `edges` shows (0 south,
 * 1 east, 2 north, 3 west, as for a saved box) and its inside to light.
 */
export function screenBoxPaths(rect: TScreenRect, edges: number[], at: TXY) {
  const [x0, y0, x1, y1] = [
    rect.x0 - at.x,
    rect.y0 - at.y,
    rect.x1 - at.x,
    rect.y1 - at.y,
  ].map((v) => v.toFixed(1));
  const sides = [
    `M${x0},${y1}H${x1}`,
    `M${x1},${y1}V${y0}`,
    `M${x0},${y0}H${x1}`,
    `M${x0},${y0}V${y1}`,
  ];
  return {
    paths: edges.map((k) => sides[k]),
    ring: [`M${x0},${y0}H${x1}V${y1}H${x0}Z`],
  };
}
