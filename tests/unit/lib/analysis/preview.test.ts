import { expect, it } from "vitest";

import {
  extendedRange,
  PREVIEW_BYTES,
  PREVIEW_VALUES,
  previewFacts,
  remainingChunks,
  previewRange,
  withOverlayBytes,
  sizeRefusal,
  timeGroups,
  withPartnerBytes,
} from "@/lib/analysis/preview.ts";

const span = { start: 0, stop: 31_411 };

it("v28: a first preview reads whole stored chunks around the map's date", () => {
  // 31,411 daily dates in chunks of 30; 1 MiB per chunk: 16 chunks fit.
  const range = previewRange({
    span,
    anchor: 15_000,
    chunk: 30,
    perGroup: 2 ** 20,
  })!;
  expect(range.start % 30).toBe(0);
  expect(range.stop % 30).toBe(0);
  expect(timeGroups(range, 30)).toBe(16);
  expect(range.start).toBeLessThanOrEqual(15_000);
  expect(range.stop).toBeGreaterThan(15_000);
  // A chunk larger than the budget: still one chunk, the map's.
  expect(
    previewRange({
      span,
      anchor: 15_000,
      chunk: 30,
      perGroup: 4 * PREVIEW_BYTES,
    })
  ).toEqual({ start: 15_000, stop: 15_030 });
});

it("v28: a preview stays inside the dates asked for and near their ends", () => {
  const asked = { start: 100, stop: 1_000 };
  const early = previewRange({
    span: asked,
    anchor: 0,
    chunk: 64,
    perGroup: 2 ** 22,
  })!;
  expect(early.start).toBe(100);
  expect(early.stop).toBe(5 * 64);
  const late = previewRange({
    span: asked,
    anchor: 999,
    chunk: 64,
    perGroup: 2 ** 22,
  })!;
  expect(late.stop).toBe(1_000);
  expect(timeGroups(late, 64)).toBe(4);
  // Everything fits: nothing to preview.
  expect(
    previewRange({ span: asked, anchor: 500, chunk: 64, perGroup: 1 })
  ).toBeUndefined();
});

it("v28: a preview holds no more values than a heatmap's worth", () => {
  // A distance × time plot of 2,048 samples per date: 32 dates at most.
  const range = previewRange({
    span,
    anchor: 20_000,
    chunk: 365,
    perGroup: 2 ** 20,
    perDate: 2_048,
  })!;
  expect(range.stop - range.start).toBe(PREVIEW_VALUES / 2_048);
  expect(range.start).toBe(20_000 - 16);
});

it("v28: extending reads as many dates again, later first, then earlier", () => {
  const asked = { start: 0, stop: 100 };
  expect(extendedRange({ start: 40, stop: 50 }, asked, 10)).toEqual({
    start: 40,
    stop: 60,
  });
  expect(extendedRange({ start: 40, stop: 100 }, asked, 10)).toEqual({
    start: 0,
    stop: 100,
  });
});

it("v28: size refusals are told apart from other refusals", () => {
  expect(
    sizeRefusal(
      "The result would hold 9,000,000 values; plots keep at most 4,000,000."
    )
  ).toEqual({ values: 9_000_000 });
  expect(
    sizeRefusal("The request touches 120,000 stored chunks; at most 100,000.")
  ).toMatchObject({
    values: undefined,
    refused: expect.stringMatching(/chunks/),
  });
  expect(sizeRefusal("The variable has no time dimension.")).toBeUndefined();
});

it("v28: the preview bar prices the next dates and places the strip", () => {
  const facts = previewFacts({
    shown: { start: 40, stop: 50 },
    span: { start: 0, stop: 100 },
    chunk: 10,
    perGroup: 2 ** 20,
    fullBytes: 10 * 2 ** 20,
  });
  expect(facts).toMatchObject({
    dates: 10,
    total: 100,
    left: 40,
    width: 10,
    nextDates: 10,
    nextBytes: 2 ** 20,
    // Read all reads the nine chunks not shown.
    allBytes: 9 * 2 ** 20,
  });
});

it("prices a stopped preview's Extend and Read all with the dates shown", () => {
  const facts = previewFacts({
    shown: { start: 40, stop: 50 },
    span: { start: 0, stop: 100 },
    chunk: 10,
    perGroup: 2 ** 20,
    fullBytes: 10 * 2 ** 20,
    rereadShown: true,
  });
  expect(facts.nextBytes).toBe(2 * 2 ** 20);
  expect(facts.allBytes).toBe(10 * 2 ** 20);
});

it("counts the dates read, and prices a stopped Extend's own target (review of interim10)", () => {
  const facts = previewFacts({
    shown: { start: 0, stop: 816 },
    span: { start: 0, stop: 19_488 },
    chunk: 24,
    perGroup: 2 ** 20,
    pending: { start: 0, stop: 1584 },
  });
  expect(facts.nextDates).toBe(768);
  expect(facts.nextBytes).toBe(32 * 2 ** 20);
  const stopped = previewFacts({
    shown: { start: 0, stop: 792 },
    span: { start: 0, stop: 19_488 },
    chunk: 24,
    read: 24,
  });
  expect(stopped.dates).toBe(24);
});

it("reads a Hovmöller's own limit and a chunk refusal (review of interim10)", async () => {
  const { sizeRefusal } = await import("@/lib/analysis/preview.ts");
  expect(
    sizeRefusal(
      "180 columns × 12,000 times is more than 2,000,000 values. Choose a bin width or a shorter time range."
    )
  ).toEqual({ values: 2_160_000, limit: 2_000_000 });
  const chunks = sizeRefusal(
    "This request touches 200,001 stored chunks; at most 200,000 are read for one plot."
  );
  expect(chunks?.values).toBeUndefined();
  expect(chunks?.refused).toMatch(/200,001 stored chunks/);
  expect(sizeRefusal("Something else went wrong.")).toBeUndefined();
});

it("performance review of interim30: Extend after a Stop says the dates it really adds", () => {
  // A 792-date preview stopped at 432 rows: Extend reads [0, 1584) again.
  const facts = previewFacts({
    shown: { start: 0, stop: 792 },
    span: { start: 0, stop: 19488 },
    chunk: 24,
    perGroup: 503808,
    rereadShown: true,
    read: 432,
  });
  expect(facts.next).toEqual({ start: 0, stop: 1584 });
  expect(facts.nextDates).toBe(1584 - 432);
  // Complete, it adds the 792 it says.
  expect(
    previewFacts({
      shown: { start: 0, stop: 792 },
      span: { start: 0, stop: 19488 },
      chunk: 24,
    }).nextDates
  ).toBe(792);
});

it("performance review of interim30: what is left of a request refused for its chunks", () => {
  const refused =
    "This selection touches 200,001 stored chunks; plots read at most 200,000.";
  // One of 200,001 dates shown: 200,000 left, within the limit.
  expect(remainingChunks(refused, 200_001, 1)).toBe(200_000);
  expect(remainingChunks(refused.replace("200,001", "400,001"), 100, 10)).toBe(
    undefined
  );
  expect(remainingChunks("of working memory", 100, 10)).toBe(undefined);
});

it("quotes a scatter partner's share of All as well as of Extend", () => {
  // 792 of 3,528 dates shown; the plot and its partner each 32 KiB a date.
  const perDate = 32 * 2 ** 10;
  const own = previewFacts({
    shown: { start: 0, stop: 792 },
    span: { start: 0, stop: 3528 },
    chunk: 24,
    perGroup: 24 * perDate,
    fullBytes: 3528 * perDate,
  });
  const { facts, partnerAllBytes } = withPartnerBytes(own, perDate, false);
  // All reads the 2,736 dates not shown, for both fields.
  expect(partnerAllBytes).toBe(2736 * perDate);
  expect(facts.allBytes).toBe(own.allBytes! + 2736 * perDate);
  expect(facts.nextBytes).toBe(own.nextBytes! + own.nextDates * perDate);
  // Shown dates read again: every date, for the partner too.
  expect(withPartnerBytes(own, perDate, true).partnerAllBytes).toBe(
    3528 * perDate
  );
  // No partner: the plot's own prices.
  expect(withPartnerBytes(own, undefined, false).facts).toEqual(own);
});

it("a chunk-limit refusal carries what its chunks decode to", () => {
  const refused = sizeRefusal(
    "This selection touches 758,232 stored chunks (about 4.0 MiB each); plots read at most 200,000."
  );
  expect(refused?.decodedBytes).toBe(758_232 * 4 * 2 ** 20);
  // The count is still read where it was.
  expect(
    remainingChunks(refused!.refused!.replace("758,232", "200,001"), 200_001, 1)
  ).toBe(200_000);
});

it("review of interim41: a first preview of tiny chunks stays a modest request", () => {
  // 200,001 dates, one 32-byte chunk each: bytes allow everything, the
  // request count does not.
  const range = previewRange({
    span: { start: 0, stop: 200_001 },
    anchor: 200_000,
    chunk: 1,
    perGroup: 32,
  })!;
  expect(range.stop - range.start).toBeGreaterThan(1);
  expect(range.stop - range.start).toBeLessThanOrEqual(256);
  expect(range.stop).toBe(200_001);
});

it("review of interim41: a Box over many spatial chunks a date previews fewer dates", () => {
  // Eight stored chunks a date: 32 dates make the same 256 requests.
  const range = previewRange({
    span: { start: 0, stop: 200_001 },
    anchor: 100_000,
    chunk: 1,
    perGroup: 8 * 32,
    chunksPerGroup: 8,
  })!;
  expect(range.stop - range.start).toBe(32);
});

it("independent review of interim45: Extend's quote includes the other members", () => {
  const own = previewFacts({
    shown: { start: 40, stop: 50 },
    span: { start: 0, stop: 100 },
    chunk: 10,
    perGroup: 4 * 2 ** 20,
    fullBytes: 40 * 2 ** 20,
  });
  // All 4 members: three more read what the plot reads.
  const priced = withOverlayBytes(own, {}, 3)!;
  expect(priced.partnerBytes).toBe(3 * own.nextBytes!);
  expect(priced.facts.nextBytes).toBe(4 * own.nextBytes!);
  expect(priced.facts.allBytes).toBe(4 * own.allBytes!);
  // Barbs alone keep their own price; unknown overlays stay unknown.
  expect(withOverlayBytes(own, { next: 5, all: 9 }, 0)!.facts.nextBytes).toBe(
    own.nextBytes! + 5
  );
  expect(withOverlayBytes(own, {}, 0)).toBeUndefined();
});
