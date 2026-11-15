import { ByteLru } from "./byteLru.ts";
import type { TWorkCounters } from "./types.ts";
import {
  decodeStoredBigInt,
  decodeStoredValue,
  type TValueCodec,
} from "./valueDecoding.ts";

/** A chunk of stored (not yet CF-decoded) values. */
export type TStoredChunk = {
  data: ArrayLike<number | bigint>;
  shape: number[];
  stride: number[];
  absent: boolean;
  /** Time waiting for the stored bytes, and their size (when observed). */
  fetchMs?: number;
  fetchedBytes?: number;
  /**
   * Cells counted as missing whatever their value: a vector component's
   * cells where the other component is missing (by logical index).
   */
  missingAt?: (index: ArrayLike<number>) => boolean;
};

/** Plots decode at most this much per stored chunk, whatever reads it. */
export const MAX_STORED_CHUNK_BYTES = 256 * 2 ** 20;

/** One source array as the analysis sees it; independent of the reader. */
export type TAnalysisArray = {
  /** Unique within the source generation; part of cache keys. */
  key: string;
  shape: number[];
  chunks: number[];
  dtype: string;
  attrs: Record<string, unknown>;
  dimensionNames: string[];
  fillValue: unknown;
  readChunk(
    coords: number[],
    signal?: AbortSignal,
    /**
     * Told of the backend reads it starts (an array reading through
     * others): the memory booked for it is held until they settle.
     */
    onBackend?: (settled: Promise<unknown>) => void
  ): Promise<TStoredChunk>;
  /** The same array without a description's guard (shared reads). */
  unguarded?: TAnalysisArray;
  /** That guard's signal: the waiter a shared read counts. */
  guard?: AbortSignal;
  /**
   * Its chunks are made from other arrays' chunks, read through the same
   * ReadContext: no limiter slot or cache of its own (a slot held while
   * waiting for the reads beneath would deadlock the limiter).
   */
  readsThrough?: boolean;
  /** Bytes of other stored chunks held with each of its chunks. */
  partnerBytes?: number;
  /**
   * A sharded array's index: bytes per shard (fetched before any value in
   * it) and stored chunks per shard along each axis.
   */
  shardIndex?: { bytes: number; chunksPerShard: number[] };
  /**
   * A publication rewrote steps `from`..`to` (inclusive) along `axis`:
   * forget the shard indices (offsets, omitted slots) of the shards there.
   */
  forgetShards?(axis: number, from: number, to: number): void;
  /**
   * A computed array's own cold reads (the arrays it is made from), when
   * its chunks are not the stored ones: preflight counts these.
   */
  coldReads?: () => number;
  /**
   * A computed array's largest single decoded stored chunk read to make
   * it, when its own chunk is not the stored one: the per-chunk limit.
   */
  backingChunkBytes?: number;
  /**
   * The decoded stored chunks held at once to make it (both rotated axes):
   * working memory, not a chunk.
   */
  backingHeldBytes?: number;
};

/**
 * Limits concurrent work (source reads, plans) across the page. A freed slot
 * passes directly to the next waiter, so a waiter aborted just after its
 * grant releases the slot onward instead of stranding the rest of the queue.
 */
export class ReadLimiter {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(public limit = 4) {}

  get pending() {
    return this.waiting.length;
  }

  get running() {
    return this.active;
  }

  async run<T>(task: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    await this.acquire(signal);
    try {
      throwIfAborted(signal);
      return await task();
    } finally {
      this.release();
    }
  }

  /** Resolves holding a slot (counted in `active`). */
  private acquire(signal?: AbortSignal) {
    throwIfAborted(signal);
    if (this.active < this.limit && this.waiting.length === 0) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const grant = () => {
        signal?.removeEventListener("abort", abort);
        resolve();
      };
      const abort = () => {
        const at = this.waiting.indexOf(grant);
        if (at >= 0) {
          this.waiting.splice(at, 1);
          reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
        }
      };
      signal?.addEventListener("abort", abort, { once: true });
      this.waiting.push(grant);
    });
  }

  private release() {
    const next = this.waiting.shift();
    if (next) {
      next(); // the slot moves on; `active` is unchanged
    } else {
      this.active--;
    }
  }
}

export function throwIfAborted(signal?: AbortSignal) {
  if (signal?.aborted) {
    throw signal.reason ?? new DOMException("Aborted", "AbortError");
  }
}

function chunkBytes(chunk: TStoredChunk) {
  const data = chunk.data as { byteLength?: number; length: number };
  return data.byteLength ?? data.length * 8;
}

/** Most bytes one declared (padded) chunk may decode to, for any read. */
const MAX_DECODED_CHUNK_BYTES = 256 * 2 ** 20;

/**
 * Refuse a metadata, coordinate or geometry read whose declared chunk
 * decodes to more than the limit, before it is dispatched (a two-value
 * axis stored in a 512 MiB chunk still decodes the whole chunk).
 */
/** Shard indices kept per page (16 B per inner chunk): then reread. */
export const SHARD_INDEX_BYTES = 64 * 2 ** 20;

export function checkDeclaredChunk(
  array: Pick<TAnalysisArray, "chunks" | "dtype" | "key" | "shardIndex">
) {
  // A coordinate's or bound's shard index too, before its range is asked for.
  const index = array.shardIndex?.bytes ?? 0;
  if (index > SHARD_INDEX_BYTES) {
    throw new Error(
      `Each shard of ${array.key.split("|").pop()} has an index of ${Math.round(index / 2 ** 20)} MiB, read before any of its values; plots keep at most ${SHARD_INDEX_BYTES / 2 ** 20} MiB of shard indexes.`
    );
  }
  const bytes = chunkByteSize(array);
  if (bytes > MAX_DECODED_CHUNK_BYTES) {
    throw new Error(
      `${array.key.split("|").pop()} is stored in chunks of ${Math.round(bytes / 2 ** 20)} MiB; plots read at most ${MAX_DECODED_CHUNK_BYTES / 2 ** 20} MiB per chunk.`
    );
  }
}

/** Shard index bytes reading `array` whole asks for. */
function wholeIndexBytes(
  array: Pick<TAnalysisArray, "chunks" | "shape" | "shardIndex">
) {
  const index = array.shardIndex;
  if (!index) {
    return 0;
  }
  const shards = array.shape.reduce(
    (p, n, d) =>
      p *
      Math.max(
        1,
        Math.ceil(
          n /
            Math.max(1, (array.chunks[d] ?? n) * (index.chunksPerShard[d] ?? 1))
        )
      ),
    1
  );
  return shards * index.bytes;
}

/**
 * Index bytes asked for while one variable is described, all its coordinates
 * together. Keyed by the description's own tally.
 */
export function chargeWholeIndexes(
  array: Pick<TAnalysisArray, "chunks" | "shape" | "shardIndex" | "key">,
  tally: { bytes: number } | undefined
) {
  const bytes = wholeIndexBytes(array);
  if (!bytes) {
    return;
  }
  const after = (tally?.bytes ?? 0) + bytes;
  if (after > SHARD_INDEX_BYTES) {
    throw new Error(
      `Reading ${array.key.split("|").pop()} goes through ${Math.round(bytes / 2 ** 20)} MiB of shard indexes${tally?.bytes ? `, ${Math.round(after / 2 ** 20)} MiB with this variable's other coordinates` : ""}; describing a variable reads at most ${SHARD_INDEX_BYTES / 2 ** 20} MiB of them.`
    );
  }
  if (tally) {
    tally.bytes = after;
  }
}

/** Decoded bytes of one full chunk of an array, from its dtype. */
export function chunkByteSize(array: Pick<TAnalysisArray, "chunks" | "dtype">) {
  const bytesPer = /64/.test(array.dtype)
    ? 8
    : /16/.test(array.dtype)
      ? 2
      : /8/.test(array.dtype)
        ? 1
        : 4;
  return array.chunks.reduce((product, size) => product * size, bytesPer);
}

/**
 * A page-wide budget of decoded bytes, reserved before a chunk is read and
 * held until its visit ends, so concurrent runs cannot hold more decoded
 * chunks than the budget whatever the read slots allow. A chunk larger than
 * the budget runs alone.
 */
export class ByteBudget {
  private used = 0;
  peak = 0;
  private readonly waiting: { bytes: number; grant: () => void }[] = [];

  constructor(readonly limit: number) {}

  get reserved() {
    return this.used;
  }

  async acquire(bytes: number, signal?: AbortSignal): Promise<() => void> {
    throwIfAborted(signal);
    const need = Math.min(Math.max(0, bytes), this.limit);
    if (this.used + need <= this.limit && this.waiting.length === 0) {
      this.take(need);
    } else {
      await new Promise<void>((resolve, reject) => {
        const entry = {
          bytes: need,
          grant: () => {
            signal?.removeEventListener("abort", abort);
            resolve();
          },
        };
        const abort = () => {
          const at = this.waiting.indexOf(entry);
          if (at >= 0) {
            this.waiting.splice(at, 1);
          }
          reject(signal!.reason ?? new DOMException("Aborted", "AbortError"));
        };
        signal?.addEventListener("abort", abort, { once: true });
        this.waiting.push(entry);
      });
    }
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.used -= need;
        this.drain();
      }
    };
  }

  private take(bytes: number) {
    this.used += bytes;
    this.peak = Math.max(this.peak, this.used);
  }

  private drain() {
    while (this.waiting.length) {
      const next = this.waiting[0];
      if (this.used > 0 && this.used + next.bytes > this.limit) {
        return;
      }
      this.waiting.shift();
      this.take(next.bytes);
      next.grant();
    }
  }
}

/** Shared caches and limits; one per page (worker or main thread). */
export class ReadContext {
  readonly chunkCache: ByteLru<TStoredChunk>;
  readonly budget: ByteBudget;
  private readonly inFlight = new Map<
    string,
    {
      promise: Promise<TStoredChunk>;
      users: number;
      controller: AbortController;
      /** The epoch it started in: a later publication makes it stale. */
      epoch: number;
    }
  >();
  /**
   * Release epochs per source (owner-scoped): a source released after a
   * read started keeps that read out of the cache; other sources' reads,
   * including one whose key merely starts alike (generation 1 and 10), are
   * unaffected.
   */
  private epoch = 0;
  private readonly released = new Map<string, number>();

  /**
   * Publications since, each with the chunks it may have changed: a read in
   * flight elsewhere in the source stays good.
   */
  private readonly publications: {
    at: number;
    owner: string;
    touches: (key: string) => boolean;
  }[] = [];

  private releasedSince(key: string, epoch: number) {
    for (const [owner, at] of this.released) {
      if (at > epoch && key.startsWith(owner)) {
        return true;
      }
    }
    return this.publications.some(
      (p) => p.at > epoch && key.startsWith(p.owner) && p.touches(key)
    );
  }

  constructor(
    readonly limiter = new ReadLimiter(4),
    chunkCacheBytes = 64 * 2 ** 20,
    decodedBudgetBytes = 32 * 2 ** 20
  ) {
    this.chunkCache = new ByteLru(chunkCacheBytes);
    this.budget = new ByteBudget(decodedBudgetBytes);
  }

  /** Read a chunk once, sharing in-flight reads of the same source chunk. */
  // eslint-disable-next-line max-lines-per-function
  async read(
    array: TAnalysisArray,
    coords: number[],
    counters: TWorkCounters,
    signal?: AbortSignal,
    /** Told of the backend read, which may outlive this reader's abort. */
    onBackend?: (settled: Promise<unknown>) => void
  ): Promise<TStoredChunk> {
    // An abort listener added after the abort never fires: refuse up front,
    // or this read would start and keep its source read alive.
    throwIfAborted(signal);
    if (array.readsThrough) {
      // Its nested reads may outlive this reader's abort: told on.
      return array.readChunk(coords, signal, onBackend);
    }
    const key = `${array.key}|${coords.join(",")}`;
    const cached = this.chunkCache.get(key);
    if (cached) {
      counters.cacheHits++;
      counters.absentChunks += Number(cached.absent);
      return cached;
    }
    let entry = this.inFlight.get(key);
    if (
      entry?.controller.signal.aborted ||
      (entry && this.releasedSince(key, entry.epoch))
    ) {
      // Its last reader gave up, or it began before its source changed (a
      // live publication): a new reader starts a fresh read. The old one
      // finishes for its own readers and is not cached.
      this.inFlight.delete(key);
      entry = undefined;
    }
    if (entry) {
      counters.sharedReads++;
    } else {
      const controller = new AbortController();
      const epoch = this.epoch;
      // Counted when the source read starts, by the run that started it:
      // queued reads cancelled before a slot opens never reach the source.
      const promise = this.limiter.run(async () => {
        counters.chunkReads++;
        const started = performance.now();
        const chunk = await array.readChunk(coords, controller.signal);
        counters.readMs += performance.now() - started;
        counters.fetchMs += chunk.fetchMs ?? 0;
        counters.fetchedBytes += chunk.fetchedBytes ?? 0;
        counters.decodedBytes += chunkBytes(chunk);
        return chunk;
      }, controller.signal);
      entry = { promise, users: 0, controller, epoch };
      this.inFlight.set(key, entry);
      const settled = entry;
      void promise
        .then((chunk) => {
          // Only the current read of a live source fills the cache: a late
          // completion of a replaced or released read is dropped.
          const current =
            this.inFlight.get(key) === settled &&
            !this.releasedSince(key, epoch);
          const bytes = chunkBytes(chunk);
          return (
            current &&
            !settled.controller.signal.aborted &&
            this.chunkCache.set(key, chunk, bytes)
          );
        })
        .catch(() => false)
        .finally(() => {
          if (this.inFlight.get(key) === settled) {
            this.inFlight.delete(key);
          }
        });
    }
    entry.users++;
    const shared = entry;
    // Settled, not fulfilled with the chunk: a waiter on it holds no decoded
    // values.
    onBackend?.(
      shared.promise.then(
        () => undefined,
        () => undefined
      )
    );
    const onAbort = () => {
      shared.users--;
      // Abort the source read only when no other analysis still needs it.
      if (shared.users <= 0) {
        shared.controller.abort(signal?.reason);
      }
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    try {
      const chunk = await raceAbort(shared.promise, signal);
      // Every run that used a gap says so, however the chunk reached it.
      counters.absentChunks += Number(chunk.absent);
      return chunk;
    } finally {
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /**
   * A live source (`sourceKey`, one store) published time steps `from` to
   * `to`. Chunks of a live field along time (`arrays`: key prefix, time
   * axis and chunk length) that hold any of those steps are dropped,
   * present ones too: a chunk read half written holds fill there. For
   * arrays without a known time axis, forget every gap (unless `gaps` is
   * false: those arrays are forgotten later). Reads in flight began before
   * the publication: they are neither joined nor cached.
   */
  forgetPublished(
    sourceKey: string,
    arrays: { prefix: string; axis: number; size: number }[],
    from: number,
    to: number,
    gaps = true
  ) {
    const owner = `${sourceKey}|`;
    const inRange = (key: string) => {
      const array = arrays.find(({ prefix }) => key.startsWith(prefix));
      if (!array) {
        return undefined;
      }
      const at = Number(key.slice(array.prefix.length).split(",")[array.axis]);
      return at * array.size <= to && (at + 1) * array.size > from;
    };
    // A read in flight of an array without a known time axis may be of a
    // gap: it is let go (whether it is one is not known until it lands).
    this.publications.push({
      at: ++this.epoch,
      owner,
      touches: (key) => inRange(key) ?? gaps,
    });
    if (this.publications.length > 256) {
      // Older ones as a release of their whole source: still safe.
      const old = this.publications.shift()!;
      this.released.set(
        old.owner,
        Math.max(this.released.get(old.owner) ?? 0, old.at)
      );
    }
    this.chunkCache.deletePrefix(
      owner,
      (chunk, key) => inRange(key) ?? (gaps && Boolean(chunk.absent))
    );
  }

  clearSource(sourceKey: string) {
    const owner = `${sourceKey}|`;
    this.released.set(owner, ++this.epoch);
    this.chunkCache.deletePrefix(owner);
  }
}

export function raceAbort<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) {
    return promise;
  }
  throwIfAborted(signal);
  return new Promise<T>((resolve, reject) => {
    const abort = () =>
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    signal.addEventListener("abort", abort, { once: true });
    promise
      .finally(() => signal.removeEventListener("abort", abort))
      .then((value) => resolve(value))
      .catch(reject);
  });
}

let lastYield = 0;
const YIELD_INTERVAL_MS = 16;

/** Yield to the event loop at most every 16 ms, then honour a cancel. */
export async function yieldIfBusy(signal?: AbortSignal) {
  const now = performance.now();
  if (now - lastYield >= YIELD_INTERVAL_MS) {
    lastYield = now;
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  }
  throwIfAborted(signal);
}

/** Sorted, disjoint half-open index runs along one dimension. */
export type TIndexRuns = [start: number, stop: number][];

type TDimChunks = { chunk: number; runs: TIndexRuns }[];

/** Directories built, per run list and chunk length (shared by time parts). */
const directories = new WeakMap<TIndexRuns, Map<number, TDimChunks>>();

/**
 * Runs grouped by chunk: built once per run list and chunk length, so a
 * selection of 500,000 runs read in four time parts builds one directory.
 */
function chunksOfRuns(runs: TIndexRuns, chunkLength: number): TDimChunks {
  let byLength = directories.get(runs);
  let known = byLength?.get(chunkLength);
  if (!known) {
    known = buildDirectory(runs, chunkLength);
    byLength ??= new Map();
    byLength.set(chunkLength, known);
    directories.set(runs, byLength);
  }
  return known;
}

/** Directories built so far (a test counts them). */
export const directoryBuilds = { count: 0 };

function buildDirectory(runs: TIndexRuns, chunkLength: number): TDimChunks {
  directoryBuilds.count++;
  const byChunk = new Map<number, TIndexRuns>();
  for (const [start, stop] of runs) {
    for (let at = start; at < stop;) {
      const chunk = Math.floor(at / chunkLength);
      const end = Math.min(stop, (chunk + 1) * chunkLength);
      let list = byChunk.get(chunk);
      if (!list) {
        list = [];
        byChunk.set(chunk, list);
      }
      list.push([at - chunk * chunkLength, end - chunk * chunkLength]);
      at = end;
    }
  }
  return [...byChunk.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([chunk, local]) => ({ chunk, runs: local }));
}

/**
 * Exact positions along some dimensions (e.g. the (row, column) of each
 * sampled cell); the other dimensions are read by runs. Only the listed
 * elements are decoded, grouped by their full chunk coordinate.
 */
export type TPointSelection = {
  dims: number[];
  /** `dims.length` positions per point, point after point. */
  positions: ArrayLike<number>;
};

type TPointGroup = {
  chunk: number[];
  /** Local positions, `dims.length` per point. */
  locals: Int32Array;
  /** Index of each point in the selection. */
  ids: Int32Array;
};

/**
 * Points grouped by chunk, compiled once per selection and chunk layout and
 * shared by every time part: one numeric key per point, one sort, and flat
 * typed arrays (group starts and chunk coordinates), so 400,000 one-point
 * groups cost a few typed arrays rather than 400,000 objects. The loops
 * yield, so a cancel lands while a large selection compiles.
 */
type TCompiledGroups = {
  count: number;
  rank: number;
  /** Start of each group in `ids`/`locals` (count + 1 entries). */
  starts: Int32Array;
  /**
   * Chunk coordinates, `rank` per group: Float64 (exact safe integers), as
   * high-order HEALPix chunk indices exceed 2^31 (order 21 at 4,096 cells
   * per chunk reaches 4,294,967,301).
   */
  chunks: Float64Array;
  ids: Int32Array;
  locals: Int32Array;
};

/**
 * Compilations by selection: finished or still running. Every time part of
 * a streamed plot waits on the same compilation instead of starting its
 * own; it stops once its last waiter has gone.
 */
type TCompilation = {
  layout: string;
  promise: Promise<TCompiledGroups>;
  controller: AbortController;
  waiters: number;
  settled: boolean;
};

const groupCache = new WeakMap<TPointSelection, TCompilation>();

/** Bytes a point selection holds: positions plus its compiled grouping. */
/**
 * Bytes a selection's runs hold: each run a small array (about 64 bytes in
 * a JavaScript engine) and its entry in the chunk directory (32): half of a
 * million interleaved cells is 500,000 runs, about 48 MB.
 */
export function runSelectionBytes(runs: TIndexRuns[]) {
  return runs.reduce((sum, dimRuns) => sum + dimRuns.length * 96, 0);
}

export function pointSelectionBytes(points: TPointSelection) {
  return points.positions.length * 8 + pointGroupBytes(points);
}

/** Bytes of a compiled point grouping (worst case one group per point). */
function pointGroupBytes(points: TPointSelection) {
  const rank = Math.max(1, points.dims.length);
  // While compiling: keys, order and the merge buffer. Kept: ids, local
  // positions, group starts and Float64 chunk coordinates.
  return (
    (points.positions.length / rank) * (8 + 4 + 4 + 4 + 4 * rank + 4 + 8 * rank)
  );
}

const POINTS_BETWEEN_YIELDS = 2 ** 16;

/** A mixed-radix chunk key per point (ordered like chunk coordinates). */
async function chunkKeys(
  points: TPointSelection,
  size: number[],
  signal?: AbortSignal
) {
  const rank = size.length;
  const count = points.positions.length / rank;
  const extent = new Array<number>(rank).fill(1);
  for (let p = 0; p < count; p++) {
    for (let k = 0; k < rank; k++) {
      extent[k] = Math.max(
        extent[k],
        Math.floor(points.positions[p * rank + k] / size[k]) + 1
      );
    }
  }
  const keys = new Float64Array(count);
  for (let p = 0; p < count; p++) {
    let key = 0;
    for (let k = 0; k < rank; k++) {
      key =
        key * extent[k] + Math.floor(points.positions[p * rank + k] / size[k]);
    }
    keys[p] = key;
    if (p > 0 && p % POINTS_BETWEEN_YIELDS === 0) {
      await yieldIfBusy(signal);
    }
  }
  return keys;
}

/**
 * Point indices ordered by key (stable). Keys already in order (sites read
 * in storage order) are not sorted at all; otherwise a bottom-up merge sort
 * yields between bounded runs, so a cancel lands within one step.
 */
async function orderByKey(keys: Float64Array, signal?: AbortSignal) {
  const count = keys.length;
  let order = Int32Array.from({ length: count }, (_, p) => p);
  let monotone = true;
  for (let p = 1; p < count && monotone; p++) {
    monotone = keys[p - 1] <= keys[p];
  }
  if (monotone) {
    return order;
  }
  let buffer = new Int32Array(count);
  let work = 0;
  for (let width = 1; width < count; width *= 2) {
    for (let from = 0; from < count; from += 2 * width) {
      const mid = Math.min(from + width, count);
      const to = Math.min(from + 2 * width, count);
      let [i, j, k] = [from, mid, from];
      while (i < mid && j < to) {
        buffer[k++] = keys[order[j]] < keys[order[i]] ? order[j++] : order[i++];
      }
      while (i < mid) {
        buffer[k++] = order[i++];
      }
      while (j < to) {
        buffer[k++] = order[j++];
      }
      work += to - from;
      if (work >= POINTS_BETWEEN_YIELDS) {
        work = 0;
        await yieldIfBusy(signal);
      }
    }
    [order, buffer] = [buffer, order];
  }
  return order;
}

async function compileGroups(
  points: TPointSelection,
  size: number[],
  signal: AbortSignal
): Promise<TCompiledGroups> {
  const rank = points.dims.length;
  const count = points.positions.length / rank;
  const keys = await chunkKeys(points, size, signal);
  const order = await orderByKey(keys, signal);
  const ids = new Int32Array(count);
  const locals = new Int32Array(count * rank);
  let groupCount = 0;
  for (let at = 0; at < count; at++) {
    if (at === 0 || keys[order[at]] !== keys[order[at - 1]]) {
      groupCount++;
    }
  }
  const starts = new Int32Array(groupCount + 1);
  const chunkCoords = new Float64Array(groupCount * rank);
  let g = -1;
  for (let at = 0; at < count; at++) {
    const p = order[at];
    ids[at] = p;
    const fresh = at === 0 || keys[p] !== keys[order[at - 1]];
    if (fresh) {
      starts[++g] = at;
    }
    for (let k = 0; k < rank; k++) {
      const position = points.positions[p * rank + k];
      const chunk = Math.floor(position / size[k]);
      locals[at * rank + k] = position - chunk * size[k];
      if (fresh) {
        chunkCoords[g * rank + k] = chunk;
      }
    }
    if (at > 0 && at % POINTS_BETWEEN_YIELDS === 0) {
      await yieldIfBusy(signal);
    }
  }
  starts[groupCount] = count;
  return { count: groupCount, rank, starts, chunks: chunkCoords, ids, locals };
}

/** The selection's grouping, shared with every concurrent caller. */
function groupPoints(
  points: TPointSelection,
  chunks: number[],
  signal?: AbortSignal
): Promise<TCompiledGroups> {
  const layout = points.dims.map((d) => chunks[d]).join(",");
  let entry = groupCache.get(points);
  if (entry?.layout !== layout) {
    const controller = new AbortController();
    const created: TCompilation = {
      layout,
      controller,
      waiters: 0,
      settled: false,
      promise: compileGroups(
        points,
        points.dims.map((d) => chunks[d]),
        controller.signal
      ),
    };
    void created.promise.then(
      () => (created.settled = true),
      () => {
        created.settled = true;
        if (groupCache.get(points) === created) {
          groupCache.delete(points);
        }
      }
    );
    groupCache.set(points, created);
    entry = created;
  }
  return waitShared(entry, signal, () => {
    if (groupCache.get(points) === entry) {
      groupCache.delete(points);
    }
  });
}

/**
 * Wait on shared work with an own signal. A waiter without a signal keeps
 * the work going; when the last waiter with one leaves before it settles,
 * the work is aborted and `dropped` forgets it.
 */
// eslint-disable-next-line max-lines-per-function
function waitShared<T>(
  shared: {
    promise: Promise<T>;
    controller: AbortController;
    waiters: number;
    settled: boolean;
  },
  signal: AbortSignal | undefined,
  dropped: () => void
): Promise<T> {
  if (!signal) {
    shared.waiters = Number.POSITIVE_INFINITY;
    return shared.promise;
  }
  shared.waiters++;
  return new Promise<T>((resolve, reject) => {
    let done = false;
    const leave = () => {
      if (done) {
        return;
      }
      done = true;
      shared.waiters--;
      if (shared.waiters <= 0 && !shared.settled) {
        shared.controller.abort(signal.reason);
        dropped();
      }
      reject(signal.reason ?? new DOMException("Aborted", "AbortError"));
    };
    if (signal.aborted) {
      leave();
      return;
    }
    signal.addEventListener("abort", leave, { once: true });
    const settle = async () => {
      try {
        const value = await shared.promise;
        if (!done) {
          done = true;
          shared.waiters--;
          resolve(value);
        }
      } catch (error) {
        done = true;
        reject(error);
      } finally {
        signal.removeEventListener("abort", leave);
      }
    };
    void settle();
  });
}

/** One group's view, made only while its chunk job runs. */
function groupAt(groups: TCompiledGroups, g: number): TPointGroup {
  const [from, to] = [groups.starts[g], groups.starts[g + 1]];
  return {
    chunk: Array.from(
      groups.chunks.subarray(g * groups.rank, (g + 1) * groups.rank)
    ),
    ids: groups.ids.subarray(from, to),
    locals: groups.locals.subarray(from * groups.rank, to * groups.rank),
  };
}

/** Distinct chunks along one dimension's runs, counted without listing. */
function countDimChunks(dimRuns: TIndexRuns, chunk: number) {
  let touched = 0;
  let lastChunk = -1;
  for (const [start, stop] of dimRuns) {
    if (stop <= start) {
      continue;
    }
    const first = Math.max(Math.floor(start / chunk), lastChunk + 1);
    const last = Math.floor((stop - 1) / chunk);
    if (last >= first) {
      touched += last - first + 1;
    }
    lastChunk = Math.max(lastChunk, last);
  }
  return touched;
}

/**
 * Number of chunks a selection touches: merged chunk intervals of each run
 * dimension times the distinct chunks of the points, without listing them.
 */
/** Most stored chunks one plan may touch (admission refuses more). */
export const MAX_PLANNED_CHUNKS = 200_000;

export function countRunChunks(
  runs: TIndexRuns[],
  chunks: number[],
  points?: TPointSelection,
  /** Stop counting once past this (planning refuses anything larger). */
  limit = MAX_PLANNED_CHUNKS
) {
  let count = 1;
  const pointDims = new Set(points?.dims ?? []);
  runs.forEach((dimRuns, d) => {
    if (!pointDims.has(d)) {
      count *= countDimChunks(dimRuns, chunks[d]);
    }
  });
  if (points && count > 0) {
    const rank = points.dims.length;
    // Numeric keys for one point dimension (the usual case), strings else.
    const keys = new Set<number | string>();
    for (let p = 0; p < points.positions.length / rank; p++) {
      if (rank === 1) {
        keys.add(Math.floor(points.positions[p] / chunks[points.dims[0]]));
      } else {
        let key = "";
        for (let k = 0; k < rank; k++) {
          key += `${Math.floor(points.positions[p * rank + k] / chunks[points.dims[k]])},`;
        }
        keys.add(key);
      }
      if (count * keys.size > limit) {
        return count * keys.size;
      }
    }
    count *= keys.size;
  }
  return count;
}

export type TVisitor = (
  chunkOrdinal: number,
  index: Float64Array,
  value: number,
  /** Index of the point in a point selection, or -1. */
  point: number
) => void;

const JOBS_PER_BATCH = 16;

/**
 * Visit every selected element of a selection (runs per dimension, and
 * optionally exact points along some dimensions), reading each touched
 * chunk once. Values are CF-decoded (NaN when missing). Each chunk job
 * reserves its decoded bytes before reading and keeps them until its visit
 * ends; the visitor gets the chunk's ordinal so reductions can be combined
 * in a fixed order.
 */
// eslint-disable-next-line max-lines-per-function
export async function visitRuns(
  context: ReadContext,
  array: TAnalysisArray,
  codec: TValueCodec,
  runs: TIndexRuns[],
  visit: TVisitor,
  counters: TWorkCounters,
  signal?: AbortSignal,
  onChunkDone?: (ordinal: number) => void,
  points?: TPointSelection
) {
  throwIfAborted(signal);
  const rank = runs.length;
  const pointDims = new Set(points?.dims ?? []);
  const perDim = runs.map((dimRuns, d) =>
    pointDims.has(d) ? [] : chunksOfRuns(dimRuns, array.chunks[d])
  );
  const runDims = [...Array(rank).keys()].filter((d) => !pointDims.has(d));
  const groups = points
    ? await groupPoints(points, array.chunks, signal)
    : undefined;
  const groupCount = groups ? groups.count : 1;
  let count = groupCount;
  for (const d of runDims) {
    count *= perDim[d].length;
  }
  counters.plannedChunks += count;
  if (count === 0) {
    return 0;
  }
  const bytes = chunkByteSize(array) + (array.partnerBytes ?? 0);
  const odometer = new Array<number>(rank).fill(0);
  const advance = shardOrder(array, runDims, perDim, odometer);
  const jobs: Promise<void>[] = [];
  let group = 0;
  for (let ordinal = 0; ordinal < count; ordinal++) {
    throwIfAborted(signal);
    const picks = runDims.map((d) => ({ d, pick: perDim[d][odometer[d]] }));
    const pointGroup = groups ? groupAt(groups, group) : undefined;
    jobs.push(
      (async () => {
        const coords = new Array<number>(rank);
        for (const { d, pick } of picks) {
          coords[d] = pick.chunk;
        }
        points?.dims.forEach((d, k) => (coords[d] = pointGroup!.chunk[k]));
        const release = await context.budget.acquire(bytes, signal);
        // The reservation lasts until the backend read settles: a source
        // that ignores the abort still decodes into memory meanwhile.
        let backend: Promise<unknown> | undefined;
        try {
          const chunk = await context.read(
            array,
            coords,
            counters,
            signal,
            (settled) => (backend = settled)
          );
          throwIfAborted(signal);
          const started = performance.now();
          await visitChunk(
            chunk,
            { coords, picks, chunkShape: array.chunks, points, pointGroup },
            codec,
            (index, value, point) => visit(ordinal, index, value, point),
            counters,
            signal
          );
          counters.reduceMs += performance.now() - started;
        } finally {
          if (backend) {
            void backend.finally(release);
          } else {
            release();
          }
        }
        onChunkDone?.(ordinal);
      })()
    );
    // Odometer: point groups innermost, then run dimensions from the last.
    group++;
    if (group === groupCount) {
      group = 0;
      advance();
    }
    // Bound the chunk jobs queued at once, and let a cancel message in.
    if (jobs.length >= JOBS_PER_BATCH) {
      await Promise.all(jobs);
      jobs.length = 0;
      await yieldIfBusy(signal);
    }
  }
  await Promise.all(jobs);
  return count;
}

/**
 * The odometer's step over the run dimensions, the last fastest. Past the
 * first, a sharded array's chunks are visited shard by shard, so each index is
 * read once per step of the first. Unsharded, or one chunk or one shard along
 * each, it is the plain order.
 */
// eslint-disable-next-line max-lines-per-function
function shardOrder(
  array: TAnalysisArray,
  runDims: number[],
  perDim: TDimChunks[],
  odometer: number[]
) {
  const nested = array.shardIndex ? runDims.slice(1) : [];
  // Each nested dimension's shards: [from, to) into its chunk list.
  const spans = new Map<number, [number, number][]>();
  for (const d of nested) {
    const per = Math.max(1, array.shardIndex!.chunksPerShard[d] ?? 1);
    const list: [number, number][] = [];
    perDim[d].forEach((pick, at) => {
      const last = list.at(-1);
      if (
        last &&
        Math.floor(perDim[d][last[0]].chunk / per) ===
          Math.floor(pick.chunk / per)
      ) {
        last[1] = at + 1;
      } else {
        list.push([at, at + 1]);
      }
    });
    spans.set(d, list);
  }
  const shard = new Array<number>(odometer.length).fill(0);
  const step = (d: number, by: "chunk" | "shard") => {
    const list = spans.get(d)!;
    if (by === "chunk") {
      odometer[d]++;
      if (odometer[d] < list[shard[d]][1]) {
        return true;
      }
      odometer[d] = list[shard[d]][0];
      return false;
    }
    shard[d] = (shard[d] + 1) % list.length;
    odometer[d] = list[shard[d]][0];
    return shard[d] !== 0;
  };
  return () => {
    for (const by of ["chunk", "shard"] as const) {
      for (let k = nested.length - 1; k >= 0; k--) {
        if (step(nested[k], by)) {
          return;
        }
      }
    }
    for (let k = runDims.length - nested.length - 1; k >= 0; k--) {
      const d = runDims[k];
      odometer[d]++;
      if (odometer[d] < perDim[d].length) {
        return;
      }
      odometer[d] = 0;
    }
  };
}

const ELEMENTS_BETWEEN_YIELDS = 2 ** 18;

type TChunkSelection = {
  coords: number[];
  picks: { d: number; pick: { chunk: number; runs: TIndexRuns } }[];
  chunkShape: number[];
  points?: TPointSelection;
  pointGroup?: TPointGroup;
};

/**
 * Visit the selected elements of one chunk: a cursor over the run
 * dimensions (no index lists are built) and, inside it, the chunk's points.
 */
// eslint-disable-next-line max-lines-per-function
async function visitChunk(
  chunk: TStoredChunk,
  selection: TChunkSelection,
  codec: TValueCodec,
  visit: (index: Float64Array, value: number, point: number) => void,
  counters: TWorkCounters,
  signal?: AbortSignal
) {
  const { coords, picks, chunkShape, points, pointGroup } = selection;
  const rank = coords.length;
  const { data, stride, absent, missingAt } = chunk;
  // Float64: global positions exceed 2^31 on high HEALPix orders.
  const index = new Float64Array(rank);
  const pointRank = points?.dims.length ?? 0;
  const pointCount = pointGroup ? pointGroup.ids.length : 1;
  const pointFlat = new Float64Array(pointCount);
  if (pointGroup) {
    for (let p = 0; p < pointCount; p++) {
      let flat = 0;
      for (let k = 0; k < pointRank; k++) {
        flat += pointGroup.locals[p * pointRank + k] * stride[points!.dims[k]];
      }
      pointFlat[p] = flat;
    }
  }
  if (picks.some(({ pick }) => pick.runs.length === 0)) {
    return;
  }
  const cursor = picks.map(({ pick }) => ({ run: 0, pos: pick.runs[0][0] }));
  // 64-bit integers keep their exact value until their markers are compared.
  const big = !absent && typeof data[0] === "bigint";
  let visited = 0;
  for (;;) {
    let base = 0;
    for (let k = 0; k < picks.length; k++) {
      const { d, pick } = picks[k];
      base += cursor[k].pos * stride[d];
      index[d] = pick.chunk * chunkShape[d] + cursor[k].pos;
    }
    for (let p = 0; p < pointCount; p++) {
      if (pointGroup) {
        for (let k = 0; k < pointRank; k++) {
          const d = points!.dims[k];
          index[d] =
            coords[d] * chunkShape[d] + pointGroup.locals[p * pointRank + k];
        }
      }
      const flat = base + pointFlat[p];
      const value = missingAt?.(index)
        ? Number.NaN
        : absent
          ? codec.absentValue
          : big
            ? decodeStoredBigInt(codec, data[flat] as bigint)
            : decodeStoredValue(codec, Number(data[flat]));
      visit(index, value, pointGroup ? pointGroup.ids[p] : -1);
      // A large chunk must not hold off a cancel or a pause.
      if (++visited % ELEMENTS_BETWEEN_YIELDS === 0) {
        await yieldIfBusy(signal);
      }
    }
    let k = picks.length - 1;
    for (; k >= 0; k--) {
      const state = cursor[k];
      const runs = picks[k].pick.runs;
      state.pos++;
      if (state.pos < runs[state.run][1]) {
        break;
      }
      state.run++;
      if (state.run < runs.length) {
        state.pos = runs[state.run][0];
        break;
      }
      state.run = 0;
      state.pos = runs[0][0];
    }
    if (k < 0) {
      break;
    }
  }
  counters.visitedElements += visited;
}
