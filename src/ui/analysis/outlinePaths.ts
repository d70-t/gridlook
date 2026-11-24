/**
 * Outlines on screen as SVG paths. A line that crosses a flat map's seam, or
 * goes behind the globe's horizon, is cut exactly there (found by halving), so
 * it reaches the map's edge or the limb on both sides instead of stopping one
 * segment short.
 */
type TPoint = { lat: number; lon: number };
type TXY = { x: number; y: number };
type TScreen = { x: number; y: number; visible: boolean } | null;
type TProject = (lat: number, lon: number) => TScreen;

const HALVINGS = 20;

/** Longitude step into (−180, 180]. */
const step = (from: number, to: number) =>
  180 - ((((180 - (to - from)) % 360) + 360) % 360);

/** Between two points, as an outline's edge runs in latitude/longitude. */
const between = (a: TPoint, b: TPoint, t: number): TPoint => ({
  lat: a.lat + (b.lat - a.lat) * t,
  lon: a.lon + step(a.lon, b.lon) * t,
});

const seenAt = (project: TProject, p: TPoint): TXY | undefined => {
  const s = project(p.lat, p.lon);
  return s?.visible ? { x: s.x, y: s.y } : undefined;
};

/**
 * Whether the screen tears between two places (a flat map's seam): their middle
 * lands far from the middle of their screen positions. Free of scale, unlike a
 * jump in pixels: along a line the middle stays near the chord.
 */
export function tornBetween(
  project: TProject,
  a: TPoint,
  b: TPoint,
  [pa, pb]: [TXY, TXY]
) {
  const gap = Math.hypot(pb.x - pa.x, pb.y - pa.y);
  if (gap < 8) {
    return false;
  }
  const m = seenAt(project, between(a, b, 0.5));
  return (
    !!m &&
    Math.hypot(m.x - (pa.x + pb.x) / 2, m.y - (pa.y + pb.y) / 2) > gap / 4
  );
}

/** The last place on screen from `seen` toward `hidden` (the horizon). */
function limb(project: TProject, seen: TPoint, hidden: TPoint) {
  let [lo, hi] = [0, 1];
  for (let k = 0; k < HALVINGS; k++) {
    const t = (lo + hi) / 2;
    if (seenAt(project, between(seen, hidden, t))) {
      lo = t;
    } else {
      hi = t;
    }
  }
  return seenAt(project, between(seen, hidden, lo));
}

/** Both sides of a seam between `a` and `b`: where the screen tears. */
function seam(project: TProject, a: TPoint, b: TPoint, at: [TXY, TXY]) {
  let [lo, hi] = [0, 1];
  let [near, far] = at;
  for (let k = 0; k < HALVINGS; k++) {
    const t = (lo + hi) / 2;
    const m = seenAt(project, between(a, b, t));
    if (!m) {
      break;
    }
    if (
      Math.hypot(m.x - near.x, m.y - near.y) <=
      Math.hypot(m.x - far.x, m.y - far.y)
    ) {
      [lo, near] = [t, m];
    } else {
      [hi, far] = [t, m];
    }
  }
  return [near, far];
}

const fmt = (q: TXY) => `${q.x.toFixed(1)},${q.y.toFixed(1)}`;

/** One polyline as a path, lifting the pen where the map does not show it. */
function edgePath(edge: TPoint[], project: TProject) {
  let d = "";
  let open = false;
  const lineTo = (q: TXY) => {
    d += `${open ? "L" : "M"}${fmt(q)}`;
    open = true;
  };
  const moveTo = (q: TXY) => {
    d += `M${fmt(q)}`;
    open = true;
  };
  let prev: { point: TPoint; at?: TXY } | undefined;
  for (const point of edge) {
    const at = seenAt(project, point);
    if (prev?.at && at) {
      if (tornBetween(project, prev.point, point, [prev.at, at])) {
        const [before, after] = seam(project, prev.point, point, [prev.at, at]);
        lineTo(before);
        moveTo(after);
      }
      lineTo(at);
    } else if (prev?.at) {
      // Into the far side: up to the horizon, then the pen lifts.
      const edgeAt = limb(project, prev.point, point);
      if (edgeAt) {
        lineTo(edgeAt);
      }
      open = false;
    } else if (at) {
      // Back from the far side (or the first point): from the horizon.
      const edgeAt = prev ? limb(project, point, prev.point) : undefined;
      moveTo(edgeAt ?? at);
      if (edgeAt) {
        lineTo(at);
      }
    }
    prev = { point, at };
  }
  return d;
}

/** An outline (`edges`: polylines) on screen. */
export function outlinePaths(edges: TPoint[][], project: TProject) {
  return edges
    .map((edge) => edgePath(edge, project))
    .filter((d) => d.length > 0);
}
