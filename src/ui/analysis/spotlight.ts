/**
 * The spotlight: while an area is being chosen (a country or an imported
 * shape) or its plot's ID is pointed at, the map outside it is dimmed, so
 * the area stands out whatever the colour map. An outline alone can match
 * the colours under it (an orange line on an orange map).
 */
import { tornBetween } from "./outlinePaths.ts";

/**
 * A box's or drawn polygon's outline edges (each densified, a box's
 * parallels both drawn eastward) as one ring in order around: south edge
 * eastward, east side, north edge westward, west side.
 */
export function ringAround<T>(edges: T[][], box: boolean): T[] {
  const ordered = box
    ? [edges[0], edges[1], [...(edges[2] ?? [])].reverse(), edges[3]]
    : edges;
  return ordered.flatMap((edge) => edge ?? []);
}

/** Previews of an area being chosen, before its plot exists. */
// The box being drawn is lit too: its inside is what will be computed.
const PREVIEWS = new Set(["country-preview", "shape-preview", "drawing-box"]);

/**
 * The areas to keep lit, as one SVG path (filled even–odd, so an enclave
 * such as Lesotho in South Africa stays dimmed), or undefined for none.
 * Only closed shapes count: a point or a path has no inside.
 */
export function spotlightPath(
  shapes: {
    id: string;
    closed: boolean;
    paths: string[];
    ring?: string[];
    lit?: () => string[];
  }[],
  highlightId?: string
) {
  const lit = shapes.filter(
    (shape) =>
      shape.closed &&
      shape.paths.length > 0 &&
      (PREVIEWS.has(shape.id) || shape.id === highlightId)
  );
  // A box or drawn polygon is outlined edge by edge: its inside is its
  // ring, closed (separate edges would light only the slivers between
  // each curved edge and its chord).
  return lit.length
    ? lit
        .flatMap((shape) => shape.lit?.() ?? shape.ring ?? shape.paths)
        .join(" ")
    : undefined;
}

type TPoint = { lat: number; lon: number };
type TScreen = { x: number; y: number; visible: boolean } | null;
type TProjectFn = (lat: number, lon: number) => TScreen;

/** `ring` (lon/lat, unwrapped) clipped to one side of a line (Sutherland–Hodgman). */
function clipSide(
  ring: TPoint[],
  inside: (p: TPoint) => boolean,
  cross: (a: TPoint, b: TPoint) => TPoint
) {
  const out: TPoint[] = [];
  ring.forEach((p, at) => {
    const q = ring[(at + 1) % ring.length];
    const [pin, qin] = [inside(p), inside(q)];
    if (pin) {
      out.push(p);
    }
    if (pin !== qin) {
      out.push(cross(p, q));
    }
  });
  return out;
}

/** `ring` clipped to a lon/lat cell [w, e] × [s, n] (a convex window). */
function clipToCell(
  ring: TPoint[],
  [w, e, s, n]: [number, number, number, number]
) {
  const atLon = (lon: number) => (a: TPoint, b: TPoint) => ({
    lon,
    lat: a.lat + ((b.lat - a.lat) * (lon - a.lon)) / (b.lon - a.lon),
  });
  const atLat = (lat: number) => (a: TPoint, b: TPoint) => ({
    lat,
    lon: a.lon + ((b.lon - a.lon) * (lat - a.lat)) / (b.lat - a.lat),
  });
  let piece = clipSide(ring, (p) => p.lon >= w, atLon(w));
  piece = clipSide(piece, (p) => p.lon <= e, atLon(e));
  piece = clipSide(piece, (p) => p.lat >= s, atLat(s));
  return clipSide(piece, (p) => p.lat <= n, atLat(n));
}

/** The piece's outline in steps of at most `step` degrees (edges curve on screen). */
function densified(piece: TPoint[], step: number) {
  return piece.flatMap((p, at) => {
    const q = piece[(at + 1) % piece.length];
    const parts = Math.max(
      1,
      Math.ceil(
        Math.max(Math.abs(q.lon - p.lon), Math.abs(q.lat - p.lat)) / step
      )
    );
    return Array.from({ length: parts }, (_, k) => ({
      lat: p.lat + ((q.lat - p.lat) * k) / parts,
      lon: p.lon + ((q.lon - p.lon) * k) / parts,
    }));
  });
}

/**
 * Longitudes unwrapped along a ring: a box from 170°E to 170°W spans
 * 170..190, not 340 degrees the other way.
 */
function unwrappedRing(ring: TPoint[]) {
  const unwrapped: TPoint[] = [];
  for (const p of ring) {
    const previous = unwrapped.at(-1);
    let lon = p.lon;
    if (previous) {
      lon += 360 * Math.round((previous.lon - lon) / 360);
    }
    unwrapped.push({ lat: p.lat, lon });
  }
  return unwrapped;
}

/** How far (px) a drawn segment may stray from the ring's own edge. */
const STRAY_PIXELS = 0.01;

/**
 * Points between those of a piece where its straight latitude/longitude edge
 * curves on screen, until each drawn segment is within STRAY_PIXELS of it.
 */
function refined(points: TPoint[], project: TProjectFn) {
  const out: TPoint[] = [];
  const between = (p: TPoint, q: TPoint, depth: number) => {
    const [a, b] = [project(p.lat, p.lon), project(q.lat, q.lon)];
    let lon = q.lon - p.lon;
    lon -= 360 * Math.round(lon / 360);
    const mid = { lat: (p.lat + q.lat) / 2, lon: p.lon + lon / 2 };
    const m =
      depth < 12 && a?.visible && b?.visible && project(mid.lat, mid.lon);
    if (
      m &&
      m.visible &&
      Math.hypot(m.x - (a.x + b.x) / 2, m.y - (a.y + b.y) / 2) > STRAY_PIXELS
    ) {
      between(p, mid, depth + 1);
      out.push(mid);
      between(mid, q, depth + 1);
    }
  };
  points.forEach((p, at) => {
    out.push(p);
    between(p, points[(at + 1) % points.length], 0);
  });
  return out.map((p) => ({
    lat: p.lat,
    lon: ((((p.lon + 180) % 360) + 360) % 360) - 180,
  }));
}

/** A piece on screen, or undefined where it is unseen or torn by a seam. */
function onScreen(piece: TPoint[], step: number, project: TProjectFn) {
  const points = refined(densified(piece, step), project);
  const screen = points.map((p) => project(p.lat, p.lon));
  const whole =
    screen.every((p) => p?.visible) &&
    screen.every((p, at) => {
      const next = (at + 1) % screen.length;
      const q = screen[next]!;
      return !tornBetween(project, points[at], points[next], [p!, q]);
    });
  return {
    path: whole
      ? `${screen.map((p, at) => `${at ? "L" : "M"}${p!.x.toFixed(3)},${p!.y.toFixed(3)}`).join("")}Z`
      : undefined,
    seen: screen.some((p) => p?.visible),
  };
}

const rangeOf = (values: number[]) => [
  Math.min(...values),
  Math.max(...values),
];

/**
 * The longitude where a flat map's seam crosses a cell, if it does: a cell
 * still torn at the finest split is lit on both sides of it.
 */
function seamIn(
  [w, e, s, n]: [number, number, number, number],
  project: TProjectFn
) {
  const lat = (s + n) / 2;
  const at = (lon: number) => {
    const p = { lat, lon: ((((lon + 180) % 360) + 360) % 360) - 180 };
    return { p, s: project(p.lat, p.lon) };
  };
  const [a, b] = [at(w), at(e)];
  if (!a.s?.visible || !b.s?.visible) {
    return undefined;
  }
  if (!tornBetween(project, a.p, b.p, [a.s, b.s])) {
    return undefined;
  }
  let [lo, hi] = [w, e];
  for (let k = 0; k < 40; k++) {
    const mid = (lo + hi) / 2;
    const m = at(mid).s;
    if (!m) {
      return undefined;
    }
    const nearA = Math.hypot(m.x - a.s.x, m.y - a.s.y);
    const nearB = Math.hypot(m.x - b.s.x, m.y - b.s.y);
    if (nearA <= nearB) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return (lo + hi) / 2;
}

/** Per ring: its unwrapped points, extent and clipped cells (view-free). */
const tessellation = new WeakMap<
  TPoint[],
  {
    unwrapped?: TPoint[];
    range?: number[][];
    pieces: Map<string, TPoint[]>;
  }
>();

/**
 * A ring's view-free work, kept per ring, so a pan only projects: its unwrapped
 * points, extent, and each cell clipped to it.
 */
function tessellated(ring: TPoint[]) {
  const kept = tessellation.get(ring) ?? {
    pieces: new Map<string, TPoint[]>(),
  };
  tessellation.set(ring, kept);
  kept.unwrapped ??= unwrappedRing(ring);
  const unwrapped = kept.unwrapped;
  kept.range ??= [
    rangeOf(unwrapped.map((p) => p.lon)),
    rangeOf(unwrapped.map((p) => p.lat)),
  ];
  const clipped = (cell: [number, number, number, number]) => {
    const key = cell.join(",");
    let piece = kept.pieces.get(key);
    if (!piece) {
      piece = clipToCell(unwrapped, cell);
      if (kept.pieces.size < 4096) {
        kept.pieces.set(key, piece);
      }
    }
    return piece;
  };
  return { range: kept.range, clipped };
}

/**
 * The inside of a ring on screen, as closed paths to fill: the ring's
 * lon/lat extent is cut into cells (of about `degrees`), each clipped to
 * the ring and drawn on
 * its own; a cell crossing the globe's limb or a flat map's seam is split
 * again (`depth` times) and its unseen or torn parts left out. So an area
 * across the antimeridian or the horizon is lit where it shows, and no
 * chord cuts through it.
 */
export function litPieces(
  ring: TPoint[],
  project: TProjectFn,
  { degrees = 8, depth = 4 }: { degrees?: number; depth?: number } = {}
) {
  if (ring.length < 3) {
    return [];
  }
  const { range, clipped } = tessellated(ring);
  const [[w, e], [s, n]] = range;
  const paths: string[] = [];
  const draw = (cell: [number, number, number, number], left: number) => {
    const piece = clipped(cell);
    if (piece.length < 3) {
      return;
    }
    const step = Math.max(cell[1] - cell[0], cell[3] - cell[2]) / 4;
    const shown = onScreen(piece, step || 1, project);
    if (shown.path) {
      paths.push(shown.path);
      return;
    }
    const [cw, ce, cs, cn] = cell;
    if (left > 0 && shown.seen) {
      const [mx, my] = [(cw + ce) / 2, (cs + cn) / 2];
      draw([cw, mx, cs, my], left - 1);
      draw([mx, ce, cs, my], left - 1);
      draw([cw, mx, my, cn], left - 1);
      draw([mx, ce, my, cn], left - 1);
      return;
    }
    const seam = left === 0 && shown.seen ? seamIn(cell, project) : undefined;
    if (seam !== undefined) {
      draw([cw, seam - 1e-7, cs, cn], -1);
      draw([seam + 1e-7, ce, cs, cn], -1);
    }
  };
  // Cells of about `degrees` (16 a side at most), split only where needed.
  const nx = Math.min(16, Math.max(1, Math.ceil((e - w) / degrees)));
  const ny = Math.min(16, Math.max(1, Math.ceil((n - s) / degrees)));
  const dx = (e - w) / nx || 1;
  const dy = (n - s) / ny || 1;
  for (let i = 0; i < nx; i++) {
    for (let j = 0; j < ny; j++) {
      draw([w + i * dx, w + (i + 1) * dx, s + j * dy, s + (j + 1) * dy], depth);
    }
  }
  return paths;
}
