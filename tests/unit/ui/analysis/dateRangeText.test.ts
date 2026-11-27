import { describe, expect, it } from "vitest";

import { compactDateRange } from "@/ui/analysis/dateRangeText.ts";

describe("the loaded dates under a plot", () => {
  it("names the month, so 9 October is not read as 10 September", () => {
    expect(compactDateRange("2024-10-09 00:00:00 – 2024-10-09 01:00:00")).toBe(
      "9 Oct 00:00 – 01:00"
    );
    expect(compactDateRange("2024-10-07 00:00:00 – 2024-10-10 18:00:00")).toBe(
      "7 Oct 00:00 – 10 Oct 18:00"
    );
  });

  it("drops a shared time of day and keeps the year when years differ", () => {
    expect(compactDateRange("2001-06-01 23:59:59 – 2001-08-01 23:59:59")).toBe(
      "1 Jun – 1 Aug"
    );
    expect(compactDateRange("2024-12-31 18:00 – 2025-01-01 06:00")).toBe(
      "2024-12-31 18:00 – 2025-01-01 06:00"
    );
  });
});
