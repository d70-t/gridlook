import { describe, expect, it } from "vitest";

import {
  axisRows,
  orderedPoints,
  seriesDateLayout,
  unreadDateSpans,
} from "@/ui/analysis/seriesDates.ts";

/**
 * A wall-clock budget, checked only on a quiet benchmark run
 * (GRIDLOOK_TIMING=1): the suite asserts results and counts, and a busy host
 * does not fail correct code.
 */
const withinBudget = (ms: number, budget: number, what = "") =>
  process.env.GRIDLOOK_TIMING === "1" && expect(ms, what).toBeLessThan(budget);

describe("time series unread shading", () => {
  it("uses the same exclusive index for ascending and descending irregular spacing", () => {
    for (const [dates, expected] of [
      [
        [0, 1, 3, 12],
        [2, 12],
      ],
      [
        [12, 3, 1, 0],
        [0, 2],
      ],
    ]) {
      const layout = seriesDateLayout(dates);
      expect(layout.sorted).toBeUndefined();
      expect(seriesDateLayout(dates)).toBe(layout);
      expect(unreadDateSpans(dates, layout, 0)).toEqual([[0, 12]]);
      expect(unreadDateSpans(dates, layout, 2)).toEqual([expected]);
      expect(unreadDateSpans(dates, layout, 4)).toEqual([]);
    }
  });

  it("keeps read dates visible between unread spans on an out-of-order axis", () => {
    const dates = [0, 4, 1, 5, 2];
    const layout = seriesDateLayout(dates);
    expect([layout.min, layout.max]).toEqual([0, 5]);
    expect(unreadDateSpans(dates, layout, 2)).toEqual([
      [0.5, 3],
      [4.5, 5],
    ]);
    expect(unreadDateSpans(dates, layout, 3)).toEqual([
      [1.5, 3],
      [4.5, 5],
    ]);
  });

  it("leaves duplicate timestamps visible after one value has been read", () => {
    const dates = [1, 3, 1, 2];
    const layout = seriesDateLayout(dates);
    expect(unreadDateSpans(dates, layout, 2)).toEqual([[1.5, 2.5]]);
    expect(unreadDateSpans(dates, layout, 3, 2)).toEqual([]);
  });
});

describe("chart points follow the index axis and keep source rows", () => {
  it("draws dates stored out of order chronologically", () => {
    const points = orderedPoints([0, 2, 1, 3], [10, 20, 15, 30], 200);
    expect(points.map((p) => [p.x, p.y, p.i])).toEqual([
      [0, 10, 0],
      [1, 15, 2],
      [2, 20, 1],
      [3, 30, 3],
    ]);
  });

  it("keeps gaps where they fall in time and only the read prefix", () => {
    const gap = orderedPoints([0, 2, 1, 3], [10, NaN, 15, 30], 200);
    expect(gap.map((p) => [p.x, p.y, p.i])[2]).toEqual([2, null, 1]);
    const partial = orderedPoints([0, 2, 1, 3], [10, 20, NaN, NaN], 200, 2);
    expect(partial.map((p) => [p.x, p.i])).toEqual([
      [0, 0],
      [2, 1],
    ]);
  });

  it("orders descending profile levels and same-time samples", () => {
    expect(axisRows([1000, 900, 800, 700, 600])).toEqual([4, 3, 2, 1, 0]);
    expect(axisRows([600, 700, 800])).toBeUndefined();
    expect(axisRows([5, 5, 4])).toEqual([2, 0, 1]);
  });

  it("maps every decimated point back to its own source row", () => {
    const n = 3000;
    const x = Array.from({ length: n }, (_, i) => (i * 7919) % n);
    const y = x.map((t) => Math.sin(t / 50));
    const points = orderedPoints(x, y, 100);
    expect(points.length).toBeLessThan(n);
    for (const p of points) {
      expect(x[p.i]).toBe(p.x);
      expect(y[p.i]).toBe(p.y);
    }
    expect(points.every((p, k) => !k || p.x >= points[k - 1].x)).toBe(true);
  });
});

describe("time labels while a series streams", () => {
  it("formats a 31,411-date axis once and reuses it for every update", async () => {
    const { timeLabels } = await import("@/lib/analysis/calendar.ts");
    const time = {
      raw: Array.from({ length: 31_411 }, (_, i) => i),
      units: "days since 1940-01-01",
      calendar: "standard",
    };
    const first = timeLabels(time);
    expect(first).toHaveLength(31_411);
    expect(first[1]).toMatch(/^1940-01-02/);
    // A partial update is a new result object around the same axis.
    const started = performance.now();
    for (let update = 0; update < 50; update++) {
      expect(timeLabels(time)).toBe(first);
    }
    withinBudget(performance.now() - started, 20);
    expect(timeLabels(undefined)).toEqual([]);
  });
});

it("leaves an undated row out of the axis extent, order and shading (review of interim33)", () => {
  const dates = [3, Number.NaN, 2, 0, 1];
  const layout = seriesDateLayout(dates);
  expect([layout.min, layout.max]).toEqual([0, 3]);
  // Two storage rows read (3 and the undated one): 0, 1 and 2 are unread.
  expect(unreadDateSpans(dates, layout, 2)).toEqual([[0, 2.5]]);
  // Drawn in date order, without the undated row.
  expect(axisRows(dates)).toEqual([3, 4, 2, 0]);
});

it("updates visible unread shading without rereading the whole mixed time coordinate", () => {
  const count = 20_000;
  const raw = Array.from({ length: count }, (_, row) =>
    row < count / 2 ? 2 * row : 2 * (row - count / 2) + 1
  );
  let reads = 0;
  const dates = new Proxy(raw, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) {
        reads++;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const layout = seriesDateLayout(dates);
  unreadDateSpans(dates, layout, 61, 20);
  reads = 0;
  const spans = unreadDateSpans(dates, layout, 62, 20);
  expect(spans.at(-1)).toEqual([122.5, count - 1]);
  expect(reads).toBeLessThan(count);
});

it("updates an interleaved half-read axis without a full date scan for subpixel gaps", () => {
  const count = 20_000;
  const half = count / 2;
  const raw = Array.from({ length: count }, (_, row) =>
    row < half ? 2 * row : 2 * (row - half) + 1
  );
  let reads = 0;
  const dates = new Proxy(raw, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) {
        reads++;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const layout = seriesDateLayout(dates);
  unreadDateSpans(dates, layout, half - 1, 20);
  reads = 0;
  expect(unreadDateSpans(dates, layout, half, 20)).toEqual([]);
  expect(reads).toBeLessThan(count);
});

it("finds a million dates' unread spans quickly, either side of halfway (review of interim37)", () => {
  // All even days stored before all odd days.
  const n = 1_000_000;
  const dates = Array.from({ length: n }, (_, at) =>
    at < n / 2 ? 2 * at : 2 * (at - n / 2) + 1
  );
  const layout = seriesDateLayout(dates);
  const time = (from: number, width: number) => {
    const started = performance.now();
    const spans = unreadDateSpans(dates, layout, from, width);
    return { ms: performance.now() - started, spans };
  };
  time(n / 2, 1); // the date groups, built once
  const runs = [
    time(n / 2 - 1, 1.2),
    time(n / 2, 1.3),
    time(n / 2 + 1, 1.4),
    time(n / 2 + 2, 1.5),
  ];
  for (const run of runs.slice(1)) {
    // Odd days unread, each a day wide: nothing as wide as the minimum.
    expect(run.spans).toEqual([]);
  }
  withinBudget(Math.max(...runs.map((r) => r.ms)), 40);
  // The same point and width again: the spans kept.
  withinBudget(time(n / 2 + 2, 1.5).ms, 1);
});

it("maintainability review of interim41: unread spans advanced row by row equal a full scan", () => {
  // Even days stored first, then odd days; a gap in the even ones.
  const n = 4000;
  const dates = [
    ...Array.from({ length: n / 2 }, (_, k) => 2 * k).filter(
      (d) => d < 1000 || d > 1200
    ),
    ...Array.from({ length: n / 2 }, (_, k) => 2 * k + 1),
  ];
  for (const width of [0, 1.5, 40]) {
    const layout = seriesDateLayout(dates);
    for (let from = 1; from < dates.length; from += 37) {
      const fresh = dates.slice();
      expect(unreadDateSpans(dates, layout, from, width)).toEqual(
        unreadDateSpans(fresh, seriesDateLayout(fresh), from, width)
      );
    }
  }
});

describe("review of interim43: unread shading as rows arrive", () => {
  /** Spans worked out from scratch on fresh arrays: the reference. */
  const fresh = (dates: number[], from: number, width: number) => {
    const copy = [...dates];
    return unreadDateSpans(copy, seriesDateLayout(copy), from, width);
  };

  it("agrees with a fresh calculation through advances and resizes", () => {
    // Unordered, with repeated dates: even days first, then odd ones,
    // the first date twice.
    const n = 400;
    const dates = [
      ...Array.from({ length: n / 2 }, (_, k) => 2 * k),
      0,
      ...Array.from({ length: n / 2 }, (_, k) => 2 * k + 1),
    ];
    const layout = seriesDateLayout(dates);
    for (const [from, width] of [
      [1, 0],
      [2, 0],
      [2, 3],
      [3, 3],
      [150, 0],
      [201, 1.5],
      [202, 1.5],
      [260, 0],
      [260, 4],
      [400, 4],
    ]) {
      expect(
        unreadDateSpans(dates, layout, from, width),
        `${from}/${width}`
      ).toEqual(fresh(dates, from, width));
    }
  });

  it("advances a million dates from one read row to two without sorting them", () => {
    const n = 1_000_000;
    const dates = [
      ...Array.from({ length: n / 2 }, (_, k) => 2 * k),
      ...Array.from({ length: n / 2 }, (_, k) => 2 * k + 1),
    ];
    const layout = seriesDateLayout(dates);
    unreadDateSpans(dates, layout, 1, 1.5);
    const started = performance.now();
    const spans = unreadDateSpans(dates, layout, 2, 1.5);
    withinBudget(performance.now() - started, 20, "first advance");
    // Dates 0 and 2 read: from 2.5 (date 1 alone is under 1.5 wide).
    expect(spans[0]).toEqual([2.5, 999_999]);
  });
});
