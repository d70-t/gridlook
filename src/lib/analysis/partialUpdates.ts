import { clipSelection, rowCount, rowsBefore } from "./timeRows.ts";
import type { TAnalysisResult, TPartialUpdate } from "./types.ts";

/**
 * Rebuild full partial results from streamed updates. Arrays are patched in
 * place; each update yields a new result object so views refresh.
 */
export function createPartialAssembler(
  onPartial: (result: TAnalysisResult) => void
) {
  let current: TAnalysisResult | undefined;
  return (update: TPartialUpdate) => {
    if (update.base) {
      current = update.base;
      if (update.padTo) {
        padColumns(current, update.padTo);
      }
    }
    if (!current) {
      return;
    }
    const patch = (target: number[] | undefined, values?: number[]) => {
      if (target && values) {
        for (let at = 0; at < values.length; at++) {
          target[update.offset + at] = values[at];
        }
      }
    };
    patch(current.values, update.values);
    patch(current.region?.coverage, update.coverage);
    patch(current.region?.validCells, update.validCells);
    patch(current.region?.spread?.std, update.spread?.std);
    patch(current.region?.spread?.min, update.spread?.min);
    patch(current.region?.spread?.max, update.spread?.max);
    patch(current.cellCoverage, update.cellCoverage);
    if (update.cells) {
      const { at, values } = update.cells;
      for (let k = 0; k < at.length; k++) {
        current.values[at[k]] = values[k];
        if (current.cellRead) {
          current.cellRead[at[k]] = 1;
        }
      }
    }
    current = {
      ...current,
      partial: update.partial,
      counters: update.counters,
    };
    onPartial(current);
  };
}

/** A base's per-step columns grown to `length` with missing values. */
function padColumns(result: TAnalysisResult, length: number) {
  const pad = (column?: number[]) => {
    if (column) {
      for (let at = column.length; at < length; at++) {
        column.push(Number.NaN);
      }
    }
  };
  pad(result.values);
  pad(result.region?.coverage);
  pad(result.region?.validCells);
  pad(result.region?.spread?.std);
  pad(result.region?.spread?.min);
  pad(result.region?.spread?.max);
}

/**
 * A copy of a (possibly streaming) result that later parts cannot change:
 * the arrays the assembler patches in place are copied, and the partial
 * status and counters are fixed as they are now.
 */
export function freezeResult(result: TAnalysisResult): TAnalysisResult {
  return {
    ...result,
    values: result.values.slice(),
    partial: result.partial && { ...result.partial },
    counters: { ...result.counters },
    region: result.region && {
      ...result.region,
      coverage: result.region.coverage.slice(),
      validCells: result.region.validCells.slice(),
      spread: result.region.spread && {
        std: result.region.spread.std.slice(),
        min: result.region.spread.min.slice(),
        max: result.region.spread.max.slice(),
      },
    },
    cellCoverage: result.cellCoverage?.slice(),
    // With its values: a sibling still reading writes into the shared one.
    cellRead: result.cellRead?.slice(),
  };
}

/**
 * A stopped series read on: the dates read before the stop (`prefix`,
 * frozen, the whole request's length) followed by a run over the dates
 * after them (`rest`, streaming or done). Per-date columns are joined at
 * the stop; parts and work add up; axes and labels stay the prefix's.
 */
// eslint-disable-next-line max-lines-per-function
export function continueResult(
  prefix: TAnalysisResult,
  rest: TAnalysisResult
): TAnalysisResult {
  // The rows the prefix read, not its whole allocated length: the request may
  // end earlier now.
  const from = prefix.query?.time?.start;
  const asked = prefix.query?.time;
  const readUntil = prefix.partial?.readUntil;
  // Rows, not indices: a request in several stored slices (timeRows.ts)
  // has fewer rows than its indices from start to stop.
  const rows =
    asked && readUntil !== undefined && from !== undefined
      ? rowsBefore(asked, Math.min(readUntil, asked.stop))
      : undefined;
  const width =
    rows !== undefined && asked
      ? prefix.values.length / Math.max(1, rowCount(asked))
      : undefined;
  const cut =
    rows !== undefined && width !== undefined && Number.isInteger(width)
      ? rows * width
      : prefix.values.length - rest.values.length;
  const rowCut = width ? cut / width : cut;
  const join = (head?: number[], tail?: number[]) =>
    head && tail ? [...head.slice(0, cut), ...tail] : head;
  /** A per-date list (one entry a row, or `per` a row). */
  const byRow = <T>(head: T[] | undefined, tail: T[] | undefined, per = 1) =>
    head && tail ? [...head.slice(0, rowCut * per), ...tail] : head;
  const time =
    prefix.time && rest.time && rows !== undefined
      ? {
          ...prefix.time,
          raw: byRow(prefix.time.raw, rest.time.raw)!,
          bounds:
            prefix.time.bounds && rest.time.bounds
              ? byRow(prefix.time.bounds, rest.time.bounds, 2)
              : undefined,
          valid:
            prefix.time.valid && rest.time.valid
              ? byRow(prefix.time.valid, rest.time.valid)
              : undefined,
          validBounds:
            prefix.time.validBounds && rest.time.validBounds
              ? byRow(prefix.time.validBounds, rest.time.validBounds, 2)
              : undefined,
          references:
            prefix.time.references && rest.time.references
              ? byRow(prefix.time.references, rest.time.references)
              : undefined,
        }
      : prefix.time;
  const query =
    rows !== undefined && asked && rest.query?.time
      ? {
          ...rest.query,
          time: clipSelection(asked, {
            start: asked.start,
            stop: rest.query.time.stop,
          })!,
        }
      : prefix.query;
  const before = prefix.partial?.done ?? 0;
  const counters = mergedCounters(prefix.counters, rest.counters);
  return {
    ...prefix,
    query,
    time,
    ...(rows !== undefined && prefix.shape?.length
      ? {
          shape: [
            time?.raw.length ?? prefix.shape[0],
            ...prefix.shape.slice(1),
          ],
        }
      : {}),
    values: join(prefix.values, rest.values)!,
    partial: rest.partial && {
      done: before + rest.partial.done,
      total: before + rest.partial.total,
      readUntil: rest.partial.readUntil,
    },
    counters,
    region: prefix.region &&
      rest.region && {
        ...prefix.region,
        coverage: join(prefix.region.coverage, rest.region.coverage)!,
        validCells: join(prefix.region.validCells, rest.region.validCells)!,
        spread: prefix.region.spread &&
          rest.region.spread && {
            std: join(prefix.region.spread.std, rest.region.spread.std)!,
            min: join(prefix.region.spread.min, rest.region.spread.min)!,
            max: join(prefix.region.spread.max, rest.region.spread.max)!,
          },
      },
    cellCoverage: join(prefix.cellCoverage, rest.cellCoverage),
  };
}

/**
 * More dates joined to those already read: `piece` covers the dates just
 * `before` or after `kept`, and only it is read. Every per-date array is joined
 * in time order (values row by row: time comes first), the work of both added
 * up. While the piece is read, its progress is the join's.
 */
export function extendResult(
  kept: TAnalysisResult,
  piece: TAnalysisResult,
  before: boolean
): TAnalysisResult {
  const join = (a?: number[], b?: number[]) =>
    a && b ? (before ? [...b, ...a] : [...a, ...b]) : undefined;
  const counters = mergedCounters(kept.counters, piece.counters);
  const time = kept.time &&
    piece.time && {
      ...kept.time,
      raw: join(kept.time.raw, piece.time.raw)!,
      ...(kept.time.bounds && piece.time.bounds
        ? { bounds: join(kept.time.bounds, piece.time.bounds) }
        : {}),
      valid:
        kept.time.valid && piece.time.valid
          ? join(kept.time.valid, piece.time.valid)
          : undefined,
      // Every per-date coordinate, as the dates (a one-shot read's).
      validBounds:
        kept.time.validBounds && piece.time.validBounds
          ? join(kept.time.validBounds, piece.time.validBounds)
          : undefined,
      references:
        kept.time.references && piece.time.references
          ? join(kept.time.references, piece.time.references)
          : undefined,
    };
  return {
    ...kept,
    values: join(kept.values, piece.values)!,
    shape: [kept.shape[0] + piece.shape[0], ...kept.shape.slice(1)],
    ...(time ? { time } : {}),
    partial: piece.partial,
    counters,
    region: kept.region &&
      piece.region && {
        ...kept.region,
        coverage: join(kept.region.coverage, piece.region.coverage)!,
        validCells: join(kept.region.validCells, piece.region.validCells)!,
        spread: kept.region.spread &&
          piece.region.spread && {
            std: join(kept.region.spread.std, piece.region.spread.std)!,
            min: join(kept.region.spread.min, piece.region.spread.min)!,
            max: join(kept.region.spread.max, piece.region.spread.max)!,
          },
      },
    cellCoverage: join(kept.cellCoverage, piece.cellCoverage),
  };
}

/**
 * A forward Extend's updates joined to the kept dates: joined once, then only
 * the rows read since written in place.
 */
// eslint-disable-next-line max-lines-per-function
export function extendJoiner(kept: TAnalysisResult) {
  let last: TAnalysisResult | undefined;
  let shapeOf = "";
  let high = 0;
  return (piece: TAnalysisResult): TAnalysisResult => {
    const shape = [
      piece.values.length,
      piece.region?.coverage.length,
      piece.region?.spread ? 1 : 0,
      piece.cellCoverage?.length,
      piece.time?.raw.length,
      piece.time?.bounds?.length,
    ].join(",");
    const rows = Math.max(1, piece.shape?.[0] ?? piece.values.length);
    const time = piece.query?.time;
    const to =
      piece.partial && time
        ? Math.min(rows, Math.max(0, rowsBefore(time, piece.partial.readUntil)))
        : rows;
    if (!last || shape !== shapeOf || !time) {
      last = extendResult(kept, piece, false);
      shapeOf = shape;
      high = time ? to : 0;
      return last;
    }
    const write = (into?: number[], source?: number[]) => {
      if (into && source) {
        const at = into.length - source.length;
        const per = source.length / rows;
        for (let k = high * per; k < to * per; k++) {
          into[at + k] = source[k];
        }
      }
    };
    write(last.values, piece.values);
    write(last.region?.coverage, piece.region?.coverage);
    write(last.region?.validCells, piece.region?.validCells);
    write(last.region?.spread?.std, piece.region?.spread?.std);
    write(last.region?.spread?.min, piece.region?.spread?.min);
    write(last.region?.spread?.max, piece.region?.spread?.max);
    write(last.cellCoverage, piece.cellCoverage);
    write(last.time?.raw, piece.time?.raw);
    write(last.time?.bounds, piece.time?.bounds);
    write(last.time?.valid, piece.time?.valid);
    write(last.time?.validBounds, piece.time?.validBounds);
    write(last.time?.references, piece.time?.references);
    high = Math.max(high, to);
    last = {
      ...last,
      partial: piece.partial,
      counters: mergedCounters(kept.counters, piece.counters),
    };
    return last;
  };
}

/**
 * The dates of a joined result up to `rows` (from its start): what was read
 * when an extension later in time stopped part way.
 */
export function firstRows(result: TAnalysisResult, rows: number) {
  return rowsBetween(result, 0, rows);
}

/**
 * The dates of a result from row `from` to its end: what an earlier step, read
 * from its end, had read when it stopped.
 */
export function lastRows(result: TAnalysisResult, from: number) {
  return rowsBetween(result, from, result.shape[0]);
}

/** A result's rows `from` to `to` (exclusive), with their dates. */
export function rowsBetween(result: TAnalysisResult, from: number, to: number) {
  const rows = to - from;
  const per = result.values.length / Math.max(1, result.shape[0]);
  const cut = (a?: number[], each = per) => a?.slice(from * each, to * each);
  return {
    ...result,
    values: cut(result.values)!,
    shape: [rows, ...result.shape.slice(1)],
    ...(result.time
      ? {
          time: {
            ...result.time,
            raw: result.time.raw.slice(from, to),
            ...(result.time.bounds
              ? { bounds: result.time.bounds.slice(from * 2, to * 2) }
              : {}),
            ...(result.time.valid
              ? { valid: result.time.valid.slice(from, to) }
              : {}),
            ...(result.time.validBounds
              ? { validBounds: result.time.validBounds.slice(from * 2, to * 2) }
              : {}),
            ...(result.time.references
              ? { references: result.time.references.slice(from, to) }
              : {}),
          },
        }
      : {}),
    partial: undefined,
    region: result.region && {
      ...result.region,
      coverage: cut(result.region.coverage, 1)!,
      validCells: cut(result.region.validCells, 1)!,
      spread: result.region.spread && {
        std: cut(result.region.spread.std, 1)!,
        min: cut(result.region.spread.min, 1)!,
        max: cut(result.region.spread.max, 1)!,
      },
    },
    cellCoverage: cut(result.cellCoverage),
  } as TAnalysisResult;
}

/** Counters that are high-water marks: joined pieces take the larger. */
const PEAK_COUNTERS = new Set(["peakAccumulatorBytes", "overlappingRuns"]);

/**
 * The work of two pieces read one after the other: counts and bytes add up,
 * peaks do not.
 */
export function mergedCounters(
  a: TAnalysisResult["counters"],
  b: TAnalysisResult["counters"]
): TAnalysisResult["counters"] {
  const counters = { ...a } as Record<string, number>;
  for (const [name, value] of Object.entries(b)) {
    if (typeof value === "number" && typeof counters[name] === "number") {
      counters[name] = PEAK_COUNTERS.has(name)
        ? Math.max(counters[name], value)
        : counters[name] + value;
    }
  }
  return counters as TAnalysisResult["counters"];
}

/**
 * A stopped series read on, joined once and then patched in place as the rest
 * streams: the joined arrays stay the same, only the rest's rows are written
 * into them.
 */
// eslint-disable-next-line max-lines-per-function
export function continueJoiner(prefix: TAnalysisResult) {
  let last: TAnalysisResult | undefined;
  let shapeOf = "";
  // The rest's rows already written: [low, high) of its own rows.
  let [low, high] = [0, 0];
  /** The rest's rows read so far, [from, to) of its own. */
  const readRows = (rest: TAnalysisResult) => {
    const time = rest.query?.time;
    const rows = Math.max(1, rest.shape?.[0] ?? rest.values.length);
    if (!time) {
      // Which rows were read is not known: all of them are written.
      return undefined;
    }
    if (!rest.partial) {
      return [0, rows];
    }
    // Stored offsets as rows of the selection: across its gaps a stored index
    // is not a row, [20,21), [30,31) kept one row of three).
    const row = (stored: number) => rowsBefore(time, stored);
    return time.fromEnd
      ? [Math.max(0, row(rest.partial.readFrom ?? time.stop)), rows]
      : [0, Math.min(rows, Math.max(0, row(rest.partial.readUntil)))];
  };
  // eslint-disable-next-line max-lines-per-function
  return (rest: TAnalysisResult): TAnalysisResult => {
    const shape = [
      rest.values.length,
      rest.region?.coverage.length,
      rest.cellCoverage?.length,
      rest.time?.raw.length,
      rest.time?.bounds?.length,
    ].join(",");
    const range = readRows(rest);
    const rows = Math.max(1, rest.shape?.[0] ?? rest.values.length);
    const [from, to] = range ?? [0, rows];
    if (!last || shape !== shapeOf) {
      last = continueResult(prefix, rest);
      shapeOf = shape;
      [low, high] = range ? [from, to] : [0, 0];
      return last;
    }
    // Only the rows read since the last update are written.
    const fresh = range
      ? [
          [Math.min(from, low), low],
          [high, Math.max(to, high)],
        ].filter(([a, b]) => b > a)
      : [[0, rows]];
    if (range) {
      [low, high] = [Math.min(low, from), Math.max(high, to)];
    }
    const tail = <T>(into: T[] | undefined, source: T[] | undefined) => {
      if (into && source) {
        const at = into.length - source.length;
        const per = source.length / rows;
        for (const [a, b] of fresh) {
          for (let k = a * per; k < b * per; k++) {
            into[at + k] = source[k];
          }
        }
      }
    };
    tail(last.values, rest.values);
    tail(last.region?.coverage, rest.region?.coverage);
    tail(last.region?.validCells, rest.region?.validCells);
    tail(last.region?.spread?.std, rest.region?.spread?.std);
    tail(last.region?.spread?.min, rest.region?.spread?.min);
    tail(last.region?.spread?.max, rest.region?.spread?.max);
    tail(last.cellCoverage, rest.cellCoverage);
    tail(last.time?.raw, rest.time?.raw);
    tail(last.time?.bounds, rest.time?.bounds);
    tail(last.time?.valid, rest.time?.valid);
    tail(last.time?.validBounds, rest.time?.validBounds);
    tail(last.time?.references, rest.time?.references);
    const before = prefix.partial?.done ?? 0;
    last = {
      ...last,
      partial: rest.partial && {
        done: before + rest.partial.done,
        total: before + rest.partial.total,
        readUntil: rest.partial.readUntil,
      },
      counters: mergedCounters(prefix.counters, rest.counters),
    };
    return last;
  };
}
