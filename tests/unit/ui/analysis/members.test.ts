import { describe, expect, it } from "vitest";

import {
  boxOf,
  chanceAbove,
  memberStats,
  percentileOf,
  roundThreshold,
} from "@/ui/analysis/members.ts";

describe("ensemble members in summary", () => {
  it("interpolates percentiles linearly", () => {
    expect(percentileOf([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(percentileOf([0, 10], 0.1)).toBeCloseTo(1);
    expect(percentileOf([], 0.5)).toBeNaN();
  });

  it("summarises each step across members, leaving missing values out", () => {
    // Ten members 1…10 at step 0; at step 1 only member 0 has a value.
    const series = Array.from({ length: 10 }, (_, m) => [
      m + 1,
      m === 0 ? 7 : Number.NaN,
      Number.NaN,
    ]);
    const stats = memberStats(series, 3);
    expect(stats.p50[0]).toBe(5.5);
    expect(stats.p10[0]).toBeCloseTo(1.9);
    expect(stats.p90[0]).toBeCloseTo(9.1);
    expect([stats.p10[1], stats.p50[1], stats.p90[1]]).toEqual([7, 7, 7]);
    expect(stats.p50[2]).toBeNaN();
    // Each member's mean over the period, over its own values.
    expect(stats.means[0]).toBe(4);
    expect(stats.means[9]).toBe(10);
  });

  it("boxes the members' means: quartiles and extremes", () => {
    expect(boxOf([4, 1, 3, 2, Number.NaN])).toEqual({
      min: 1,
      q1: 1.75,
      median: 2.5,
      q3: 3.25,
      max: 4,
      count: 4,
    });
  });

  it("counts the members above a threshold per step", () => {
    const series = [
      [1, 5, Number.NaN],
      [2, 6, Number.NaN],
      [3, 7, Number.NaN],
      [4, Number.NaN, Number.NaN],
    ];
    const chance = chanceAbove(series, 2.5, 3);
    expect(chance.share[0]).toBe(50);
    expect(chance.share[1]).toBe(100);
    expect(chance.valid).toEqual([4, 3, 0]);
    expect(chance.share[2]).toBeNaN();
  });

  it("starts the threshold at the members' rounded median", () => {
    expect(roundThreshold([288.37, 291.2, 290.04])).toBe(290);
    expect(roundThreshold([0.0123, 0.0127])).toBe(0.013);
    expect(roundThreshold([])).toBe(0);
  });
});

it("interim48: the default threshold is selected over the members as they are", () => {
  const members = [
    [1, 2, Number.NaN],
    [3, 4, 5],
  ];
  expect(roundThreshold(members)).toBe(3);
  const sort = Array.prototype.sort;
  let sorts = 0;
  Array.prototype.sort = function (this: unknown[], ...args) {
    sorts++;
    return sort.apply(this, args as never);
  } as typeof sort;
  try {
    roundThreshold([Array.from({ length: 4096 }, (_, k) => k)]);
  } finally {
    Array.prototype.sort = sort;
  }
  expect(sorts).toBe(0);
});

it("interim49: the chance threshold is kept per set of member arrays", async () => {
  const { roundThreshold } = await import("@/ui/analysis/members.ts");
  const members = [
    [1, 2, Number.NaN],
    [3, 4, 5],
  ];
  const first = roundThreshold([...members]);
  // A new list around the same arrays: the kept value, not a new pass.
  members[0][0] = 100;
  expect(roundThreshold([...members])).toBe(first);
  expect(
    roundThreshold([
      [1, 2],
      [3, 4, 5],
    ])
  ).toBe(3);
});
