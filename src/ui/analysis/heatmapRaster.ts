/**
 * Pixel layout of a time × axis heatmap: which source rows and columns each
 * pixel shows, with no more work than the cells plus the pixels.
 *
 * - Time cells use declared bounds when the source has them. Otherwise an
 *   instantaneous sample covers at most half the typical spacing on either
 *   side, so a long gap between samples stays visible as unsampled time.
 * - When more rows (or columns) than pixels share the plot, each pixel shows
 *   the most extreme value of the cells it covers (largest deviation from
 *   the plot's mean), so a short event is not dropped.
 */

/** Pixel states besides a value. */
export const PIXEL = { VALUE: 0, MISSING: 1, UNREAD: 2, GAP: 3 } as const;

export type TCells = { lo: Float64Array; hi: Float64Array };

/** Cells along an axis: declared bounds, or halfway to each neighbour. */
/**
 * Axis cells from edges (n + 1), from each cell's own [low, high] (2n,
 * layers that need not join: a gap stays empty), or from midpoints.
 */
// eslint-disable-next-line max-lines-per-function
export function axisCells(values: ArrayLike<number>, bounds?: number[]) {
  const n = values.length;
  if (bounds && n > 1 && bounds.length === 2 * n) {
    const lo = new Float64Array(n);
    const hi = new Float64Array(n);
    for (let at = 0; at < n; at++) {
      lo[at] = Math.min(bounds[2 * at], bounds[2 * at + 1]);
      hi[at] = Math.max(bounds[2 * at], bounds[2 * at + 1]);
    }
    return { lo, hi };
  }
  const lo = new Float64Array(n);
  const hi = new Float64Array(n);
  if (bounds && bounds.length === n + 1) {
    for (let at = 0; at < n; at++) {
      lo[at] = Math.min(bounds[at], bounds[at + 1]);
      hi[at] = Math.max(bounds[at], bounds[at + 1]);
    }
    return { lo, hi };
  }
  // Halfway to the nearest known neighbours: a position that is not known (a
  // missing hybrid coefficient) has no cell, and its neighbours keep theirs.
  // Neighbours by position, not by storage.
  const known: number[] = [];
  for (let at = 0; at < n; at++) {
    if (Number.isFinite(values[at])) {
      known.push(at);
    }
  }
  if (
    known.some(
      (_, k) => k > 1 && order(values, known, k) !== order(values, known, 1)
    )
  ) {
    known.sort((a, b) => values[a] - values[b]);
  }
  lo.fill(Number.NaN);
  hi.fill(Number.NaN);
  for (let k = 0; k < known.length; k++) {
    const v = values[known[k]];
    const prev = k > 0 ? values[known[k - 1]] : undefined;
    const next = k + 1 < known.length ? values[known[k + 1]] : undefined;
    const before =
      prev !== undefined
        ? (prev + v) / 2
        : next !== undefined
          ? v - (next - v) / 2
          : v - 0.5;
    const after =
      next !== undefined
        ? (v + next) / 2
        : prev !== undefined
          ? v + (v - prev) / 2
          : v + 0.5;
    lo[known[k]] = Math.min(before, after);
    hi[known[k]] = Math.max(before, after);
  }
  return { lo, hi };
}

function median(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
}

/**
 * Time cells: declared bounds ([lo, hi] per step), or each sample reaching
 * halfway to its neighbours but no farther than half the median spacing.
 * Declared bounds that overlap heavily (accumulations since a fixed start)
 * would put most steps under every pixel, at quadratic cost: those steps
 * are drawn around their time coordinates instead, and `overlapping` says
 * so. Bounds that coincide or barely overlap are drawn as declared.
 */
export function timeCells(
  raw: ArrayLike<number>,
  bounds?: number[]
): TCells & { gaps: boolean; overlapping?: boolean } {
  const n = raw.length;
  if (bounds && bounds.length === 2 * n) {
    const lo = new Float64Array(n);
    const hi = new Float64Array(n);
    for (let at = 0; at < n; at++) {
      lo[at] = Math.min(bounds[2 * at], bounds[2 * at + 1]);
      hi[at] = Math.max(bounds[2 * at], bounds[2 * at + 1]);
    }
    if (!heavyOverlap({ lo, hi }, 4 * n)) {
      return { lo, hi, gaps: hasGaps({ lo, hi }) };
    }
    return { ...timeCells(raw), overlapping: true };
  }
  // A missing time has no cell (NaN, skipped when drawn); its neighbours
  // reach toward each other as if it were not there.
  const usable: number[] = [];
  for (let at = 0; at < n; at++) {
    if (Number.isFinite(raw[at])) {
      usable.push(at);
    }
  }
  // Neighbours in time, not in storage: a source may store dates out of
  // order, and each sample's cell must reach only toward its own neighbours.
  const order = [...usable].sort((a, b) => raw[a] - raw[b]);
  const stored =
    order.every((at, k) => at === usable[k]) ||
    order.every((at, k) => at === usable[usable.length - 1 - k]);
  // Spacing per step: across a missing date the distance covers two steps,
  // so its neighbours stay their own width and the missing step stays empty
  // (storage steps count only when storage follows time).
  const steps: number[] = [];
  for (let k = 1; k < order.length; k++) {
    const [a, b] = [order[k - 1], order[k]];
    steps.push((raw[b] - raw[a]) / (stored ? Math.abs(b - a) : 1));
  }
  const half = (median(steps) || 1) / 2;
  const own = axisCells(order.map((at) => raw[at]));
  const lo = new Float64Array(n).fill(Number.NaN);
  const hi = new Float64Array(n).fill(Number.NaN);
  order.forEach((at, k) => {
    lo[at] = Math.max(own.lo[k], raw[at] - half);
    hi[at] = Math.min(own.hi[k], raw[at] + half);
  });
  const cells = { lo, hi };
  return { ...cells, gaps: hasGaps(cells) };
}

function byStart(cells: TCells) {
  return Array.from(cells.lo, (_, at) => at)
    .filter((at) => Number.isFinite(cells.lo[at]))
    .sort((a, b) => cells.lo[a] - cells.lo[b]);
}

function hasGaps(cells: TCells) {
  const order = byStart(cells);
  for (let k = 1; k < order.length; k++) {
    const previous = cells.hi[order[k - 1]];
    const next = cells.lo[order[k]];
    if (next - previous > 1e-9 * Math.max(1, Math.abs(next))) {
      return true;
    }
  }
  return false;
}

/**
 * Whether the cells active between consecutive boundaries sum to more than
 * `limit`: the most entries the pixel sweep could need at full resolution.
 */
function heavyOverlap(cells: TCells, limit: number) {
  const events: number[][] = [];
  for (let at = 0; at < cells.lo.length; at++) {
    if (Number.isFinite(cells.lo[at]) && cells.hi[at] > cells.lo[at]) {
      events.push([cells.lo[at], 1], [cells.hi[at], -1]);
    }
  }
  events.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  let active = 0;
  let total = 0;
  for (let k = 0; k < events.length; k++) {
    active += events[k][1];
    if (active > 0 && events[k + 1]?.[0] > events[k][0]) {
      total += active;
      if (total > limit) {
        return true;
      }
    }
  }
  return false;
}

export function extent(cells: TCells) {
  let low = Number.POSITIVE_INFINITY;
  let high = Number.NEGATIVE_INFINITY;
  for (let at = 0; at < cells.lo.length; at++) {
    if (Number.isFinite(cells.lo[at]) && Number.isFinite(cells.hi[at])) {
      low = Math.min(low, cells.lo[at]);
      high = Math.max(high, cells.hi[at]);
    }
  }
  return { low, high };
}

type TAxisMap = {
  /** Per pixel: an index into the (reduced) cells, or −1. */
  index: Int32Array;
  /** Reduced: pixel p gathers these cells (CSR layout); else undefined. */
  members?: { start: Int32Array; items: Int32Array };
  size: number;
};

/**
 * Which cells cover each of `pixels` pixels. `toPixel` maps a coordinate to
 * a fractional pixel position (either direction).
 */
/** One cell per pixel into `index`; false as soon as two cells collide. */
function mapDirect(
  index: Int32Array,
  n: number,
  span: (at: number) => number[]
) {
  for (let at = 0; at < n; at++) {
    const [p0, p1] = span(at);
    for (let p = p0; p < p1; p++) {
      if (index[p] >= 0) {
        return false;
      }
      index[p] = at;
    }
  }
  return true;
}

function mapAxis(
  cells: TCells,
  pixels: number,
  toPixel: (value: number) => number
): TAxisMap {
  const n = cells.lo.length;
  // Pixels [p0, p1) a cell covers; empty ([0, 0]) for a cell with no
  // finite position (a missing time) or one wholly outside the view.
  const span = (at: number) => {
    const a = toPixel(cells.lo[at]);
    const b = toPixel(cells.hi[at]);
    if (!Number.isFinite(a) || !Number.isFinite(b)) {
      return [0, 0];
    }
    const p0 = Math.max(0, Math.floor(Math.min(a, b)));
    const p1 = Math.min(pixels, Math.max(p0 + 1, Math.ceil(Math.max(a, b))));
    return p1 > p0 ? [p0, p1] : [0, 0];
  };
  const index = new Int32Array(pixels).fill(-1);
  // Direct mapping only while no two cells share a pixel: irregular
  // coordinates can put several cells in one pixel even when there are
  // fewer cells than pixels, and then the extreme rule must apply.
  if (n <= pixels && mapDirect(index, n, span)) {
    return { index, size: n };
  }
  index.fill(-1);
  return sweepGroups(index, n, span, pixels);
}

/**
 * Pixels shared by cells, by an interval sweep: cells enter and leave at
 * their pixel boundaries, and each stretch of pixels between boundaries is
 * one group holding the cells active there. Storage follows the distinct
 * stretches, not pixels × cells: 5,000 coinciding dates over 940 pixels
 * are one group of 5,000, not 4.7 million entries.
 */
// eslint-disable-next-line max-lines-per-function
function sweepGroups(
  index: Int32Array,
  n: number,
  span: (at: number) => number[],
  pixels: number
): TAxisMap {
  const packed: number[] = [];
  for (let at = 0; at < n; at++) {
    const [p0, p1] = span(at);
    // An empty span enters nothing: it must not leave a cell it never
    // entered (and a NaN boundary would stop the sweep advancing).
    if (p1 <= p0) {
      continue;
    }
    // Packed as pixel * 2 + kind (leave 0 before enter 1), with the cell.
    packed.push((p0 * 2 + 1) * (n + 1) + at, p1 * 2 * (n + 1) + at);
  }
  const events = Float64Array.from(packed).sort();
  // Active cells, with each one's place for O(1) removal.
  const active: number[] = [];
  const place = new Int32Array(n).fill(-1);
  const start: number[] = [0];
  const items: number[] = [];
  let k = 0;
  while (k < events.length) {
    const pixel = Math.floor(Math.floor(events[k] / (n + 1)) / 2);
    // Apply every boundary at this pixel.
    while (
      k < events.length &&
      Math.floor(Math.floor(events[k] / (n + 1)) / 2) === pixel
    ) {
      const at = events[k] % (n + 1);
      if (Math.floor(events[k] / (n + 1)) % 2 === 1) {
        place[at] = active.length;
        active.push(at);
      } else {
        const last = active.pop()!;
        if (last !== at) {
          active[place[at]] = last;
          place[last] = place[at];
        }
        place[at] = -1;
      }
      k++;
    }
    const next =
      k < events.length
        ? Math.floor(Math.floor(events[k] / (n + 1)) / 2)
        : pixels;
    if (active.length && next > pixel) {
      for (const at of [...active].sort((x, y) => x - y)) {
        items.push(at);
      }
      start.push(items.length);
      index.fill(start.length - 2, pixel, Math.min(next, pixels));
    }
  }
  return {
    index,
    members: { start: Int32Array.from(start), items: Int32Array.from(items) },
    size: start.length - 1,
  };
}

export type TRaster = {
  /** Values per (time pixel row, axis pixel column) after mapping. */
  value: (timePixel: number, axisPixel: number) => number;
  state: (timePixel: number, axisPixel: number) => number;
  /** Most source cells behind one pixel (1 when nothing is reduced). */
  reducedRows: number;
  /** Values held between the two reduction stages (memory check). */
  intermediateValues: number;
  /** Cell entries in the shared-pixel lookups of both axes (memory check). */
  lookupEntries: number;
  reducedColumns: number;
  /**
   * The cell a pixel shows: its source row and column, and how many read rows
   * and columns share the pixel. Hovering reads it rather than the cells again.
   */
  winner: (
    timePixel: number,
    axisPixel: number
  ) =>
    { row: number; column: number; rows: number; columns: number } | undefined;
};

type TRasterInput = {
  values: ArrayLike<number>;
  rows: TCells;
  columns: TCells;
  /** Rows from this index on were not read. */
  unreadFrom?: number;
  timePixels: number;
  axisPixels: number;
  timeToPixel: (raw: number) => number;
  axisToPixel: (value: number) => number;
};

export function meanOf(values: ArrayLike<number>) {
  let sum = 0;
  let n = 0;
  for (let at = 0; at < values.length; at++) {
    if (Number.isFinite(values[at])) {
      sum += values[at];
      n++;
    }
  }
  return n ? sum / n : 0;
}

/** Map the time and axis cells to pixels, reducing to extremes as needed. */
/**
 * Whether `v` wins a pixel over `held`: farther from `mean`, a tie to the
 * larger value, in the painter and the readout alike.
 */
function fartherThan(v: number, held: number, mean: number) {
  const [a, b] = [Math.abs(v - mean), Math.abs(held - mean)];
  return a > b || (a === b && v > held);
}

/** The most cells behind one pixel: rows × columns when both are reduced. */
export function cellsPerPixel(
  raster: Pick<TRaster, "reducedRows" | "reducedColumns">
) {
  return raster.reducedRows * raster.reducedColumns;
}

// eslint-disable-next-line max-lines-per-function
export function rasterize(input: TRasterInput): TRaster {
  const nRows = input.rows.lo.length;
  const nCols = input.columns.lo.length;
  const unreadFrom = input.unreadFrom ?? nRows;
  const mean = meanOf(input.values);
  const rowMap = mapAxis(input.rows, input.timePixels, input.timeToPixel);
  const colMap = mapAxis(input.columns, input.axisPixels, input.axisToPixel);
  // Stage 1: rows (reduced to pixels when there are more rows than pixels).
  const width = nCols;
  const stage1 = new Float64Array(rowMap.size * width).fill(Number.NaN);
  // The source row behind each stage-1 value (rows reduced only).
  const win1 = rowMap.members
    ? new Int32Array(rowMap.size * width).fill(-1)
    : undefined;
  const unread1 = new Uint8Array(rowMap.size);
  let reducedRows = 1;
  const pick = (current: number, v: number) =>
    Number.isNaN(current) || fartherThan(v, current, mean) ? v : current;
  if (rowMap.members) {
    const { start, items } = rowMap.members;
    for (let p = 0; p < rowMap.size; p++) {
      reducedRows = Math.max(reducedRows, start[p + 1] - start[p]);
      let read = 0;
      for (let k = start[p]; k < start[p + 1]; k++) {
        const row = items[k];
        if (row >= unreadFrom) {
          continue;
        }
        read++;
        for (let c = 0; c < width; c++) {
          const v = input.values[row * width + c];
          if (Number.isFinite(v)) {
            const at = p * width + c;
            const current = stage1[at];
            const next = pick(current, v);
            if (Number.isNaN(current) || next !== current) {
              stage1[at] = next;
              win1![at] = row;
            }
          }
        }
      }
      unread1[p] = read === 0 && start[p + 1] > start[p] ? 1 : 0;
    }
  } else {
    for (let row = 0; row < nRows; row++) {
      unread1[row] = row >= unreadFrom ? 1 : 0;
      for (let c = 0; c < width; c++) {
        stage1[row * width + c] = input.values[row * width + c];
      }
    }
  }
  // Stage 2: columns.
  const rows1 = rowMap.size;
  let reducedColumns = 1;
  let stage2 = stage1;
  let cols2 = width;
  // The source column behind each stage-2 value (columns reduced only).
  let win2: Int32Array | undefined;
  if (colMap.members) {
    const { start, items } = colMap.members;
    cols2 = colMap.size;
    stage2 = new Float64Array(rows1 * cols2).fill(Number.NaN);
    win2 = new Int32Array(rows1 * cols2).fill(-1);
    for (let p = 0; p < cols2; p++) {
      reducedColumns = Math.max(reducedColumns, start[p + 1] - start[p]);
      for (let r = 0; r < rows1; r++) {
        let best = Number.NaN;
        let bestColumn = -1;
        for (let k = start[p]; k < start[p + 1]; k++) {
          const v = stage1[r * width + items[k]];
          if (Number.isFinite(v)) {
            const next = pick(best, v);
            if (Number.isNaN(best) || next !== best) {
              best = next;
              bestColumn = items[k];
            }
          }
        }
        stage2[r * cols2 + p] = best;
        win2[r * cols2 + p] = bestColumn;
      }
    }
  }
  const readRowsIn = (r: number) => {
    if (!rowMap.members) {
      return 1;
    }
    const { start, items } = rowMap.members;
    let n = 0;
    for (let k = start[r]; k < start[r + 1]; k++) {
      n += items[k] < unreadFrom ? 1 : 0;
    }
    return n;
  };
  return {
    reducedRows,
    reducedColumns,
    intermediateValues: stage1.length + (stage2 === stage1 ? 0 : stage2.length),
    lookupEntries:
      (rowMap.members?.items.length ?? 0) + (colMap.members?.items.length ?? 0),
    value: (tp, ap) => {
      const r = rowMap.index[tp];
      const c = colMap.index[ap];
      return r < 0 || c < 0 ? Number.NaN : stage2[r * cols2 + c];
    },
    winner: (tp, ap) => {
      const r = rowMap.index[tp];
      const c = colMap.index[ap];
      if (r < 0 || c < 0 || !Number.isFinite(stage2[r * cols2 + c])) {
        return undefined;
      }
      const column = win2 ? win2[r * cols2 + c] : c;
      const row = win1 ? win1[r * width + column] : r;
      const columns = colMap.members
        ? colMap.members.start[c + 1] - colMap.members.start[c]
        : 1;
      return { row, column, rows: readRowsIn(r), columns };
    },
    state: (tp, ap) => {
      const r = rowMap.index[tp];
      if (r < 0) {
        return PIXEL.GAP;
      }
      if (unread1[r]) {
        return PIXEL.UNREAD;
      }
      const c = colMap.index[ap];
      if (c < 0) {
        return PIXEL.GAP;
      }
      return Number.isFinite(stage2[r * cols2 + c])
        ? PIXEL.VALUE
        : PIXEL.MISSING;
    },
  };
}

/** Ticks at round steps, by a bounded integer index. */
export function niceTicks(low: number, high: number, n: number) {
  const [a, b] = [Math.min(low, high), Math.max(low, high)];
  const span = b - a;
  if (!(span > 0) || !Number.isFinite(span)) {
    return Number.isFinite(a) ? [a] : [];
  }
  const raw = span / Math.max(1, n);
  const magnitude = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10]
    .map((m) => m * magnitude)
    .find((m) => m >= raw)!;
  const first = Math.ceil(a / step);
  // A step lost to rounding (near-equal ends) gives one labelled tick.
  if (!(step > 0) || !Number.isFinite(first)) {
    return [a];
  }
  const ticks: number[] = [];
  for (let i = 0; i <= n + 2; i++) {
    const v = (first + i) * step;
    if (v > b + step * 1e-9) {
      break;
    }
    if (Number.isFinite(v) && (!ticks.length || v > ticks[ticks.length - 1])) {
      ticks.push(v);
    }
  }
  return ticks.length ? ticks : [a];
}

/**
 * Curtain columns: the samples whose extent (edges `xEdges`, in data units
 * mapped by `devX` to device pixels) intersects each of `W` pixel columns.
 */
export function columnMembers(
  xEdges: ArrayLike<number>,
  devX: (d: number) => number,
  W: number
) {
  const ns = xEdges.length - 1;
  const ranges = new Int32Array(2 * ns);
  const counts = new Int32Array(W + 1);
  for (let s = 0; s < ns; s++) {
    const [x0, x1] = [devX(xEdges[s]), devX(xEdges[s + 1])];
    const lo = Math.min(x0, x1);
    const hi = Math.max(x0, x1);
    const a = Math.max(0, Math.min(W - 1, Math.floor(lo)));
    // A zero-width sample still owns the pixel it lies in.
    const b = Math.max(a + 1, Math.min(W, Math.ceil(hi)));
    ranges[2 * s] = a;
    ranges[2 * s + 1] = b;
    for (let x = a; x < b; x++) {
      counts[x + 1]++;
    }
  }
  for (let x = 0; x < W; x++) {
    counts[x + 1] += counts[x];
  }
  const items = new Int32Array(counts[W]);
  const fill = counts.slice(0, W);
  for (let s = 0; s < ns; s++) {
    for (let x = ranges[2 * s]; x < ranges[2 * s + 1]; x++) {
      items[fill[x]++] = s;
    }
  }
  return { start: counts, items };
}

export function sameMembers(
  columns: { start: Int32Array; items: Int32Array },
  a: number,
  b: number
) {
  const n = columns.start[a + 1] - columns.start[a];
  if (n !== columns.start[b + 1] - columns.start[b]) {
    return false;
  }
  for (let k = 0; k < n; k++) {
    if (
      columns.items[columns.start[a] + k] !==
      columns.items[columns.start[b] + k]
    ) {
      return false;
    }
  }
  return true;
}

/**
 * Whether palette code `code` should replace `held` (negative: nothing
 * valid yet) in a pixel that shows several cells: the one farther from
 * `centre` (the code of the plot's mean) wins, ties go to the larger code.
 * A thin peak of 99 among zeros stays visible.
 */
export function moreExtreme(code: number, held: number, centre: number) {
  if (held < 0) {
    return true;
  }
  const a = Math.abs(code - centre);
  const b = Math.abs(held - centre);
  return a > b || (a === b && code > held);
}

/**
 * The cells whose span covers device pixel `pixel`, where `toPixel` maps a
 * coordinate to device pixels from the plot's start; the first `until`.
 */
export function coveringCells(
  cells: { lo: ArrayLike<number>; hi: ArrayLike<number> },
  toPixel: (v: number) => number,
  pixel: number,
  until = cells.lo.length
) {
  const found: number[] = [];
  for (let k = 0; k < until; k++) {
    const [a, b] = [toPixel(cells.lo[k]), toPixel(cells.hi[k])];
    const [from, to] = [Math.floor(Math.min(a, b)), Math.ceil(Math.max(a, b))];
    if (from <= pixel && Math.max(from, to - 1) >= pixel) {
      found.push(k);
    }
  }
  return found;
}

/**
 * Of the cells at `rows` × `columns` (values row-major, `width` columns), the
 * one the raster paints: the value farthest from `mean`. Undefined when the
 * pixel holds one cell, or none with a value.
 */
export function mostExtreme(
  values: ArrayLike<number>,
  width: number,
  rows: number[],
  columns: number[],
  mean: number
) {
  let [row, column, value] = [-1, -1, Number.NaN];
  for (const r of rows) {
    for (const c of columns) {
      const v = values[r * width + c];
      if (Number.isFinite(v) && (row < 0 || fartherThan(v, value, mean))) {
        [row, column, value] = [r, c, v];
      }
    }
  }
  const n = rows.length * columns.length;
  return n > 1 && row >= 0
    ? { n, row, column, value, dates: rows.length, places: columns.length }
    : undefined;
}

/**
 * The read row whose time cell holds `t` (within `tolerance`, in time units),
 * the one with the nearest date when several do; -1 for none. The rows are
 * ordered once per axis and read: a pointer move searches, it does not visit
 * every date.
 */
export function rowUnder(
  raw: ArrayLike<number>,
  rows: TCells,
  readUntil: number,
  t: number,
  tolerance: number
) {
  const index = rowIndexOf(raw, rows, readUntil);
  const { order, at, reach, loose, broad } = index;
  const inside = (row: number) => {
    const [a, b] = [rows.lo[row], rows.hi[row]];
    return t >= Math.min(a, b) - tolerance && t <= Math.max(a, b) + tolerance;
  };
  let best = -1;
  const consider = (row: number) => {
    if (!inside(row)) {
      return;
    }
    const d = Math.abs(raw[row] - t);
    const bd = best < 0 ? Infinity : Math.abs(raw[best] - t);
    if (best < 0 || d < bd || (d === bd && row < best)) {
      best = row;
    }
  };
  // Dated rows whose cells could reach t: their dates lie within the
  // widest reach of t.
  const from = lowerBound(at, t - reach - tolerance);
  for (let k = from; k < at.length && at[k] <= t + reach + tolerance; k++) {
    consider(order[k]);
  }
  // The few widest cells, looked at each.
  for (const row of broad) {
    consider(row);
  }
  // Rows without a usable date (rare) are looked at one by one.
  for (const row of loose) {
    if (!inside(row)) {
      continue;
    }
    if (best < 0 || (!Number.isFinite(raw[best]) && row < best)) {
      best = row;
    }
  }
  return best;
}

type TRowIndex = {
  order: Uint32Array;
  at: Float64Array;
  reach: number;
  loose: number[];
  /** Dated rows reaching farther than `reach`, at most BROAD_ROWS. */
  broad: number[];
};
/** The widest cells kept aside, so the others' reach bounds a search. */
const BROAD_ROWS = 64;
const rowIndexes = new WeakMap<TCells, Map<number, TRowIndex>>();

function rowIndexOf(raw: ArrayLike<number>, rows: TCells, readUntil: number) {
  const kept = rowIndexes.get(rows)?.get(readUntil);
  if (kept) {
    return kept;
  }
  const dated: number[] = [];
  const loose: number[] = [];
  const reaches: number[] = [];
  for (let row = 0; row < readUntil; row++) {
    const value = raw[row];
    if (!Number.isFinite(value)) {
      loose.push(row);
      continue;
    }
    const far = Math.max(
      Math.abs(rows.lo[row] - value),
      Math.abs(rows.hi[row] - value)
    );
    dated.push(row);
    reaches.push(Number.isFinite(far) ? far : 0);
  }
  // The reach of all but the BROAD_ROWS widest; those are looked at each.
  const sorted = Float64Array.from(reaches).sort();
  const reach = sorted.length
    ? sorted[Math.max(0, sorted.length - 1 - BROAD_ROWS)]
    : 0;
  const broad = dated.filter((_, k) => reaches[k] > reach);
  dated.sort((a, b) => raw[a] - raw[b] || a - b);
  const index = {
    order: Uint32Array.from(dated),
    at: Float64Array.from(dated, (row) => raw[row]),
    reach,
    loose,
    broad,
  };
  // One index per read extent: a growing read keeps only the newest.
  rowIndexes.set(rows, new Map([[readUntil, index]]));
  return index;
}

function lowerBound(sorted: Float64Array, value: number) {
  let [lo, hi] = [0, sorted.length];
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (sorted[mid] < value) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/**
 * The time at pixel `along` of a linear time axis drawn by `time`, and half a
 * pixel in time: inverted between the earliest and latest times shown, not
 * extrapolated to 0 and 1.
 */
/** Each time axis's finite extent, per axis array. */
const extents = new WeakMap<
  object,
  { length: number; low: number; high: number }
>();

export function pointerTime(
  time: (t: number) => number,
  raw: ArrayLike<number>,
  along: number
) {
  // The axis's extent, found once per axis, each value read once.
  let kept = extents.get(raw);
  if (kept?.length !== raw.length) {
    let [lo, hi] = [Infinity, -Infinity];
    for (let at = 0; at < raw.length; at++) {
      const value = raw[at];
      if (Number.isFinite(value)) {
        lo = Math.min(lo, value);
        hi = Math.max(hi, value);
      }
    }
    kept = { length: raw.length, low: lo, high: hi };
    extents.set(raw, kept);
  }
  const { low, high } = kept;
  if (!Number.isFinite(low)) {
    return undefined;
  }
  const [t0, t1] = low < high ? [low, high] : [low, low + 1];
  const [p0, p1] = [time(t0), time(t1)];
  const scale = (p1 - p0) / (t1 - t0);
  if (!(Math.abs(scale) > 0) || !Number.isFinite(scale)) {
    return undefined;
  }
  return { t: t0 + (along - p0) / scale, tolerance: 0.5 / Math.abs(scale) };
}

/** The direction (−1, 0 or 1) from the known level before `k` to `k`. */
function order(values: ArrayLike<number>, known: number[], k: number) {
  return Math.sign(values[known[k]] - values[known[k - 1]]);
}
