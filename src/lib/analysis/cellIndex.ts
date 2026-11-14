import { ByteLru } from "./byteLru.ts";
import { raceAbort } from "./chunkVisitor.ts";
import {
  decodeZuniq,
  HEALPIX_MAX_ORDER,
  healpixCellCount,
  parseCellId,
  toSafeNumber,
  type TIdRange,
} from "./healpixIds.ts";

/**
 * Where the cells of a HEALPix level sit in its data: the position of an id
 * along the cell axis, without scanning or materializing the whole coordinate.
 */
export const CELL_INDEX_KINDS = {
  DENSE: "dense",
  SORTED: "sorted",
  RUNS: "runs",
  MAPPED: "mapped",
} as const;

type TCellIndexKind = (typeof CELL_INDEX_KINDS)[keyof typeof CELL_INDEX_KINDS];

export const INDEX_VALIDATION = {
  IMPLICIT: "implicit",
  FULL: "full",
  DECLARED: "publisher-declared",
  ACCESSED: "accessed-chunks-only",
} as const;

export type TIndexValidation =
  (typeof INDEX_VALIDATION)[keyof typeof INDEX_VALIDATION];

/** Stored positions `[start, end)` holding one id range's stored cells. */
type TPositionSpan = [start: number, end: number];

export type TCellIndex = {
  kind: TCellIndexKind;
  validation: TIndexValidation;
  /** Number of stored positions along the cell axis. */
  length: number;
  /** Stored position of each id, or -1 when the id is not stored. */
  positionsOf(ids: bigint[], signal?: AbortSignal): Promise<number[]>;
  /** Stored positions of the cells in `ranges` (sorted, disjoint). */
  spansOf(
    ranges: TIdRange[],
    signal?: AbortSignal
  ): Promise<{ spans: TPositionSpan[]; stored: number }>;
  counters: { chunkReads: number; bytes: number; fenceChecks?: number };
};

export type TCoordinateReader = {
  length: number;
  chunkLength: number;
  readChunk(
    chunkIndex: number,
    signal?: AbortSignal
  ): Promise<ArrayLike<number | bigint>>;
};

function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

function toBigIds(values: ArrayLike<number | bigint>): BigInt64Array {
  if (values instanceof BigInt64Array) {
    return values;
  }
  const ids = new BigInt64Array(values.length);
  for (let index = 0; index < values.length; index++) {
    ids[index] = parseCellId(values[index]);
  }
  return ids;
}

function lowerBoundIn(ids: BigInt64Array, target: bigint) {
  let lo = 0;
  let hi = ids.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (ids[mid] < target) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  return lo;
}

/** A dense level stores cell `id` at position `id`. */
export function createDenseIndex(order: number, length: number): TCellIndex {
  const expected = healpixCellCount(order);
  if (BigInt(length) !== expected) {
    throw new Error(
      `A dense order-${order} level has ${expected} cells, but the cell axis has ${length}.`
    );
  }
  return {
    kind: CELL_INDEX_KINDS.DENSE,
    validation: INDEX_VALIDATION.IMPLICIT,
    length,
    counters: { chunkReads: 0, bytes: 0 },
    async positionsOf(ids) {
      return ids.map((id) =>
        id >= 0n && id < expected ? toSafeNumber(id, "cell id") : -1
      );
    },
    async spansOf(ranges) {
      const spans: TPositionSpan[] = ranges.map(([start, end]) => [
        toSafeNumber(start, "cell id"),
        toSafeNumber(end, "cell id"),
      ]);
      let stored = 0;
      for (const [start, end] of spans) {
        stored += end - start;
      }
      return { spans, stored };
    },
  };
}

type TFence = [first: bigint, last: bigint];

/** The index chunk a query read last, kept for its next lookups. */
type TPin = { chunk: number; ids?: BigInt64Array };

/** First and last ids of the chunks validated so far, in chunk order. */
type TFences = {
  byChunk: Map<number, TFence>;
  /** Validated chunk numbers, ascending. */
  order: number[];
  checks: { fenceChecks: number };
};

/**
 * Strictly ascending inside, and apart from the chunks read before. Those
 * are already ordered among themselves, so the nearest validated chunk on
 * each side is enough: a few comparisons per chunk, not one per chunk read.
 */
function validateSortedChunk(
  chunk: number,
  ids: BigInt64Array,
  fences: TFences
) {
  for (let at = 1; at < ids.length; at++) {
    if (ids[at] === ids[at - 1]) {
      throw new Error(`The cell coordinate repeats cell id ${ids[at]}.`);
    }
    if (ids[at] < ids[at - 1]) {
      throw new Error(
        "The cell coordinate is not in ascending order; it needs an index before analysis."
      );
    }
  }
  if (ids.length === 0) {
    return;
  }
  const first = ids[0];
  const last = ids[ids.length - 1];
  const known = fences.byChunk.get(chunk);
  if (known) {
    // A re-read after eviction must match what was read before.
    fences.checks.fenceChecks++;
    if (known[0] !== first || known[1] !== last) {
      throw new Error("The cell coordinate changed while it was being read.");
    }
    return;
  }
  let lo = 0;
  let hi = fences.order.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (fences.order[mid] < chunk) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const before = fences.byChunk.get(fences.order[lo - 1]);
  const after = fences.byChunk.get(fences.order[lo]);
  fences.checks.fenceChecks += 2;
  if ((before && before[1] >= first) || (after && after[0] <= last)) {
    throw new Error(
      "Chunks of the cell coordinate overlap or are out of order; it needs an index before analysis."
    );
  }
  fences.order.splice(lo, 0, chunk);
  fences.byChunk.set(chunk, [first, last]);
}

/**
 * Binary searches over the resident coordinate already validated at
 * admission: never re-converted, re-checked or cached per lookup (the byte
 * cache may be smaller than a 64 MiB coordinate).
 */
export function createValidatedIndex(ids: BigInt64Array): TCellIndex {
  return {
    kind: CELL_INDEX_KINDS.SORTED,
    validation: INDEX_VALIDATION.FULL,
    length: ids.length,
    counters: { chunkReads: 0, bytes: 0 },
    async positionsOf(query, signal) {
      throwIfAborted(signal);
      return query.map((id) => {
        const at = lowerBoundIn(ids, id);
        return ids[at] === id ? at : -1;
      });
    },
    async spansOf(ranges, signal) {
      throwIfAborted(signal);
      const spans: TPositionSpan[] = [];
      let stored = 0;
      for (const [start, end] of ranges) {
        const lo = lowerBoundIn(ids, start);
        const hi = lowerBoundIn(ids, end);
        if (hi > lo) {
          spans.push([lo, hi]);
          stored += hi - lo;
        }
      }
      return { spans, stored };
    },
  };
}

/**
 * A packed level with an ascending cell coordinate, read lazily chunk by
 * chunk. Fences (first and last id per chunk) are kept; chunk contents live
 * in a shared byte-bounded cache.
 */
// eslint-disable-next-line max-lines-per-function
export function createSortedIndex(
  reader: TCoordinateReader,
  cache: ByteLru<BigInt64Array>,
  cacheKey: string,
  validation: TIndexValidation
): TCellIndex {
  const counters = { chunkReads: 0, bytes: 0, fenceChecks: 0 };
  const fences: TFences = { byChunk: new Map(), order: [], checks: counters };
  const pending = new Map<
    number,
    {
      promise: Promise<BigInt64Array>;
      users: number;
      controller: AbortController;
    }
  >();
  const chunkCount = Math.ceil(reader.length / reader.chunkLength);

  /**
   * One read per chunk, shared by every waiter; it is aborted only when its
   * last waiter gives up, so one cancelled plan cannot fail another.
   */
  async function chunkIds(chunk: number, signal?: AbortSignal, pin?: TPin) {
    throwIfAborted(signal);
    if (pin?.chunk === chunk && pin.ids) {
      return pin.ids;
    }
    const ids = await sharedChunkIds(chunk, signal);
    if (pin) {
      pin.chunk = chunk;
      pin.ids = ids;
    }
    return ids;
  }

  // eslint-disable-next-line max-lines-per-function
  async function sharedChunkIds(chunk: number, signal?: AbortSignal) {
    const key = `${cacheKey}|${chunk}`;
    const cached = cache.get(key);
    if (cached) {
      return cached;
    }
    let entry = pending.get(chunk);
    if (entry?.controller.signal.aborted) {
      pending.delete(chunk);
      entry = undefined;
    }
    if (!entry) {
      const controller = new AbortController();
      const created = {
        users: 0,
        controller,
        promise: reader.readChunk(chunk, controller.signal).then((values) => {
          const ids = toBigIds(values);
          counters.chunkReads++;
          counters.bytes += ids.byteLength;
          validateSortedChunk(chunk, ids, fences);
          if (pending.get(chunk) === created) {
            cache.set(key, ids, ids.byteLength);
          }
          return ids;
        }),
      };
      entry = created;
      pending.set(chunk, created);
      created.promise
        .finally(() => {
          if (pending.get(chunk) === created) {
            pending.delete(chunk);
          }
        })
        .catch(() => {});
    }
    const shared = entry;
    shared.users++;
    const onAbort = () => {
      shared.users--;
      if (shared.users <= 0) {
        shared.controller.abort(signal?.reason);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      return await raceAbort(shared.promise, signal);
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  async function lastOf(chunk: number, signal?: AbortSignal, pin?: TPin) {
    const fence = fences.byChunk.get(chunk);
    if (fence) {
      return fence[1];
    }
    const ids = await chunkIds(chunk, signal, pin);
    return ids[ids.length - 1];
  }

  /** Position of the first stored id not less than `target`. */
  async function lowerBound(target: bigint, signal?: AbortSignal, pin?: TPin) {
    let lo = 0;
    let hi = chunkCount;
    // The pinned chunk answers first when the target falls inside it
    // (nearby ids of one query), without a search.
    if (pin?.ids?.length) {
      const ids = pin.ids;
      if (ids[0] < target && target <= ids[ids.length - 1]) {
        return pin.chunk * reader.chunkLength + lowerBoundIn(ids, target);
      }
    }
    while (lo < hi) {
      throwIfAborted(signal);
      const mid = Math.floor((lo + hi) / 2);
      if ((await lastOf(mid, signal, pin)) < target) {
        lo = mid + 1;
      } else {
        hi = mid;
      }
    }
    if (lo === chunkCount) {
      return reader.length;
    }
    const ids = await chunkIds(lo, signal, pin);
    return lo * reader.chunkLength + lowerBoundIn(ids, target);
  }

  async function idAt(position: number, signal?: AbortSignal, pin?: TPin) {
    const chunk = Math.floor(position / reader.chunkLength);
    const ids = await chunkIds(chunk, signal, pin);
    return ids[position - chunk * reader.chunkLength];
  }

  return {
    kind: CELL_INDEX_KINDS.SORTED,
    validation,
    length: reader.length,
    counters,
    async positionsOf(ids, signal) {
      const positions = new Array<number>(ids.length).fill(-1);
      // The chunk last read stays at hand for this query, cached or not
      // (one just over the cache's size is not). Looked up in id order, so
      // each chunk is read once however the route orders its cells (ids
      // alternating between two chunks read three chunks, not 33); the
      // positions go back in the order asked.
      const pin: TPin = { chunk: -1 };
      const order = Array.from(ids, (_, at) => at).sort((a, b) =>
        ids[a] < ids[b] ? -1 : ids[a] > ids[b] ? 1 : a - b
      );
      for (const at of order) {
        const id = ids[at];
        const position = await lowerBound(id, signal, pin);
        const found =
          position < reader.length &&
          (await idAt(position, signal, pin)) === id;
        positions[at] = found ? position : -1;
      }
      return positions;
    },
    async spansOf(ranges, signal) {
      const spans: TPositionSpan[] = [];
      let stored = 0;
      const pin: TPin = { chunk: -1 };
      for (const [start, end] of ranges) {
        const from = await lowerBound(start, signal, pin);
        const to = await lowerBound(end, signal, pin);
        if (to > from) {
          spans.push([from, to]);
          stored += to - from;
        }
      }
      return { spans, stored };
    },
  };
}

/** Sorted runs `first + k` (k < count) stored at positions `offset + k`. */
export type TRuns = { first: bigint[]; count: number[]; offset: number[] };

function appendRun(runs: TRuns, first: bigint, count: number) {
  const last = runs.first.length - 1;
  if (last >= 0) {
    const end = runs.first[last] + BigInt(runs.count[last]);
    if (first < end) {
      throw new Error("The compressed cell coordinate is not ascending.");
    }
    if (first === end) {
      runs.count[last] += count;
      return;
    }
  }
  runs.offset.push(last < 0 ? 0 : runs.offset[last] + runs.count[last]);
  runs.first.push(first);
  runs.count.push(count);
}

/** Runs of a `"compacted"` coordinate of `zuniq` ids, for data at `order`. */
export function compactedRuns(
  order: number,
  ids: ArrayLike<number | bigint>
): TRuns {
  const runs: TRuns = { first: [], count: [], offset: [] };
  for (let at = 0; at < ids.length; at++) {
    const cell = decodeZuniq(parseCellId(ids[at]));
    if (cell.order > order) {
      throw new Error(
        `A compacted cell of order ${cell.order} is finer than the data (order ${order}).`
      );
    }
    const shift = BigInt(2 * (order - cell.order));
    appendRun(
      runs,
      cell.ipix << shift,
      toSafeNumber(1n << shift, "run length")
    );
  }
  return runs;
}

/** Runs of a `"ranges"` coordinate: flat `[start, end)` order-29 id pairs. */
export function rangeRuns(
  order: number,
  bounds: ArrayLike<number | bigint>
): TRuns {
  if (bounds.length % 2 !== 0) {
    throw new Error("A ranges cell coordinate holds a start without its end.");
  }
  const runs: TRuns = { first: [], count: [], offset: [] };
  const shift = BigInt(2 * (HEALPIX_MAX_ORDER - order));
  const mask = (1n << shift) - 1n;
  for (let at = 0; at < bounds.length; at += 2) {
    const first = (parseCellId(bounds[at]) + mask) >> shift;
    const end = parseCellId(bounds[at + 1]) >> shift;
    if (end > first) {
      appendRun(runs, first, toSafeNumber(end - first, "run length"));
    }
  }
  return runs;
}

function firstRunEndingAfter(runs: TRuns, id: bigint) {
  let lo = 0;
  let hi = runs.first.length;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (runs.first[mid] + BigInt(runs.count[mid]) > id) {
      hi = mid;
    } else {
      lo = mid + 1;
    }
  }
  return lo;
}

export function createRunsIndex(runs: TRuns): TCellIndex {
  const last = runs.first.length - 1;
  const length = last < 0 ? 0 : runs.offset[last] + runs.count[last];
  function positionOf(id: bigint) {
    const run = firstRunEndingAfter(runs, id);
    if (run === runs.first.length || runs.first[run] > id) {
      return -1;
    }
    return runs.offset[run] + Number(id - runs.first[run]);
  }
  return {
    kind: CELL_INDEX_KINDS.RUNS,
    validation: INDEX_VALIDATION.FULL,
    length,
    counters: { chunkReads: 0, bytes: 0 },
    async positionsOf(ids) {
      return ids.map(positionOf);
    },
    async spansOf(ranges) {
      const spans: TPositionSpan[] = [];
      let stored = 0;
      for (const [start, end] of ranges) {
        for (
          let run = firstRunEndingAfter(runs, start);
          run < runs.first.length && runs.first[run] < end;
          run++
        ) {
          const runEnd = runs.first[run] + BigInt(runs.count[run]);
          const from = start > runs.first[run] ? start : runs.first[run];
          const to = end < runEnd ? end : runEnd;
          const offset = runs.offset[run];
          const span: TPositionSpan = [
            offset + Number(from - runs.first[run]),
            offset + Number(to - runs.first[run]),
          ];
          spans.push(span);
          stored += span[1] - span[0];
        }
      }
      return { spans, stored };
    },
  };
}

/**
 * An unsorted coordinate small enough to map completely in memory: the ids
 * sorted (8 B each) and their stored positions in that order (4 B each),
 * built from typed arrays (no object per id). A query gathers the
 * positions of its ranges and merges neighbours into spans: one contiguous
 * storage interval is one span, and a range holding every stored cell is
 * the whole axis without gathering anything.
 */
export function createMappedIndex(ids: ArrayLike<number | bigint>): TCellIndex {
  const { sorted, order } = sortedWithPositions(ids);
  const n = sorted.length;
  return {
    kind: CELL_INDEX_KINDS.MAPPED,
    validation: INDEX_VALIDATION.FULL,
    length: n,
    counters: { chunkReads: 0, bytes: 0 },
    async positionsOf(query) {
      return query.map((id) => {
        const at = lowerBoundIn(sorted, id);
        return sorted[at] === id ? order[at] : -1;
      });
    },
    async spansOf(ranges, signal) {
      throwIfAborted(signal);
      const found: [number, number][] = [];
      let count = 0;
      for (const [start, end] of ranges) {
        const lo = lowerBoundIn(sorted, start);
        const hi = lowerBoundIn(sorted, end);
        if (hi > lo) {
          found.push([lo, hi]);
          count += hi - lo;
        }
      }
      if (count === n && n > 0) {
        return { spans: [[0, n]], stored: n };
      }
      return { spans: mergedSpans(order, found, count), stored: count };
    },
  };
}

/** The ids sorted, with the stored position of each, as typed arrays. */
function sortedWithPositions(ids: ArrayLike<number | bigint>) {
  const values = toBigIds(ids);
  const order = Uint32Array.from(values, (_, at) => at).sort((a, b) =>
    values[a] < values[b] ? -1 : values[a] > values[b] ? 1 : 0
  );
  const sorted = BigInt64Array.from(order, (at) => values[at]);
  for (let k = 1; k < sorted.length; k++) {
    if (sorted[k] === sorted[k - 1]) {
      throw new Error(`The cell coordinate repeats cell id ${sorted[k]}.`);
    }
  }
  return { sorted, order };
}

/** The positions of sorted slots [lo, hi), merged into storage spans. */
function mergedSpans(
  order: Uint32Array,
  found: [number, number][],
  count: number
) {
  const positions = new Uint32Array(count);
  let k = 0;
  for (const [lo, hi] of found) {
    positions.set(order.subarray(lo, hi), k);
    k += hi - lo;
  }
  positions.sort();
  const spans: TPositionSpan[] = [];
  for (let at = 0; at < count; at++) {
    const last = spans[spans.length - 1];
    if (last && last[1] === positions[at]) {
      last[1]++;
    } else {
      spans.push([positions[at], positions[at] + 1]);
    }
  }
  return spans;
}

/** Whether a fully read coordinate is strictly ascending. */
export function isStrictlyAscending(ids: ArrayLike<number | bigint>) {
  for (let at = 1; at < ids.length; at++) {
    if (!(ids[at] > ids[at - 1])) {
      return false;
    }
  }
  return true;
}
