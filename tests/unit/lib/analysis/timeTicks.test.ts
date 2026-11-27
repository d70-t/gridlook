import { describe, expect, it } from "vitest";

import {
  decodeTimeValue,
  parseTimeAxis,
  type TTimeAxis,
} from "@/lib/analysis/calendar.ts";
import { timeTicks } from "@/lib/analysis/timeTicks.ts";

function axis(units: string, calendar = "standard") {
  const parsed = parseTimeAxis(units, calendar);
  if ("unsupported" in parsed) {
    throw new Error(parsed.unsupported);
  }
  return parsed as TTimeAxis;
}

// eslint-disable-next-line max-lines-per-function
describe("time ticks", () => {
  it("places day ticks at midnight and names the month once", () => {
    const hours = axis("hours since 2024-06-11 00:00");
    const { ticks, context } = timeTicks(hours, 0, 96, 6);
    expect(ticks.map((t) => t.label)).toEqual([
      "11 Jun",
      "12 Jun",
      "13 Jun",
      "14 Jun",
      "15 Jun",
    ]);
    expect(ticks.map((t) => t.value)).toEqual([0, 24, 48, 72, 96]);
    expect(context).toBe("June 2024");
  });

  it("gives irregular samples distinct ticks at the dates they name", () => {
    const days = axis("days since 2001-01-01");
    // Seven irregular samples between 17 Jan and 5 Feb.
    const samples = [16, 16.4, 20, 27.5, 30, 34.9, 35];
    const { ticks } = timeTicks(days, samples[0], samples[6], 6);
    const labels = ticks.map((t) => t.label);
    expect(new Set(labels).size).toBe(labels.length);
    for (const tick of ticks) {
      const date = decodeTimeValue(days, tick.value);
      expect([date.hour, date.minute, date.second]).toEqual([0, 0, 0]);
      expect(tick.label).toBe(`${date.day} ${["Jan", "Feb"][date.month - 1]}`);
    }
  });

  it("follows a 360-day calendar's months and years", () => {
    const days = axis("days since 2000-01-01", "360_day");
    const { ticks, context } = timeTicks(days, 0, 720, 8);
    expect(ticks.find((t) => t.label === "Jan 2001")?.value).toBe(360);
    expect(ticks[0]).toEqual({ value: 0, label: "Jan 2000" });
    expect(context).toBe("2000–2002");
  });

  it("uses whole years over long spans and clock times within a day", () => {
    const years = timeTicks(
      axis("days since 1850-01-01", "noleap"),
      0,
      365 * 200,
      6
    );
    expect(years.ticks.map((t) => t.label)).toEqual([
      "1850",
      "1900",
      "1950",
      "2000",
      "2050",
    ]);
    const clock = timeTicks(axis("minutes since 2024-03-02 00:00"), 30, 600, 6);
    expect(clock.ticks[0].label).toBe("02:00");
    expect(clock.context).toBe("March 2024");
  });
});
