import { expect, it } from "vitest";

import { tickText } from "@/ui/analysis/valueTicks.ts";

const ticks = (values: number[]) => values.map((value) => ({ value }));

it("labels neighbouring ticks apart (25 Nov: 270, 271, 271, 272, 272)", () => {
  const half = ticks([270, 270.5, 271, 271.5, 272]);
  expect(half.map((t) => tickText(t.value, half))).toEqual([
    "270",
    "270.5",
    "271",
    "271.5",
    "272",
  ]);
  const fine = ticks([1000.02, 1000.04]);
  expect(fine.map((t) => tickText(t.value, fine))).toEqual([
    "1000.02",
    "1000.04",
  ]);
  // Whole steps stay whole; exponents stay for the very large and small.
  expect(tickText(20, ticks([0, 20]))).toBe("20");
  expect(tickText(2e7, ticks([0, 1e7]))).toBe("2.0e+7");
  expect(tickText(2e-5, ticks([0, 1e-5]))).toBe("2.0e-5");
});

it("labels every pressure tick distinctly when the axis uses scientific notation", () => {
  const marks = ticks([1_000_000, 1_000_020, 1_000_040, 1_000_060]);
  const labels = marks.map(({ value }) => tickText(value, marks));
  expect(new Set(labels).size).toBe(marks.length);
});
