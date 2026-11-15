/**
 * Rows of a date selection (25 Nov): a selection is one stored slice from
 * `start` to `stop`, or several (`runs`) when the dates chosen are not
 * stored together (Jan 1 to Jan 3 on a file storing Jan 1, Jan 4, Jan 2,
 * Jan 3 is [0, 1) and [2, 4)). A result's rows are the slices' dates in
 * storage order, one after another.
 */
import type { TAnalysisQuery } from "./types.ts";

export type TTimeSelection = NonNullable<TAnalysisQuery["time"]>;
type TRun = [number, number];

/** The stored slices a selection reads, in storage order. */
function slicesOf(time: TTimeSelection): TRun[] {
  return time.runs?.length ? time.runs : [[time.start, time.stop]];
}

/** How many dates (rows) a selection reads. */
export function rowCount(time: TTimeSelection) {
  return slicesOf(time).reduce((n, [a, b]) => n + b - a, 0);
}

/** Where the last count of a selection stopped: whole runs before it. */
const cursors = new WeakMap<
  TTimeSelection,
  { index: number; run: number; rows: number }
>();

/**
 * Rows of the selection stored before index `index`. Counted on from the last
 * count when it moves forward, as a read's progress does.
 */
export function rowsBefore(time: TTimeSelection, index: number) {
  const runs = slicesOf(time);
  let at = cursors.get(time);
  if (!at || index < at.index) {
    at = { index, run: 0, rows: 0 };
  }
  let { run, rows } = at;
  while (run < runs.length && runs[run][1] <= index) {
    rows += runs[run][1] - runs[run][0];
    run++;
  }
  cursors.set(time, { index, run, rows });
  const open = runs[run];
  return rows + (open ? Math.max(0, index - open[0]) : 0);
}

/** The stored index of each row. */
export function rowIndices(time: TTimeSelection) {
  return slicesOf(time).flatMap(([a, b]) =>
    Array.from({ length: b - a }, (_, k) => a + k)
  );
}

/**
 * The selection of the dates from `low` to `high` (inclusive) among the
 * stored indices `start` to `stop`: one slice when they are stored
 * together, else their slices (`runs`).
 */
export function selectionOf(
  raw: ArrayLike<number>,
  low: number,
  high: number,
  start: number,
  stop: number
): TTimeSelection {
  const runs: TRun[] = [];
  for (let at = start; at < stop; at++) {
    if (raw[at] >= low && raw[at] <= high) {
      const last = runs.at(-1);
      if (last && last[1] === at) {
        last[1] = at + 1;
      } else {
        runs.push([at, at + 1]);
      }
    }
  }
  if (!runs.length) {
    return { start, stop };
  }
  const [first, end] = [runs[0][0], runs.at(-1)![1]];
  return runs.length > 1
    ? { start: first, stop: end, runs }
    : { start: first, stop: end };
}

/**
 * The part of a selection within stored indices `range` (a preview, an
 * Extend, the rest after a stop): its slices cut there; undefined when
 * none of its dates are. A selection of one slice is cut to the range.
 */
export function clipSelection(
  time: TTimeSelection,
  range: { start: number; stop: number; fromEnd?: boolean }
): TTimeSelection | undefined {
  const runs = slicesOf(time)
    .map(([a, b]): TRun => [Math.max(a, range.start), Math.min(b, range.stop)])
    .filter(([a, b]) => b > a);
  if (!runs.length) {
    return undefined;
  }
  const fromEnd = range.fromEnd ?? time.fromEnd;
  return {
    start: runs[0][0],
    stop: runs.at(-1)![1],
    ...(fromEnd ? { fromEnd } : {}),
    ...(runs.length > 1 ? { runs } : {}),
  };
}

/** Rows read before stored index `index` (a request without dates: all). */
export function rowsUntil(time: TTimeSelection | undefined, index: number) {
  return time ? rowsBefore(time, index) : index;
}

/**
 * The row of stored index `index`: negative before the selection or where
 * it skips the index, past its rows after it.
 */
export function rowOf(time: TTimeSelection | undefined, index: number) {
  if (!time) {
    return index;
  }
  if (slicesOf(time).some(([a, b]) => index >= a && index < b)) {
    return rowsBefore(time, index);
  }
  return index >= time.stop ? rowCount(time) + index - time.stop : -1;
}

/** The stored index of row `row` (a request without dates: the row). */
export function indexAt(time: TTimeSelection | undefined, row: number) {
  if (!time) {
    return row;
  }
  let left = row;
  for (const [a, b] of slicesOf(time)) {
    if (left < b - a) {
      return a + left;
    }
    left -= b - a;
  }
  return time.stop + left;
}

/**
 * Whether a selection reads any stored index from `from` to `to` (inclusive): a
 * gap between its slices is not read.
 */
export function readsIndices(time: TTimeSelection, from: number, to: number) {
  return slicesOf(time).some(([a, b]) => a <= to && b > from);
}

/** Two selections of the same stored rows. */
export function sameSelection(a: TTimeSelection, b: TTimeSelection) {
  const [sa, sb] = [slicesOf(a), slicesOf(b)];
  return (
    sa.length === sb.length &&
    sa.every(([x, y], k) => x === sb[k][0] && y === sb[k][1])
  );
}

/** Stored indices `range` of a request in slices, as its rows. */
export function rowRange(
  all: TTimeSelection,
  range: { start: number; stop: number }
) {
  return {
    start: rowsBefore(all, range.start),
    stop: rowsBefore(all, range.stop),
  };
}

/** Rows of a request in slices, as the stored indices they span. */
export function indexRange(
  all: TTimeSelection,
  rows: { start: number; stop: number }
) {
  return {
    start: indexAt(all, rows.start),
    stop: indexAt(all, Math.max(rows.start, rows.stop - 1)) + 1,
  };
}

/**
 * The stored indices of a selection's earliest and latest dates, wherever
 * the file keeps them (an auxiliary time need not be ordered). Undated
 * rows are skipped; a selection with none dated gives its first index.
 */
export function chronologicalEnds(
  time: TTimeSelection,
  raw: ArrayLike<number>
) {
  let [from, to] = [-1, -1];
  for (const [a, b] of slicesOf(time)) {
    for (let at = a; at < b; at++) {
      const value = raw[at];
      if (!Number.isFinite(value)) {
        continue;
      }
      if (from < 0 || value < raw[from]) {
        from = at;
      }
      if (to < 0 || value > raw[to]) {
        to = at;
      }
    }
  }
  return from < 0 ? { from: time.start, to: time.start } : { from, to };
}
