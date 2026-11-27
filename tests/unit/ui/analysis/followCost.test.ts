import { expect, it } from "vitest";

import { correspondingIndex } from "@/ui/analysis/plotLayout.ts";

/**
 * A wall-clock budget, checked only on a quiet benchmark run
 * (GRIDLOOK_TIMING=1): the suite asserts results and counts, and a busy host
 * does not fail correct code.
 */
const withinBudget = (ms: number, budget: number, what = "") =>
  process.env.GRIDLOOK_TIMING === "1" && expect(ms, what).toBeLessThan(budget);

it("matches each map step on a long reversed axis without scanning it (review of interim37)", () => {
  const n = 87_600;
  const values = Array.from({ length: n }, (_, at) => at);
  const plot = {
    values: [...values].reverse(),
    units: "hours since 2000-01-01",
    calendar: "standard",
  };
  // The map's coordinate is made afresh at each step, over the same values.
  const at = (index: number) =>
    correspondingIndex(
      { values, units: "hours since 2000-01-01", calendar: "standard" },
      index,
      plot,
      "time"
    );
  expect(at(0)).toBe(n - 1);
  const started = performance.now();
  for (let step = 1; step <= 200; step++) {
    expect(at(step * 400)).toBe(n - 1 - step * 400);
  }
  withinBudget(performance.now() - started, 20);
  // A date the plot holds twice names no row.
  const twice = { ...plot, values: [5, 6, 5] };
  expect(
    correspondingIndex(
      { values: [5, 7], units: plot.units, calendar: "standard" },
      0,
      twice,
      "time"
    )
  ).toBe(undefined);
});

it("final review of interim41: a repeated map date badges only the same stored row", () => {
  const units = "days since 2000-01-01";
  // The map's axis repeats day 0; the plot reads rows 1 and 2.
  const map = { values: [0, 0, 1], units };
  const plot = { values: [0, 1], units, rows: { start: 1, stop: 3 } };
  // Row 0 is not in the plot: no badge (it is not row 1's 20 K).
  expect(correspondingIndex(map, 0, plot, "time")).toBeUndefined();
  // Row 1 is the plot's first, row 2 its second.
  expect(correspondingIndex(map, 1, plot, "time")).toBe(0);
  expect(correspondingIndex(map, 2, plot, "time")).toBe(1);
});

it("independent review of interim41: a point's caption tells neighbouring fine cells apart", async () => {
  const { describeGeometry } = await import("@/ui/analysis/plotLayout.ts");
  const point = {
    kind: "point" as const,
    lat: -0.00001943953,
    lon: 0.00001943953,
  };
  // Cells 0.000001° apart: seven decimals, not "0.00° S, 0.00° E".
  expect(describeGeometry(point, 1e-6)).toBe("0.0000194° S, 0.0000194° E");
  expect(
    describeGeometry({ kind: "point", lat: 20.2281, lon: -0.6219 }, 1)
  ).toBe("20.23° N, 0.62° W");
});

it("final review of interim41: a map axis read afresh into a new array is keyed once", () => {
  const n = 87_600;
  const units = "hours since 2000-01-01";
  const plot = {
    values: Array.from({ length: n }, (_, at) => n - 1 - at),
    units,
  };
  const fresh = () => ({
    values: Array.from({ length: n }, (_, at) => at),
    units,
  });
  expect(correspondingIndex(fresh(), 5, plot, "time")).toBe(n - 6);
  // Each step the map's values arrive in a new array: found again.
  const started = performance.now();
  for (let step = 0; step < 5; step++) {
    expect(correspondingIndex(fresh(), step, plot, "time")).toBe(n - 1 - step);
  }
  withinBudget((performance.now() - started) / 5, 30);
});
