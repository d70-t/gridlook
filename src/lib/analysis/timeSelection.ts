/**
 * Date ranges made of several stored slices (25 Nov): a file that stores
 * its dates out of order (Jan 1, Jan 4, Jan 2, Jan 3) holds Jan 1 to Jan 3
 * in two slices, [0, 1) and [2, 4). A selection then carries those `runs`
 * beside its outer `start` and `stop`; the rows of a result are the runs'
 * dates in storage order, one after another. A selection without runs is
 * the one slice from `start` to `stop`, as before.
 */
import { AnalysisInputError } from "./analysisErrors.ts";
import type { TPlannedAnalysis } from "./operations.ts";
import { extendResult, mergedCounters } from "./partialUpdates.ts";
import type {
  TAnalysisQuery,
  TAnalysisResult,
  TPartialUpdate,
  TPlanEstimate,
} from "./types.ts";

type TTimeSelection = NonNullable<TAnalysisQuery["time"]>;
type TRun = [number, number];
type TSliceTime = (start: number, stop: number) => TAnalysisResult["time"];
type TPartial = TPartialUpdate["partial"];

/** A selection's runs as given: whole, ascending, apart, within it. */
function checkedRuns(time: TTimeSelection): TRun[] | undefined {
  const runs = time.runs;
  if (!runs?.length) {
    return undefined;
  }
  const valid =
    runs[0][0] === time.start &&
    runs.at(-1)![1] === time.stop &&
    runs.every(
      ([a, b], k) =>
        Number.isInteger(a) &&
        Number.isInteger(b) &&
        b > a &&
        (k === 0 || a > runs[k - 1][1])
    );
  if (!valid) {
    throw new AnalysisInputError(
      "The date range's slices must be whole, ascending, separate index ranges from its start to its stop."
    );
  }
  return runs.length > 1 ? runs : undefined;
}

/** Several plans' estimates as one: their reads added up, asked together. */
// eslint-disable-next-line max-lines-per-function
function combined(
  estimates: TPlanEstimate[],
  limits: TSliceLimits,
  runs: TRun[]
): TPlanEstimate {
  const [first] = estimates;
  // One pass, no argument spread (an unbounded spread overflows the stack).
  let [chunks, decodedBytes, outputValues, largest, largestOutput] = [
    0, 0, 0, 0, 0,
  ];
  // The partner's and terms' reads, apart: the field's time chunks say nothing
  // of theirs.
  let [termChunks, termBytes] = [0, 0];
  for (const e of estimates) {
    chunks += e.chunks - (e.termChunks ?? 0);
    decodedBytes += e.decodedBytes - (e.termBytes ?? 0);
    termChunks += e.termChunks ?? 0;
    termBytes += e.termBytes ?? 0;
    outputValues += e.outputValues;
    largest = Math.max(largest, e.workingBytes);
    largestOutput = Math.max(largestOutput, e.outputValues);
  }
  // Slices over the same cells share the stored chunks of their dates: a chunk
  // of time holding several slices is read once, while it stays in the
  // decoded-chunk cache.
  const shared = sharedShare(runs, limits.timeChunk);
  if (shared < 1 && decodedBytes * shared <= (limits.cacheBytes ?? 0)) {
    chunks = Math.max(1, Math.round(chunks * shared));
    decodedBytes = Math.round(decodedBytes * shared);
  }
  chunks += termChunks;
  decodedBytes += termBytes;
  // The whole result is held while its slices are read: the largest slice's
  // working set plus every slice's output.
  const workingBytes = largest + (outputValues - largestOutput) * 8;
  limits.admit({ chunks, outputValues, workingBytes });
  // Every slice's runs, axis by axis, for the shards they touch together.
  const merge = (
    pick: (e: TPlanEstimate) => [number, number][][] | undefined
  ) => {
    const lists = estimates.map(pick);
    if (lists.some((list) => !list)) {
      return undefined;
    }
    return lists[0]!.map((_, d) => lists.flatMap((list) => list![d] ?? []));
  };
  const own = merge((e) => e.shardRuns?.own);
  const partner = merge((e) => e.shardRuns?.partner);
  return {
    ...first,
    ...(own ? { shardRuns: { own, ...(partner ? { partner } : {}) } } : {}),
    chunks,
    decodedBytes,
    workingBytes,
    outputValues,
    // All slices' partner reads, not the first slice's.
    ...(termChunks ? { termChunks, termBytes } : {}),
    needsConfirmation: estimates.some((e) => e.needsConfirmation),
    modest:
      estimates.every((e) => e.modest) &&
      decodedBytes <= limits.bytes &&
      chunks <= limits.chunks,
    notes: [
      `The dates are stored in ${estimates.length} separate slices of the file; each is read on its own.`,
      ...first.notes,
    ],
  };
}

/**
 * The distinct stored time chunks the runs touch, as a share of the chunks
 * counted run by run (1: none shared).
 */
function sharedShare(runs: TRun[], chunk: number | undefined) {
  if (!chunk || chunk <= 0) {
    return 1;
  }
  let [counted, distinct, last] = [0, 0, -1];
  // Runs ascend: a chunk shared by neighbours is met in order.
  for (const [start, stop] of runs) {
    const [a, b] = [Math.floor(start / chunk), Math.floor((stop - 1) / chunk)];
    counted += b - a + 1;
    distinct += b - Math.max(a, last + 1) + 1;
    last = Math.max(last, b);
  }
  return counted ? distinct / counted : 1;
}

/** The limits a sliced plan is held to as a whole. */
type TSliceLimits = {
  /** Rows per stored time chunk, and the decoded-chunk cache's size. */
  timeChunk?: number;
  cacheBytes?: number;
  /** A modest request: started without asking. */
  bytes: number;
  chunks: number;
  /** The hard limits (chunks, output values, working memory): throws. */
  admit: (total: {
    chunks: number;
    outputValues: number;
    workingBytes: number;
  }) => void;
};

/** Rows of missing values shaped as `like`, with their own dates. */
function blank(
  like: TAnalysisResult,
  rows: number,
  time: TAnalysisResult["time"]
): TAnalysisResult {
  const per = (column: number[]) => column.length / Math.max(1, like.shape[0]);
  const nan = (column?: number[]) =>
    column && new Array<number>(rows * per(column)).fill(Number.NaN);
  return {
    ...like,
    values: nan(like.values)!,
    shape: [rows, ...like.shape.slice(1)],
    ...(time ? { time } : {}),
    region: like.region && {
      ...like.region,
      coverage: nan(like.region.coverage)!,
      validCells: nan(like.region.validCells)!,
      spread: like.region.spread && {
        std: nan(like.region.spread.std)!,
        min: nan(like.region.spread.min)!,
        max: nan(like.region.spread.max)!,
      },
    },
    cellCoverage: nan(like.cellCoverage),
  };
}

/** A streamed base's columns grown to `length` (its `padTo`). */
function padded(base: TAnalysisResult, length?: number): TAnalysisResult {
  if (!length) {
    return base;
  }
  const pad = (column?: number[]) =>
    column && [
      ...column,
      ...new Array<number>(Math.max(0, length - column.length)).fill(
        Number.NaN
      ),
    ];
  return {
    ...base,
    values: pad(base.values)!,
    region: base.region && {
      ...base.region,
      coverage: pad(base.region.coverage)!,
      validCells: pad(base.region.validCells)!,
      spread: base.region.spread && {
        std: pad(base.region.spread.std)!,
        min: pad(base.region.spread.min)!,
        max: pad(base.region.spread.max)!,
      },
    },
  };
}

/**
 * Results in storage order joined row after row, pairwise level by level:
 * each value copied about log₂(n) times, not n.
 */
function joined(parts: TAnalysisResult[]) {
  let level = parts;
  while (level.length > 1) {
    const next: TAnalysisResult[] = [];
    for (let at = 0; at < level.length; at += 2) {
      next.push(
        at + 1 < level.length
          ? extendResult(level[at], level[at + 1], false)
          : level[at]
      );
    }
    level = next;
  }
  return level[0];
}

/** A slice's whole streamed base, as a delta at its rows in the request. */
function asDelta(
  base: TAnalysisResult,
  update: Pick<TPartialUpdate, "partial" | "counters">,
  offset: number
): TPartialUpdate {
  return {
    offset,
    values: base.values,
    ...(base.region
      ? {
          coverage: base.region.coverage,
          validCells: base.region.validCells,
          ...(base.region.spread ? { spread: base.region.spread } : {}),
        }
      : {}),
    ...(base.cellCoverage ? { cellCoverage: base.cellCoverage } : {}),
    partial: update.partial,
    counters: update.counters,
  };
}

/**
 * A plan for a selection of several slices: one plan a slice, priced,
 * admitted and asked about together, read one after another (from the
 * last when the selection is read from its end). The stream carries one
 * full base, the whole request's rows with the dates of slices still to
 * come, then deltas at each slice's rows; the result's rows are the
 * slices' dates in storage order. Without runs, the plan itself.
 */
// eslint-disable-next-line max-lines-per-function
export async function planInSlices(
  query: TAnalysisQuery,
  plan: (query: TAnalysisQuery) => Promise<TPlannedAnalysis>,
  sliceTime: TSliceTime,
  limits: TSliceLimits
): Promise<TPlannedAnalysis> {
  const runs = query.time && checkedRuns(query.time);
  if (!runs) {
    return plan(query);
  }
  const fromEnd = Boolean(query.time!.fromEnd);
  const plans: TPlannedAnalysis[] = [];
  for (const [start, stop] of runs) {
    plans.push(
      await plan({
        ...query,
        time: { start, stop, ...(fromEnd ? { fromEnd } : {}) },
      })
    );
  }
  const rows = runs.map(([a, b]) => b - a);
  // One running sum.
  const offsets: number[] = [];
  rows.reduce((at, r) => (offsets.push(at), at + r), 0);
  const order = rows.map((_, k) => k);
  if (fromEnd) {
    order.reverse();
  }
  return {
    estimate: combined(
      plans.map((p) => p.estimate),
      limits,
      runs
    ),

    // eslint-disable-next-line max-lines-per-function -- one read, slice by slice
    async execute(signal, hooks) {
      const results: TAnalysisResult[] = [];
      const total = offsets.at(-1)! + rows.at(-1)!;
      let [baseSent, rowsDone] = [false, 0];
      /** Values a row holds (a profile's levels), once a slice showed it. */
      let perRow: number | undefined;
      // Work of the slices already read: an update's counters are the
      // whole request's so far, not its slice's.
      let doneCounters: TAnalysisResult["counters"] | undefined;
      const sum = (c: TAnalysisResult["counters"]) =>
        doneCounters ? mergedCounters(doneCounters, c) : c;
      // Progress in selected dates; read up to (or, from the end, from)
      // the slices published so far.
      const progress = (k: number, inSlice: number, at?: TPartial) => ({
        done: rowsDone + inSlice,
        total,
        readUntil: fromEnd ? query.time!.stop : (at?.readUntil ?? runs[k][0]),
        ...(fromEnd ? { readFrom: at?.readFrom ?? runs[k][1] } : {}),
      });
      // At most one update per `publishEveryMs` across all slices: 512 one-date
      // slices published 1,023 results, and the chart took 44.8 s to show a
      // cached read. Skipped updates are made good by a whole snapshot, not a
      // delta.
      const every = hooks?.publishEveryMs ?? 0;
      let [lastSent, skipped] = [Number.NEGATIVE_INFINITY, false];
      let latest:
        | {
            k: number;
            own: TAnalysisResult;
            counters: TAnalysisResult["counters"];
            partial: TPartial;
          }
        | undefined;
      /** Every slice as read so far, the others' dates without values. */
      const sendWhole = (
        k: number,
        own: TAnalysisResult,
        counters: TAnalysisResult["counters"],
        partial: TPartial
      ) => {
        baseSent = true;
        skipped = false;
        lastSent = performance.now();
        const whole = joined(
          runs.map(
            ([a, b], j) =>
              (j === k ? own : results[j]) ??
              blank(own, rows[j], sliceTime(a, b))
          )
        );
        hooks?.onPartial?.({
          base: { ...whole, query, partial, counters },
          offset: 0,
          values: [],
          partial,
          counters,
        });
      };
      // A skipped update is sent when its window closes, not only at the next
      // one: a read held after three fast slices still shows them.
      let trailing: ReturnType<typeof setTimeout> | undefined;
      const later = () => {
        if (trailing === undefined) {
          trailing = setTimeout(
            () => {
              trailing = undefined;
              flush();
            },
            Math.max(0, every - (performance.now() - lastSent))
          );
        }
      };
      /** A slice as read so far: a whole snapshot, then as deltas. */
      const send = (
        k: number,
        own: TAnalysisResult,
        counters: TAnalysisResult["counters"],
        partial: TPartial
      ) => {
        latest = { k, own, counters, partial };
        if (baseSent && performance.now() - lastSent < every) {
          skipped = true;
          later();
          return;
        }
        if (!baseSent || skipped) {
          sendWhole(k, own, counters, partial);
          return;
        }
        lastSent = performance.now();
        const per = own.values.length / Math.max(1, rows[k]) || 1;
        hooks?.onPartial?.(
          asDelta(own, { partial, counters }, offsets[k] * per)
        );
      };
      /** What a skipped update would have shown, before a stop or failure. */
      const flush = () => {
        if (trailing !== undefined) {
          clearTimeout(trailing);
          trailing = undefined;
        }
        if (skipped && latest) {
          sendWhole(latest.k, latest.own, latest.counters, latest.partial);
        }
      };
      for (const [step, k] of order.entries()) {
        try {
          results[k] = await plans[k].execute(signal, {
            ...hooks,
            onPartial: (update) => {
              const own = update.base && padded(update.base, update.padTo);
              const inSlice = Math.floor(
                (update.partial.done / Math.max(1, update.partial.total)) *
                  rows[k]
              );
              const partial = progress(k, inSlice, update.partial);
              const counters = sum(update.counters);
              if (own) {
                perRow = own.values.length / Math.max(1, rows[k]) || perRow;
                send(k, own, counters, partial);
                return;
              }
              // A delta inside a slice: within the window, or after skipped
              // updates (whose snapshot this delta does not complete), wait.
              if (skipped || performance.now() - lastSent < every) {
                skipped = baseSent;
                if (skipped) {
                  later();
                }
                return;
              }
              lastSent = performance.now();
              hooks?.onPartial?.({
                ...update,
                offset: update.offset + offsets[k] * (perRow ?? 1),
                counters,
                partial,
              });
            },
          });
        } catch (error) {
          // A stop or failure keeps every finished slice on screen.
          flush();
          throw error;
        }
        doneCounters = sum(results[k].counters);
        rowsDone += rows[k];
        perRow = results[k].values.length / Math.max(1, rows[k]) || perRow;
        // A finished slice is published before the next starts: a Stop or a
        // failure there keeps it.
        if (step < order.length - 1) {
          const [a, b] = runs[k];
          send(k, results[k], doneCounters, {
            done: rowsDone,
            total,
            readUntil: fromEnd ? query.time!.stop : b,
            ...(fromEnd ? { readFrom: a } : {}),
          });
        }
      }
      if (trailing !== undefined) {
        clearTimeout(trailing);
        trailing = undefined;
      }
      return { ...joined(results), query, partial: undefined };
    },
  };
}
