import { reduceForDisplay } from "@/lib/analysis/analysisExport.ts";

type TDateLayout = {
  min: number;
  max: number;
  ascending: boolean;
  sorted?: Uint32Array;
};

// Opening the Data tab unmounts the chart. Keep its date order as long as
// the result is alive so switching back to Chart reuses it.
const layouts = new WeakMap<number[], TDateLayout>();

/** Dates are immutable during a streamed run. Record their order once. */
export function seriesDateLayout(dates: number[]): TDateLayout {
  const known = layouts.get(dates);
  if (known) {
    return known;
  }
  let ascending = true;
  let descending = true;
  let min = Infinity;
  let max = -Infinity;
  // Rows without a date have no place on the axis: left out of its extent and
  // order.
  let undated = false;
  let previous: number | undefined;
  for (let i = 0; i < dates.length; i++) {
    const date = dates[i];
    if (!Number.isFinite(date)) {
      undated = true;
      continue;
    }
    min = Math.min(min, date);
    max = Math.max(max, date);
    if (previous !== undefined) {
      ascending &&= date > previous;
      descending &&= date < previous;
    }
    previous = date;
  }
  ascending &&= !undated;
  // With duplicates, mixed order or undated rows, group by date for shading.
  // Keep the original indices because the worker reports progress in file
  // order. Sorted over a typed copy read once.
  const keys =
    (ascending || descending) && !undated
      ? undefined
      : Float64Array.from(dates);
  const sorted = keys
    ? Uint32Array.from({ length: dates.length }, (_, i) => i)
        .filter((i) => Number.isFinite(keys[i]))
        .sort((a, b) => keys[a] - keys[b] || a - b)
    : undefined;
  const layout = { min, max, ascending, sorted };
  layouts.set(dates, layout);
  return layout;
}

// For an unordered axis each source row belongs to a chronological date group.
type TDateGroups = {
  groupByRow: Uint32Array; // One-based; undated rows have zero.
  firstRows: Uint32Array; // Earliest source row for each distinct date.
  // Each group's date, read once: later passes read no dates.
  values: Float64Array;
  prefix?: { end: number; rows: number[] };
};
const dateGroups = new WeakMap<Uint32Array, TDateGroups>();

function groupsFor(dates: number[], sorted: Uint32Array) {
  const cached = dateGroups.get(sorted);
  if (cached) {
    return cached;
  }
  const groupByRow = new Uint32Array(dates.length);
  const first = new Uint32Array(sorted.length);
  const values = new Float64Array(sorted.length);
  let count = 0;
  let previous = Number.NaN;
  for (const row of sorted) {
    const value = dates[row];
    if (value !== previous) {
      values[count] = value;
      first[count++] = row;
      previous = value;
    }
    groupByRow[row] = count;
  }
  const groups: TDateGroups = {
    groupByRow,
    firstRows: first.subarray(0, count),
    values: values.subarray(0, count),
  };
  dateGroups.set(sorted, groups);
  return groups;
}

// Read a small source range directly. For a large range the existing sorted
// order is cheaper to filter. Multiple plot layers reuse the same prefix.
function rangeRows(
  sorted: Uint32Array,
  groups: TDateGroups,
  start: number,
  end: number
) {
  if (start === 0 && groups.prefix?.end === end) {
    return groups.prefix.rows;
  }
  const rows: number[] = [];
  const count = end - start;
  if (count * Math.max(1, Math.log2(count)) < sorted.length) {
    for (let row = start; row < end; row++) {
      if (groups.groupByRow[row]) {
        rows.push(row);
      }
    }
    rows.sort((a, b) => groups.groupByRow[a] - groups.groupByRow[b]);
  } else {
    for (const row of sorted) {
      if (start <= row && row < end) {
        rows.push(row);
      }
    }
  }
  if (start === 0) {
    groups.prefix = { end, rows };
  }
  return rows;
}

type TSpan = [number, number];

/** Midpoints between adjacent dates divide the displayed time axis. */
export function unreadDateSpans(
  dates: number[],
  layout: TDateLayout,
  from: number,
  minimumWidth = 0
): TSpan[] {
  if (from >= dates.length || layout.min > layout.max) {
    return [];
  }
  if (from <= 0) {
    return [[layout.min, layout.max]];
  }
  if (!layout.sorted) {
    const boundary = (dates[from - 1] + dates[from]) / 2;
    return [layout.ascending ? [boundary, layout.max] : [layout.min, boundary]];
  }

  const groups = groupsFor(dates, layout.sorted);
  const memo = unreadMemo.get(groups);
  if (memo && memo.from === from && memo.width === minimumWidth) {
    return memo.spans;
  }
  const first = groups.firstRows;
  const boundary = (group: number) =>
    group === 0
      ? layout.min
      : group === first.length
        ? layout.max
        : (groups.values[group - 1] + groups.values[group]) / 2;
  // Rows read since: only their dates split the spans kept, which only shrink
  // as rows are read.
  if (memo && memo.width === minimumWidth && memo.from < from) {
    return advanced(groups, memo, from, boundary);
  }
  // The unread stretches of date groups do not depend on the width: a resize
  // filters them, not the million dates again.
  const spans: TSpan[] = [];
  const runs = unreadRuns(groups, from);
  for (let r = 0; r < runs.length; r += 2) {
    const [lo, hi] = [boundary(runs[r]), boundary(runs[r + 1])];
    if (hi - lo >= minimumWidth) {
      spans.push([lo, hi]);
    }
  }
  unreadMemo.set(groups, { from, width: minimumWidth, spans });
  return spans;
}

/** The kept spans with the rows read since split out, kept in turn. */
function advanced(
  groups: TDateGroups,
  memo: { from: number; width: number; spans: TSpan[] },
  from: number,
  boundary: (group: number) => number
) {
  const spans = splitSpans(
    memo.spans,
    groupsReadBetween(groups, memo.from, from),
    boundary,
    memo.width
  );
  unreadMemo.set(groups, { from, width: memo.width, spans });
  return spans;
}

/**
 * The date groups whose first row is in [from, to), in date order: the rows
 * read since, looked up in the row-to-group table.
 */
function groupsReadBetween(groups: TDateGroups, from: number, to: number) {
  const { firstRows, groupByRow } = groups;
  const read: number[] = [];
  for (let row = from; row < to; row++) {
    const group = groupByRow[row] - 1;
    if (group >= 0 && firstRows[group] === row) {
      read.push(group);
    }
  }
  return read.sort((a, b) => a - b);
}

/**
 * Unread stretches of date groups, kept per axis: pairs [first, end)
 * flat in one array (half a million stretches are no half a million
 * arrays).
 */
const runsMemo = new WeakMap<
  TDateGroups,
  { from: number; runs: Uint32Array }
>();

/** The stretches of date groups not read when rows before `from` are. */
function unreadRuns(groups: TDateGroups, from: number): Uint32Array {
  const memo = runsMemo.get(groups);
  if (memo?.from === from) {
    return memo.runs;
  }
  let runs: Uint32Array;
  if (memo && memo.from < from) {
    // Only the groups read since split the stretches kept.
    runs = splitRuns(memo.runs, groupsReadBetween(groups, memo.from, from));
  } else {
    // A date is read as soon as its earliest source row is: one pass over the
    // dates' first rows.
    const first = groups.firstRows;
    const out = new Uint32Array(first.length + 2);
    let [n, start] = [0, -1];
    for (let group = 0; group <= first.length; group++) {
      const unread = group < first.length && first[group] >= from;
      if (unread && start < 0) {
        start = group;
      } else if (!unread && start >= 0) {
        out[n++] = start;
        out[n++] = group;
        start = -1;
      }
    }
    runs = out.slice(0, n);
  }
  runsMemo.set(groups, { from, runs });
  return runs;
}

/**
 * Stretches of groups with the groups read (in order) taken out: the
 * stretches between them copied whole, each read group found by a binary
 * search (half a million stretches and one group read is no rebuild).
 */
function splitRuns(runs: Uint32Array, read: number[]) {
  const out = new Uint32Array(runs.length + 2 * read.length);
  let [n, r, a, b] = [0, 0, -1, -1];
  const emit = (from: number, to: number) => {
    if (to > from) {
      out[n++] = from;
      out[n++] = to;
    }
  };
  for (const group of read) {
    if (a >= 0 && group < b) {
      emit(a, group);
      a = group + 1;
      continue;
    }
    if (a >= 0) {
      emit(a, b);
      a = -1;
    }
    // The first stretch from r on that ends after the group.
    let [low, high] = [r / 2, runs.length / 2];
    while (low < high) {
      const mid = (low + high) >> 1;
      if (runs[2 * mid + 1] <= group) {
        low = mid + 1;
      } else {
        high = mid;
      }
    }
    out.set(runs.subarray(r, 2 * low), n);
    n += 2 * low - r;
    r = 2 * low;
    if (r < runs.length && runs[r] <= group) {
      [a, b] = [runs[r], runs[r + 1]];
      r += 2;
      emit(a, group);
      a = group + 1;
    }
  }
  if (a >= 0) {
    emit(a, b);
  }
  out.set(runs.subarray(r), n);
  n += runs.length - r;
  return out.slice(0, n);
}

/**
 * Spans with each newly read group's own interval taken out; pieces below
 * `minimumWidth` dropped (they were part of a span wide enough before).
 */
function splitSpans(
  spans: TSpan[],
  read: number[],
  boundary: (group: number) => number,
  minimumWidth: number
) {
  const out: TSpan[] = [];
  let k = 0;
  for (const span of spans) {
    const b = span[1];
    let a = span[0];
    // The groups read inside this span, in date order.
    while (k < read.length && boundary(read[k] + 1) <= a) {
      k++;
    }
    while (k < read.length && boundary(read[k]) < b) {
      const [lo, hi] = [boundary(read[k]), boundary(read[k] + 1)];
      if (lo - a >= minimumWidth && lo > a) {
        out.push([a, lo]);
      }
      a = Math.max(a, hi);
      k++;
    }
    if (b - a >= minimumWidth && b > a) {
      out.push([a, b]);
    }
  }
  return out;
}

/** The last unread spans of each axis: a redraw at the same point reuses them. */
const unreadMemo = new WeakMap<
  TDateGroups,
  { from: number; width: number; spans: TSpan[] }
>();

/**
 * The first `read` source rows in the order of their values on the chart's
 * index axis (dates, or a profile's levels), ties in source order;
 * undefined when the rows already ascend. Charts draw lines and find the
 * nearest point in this order and report the source row.
 */
export function axisRows(
  values: number[],
  read = values.length
): number[] | undefined {
  const layout = seriesDateLayout(values);
  if (layout.ascending) {
    return undefined;
  }
  if (!layout.sorted) {
    // Descending: the rows read, last first (no million-row array for
    // three rows read).
    const rows = Math.min(read, values.length);
    return Array.from({ length: rows }, (_, i) => rows - 1 - i);
  }
  return rangeRows(
    layout.sorted,
    groupsFor(values, layout.sorted),
    0,
    Math.min(read, values.length)
  );
}

/**
 * `y` against `x` along the index axis, in its order (dates out of file
 * order are drawn chronologically), reduced to `buckets` columns; each
 * point keeps its source row `i`. Only the first `read` rows are used.
 */
// eslint-disable-next-line max-lines-per-function
export function orderedPoints(
  x: number[],
  y: number[],
  buckets: number,
  read = y.length,
  /**
   * The stretch of x shown (zoomed): only it is reduced to `buckets`, and the
   * sample just outside each end is added as it is.
   */
  shown?: { min: number; max: number }
) {
  const readRows = Math.min(read, y.length);
  const layout = seriesDateLayout(x);
  // A descending axis by arithmetic, not as a list of its rows; a sorted one by
  // its order.
  const sortedRows =
    layout.ascending || !layout.sorted ? undefined : axisRows(x, readRows);
  const rowAt = layout.ascending
    ? undefined
    : sortedRows
      ? (k: number) => sortedRows[k]
      : (k: number) => readRows - 1 - k;
  const n = sortedRows ? sortedRows.length : readRows;
  // In time order: the k-th sample's x and y, read only when used (a
  // narrow zoom of a descending axis read all 200,000 values).
  const xAt = rowAt ? (k: number) => x[rowAt(k)] : (k: number) => x[k];
  const yAt = rowAt ? (k: number) => y[rowAt(k)] : (k: number) => y[k];
  const point = (k: number) => {
    const value = yAt(k);
    return {
      x: xAt(k),
      y: Number.isNaN(value) ? null : value,
      i: rowAt ? rowAt(k) : k,
    };
  };
  // A descending axis seen whole: reduced in stored order against its negated
  // dates (made once per axis), so its columns are kept between updates like an
  // ascending one's, then put in time order.
  if (rowAt && !sortedRows && !shown) {
    const negated = negatedAxis(x);
    const reduced = reduceForDisplay(negated, y, buckets, readRows);
    const out = reduced.x.map((xValue, at) => ({
      x: -xValue,
      y: Number.isNaN(reduced.y[at]) ? null : reduced.y[at],
      i: reduced.index[at],
    }));
    return out.reverse();
  }
  const [lo, hi] = shown
    ? [firstAt(xAt, shown.min, n, false), firstAt(xAt, shown.max, n, true)]
    : [0, n];
  const length = Math.max(0, hi - lo);
  // In file order from the start: the rows read, reduced where they are. Not a
  // zoom from row 0: its columns are the view's, not the whole axis' kept ones.
  const direct = !rowAt && lo === 0 && !shown;
  const xs = direct ? x : Array.from({ length }, (_, k) => xAt(lo + k));
  const ys = direct ? y : Array.from({ length }, (_, k) => yAt(lo + k));
  const reduced = reduceForDisplay(xs, ys, buckets, length);
  const inner = reduced.x.map((xValue, at) => ({
    x: xValue,
    y: Number.isNaN(reduced.y[at]) ? null : reduced.y[at],
    i: rowAt ? rowAt(lo + reduced.index[at]) : lo + reduced.index[at],
  }));
  if (!shown) {
    return inner;
  }
  return [
    ...(lo > 0 ? [point(lo - 1)] : []),
    ...inner,
    ...(hi < n ? [point(hi)] : []),
  ];
}

/** An axis negated, once per axis array. */
const negatedAxes = new WeakMap<number[], number[]>();
function negatedAxis(x: number[]) {
  let out = negatedAxes.get(x);
  if (!out) {
    out = x.map((v) => -v);
    negatedAxes.set(x, out);
  }
  return out;
}

/**
 * The first of the first `n` ascending `xs` at or above `value` (above it,
 * when `past`).
 */
function firstAt(
  xs: (k: number) => number,
  value: number,
  n: number,
  past: boolean
) {
  let [low, high] = [0, n];
  while (low < high) {
    const mid = (low + high) >> 1;
    if (xs(mid) < value || (past && xs(mid) === value)) {
      low = mid + 1;
    } else {
      high = mid;
    }
  }
  return low;
}
