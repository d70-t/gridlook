/**
 * Locating a point on a grid by its own 1-D axes (projected x/y, rotated
 * latitude/longitude): exact against the cells' published sides, which are
 * straight in those coordinates, not in latitude and longitude.
 */

/** Each cell's [low, high] along an axis: published, else halfway. */
export function axisSides(
  centres: ArrayLike<number>,
  bounds?: ArrayLike<number>,
  /** A periodic axis's turn (360 for longitudes): sides taken near their
   * centre, so [290°, 30°] about 0° is [−70°, 30°]. */
  period?: number
) {
  const n = centres.length;
  const low = new Float64Array(n);
  const high = new Float64Array(n);
  for (let k = 0; k < n; k++) {
    const c = centres[k];
    const before = k > 0 ? (centres[k - 1] + c) / 2 : undefined;
    const after = k + 1 < n ? (c + centres[k + 1]) / 2 : undefined;
    // Halfway edges, mirrored at the axis ends.
    const a = before ?? (after !== undefined ? 2 * c - after : c);
    const b = after ?? (before !== undefined ? 2 * c - before : c);
    const [halfLow, halfHigh] = a <= b ? [a, b] : [b, a];
    const known = [bounds?.[2 * k], bounds?.[2 * k + 1]]
      .filter((v): v is number => v !== undefined && Number.isFinite(v))
      .map((v) => (period ? v - period * Math.round((v - c) / period) : v));
    if (known.length === 2) {
      [low[k], high[k]] = known[0] <= known[1] ? known : [known[1], known[0]];
    } else if (known.length === 1) {
      [low[k], high[k]] =
        known[0] <= c ? [known[0], halfHigh] : [halfLow, known[0]];
    } else {
      [low[k], high[k]] = [halfLow, halfHigh];
    }
  }
  return { low, high, centres };
}

/** The cell holding `v` (its nearest centre among several), or −1. */
export function containingIndex(
  sides: ReturnType<typeof axisSides>,
  v: number
) {
  let best = -1;
  for (let k = 0; k < sides.low.length; k++) {
    if (
      v >= sides.low[k] &&
      v <= sides.high[k] &&
      (best < 0 ||
        Math.abs(sides.centres[k] - v) < Math.abs(sides.centres[best] - v))
    ) {
      best = k;
    }
  }
  return best;
}

/**
 * The cell holding longitude `v` in any of its turns: the published sides are
 * the periodic boundary, not the outer centres' midpoint.
 */
export function containingPeriodic(
  sides: ReturnType<typeof axisSides>,
  v: number
) {
  let [lo, hi] = [Infinity, -Infinity];
  for (let k = 0; k < sides.low.length; k++) {
    lo = Math.min(lo, sides.low[k]);
    hi = Math.max(hi, sides.high[k]);
  }
  let best = -1;
  let distance = Infinity;
  for (let turn = Math.floor((lo - v) / 360); v + 360 * turn <= hi; turn++) {
    const along = v + 360 * turn;
    const k = containingIndex(sides, along);
    const d = k < 0 ? Infinity : Math.abs(sides.centres[k] - along);
    if (d < distance) {
      [best, distance] = [k, d];
    }
  }
  return best;
}

/** A located (row, column) along two named axes, or undefined. */
export type TAxisLocator = {
  /** The row axis's and the column axis's dimension names. */
  dims: [string, string];
  make: () => Promise<
    (lat: number, lon: number) => [number, number] | undefined
  >;
};
