import { expect, it } from "vitest";

import type { TAnalysisResult } from "@/lib/analysis/types.ts";
import { chartSpec } from "@/ui/analysis/plotFigure.ts";
import { orderedPoints } from "@/ui/analysis/seriesDates.ts";

const N = 200_000;
const WIDTH = 800;

it("retains visible oscillations when a zoom includes the first stored date", () => {
  const x = Array.from({ length: N }, (_, i) => i);
  const y = x.map((i) => Math.floor(i / 10) % 2);
  const transitions = (start: number) => {
    const points = orderedPoints(x, y, WIDTH, N, {
      min: start,
      max: start + 3999,
    }).filter((p) => p.x >= start && p.x <= start + 3999);
    return points.reduce(
      (count, p, i) => count + Number(i > 0 && p.y !== points[i - 1].y),
      0
    );
  };
  // Each ten-sample half-cycle spans two screen columns in either zoom.
  expect(transitions(1)).toBe(400);
  expect(transitions(0)).toBe(399);
});

function numericReads(values: number[]) {
  let hits = 0;
  const observed = new Proxy(values, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) {
        hits++;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  return { observed, count: () => hits, reset: () => (hits = 0) };
}

it("a new row on a descending axis reuses the already plotted history", () => {
  const x = Array.from({ length: N }, (_, i) => N - i);
  const y = numericReads(x.map((i) => i % 13));
  orderedPoints(x, y.observed, WIDTH, 100_000);
  y.reset();
  const next = orderedPoints(x, y.observed, WIDTH, 100_001);
  expect(next.some((p) => p.i === 100_000)).toBe(true);
  expect(y.count()).toBeLessThan(WIDTH * 10);
});

it("appending to a dense burst need not revisit all earlier values in its display column", () => {
  // 100,001 seconds of burst data followed by a 10-year gap to hourly observations.
  const x = Array.from({ length: N }, (_, i) =>
    i < 100_010 ? i : 10 * 365 * 86_400 + (i - 100_010) * 3600
  );
  const y = numericReads(x.map((i) => i % 13));
  orderedPoints(x, y.observed, WIDTH, 100_000);
  y.reset();
  const next = orderedPoints(x, y.observed, WIDTH, 100_001);
  expect(next.some((p) => p.i === 100_000)).toBe(true);
  expect(y.count()).toBeLessThan(WIDTH * 10);
});

it("a country mean with a coverage threshold does not re-mask its entire prefix on each publication", () => {
  const raw = Array.from({ length: N }, (_, i) => i);
  const coverage = numericReads(raw.map((i) => (i % 4 === 0 ? 0.4 : 0.9)));
  const result = {
    kind: "region-series",
    query: { variable: "tas", minCoverage: 0.5, time: { start: 0, stop: N } },
    time: { dimension: "time", raw },
    region: { coverage: coverage.observed },
    values: raw,
    partial: { done: 100_000, total: N, readUntil: 100_000 },
  } as unknown as TAnalysisResult;
  const spec = (r: TAnalysisResult) => chartSpec(r)!;
  expect(spec(result).y[99_999]).toBe(99_999);
  coverage.reset();
  const next = spec({
    ...result,
    partial: { done: 100_001, total: N, readUntil: 100_001 },
  });
  expect(next.y[100_000]).toBeNaN();
  expect(coverage.count()).toBeLessThan(WIDTH * 10);
});
