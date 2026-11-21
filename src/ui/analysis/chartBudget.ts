/**
 * Drawing work bounded by the screen, not by the data: finite extents
 * without spreading values into arguments (any length), and the marks a
 * chart draws thinned to its pixels. Downloads keep every value.
 */

/** The finite minimum and maximum, or undefined when there is none. */
export function extent(...lists: ArrayLike<number>[]) {
  let low = Infinity;
  let high = -Infinity;
  for (const list of lists) {
    for (let at = 0; at < list.length; at++) {
      const v = list[at];
      if (v < low) {
        low = v;
      }
      if (v > high) {
        high = v;
      }
    }
  }
  return low <= high && Number.isFinite(low) && Number.isFinite(high)
    ? { low, high }
    : undefined;
}

/**
 * The points of a scatter worth drawing: one per occupied cell of `cell`
 * pixels (the first met), finite only. Indices into the input.
 */
export function thinScatter(
  xs: ArrayLike<number>,
  ys: ArrayLike<number>,
  toX: (x: number) => number,
  toY: (y: number) => number,
  cell = 1.5
) {
  const seen = new Set<number>();
  const kept: number[] = [];
  for (let at = 0; at < xs.length; at++) {
    const px = toX(xs[at]);
    const py = toY(ys[at]);
    if (!Number.isFinite(px) || !Number.isFinite(py)) {
      continue;
    }
    const key = Math.floor(px / cell) * 65536 + Math.floor(py / cell);
    if (!seen.has(key)) {
      seen.add(key);
      kept.push(at);
    }
  }
  return kept;
}

/**
 * Several scatters in one panel within a total of `budget` marks: cells
 * grow from `cell` pixels until every series together fits (four series
 * of 31,411 days drew 80,397 circles; now a few thousand). Indices per
 * series.
 */
export function budgetedScatter(
  series: { xs: ArrayLike<number>; ys: ArrayLike<number> }[],
  toX: (x: number) => number,
  toY: (y: number) => number,
  { budget = 6000, cell = 2 }: { budget?: number; cell?: number } = {}
) {
  let size = cell;
  for (let round = 0; ; round++) {
    const kept = series.map((s) => thinScatter(s.xs, s.ys, toX, toY, size));
    const total = kept.reduce((sum, k) => sum + k.length, 0);
    if (total <= budget || round >= 8) {
      return { kept, cell: size };
    }
    size *= Math.max(1.2, Math.sqrt(total / budget));
  }
}

/** Dots as one SVG path (a circle per point), one element per series. */
export function dotsPath(points: { x: number; y: number }[], r: number) {
  const d = 2 * r;
  return points
    .map(
      (p) =>
        `M${(p.x - r).toFixed(1)},${p.y.toFixed(1)}a${r},${r} 0 1,0 ${d},0a${r},${r} 0 1,0 ${-d},0`
    )
    .join("");
}

/**
 * A line for the screen: per pixel column its first, lowest, highest and
 * last points, in order, so peaks survive. Points in x order; a non-finite
 * y is a gap and is kept as one.
 */
export function thinLine<T extends { x: number; y: number }>(
  points: T[],
  toX: (x: number) => number
): T[] {
  if (points.length <= 4096) {
    return points;
  }
  const out: T[] = [];
  let column = Number.NaN;
  let group: T[] = [];
  const flush = () => {
    if (!group.length) {
      return;
    }
    let low = group[0];
    let high = group[0];
    for (const p of group) {
      low = p.y < low.y ? p : low;
      high = p.y > high.y ? p : high;
    }
    const picked = [group[0], low, high, group[group.length - 1]];
    out.push(...[...new Set(picked)].sort((a, b) => a.x - b.x));
    group = [];
  };
  for (const p of points) {
    if (!Number.isFinite(p.y)) {
      flush();
      out.push(p);
      continue;
    }
    const c = Math.floor(toX(p.x));
    if (c !== column) {
      flush();
      column = c;
    }
    group.push(p);
  }
  flush();
  return out;
}
