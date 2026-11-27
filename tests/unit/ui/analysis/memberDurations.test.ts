import { expect, it } from "vitest";

import { meanDurations, memberStats } from "@/ui/analysis/members.ts";

it("weights each member's period mean by its interval lengths (review of interim37)", () => {
  // A one-day mean and a nine-day mean: [0, 20] is 18, [10, 10] is 10.
  const result = {
    cellMethods: "time: mean",
    time: { dimension: "time", raw: [0.5, 5.5], bounds: [0, 1, 1, 10] },
  };
  const durations = meanDurations(result);
  expect(durations).toEqual([1, 9]);
  const { means } = memberStats(
    [
      [0, 20],
      [10, 10],
    ],
    2,
    durations
  );
  expect(means).toEqual([18, 10]);
  // Readings at instants, or unknown intervals, weigh equally.
  expect(meanDurations({ ...result, cellMethods: "time: point" })).toBe(
    undefined
  );
  // An unknown interval is said per step; a value there is left out of the mean
  // over known lengths, and counted.
  const unknown = meanDurations({
    ...result,
    time: { ...result.time, bounds: [0, 1, Number.NaN, 10] },
  });
  expect(unknown).toEqual([1, NaN]);
  expect(memberStats([[0, 20]], 2, unknown)).toMatchObject({
    means: [0],
    leftOut: 1,
  });
});

it("review of interim43: a value of unknown length is left out of the period mean", () => {
  // [0, 20, 100] over one day, nine days and an unknown interval: 18 over
  // the ten known days, not the sample mean 40.
  const durations = [1, 9, Number.NaN];
  expect(memberStats([[0, 20, 100]], 3, durations)).toMatchObject({
    means: [18],
    leftOut: 1,
  });
  // No known length at all: equal weights, nothing said left out.
  expect(
    memberStats([[0, 20, 100]], 3, [Number.NaN, Number.NaN, Number.NaN])
  ).toMatchObject({ means: [40], leftOut: 0 });
});
