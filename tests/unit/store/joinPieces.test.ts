import { expect, it, vi } from "vitest";

/**
 * A wall-clock budget, checked only on a quiet benchmark run
 * (GRIDLOOK_TIMING=1): the suite asserts results and counts, and a busy host
 * does not fail correct code.
 */
const withinBudget = (ms: number, budget: number, what = "") =>
  process.env.GRIDLOOK_TIMING === "1" && expect(ms, what).toBeLessThan(budget);

vi.mock("@/store/store.ts", () => ({ useGlobeControlStore: () => ({}) }));
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
const { joinInOrder } = await import("@/store/analysisStore.ts");

const piece = (t: number) =>
  ({
    kind: "point-series",
    query: { variable: "u", time: { start: t, stop: t + 1 } },
    time: { dimension: "time", raw: [t], units: "days since 2001-01-01" },
    values: [t * 2],
    shape: [1],
    dims: ["time"],
    notes: [],
    counters: { chunks: 1 },
  }) as never;

it("joins sparse pieces in order, pairwise (review of interim37)", () => {
  const parts = Array.from({ length: 20000 }, (_, t) => piece(t));
  const start = performance.now();
  const joined = joinInOrder(parts) as {
    values: number[];
    time: { raw: number[] };
  };
  const elapsed = performance.now() - start;
  expect(joined.time.raw).toEqual(Array.from({ length: 20000 }, (_, t) => t));
  expect(joined.values).toEqual(Array.from({ length: 20000 }, (_, t) => 2 * t));
  // One after another this would take seconds: n² copies.
  withinBudget(elapsed, 300);
});
