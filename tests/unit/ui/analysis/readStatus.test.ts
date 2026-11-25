import { describe, expect, it } from "vitest";

import type { TAnalysisResult } from "@/lib/analysis/types.ts";
import {
  bytesRead,
  bytesText,
  datesRead,
  goalDates,
  partsText,
} from "@/ui/analysis/readStatus.ts";

/** A series of 432 hourly dates, read up to `readUntil`. */
function series(readUntil?: number) {
  return {
    query: { time: { start: 0, stop: 432 } },
    time: {
      raw: Array.from({ length: 432 }, (_, h) => h),
      units: "hours since 2024-01-01",
      calendar: "standard",
      dimension: "time",
    },
    ...(readUntil === undefined
      ? {}
      : { partial: { done: 6, total: 36, readUntil } }),
    counters: {
      chunkReads: 6,
      physicalBytes: 22 * 2 ** 20,
      fetchedBytes: 20 * 2 ** 20,
      decodedBytes: 40 * 2 ** 20,
    },
  } as unknown as TAnalysisResult;
}

describe("the read-status row keeps parts, dates and bytes apart", () => {
  it("states the P26 example as three different facts", () => {
    const result = series(60);
    expect(partsText({ done: 5, total: 36 }, false)).toBe("Part 6 of 36");
    expect(datesRead(result)?.text).toBe("60 of 432 dates");
    expect(datesRead(result)?.through).toBe("2024-01-03 11:00:00");
    expect(bytesRead(result.counters)).toEqual({
      fetched: "22 MiB fetched",
      decoded: "40 MiB decoded",
    });
  });

  it("says Paused, and every part once all are read", () => {
    expect(partsText({ done: 6, total: 36 }, true)).toBe(
      "Paused after part 6 of 36"
    );
    expect(partsText({ done: 36, total: 36 }, false)).toBe("All 36 parts read");
    expect(partsText(undefined, false)).toBe("");
  });

  it("counts a finished result whole, and stored bytes when HTTP is unseen", () => {
    expect(datesRead(series())?.text).toBe("432 of 432 dates");
    const local = { ...series().counters, physicalBytes: 0 };
    expect(bytesRead(local).fetched).toBe("20 MiB fetched");
    expect(bytesText(1536)).toBe("2 KiB");
    expect(bytesText(3 * 2 ** 30)).toBe("3.0 GiB");
  });
});

describe("the stages before a figure", () => {
  it("say what is done, what is under way and what comes next", async () => {
    const { stagesOf } = await import("@/ui/analysis/readStatus.ts");
    expect(stagesOf("planning").map((s) => `${s.name}:${s.state}`)).toEqual([
      "Describe the variable:done",
      "Plan the reads:now",
      "Read and compute:next",
    ]);
    // Waiting for a slot shows only when it happens.
    expect(stagesOf("queued").map((s) => s.state)).toEqual([
      "done",
      "done",
      "now",
      "next",
    ]);
    expect(stagesOf("done")).toEqual([]);
  });
});

describe("one count for a read in steps", () => {
  // Read all after a first preview of 68 dates: the later dates in one step to
  // 136, then on to 272.
  const steps = (start: number, stop: number, readUntil: number) =>
    ({
      ...series(readUntil),
      query: { time: { start, stop } },
    }) as unknown as TAnalysisResult;
  it("counts toward everything asked for, never falling back", () => {
    const ext = {
      shown: { start: 0, stop: 68 },
      target: { start: 0, stop: 136 },
      then: { start: 0, stop: 272 },
      before: false,
    };
    expect(goalDates(ext, steps(0, 136, 68))?.text).toBe("68 of 272 dates");
    expect(goalDates(ext, steps(0, 136, 119))?.read).toBe(119);
    const next = {
      ...ext,
      shown: { start: 0, stop: 136 },
      then: undefined,
      target: { start: 0, stop: 272 },
    };
    expect(goalDates(next, steps(0, 272, 170))?.text).toBe("170 of 272 dates");
  });
  it("counts earlier dates read before those shown", () => {
    const ext = {
      shown: { start: 200, stop: 264 },
      target: { start: 0, stop: 264 },
      before: true,
    };
    // A step of 100 earlier dates, 40 of them read.
    expect(goalDates(ext, steps(100, 200, 140))?.text).toBe("104 of 264 dates");
  });
  it("is the plain count without steps", () => {
    expect(goalDates(undefined, series(60))?.text).toBe("60 of 432 dates");
  });
});
