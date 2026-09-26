import { expect, it, vi } from "vitest";

import type { TPreparedScalarFrame } from "@/ui/grids/composables/scalarFrame.ts";
import { interpolateScalarValue } from "@/ui/grids/composables/scalarInterpolation.ts";
import {
  SCALAR_INTERPOLATION,
  createScalarTimeline,
  scalarInterpolationWeight,
  scalarPresentationCount,
  scalarPresentationFrame,
} from "@/ui/grids/composables/scalarTimeline.ts";

vi.stubGlobal("localStorage", { getItem: () => null });

function frame(values: number[], attrs = {}, calendar = "standard") {
  return {
    info: {
      attrs,
      dimInfo: [
        { values, attrs: { units: "days since 2000-01-01", calendar } },
      ],
    },
  } as unknown as TPreparedScalarFrame;
}

it("counts endpoints once and maps every subdivision without caching intermediate arrays", () => {
  expect(scalarPresentationCount(3, 0)).toBe(3);
  expect(scalarPresentationCount(3, 1)).toBe(5);
  expect(scalarPresentationCount(3, 1000)).toBe(2003);
  expect([0, 1, 2, 3, 4].map((i) => scalarPresentationFrame(i, 3, 1))).toEqual([
    { first: 0, next: 1, alpha: 0 },
    { first: 0, next: 1, alpha: 0.5 },
    { first: 1, next: 2, alpha: 0 },
    { first: 1, next: 2, alpha: 0.5 },
    { first: 1, next: 2, alpha: 1 },
  ]);
});
it.each([-1, 0.5, NaN, Infinity, Number.MAX_SAFE_INTEGER])(
  "rejects invalid subdivision count %s",
  (value) => {
    expect(scalarPresentationCount(3, value)).toBe(0);
  }
);
it("uses actual unequal timestamps for labels and detects unequal gaps", () => {
  const timeline = createScalarTimeline(frame([0, 2, 5]), 0, 0, 2);
  expect(timeline.unequalGaps).toBe(true);
  expect(timeline.label(0, 0.5)).toBe("02 Jan 2000 • 00:00:00.000");
  expect(timeline.label(1, 0.5)).toBe("04 Jan 2000 • 12:00:00.000");
  expect(timeline.label(1, 1)).toBe("06 Jan 2000 • 00:00:00.000");
  expect(createScalarTimeline(frame([0, 2, 4]), 0, 0, 2).unequalGaps).toBe(
    false
  );
});
it("preserves non-Gregorian time coordinates without claiming Gregorian dates", () => {
  const timeline = createScalarTimeline(frame([0, 2], {}, "360_day"), 0, 0, 1);
  expect(timeline.label(0, 0.5)).toBe("1 days since 2000-01-01 (360_day)");
});
it.each([
  [0, NaN],
  [0, 0],
  [2, 1],
])("rejects unusable source timestamps %j", (a, b) => {
  expect(() => createScalarTimeline(frame([a, b]), 0, 0, 1)).toThrow();
});
it.each([
  { ["flag_values"]: [0, 1] },
  { ["flag_masks"]: [1] },
  { ["cell_methods"]: "time: sum" },
])("keeps non-interpolatable variable semantics original-only %j", (attrs) => {
  expect(() => createScalarTimeline(frame([0, 1], attrs), 0, 0, 1)).toThrow(
    /categorical or accumulated/
  );
});
it("interpolates physical scalars, preserves endpoints, and does not fill missing cells", () => {
  expect(interpolateScalarValue(-10, 30, 0.25)).toBe(0);
  expect(interpolateScalarValue(5, NaN, 0)).toBe(5);
  expect(interpolateScalarValue(NaN, 5, 1)).toBe(5);
  expect(interpolateScalarValue(5, NaN, 0.5)).toBeNaN();
  expect(interpolateScalarValue(Infinity, 5, 0.5)).toBeNaN();
});

it("smoothstep reaches endpoints with zero slope and stays within their values", () => {
  const weight = (t: number) =>
    scalarInterpolationWeight(t, SCALAR_INTERPOLATION.SMOOTHSTEP);
  expect([0, 0.25, 0.5, 0.75, 1].map(weight)).toEqual([
    0,
    5 / 32,
    0.5,
    27 / 32,
    1,
  ]);
  const epsilon = 1e-6;
  expect((weight(epsilon) - weight(0)) / epsilon).toBeCloseTo(0, 5);
  expect((weight(1) - weight(1 - epsilon)) / epsilon).toBeCloseTo(0, 5);
  let previous = 0;
  for (let i = 0; i <= 100; i++) {
    const alpha = weight(i / 100);
    expect(alpha).toBeGreaterThanOrEqual(previous);
    expect(alpha).toBeLessThanOrEqual(1);
    expect(interpolateScalarValue(-10, 30, alpha)).toBeGreaterThanOrEqual(-10);
    expect(interpolateScalarValue(30, -10, alpha)).toBeLessThanOrEqual(30);
    previous = alpha;
  }
  expect(scalarInterpolationWeight(0.25, SCALAR_INTERPOLATION.LINEAR)).toBe(
    0.25
  );
  expect(interpolateScalarValue(5, NaN, weight(0))).toBe(5);
  expect(interpolateScalarValue(NaN, 5, weight(1))).toBe(5);
  expect(interpolateScalarValue(5, NaN, weight(0.25))).toBeNaN();
});
