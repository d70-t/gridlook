import { expect, it } from "vitest";

import { timeLabels } from "@/lib/analysis/calendar.ts";
import { unitChoices } from "@/lib/analysis/displayUnits.ts";
import { converter } from "@/lib/analysis/unitConvert.ts";
import { healpixCellAxis } from "@/lib/grids/analysisGrid.ts";
import { pairSeries } from "@/ui/analysis/compare.ts";
import { accumulate, spectrum } from "@/ui/analysis/timeViews.ts";

const day = 86400;
const units = "days since 2001-01-01";

it("respects an explicitly named spatial dimension absent from a field", () => {
  expect(
    healpixCellAxis(
      ["time", "member"],
      [2, 48],
      // eslint-disable-next-line camelcase -- DGGS attribute name
      { spatial_dimension: "cell" },
      undefined,
      48
    )
  ).toBe(-1);
});

it("uses an explicitly named spatial dimension when it is present", () => {
  expect(
    healpixCellAxis(
      ["time", "cell"],
      [2, 48],
      // eslint-disable-next-line camelcase -- DGGS attribute name
      { spatial_dimension: "cell" },
      undefined,
      48
    )
  ).toBe(1);
});

it("pairs only observations with known timestamps", () => {
  const raw = [3, NaN, 0, 1, 2];
  const time = {
    raw,
    calendar: "standard",
    units,
    quantity: "intensive" as const,
  };
  const make = (values: number[]) => ({
    time,
    calendar: "standard",
    dates: timeLabels(time),
    values,
  });
  const result = pairSeries(make([3, 100, 0, 1, 2]), make([3, -100, 0, 1, 2]));
  expect(result.reference).toHaveLength(4);
});

it("preserves elapsed integration across four known dates if another date is absent", () => {
  const raw = [3, NaN, 0, 1, 2];
  const result = accumulate(
    raw,
    units,
    [1, 999, 1, 1, 1],
    "kg m-2 s-1",
    undefined,
    undefined,
    "point"
  );
  expect(result.y[0]).toBe(3 * day);
});

it("locates the strongest component of a four-day and Nyquist mixture", () => {
  const wave = Array.from(
    { length: 128 },
    (_, i) => 1.5 * Math.cos((2 * Math.PI * i) / 4) + (-1) ** i
  );
  expect(spectrum(wave, day)?.peak).toBe(4 * day);
});

it("integrates three declared daily means over their stated support", () => {
  const result = accumulate(
    [0, 1, 2],
    units,
    [1, 1, 1],
    "kg m-2 s-1",
    [-0.5, 0.5, 0.5, 1.5, 1.5, 2.5],
    undefined,
    "mean"
  );
  expect(result.y).toEqual([day, 2 * day, 3 * day]);
});

it("converts the same ocean current expressed in mm/s and m/s", () => {
  expect(converter("mm/s", "m/s")?.(1000)).toBe(1);
});

it("offers a physically compatible speed unit for a field stored in mm/s", () => {
  const offered = unitChoices("mm/s").map((choice) => choice.units);
  expect(offered).toContain("m s-1");
});
