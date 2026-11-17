import type { TLatLon } from "./sphere.ts";

/**
 * An edge the atlas adds to close a ring, not a coast or border: along the
 * ±180° meridian or along a pole (Antarctica's ring runs down the date line
 * to the South Pole and back; 24 Nov: it was drawn as a line to the pole).
 */
const AT_SEAM = 179.9999;
const AT_POLE = 89.9999;
function closingEdge(a: number[], b: number[]) {
  const seam =
    Math.abs(a[0]) >= AT_SEAM &&
    Math.abs(b[0]) >= AT_SEAM &&
    Math.sign(a[0]) === Math.sign(b[0]);
  const pole = Math.abs(a[1]) >= AT_POLE && Math.abs(b[1]) >= AT_POLE;
  return seam || pole;
}

/**
 * A ring as the lines it draws: one closed line, or (with closing edges)
 * the open runs between them.
 */
function drawnRuns(ring: number[][]) {
  const runs: number[][][] = [];
  let run: number[][] = [ring[0]];
  for (let at = 1; at < ring.length; at++) {
    if (closingEdge(ring[at - 1], ring[at])) {
      if (run.length > 1) {
        runs.push(run);
      }
      run = [];
    }
    run.push(ring[at]);
  }
  if (run.length > 1) {
    runs.push(run);
  }
  // The run that wraps past the ring's start joins the first one.
  if (runs.length > 1 && !closingEdge(ring[ring.length - 2], ring[0])) {
    const last = runs.pop()!;
    runs[0] = [...last, ...runs[0].slice(1)];
  }
  return runs;
}

/**
 *  Bound per-frame projection work. Only the map preview samples the rings.
 * Keep each island and hole closed, including the smallest three-point rings;
 * edges the atlas adds to close a ring are not drawn.
 */
export function countryOutline(polygons: number[][][][]): TLatLon[][] {
  const rings = polygons.flat().filter((ring) => ring.length >= 4);
  // Largest rings first, so the map's label anchors to a major landmass.
  rings.sort((a, b) => b.length - a.length);
  const count = rings.reduce((n, ring) => n + ring.length - 1, 0);
  const stride = Math.max(1, Math.ceil(count / 2048));
  return rings.flatMap((ring) => {
    const runs = drawnRuns(ring);
    const closed = runs.length === 1 && runs[0].length === ring.length;
    return runs.map((run) => {
      // A closed ring repeats its first point last; an open run keeps both
      // ends where they are.
      const length = closed ? run.length - 1 : run.length;
      const samples = Math.min(
        length,
        Math.max(closed ? 3 : 2, Math.ceil(length / stride))
      );
      const points = Array.from({ length: samples }, (_, at) => {
        const [lon, lat] = run[Math.floor((at * length) / samples)];
        return { lon, lat };
      });
      if (closed) {
        return [...points, points[0]];
      }
      const [lon, lat] = run[run.length - 1];
      const end = points.at(-1);
      return end && end.lon === lon && end.lat === lat
        ? points
        : [...points, { lon, lat }];
    });
  });
}
