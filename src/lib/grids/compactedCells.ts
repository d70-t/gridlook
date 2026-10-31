type TCellIds = ArrayLike<number | bigint>;

/** The deepest HEALPix level a `zuniq` id or a `"ranges"` coordinate can hold. */
const MAX_LEVEL = 29;

/**
 * A level that is stored with a compressed `cell` coordinate of the dggs
 * convention, seen as sorted runs of cells: the nested ids `first + k`,
 * `k < count`, sit at the indices `offset + k` of the data.
 */
type TRuns = {
  first: number[];
  count: number[];
  offset: number[];
};

function toNumber(value: bigint) {
  if (value > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error("A cell id of the coordinate is too large to search.");
  }
  return Number(value);
}

/**
 * The level and the nested id of a `zuniq` id: `(2 * ipix + 1)` shifted left
 * so that its lowest set bit sits at `2 * (29 - level)`.
 */
export function decodeZuniq(id: bigint) {
  if (id <= 0n) {
    throw new Error(`Not a zuniq cell id: ${id}`);
  }
  let trailing = 0n;
  while (((id >> trailing) & 1n) === 0n) {
    trailing++;
  }
  if (trailing % 2n !== 0n) {
    throw new Error(`Not a zuniq cell id: ${id}`);
  }
  return {
    level: MAX_LEVEL - Number(trailing / 2n),
    ipix: id >> (trailing + 1n),
  };
}

/** The `zuniq` id of a nested cell; the inverse of `decodeZuniq`. */
export function encodeZuniq(level: number, ipix: bigint) {
  return ((ipix << 1n) | 1n) << BigInt(2 * (MAX_LEVEL - level));
}

function appendRun(runs: TRuns, first: number, count: number) {
  const last = runs.first.length - 1;
  const end = runs.first[last] + runs.count[last];
  if (last >= 0 && first < end) {
    throw new Error("The cell coordinate is not in ascending order.");
  }
  if (last >= 0 && first === end) {
    runs.count[last] += count; // keep neighbours together
    return;
  }
  runs.offset.push(last < 0 ? 0 : runs.offset[last] + runs.count[last]);
  runs.first.push(first);
  runs.count.push(count);
}

/** The runs of a `"compacted"` coordinate of `zuniq` ids, for data at `level`. */
function compactedRuns(level: number, ids: TCellIds) {
  const runs: TRuns = { first: [], count: [], offset: [] };
  for (let at = 0; at < ids.length; at++) {
    const cell = decodeZuniq(BigInt(ids[at]));
    if (cell.level > level) {
      throw new Error(
        `A compacted cell id of level ${cell.level} is finer than the data (level ${level}).`
      );
    }
    const shift = BigInt(2 * (level - cell.level));
    appendRun(runs, toNumber(cell.ipix << shift), toNumber(1n << shift));
  }
  return runs;
}

/**
 * The runs of a `"ranges"` coordinate: `[start, end)` pairs of nested ids at
 * level 29, given flat, for data at `level`.
 */
function rangeRuns(level: number, bounds: TCellIds) {
  if (bounds.length % 2 !== 0) {
    throw new Error("A ranges cell coordinate holds a start without its end.");
  }
  const runs: TRuns = { first: [], count: [], offset: [] };
  const shift = BigInt(2 * (MAX_LEVEL - level));
  const mask = (1n << shift) - 1n;
  for (let at = 0; at < bounds.length; at += 2) {
    const first = (BigInt(bounds[at]) + mask) >> shift;
    const end = BigInt(bounds[at + 1]) >> shift;
    if (end > first) {
      appendRun(runs, toNumber(first), toNumber(end - first));
    }
  }
  return runs;
}

/** Index of the first run for which `ends` is true (they are ascending). */
function firstRun(runs: TRuns, ends: (run: number) => boolean) {
  let lo = 0;
  let hi = runs.first.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (ends(mid)) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

/**
 * The same questions as `createSortedCells`, answered by arithmetic on the
 * runs: where the cells of a nested range start in the data, and which ids sit
 * at which indices. Nothing is read beyond the coordinate that made the runs.
 */
function createRunCells(runs: TRuns) {
  const last = runs.first.length - 1;
  const length = last < 0 ? 0 : runs.offset[last] + runs.count[last];

  /** Index of the first cell with an id of at least `target`. */
  async function lowerBound(target: number) {
    const run = firstRun(
      runs,
      (at) => runs.first[at] + runs.count[at] > target
    );
    if (run === runs.first.length) {
      return length;
    }
    return runs.offset[run] + Math.max(0, target - runs.first[run]);
  }

  /** The cell ids at indices `[start, end)`. */
  async function slice(start: number, end: number) {
    const cells: number[] = [];
    let run = firstRun(runs, (at) => runs.offset[at] + runs.count[at] > start);
    for (let index = start; index < end; run++) {
      const stop = Math.min(end, runs.offset[run] + runs.count[run]);
      for (; index < stop; index++) {
        cells.push(runs.first[run] + (index - runs.offset[run]));
      }
    }
    return cells;
  }

  // The runs are built ascending and apart, or not at all.
  async function isAscending() {
    return true;
  }

  return { length, lowerBound, slice, isAscending };
}

/**
 * The cells of data at `level` whose coordinate is compacted: `zuniq` ids,
 * each standing for a cell of that level or for all the cells it contains.
 * The data holds those cells one after the other in ascending nested order.
 */
export function createCompactedCells(level: number, ids: TCellIds) {
  return createRunCells(compactedRuns(level, ids));
}

/**
 * The cells of data at `level` whose coordinate is given as `[start, end)`
 * ranges of nested ids at level 29, flattened to `start, end, start, end, ...`.
 */
export function createRangeCells(level: number, bounds: TCellIds) {
  return createRunCells(rangeRuns(level, bounds));
}
