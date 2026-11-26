import { expect, it, vi } from "vitest";

import { orderedPoints, seriesDateLayout } from "@/ui/analysis/seriesDates.ts";

it("keeps a narrow zoom of a known descending axis within a viewport-sized row allocation", () => {
  const n = 200_000;
  const dates = Array.from({ length: n }, (_, row) => n - row - 1);
  const values = dates.map((date) => date % 12);
  seriesDateLayout(dates);
  const allocations = vi.spyOn(Array, "from");
  let largest = 0;
  try {
    const points = orderedPoints(dates, values, 800, n, { min: 100, max: 120 });
    expect(points.map((point) => point.x)).toEqual(
      Array.from({ length: 23 }, (_, i) => i + 99)
    );
    for (const [input] of allocations.mock.calls) {
      if ("length" in Object(input)) {
        largest = Math.max(largest, (input as ArrayLike<unknown>).length);
      }
    }
  } finally {
    allocations.mockRestore();
  }
  // Finding two bracketing rows on this previously indexed axis takes a
  // binary search. A 21-date viewport should not materialize 200,000 rows.
  expect(largest).toBeLessThan(1000);
});

it("interim48: one more row of a part-read series redoes its column only", async () => {
  const { reduceForDisplay } = await import("@/lib/analysis/analysisExport.ts");
  const n = 200_000;
  const x = Array.from({ length: n }, (_, k) => k);
  const values = new Array<number>(n).fill(Number.NaN);
  for (let k = 0; k < 100_000; k++) {
    values[k] = k % 997 === 0 ? Number.NaN : Math.sin(k / 50);
  }
  let reads = 0;
  const y = new Proxy(values, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) {
        reads++;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  const first = reduceForDisplay(x, y, 800, 100_000);
  values[100_000] = 5;
  reads = 0;
  const next = reduceForDisplay(x, y, 800, 100_001);
  expect(reads).toBeLessThan(2_000);
  // The new row's peak is drawn, and every gap still breaks the line.
  expect(next.y).toContain(5);
  expect(next.y.filter(Number.isNaN).length).toBe(
    first.y.filter(Number.isNaN).length
  );
  expect(first.y.filter(Number.isNaN).length).toBeGreaterThanOrEqual(100);
});
