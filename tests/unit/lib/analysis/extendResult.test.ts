import { describe, expect, it } from "vitest";

import { extendResult, firstRows } from "@/lib/analysis/partialUpdates.ts";
import type { TAnalysisResult } from "@/lib/analysis/types.ts";

/** An area series of `values` at days `days`. */
function series(values: number[], days: number[]): TAnalysisResult {
  return {
    values,
    shape: [values.length],
    time: {
      dimension: "time",
      raw: days,
      bounds: days.flatMap((d) => [d, d + 1]),
    },
    counters: { chunkReads: values.length, fetchedBytes: 8 * values.length },
    region: {
      coverage: values.map(() => 1),
      validCells: values.map(() => 4),
    },
    notes: [],
  } as unknown as TAnalysisResult;
}

describe("Extend keeps what was read and reads only the new dates (review of interim8)", () => {
  it("joins later dates after, earlier dates before, in time order", () => {
    const kept = series([1, 2], [10, 11]);
    const later = extendResult(kept, series([3, 4], [12, 13]), false);
    expect(later.values).toEqual([1, 2, 3, 4]);
    expect(later.time?.raw).toEqual([10, 11, 12, 13]);
    expect(later.time?.bounds).toEqual([10, 11, 11, 12, 12, 13, 13, 14]);
    expect(later.shape).toEqual([4]);
    expect(later.region?.coverage).toEqual([1, 1, 1, 1]);
    expect(later.counters.chunkReads).toBe(4);
    const earlier = extendResult(kept, series([0], [9]), true);
    expect(earlier.values).toEqual([0, 1, 2]);
    expect(earlier.time?.raw).toEqual([9, 10, 11]);
  });

  it("keeps exactly the dates read when an extension stops part way", () => {
    const kept = series([1, 2], [10, 11]);
    const piece = {
      ...series([3, Number.NaN, Number.NaN], [12, 13, 14]),
      partial: { done: 1, total: 3, readUntil: 13 },
    };
    const joined = extendResult(kept, piece, false);
    const loaded = firstRows(joined, 3);
    expect(loaded.values).toEqual([1, 2, 3]);
    expect(loaded.time?.raw).toEqual([10, 11, 12]);
    expect(loaded.partial).toBeUndefined();
    expect(loaded.region?.validCells).toEqual([4, 4, 4]);
  });

  it("joins a time × space result row by row", () => {
    const grid = (values: number[], days: number[]) =>
      ({
        ...series(values, days),
        shape: [days.length, 2],
        region: undefined,
        cellCoverage: values.map(() => 1),
      }) as TAnalysisResult;
    const joined = extendResult(
      grid([1, 2, 3, 4], [0, 1]),
      grid([5, 6], [2]),
      false
    );
    expect(joined.shape).toEqual([3, 2]);
    expect(joined.values).toEqual([1, 2, 3, 4, 5, 6]);
    expect(firstRows(joined, 2).values).toEqual([1, 2, 3, 4]);
  });
});
