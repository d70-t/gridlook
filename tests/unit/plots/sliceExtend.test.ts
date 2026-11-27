import { describe, expect, it } from "vitest";

import { nextDates, previewFacts } from "@/lib/analysis/preview.ts";
import {
  chronologicalEnds,
  clipSelection,
  rowCount,
  selectionOf,
} from "@/lib/analysis/timeRows.ts";

const MIB = 2 ** 20;

describe("review of interim43: Extend on a request in slices", () => {
  // Dates [0, 20) and [105, 128), one 2 MiB stored chunk a date; the
  // preview around the map's date 64 shows 17, 18, 19 and 105 to 109.
  const span = {
    start: 0,
    stop: 128,
    runs: [
      [0, 20],
      [105, 128],
    ] as [number, number][],
  };
  const shown = { start: 17, stop: 110 };
  const datesIn = (range: { start: number; stop: number }) => {
    const part = clipSelection(span, range);
    return part ? rowCount(part) : 0;
  };

  it("quotes the eight dates and 16 MiB its click reads", () => {
    const facts = previewFacts({
      shown,
      span,
      chunk: 1,
      perGroup: 2 * MIB,
      datesIn,
    });
    // The click (the store) reads these dates: 110 to 117.
    const clicked = nextDates(span, shown, 1, undefined);
    expect(clicked).toEqual({ start: 17, stop: 118 });
    expect(facts.next).toEqual(clicked);
    expect(facts.nextDates).toBe(8);
    expect(facts.nextBytes).toBe(16 * MIB);
  });
});

describe("review of interim43: a range's ends on an unordered time", () => {
  it("are its earliest and latest dates, in one slice or several", () => {
    // Days stored [5, 0, 4, 2, 3, 1, 6, 9, 8, 7]: January 1 is index 1,
    // January 10 index 7.
    const raw = [5, 0, 4, 2, 3, 1, 6, 9, 8, 7];
    expect(chronologicalEnds({ start: 0, stop: 10 }, raw)).toEqual({
      from: 1,
      to: 7,
    });
    // A From edit to January 2 keeps January 9 and 10.
    const chosen = selectionOf(raw, 1, raw[7], 0, raw.length);
    expect(rowCount(chosen)).toBe(9);
    // Days [3, 1, 2, 4]: To January 3 keeps January 1 and 2.
    const days = [3, 1, 2, 4];
    const ends = chronologicalEnds({ start: 0, stop: 4 }, days);
    expect(ends).toEqual({ from: 1, to: 3 });
    expect(rowCount(selectionOf(days, days[ends.from], 3, 0, 4))).toBe(3);
    // Undated rows are skipped.
    expect(
      chronologicalEnds({ start: 0, stop: 3 }, [Number.NaN, 4, 2])
    ).toEqual({ from: 2, to: 1 });
  });
});
