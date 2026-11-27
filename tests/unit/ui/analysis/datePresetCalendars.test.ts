import { expect, it } from "vitest";

import { rowIndices } from "@/lib/analysis/timeRows.ts";
import { datePresets } from "@/ui/analysis/datePresets.ts";

const lastYear = (raw: number[], calendar: string) =>
  datePresets({
    raw,
    units: "days since 2001-01-01",
    calendar,
    chunk: 1,
  }).find((preset) => preset.id === "year")?.range;

it("independent review of interim41: Last year is the same dates in either calendar spelling and storage order", () => {
  // Two no-leap years of days, 0 … 729.
  const days = Array.from({ length: 730 }, (_, d) => d);
  const noleap = lastYear(days, "noleap");
  expect(noleap).toEqual({ start: 365, stop: 730 });
  expect(lastYear(days, "365_day")).toEqual(noleap);
  // Stored newest first: the same 365 dates.
  const reversed = days.slice().reverse();
  const range = lastYear(reversed, "noleap")!;
  expect(
    rowIndices(range)
      .map((at) => reversed[at])
      .sort((a, b) => a - b)
  ).toEqual(days.slice(365));
});
