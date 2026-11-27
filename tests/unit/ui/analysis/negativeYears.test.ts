import { expect, it } from "vitest";

import { timeLabels } from "@/lib/analysis/calendar.ts";
import {
  annualCycle,
  countAbove,
  spansMonths,
  subDaily,
} from "@/ui/analysis/timeViews.ts";

it("groups negative calendar years by their signed year (review of interim37)", () => {
  for (const units of [
    "days since -0006-01-01 12:00:00",
    "days since 0394-01-01 12:00:00",
  ]) {
    const raw = Array.from({ length: 2160 }, (_, at) => at);
    const dates = timeLabels({ raw, units, calendar: "360_day" });
    const values = raw.map((day) => (day % 360 < 30 ? 100 : 0));
    const counted = countAbove(dates, values, 0);
    expect(counted.above).toEqual([30, 30, 30, 30, 30, 30]);
    expect(subDaily(dates)).toBe(false);
    expect(spansMonths(dates)).toBe(true);
    expect(annualCycle(dates, values).mean[0]).toBe(100);
  }
});
