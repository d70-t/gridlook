import { describe, expect, it } from "vitest";

import {
  continueJoiner,
  continueResult,
} from "@/lib/analysis/partialUpdates.ts";
import type { TAnalysisResult } from "@/lib/analysis/types.ts";

const NaN4 = [Number.NaN, Number.NaN];

/** An area series of four dates, stopped after two. */
function stopped(): TAnalysisResult {
  return {
    values: [1, 2, ...NaN4],
    partial: { done: 2, total: 4, readUntil: 2 },
    counters: { chunkReads: 2, fetchedBytes: 200 },
    region: {
      coverage: [1, 0.5, ...NaN4],
      validCells: [4, 2, ...NaN4],
      spread: {
        std: [0.1, 0.2, ...NaN4],
        min: [0, 1, ...NaN4],
        max: [2, 3, ...NaN4],
      },
    },
    notes: ["kept"],
  } as unknown as TAnalysisResult;
}

describe("reading on after Stop", () => {
  it("joins every per-date column at the stop and adds up parts and work", () => {
    const rest = {
      values: [3, Number.NaN],
      partial: { done: 1, total: 2, readUntil: 3 },
      counters: { chunkReads: 1, fetchedBytes: 50 },
      region: {
        coverage: [0.25, Number.NaN],
        validCells: [1, Number.NaN],
        spread: {
          std: [0.3, Number.NaN],
          min: [2, Number.NaN],
          max: [4, Number.NaN],
        },
      },
      notes: ["rest"],
    } as unknown as TAnalysisResult;
    const joined = continueResult(stopped(), rest);
    expect(joined.values).toEqual([1, 2, 3, Number.NaN]);
    expect(joined.region!.coverage).toEqual([1, 0.5, 0.25, Number.NaN]);
    expect(joined.region!.validCells).toEqual([4, 2, 1, Number.NaN]);
    expect(joined.region!.spread!.max).toEqual([2, 3, 4, Number.NaN]);
    // Parts count across both reads; the read reaches the rest's point.
    expect(joined.partial).toEqual({ done: 3, total: 4, readUntil: 3 });
    expect(joined.counters).toMatchObject({ chunkReads: 3, fetchedBytes: 250 });
    // Axes, labels and notes stay those of the whole request.
    expect(joined.notes).toEqual(["kept"]);
  });

  it("is complete when the rest is", () => {
    const joined = continueResult(stopped(), {
      ...stopped(),
      values: [3, 4],
      partial: undefined,
      region: undefined,
    } as unknown as TAnalysisResult);
    expect(joined.values).toEqual([1, 2, 3, 4]);
    expect(joined.partial).toBeUndefined();
  });
});

describe("reading a grid on after Stop", () => {
  it("joins a time × axis grid row by row (Hovmöller, time–depth)", () => {
    // Four dates × two bins, stopped after two dates.
    const prefix = {
      values: [1, 2, 3, 4, ...NaN4, ...NaN4],
      partial: { done: 1, total: 2, readUntil: 2 },
      counters: {},
      cellCoverage: [1, 1, 1, 1, ...NaN4, ...NaN4],
      notes: [],
    } as unknown as TAnalysisResult;
    const rest = {
      values: [5, 6, 7, 8],
      counters: {},
      cellCoverage: [0.5, 0.5, 0.5, 0.5],
      notes: [],
    } as unknown as TAnalysisResult;
    const joined = continueResult(prefix, rest);
    expect(joined.values).toEqual([1, 2, 3, 4, 5, 6, 7, 8]);
    expect(joined.cellCoverage).toEqual([1, 1, 1, 1, 0.5, 0.5, 0.5, 0.5]);
  });
});

it("updates one continued date without traversing the entire unread suffix", () => {
  const rows = 8192;
  const prefix = {
    ...stopped(),
    query: { time: { start: 0, stop: rows * 2 } },
    shape: [2 * rows],
    values: new Array(2 * rows).fill(Number.NaN),
    region: undefined,
    partial: { done: rows, total: 2 * rows, readUntil: rows },
  } as TAnalysisResult;
  let reads = 0;
  const values = new Proxy(new Array<number>(rows).fill(Number.NaN), {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) {
        reads++;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const rest = {
    ...prefix,
    query: { time: { start: rows, stop: 2 * rows } },
    shape: [rows],
    values,
    partial: { done: 0, total: rows, readUntil: rows },
  } as TAnalysisResult;
  const join = continueJoiner(prefix);
  const first = join(rest);
  reads = 0;
  values[0] = 21;
  const next = join({
    ...rest,
    partial: { done: 1, total: rows, readUntil: rows + 1 },
  });
  expect(next.values).toBe(first.values);
  expect(next.values[rows]).toBe(21);
  expect(reads).toBeLessThan(32);
});

it("interim47 keeps every selected row when a sparse Continue streams across a storage gap", () => {
  // One selected date was kept. Three single rows remain at storage indices 10, 20, 30.
  const full = {
    start: 0,
    stop: 31,
    runs: [
      [0, 1],
      [10, 11],
      [20, 21],
      [30, 31],
    ],
  };
  const restTime = { start: 10, stop: 31, runs: full.runs.slice(1) };
  const make = (
    time: typeof full,
    values: number[],
    raw: number[],
    partial?: TAnalysisResult["partial"]
  ) =>
    ({
      query: { time },
      shape: [values.length],
      values,
      time: { raw },
      counters: {},
      partial,
    }) as TAnalysisResult;
  const nan = Number.NaN;
  const join = continueJoiner(
    make(full, [1, nan, nan, nan], [0, 10, 20, 30], {
      done: 1,
      total: 4,
      readUntil: 1,
    })
  );
  const update = (values: number[], done: number, readUntil: number) =>
    make(restTime, values, [10, 20, 30], { done, total: 3, readUntil });
  join(update([11, nan, nan], 1, 11));
  join(update([11, 21, nan], 2, 21));
  const final = join(make(restTime, [11, 21, 31], [10, 20, 30]));
  expect(final.partial).toBeUndefined();
  expect(final.values).toEqual([1, 11, 21, 31]);
});
