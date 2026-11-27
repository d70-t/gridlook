import { describe, expect, it } from "vitest";

import { errorHelp, sizeOf } from "@/ui/analysis/errorHelp.ts";

describe("a failed plot says what can help", () => {
  const big =
    "133 bins × 19,488 times is more than 2,000,000 values. Choose a wider bin or a shorter time range.";

  it("reads the size of a request that is too large", () => {
    expect(sizeOf(big)).toEqual({ values: 133 * 19488, limit: 2_000_000 });
    expect(
      sizeOf(
        "The result would hold 5,000,000 values; plots keep at most 4,000,000."
      )
    ).toEqual({ values: 5_000_000, limit: 4_000_000 });
  });

  it("offers the first dates, fewer dates and wider bins, not a retry", () => {
    const help = errorHelp(big, true);
    expect(help.title).toBe("Too many values for one plot");
    expect(help.actions).toEqual([
      "first-dates",
      "dates",
      "bins",
      "settings",
      "copy",
    ]);
    expect(help.why).toMatch(/2,591,904 values.*about 2× less/);
    expect(help.why).toMatch(/Retrying would fail the same way/);
  });

  it("retries a store that could not be reached", () => {
    expect(errorHelp("Failed to fetch: network error", true).actions[0]).toBe(
      "retry"
    );
    expect(errorHelp("Something odd", false).actions).toEqual([
      "retry",
      "settings",
      "copy",
    ]);
  });
});
