import { expect, it } from "vitest";

import { pairSeries, validTimeAxis } from "@/ui/analysis/compare.ts";

const runs = {
  raw: [0, 86400],
  units: "seconds since 2024-10-01",
  calendar: "proleptic_gregorian",
  standardName: "forecast_reference_time",
};
const lead = (hours: number) => [
  {
    standardName: "forecast_period",
    value: hours,
    units: "hours",
    seconds: 3600,
  },
];

function series(
  time: Exclude<ReturnType<typeof validTimeAxis>, { reason: string }>
) {
  return { dates: time.raw.map(String), values: [1, 2], time };
}

it("interim48: forecasts pair at valid time, not at initialization", () => {
  const day = validTimeAxis(runs, lead(24));
  const now = validTimeAxis(runs, lead(0));
  if ("reason" in day || "reason" in now) {
    throw new Error("expected valid times");
  }
  expect(day.raw).toEqual([86400, 172800]);
  // Run 1 at +24 h and run 2 at +0 h are one moment: one pair, not two.
  const pair = pairSeries(series(now), series(day));
  expect([pair.reference, pair.other]).toEqual([[2], [1]]);
});

it("interim48: a forecast without a known lead is not compared", () => {
  expect(validTimeAxis(runs, [])).toHaveProperty("reason");
  expect(
    validTimeAxis(runs, [
      {
        standardName: "forecast_period",
        value: 6,
        valueBounds: [0, 6],
        units: "hours",
      },
    ])
  ).toMatchObject({ raw: [21600, 108000], bounds: [0, 21600, 86400, 108000] });
});
