import { expect, it } from "vitest";

import { encodeTimeValue, parseTimeAxis } from "@/lib/analysis/calendar.ts";

it("keeps a reference time 15 µs after midnight (review of interim37)", () => {
  const epoch = { year: 1970, month: 1, day: 1, hour: 0, minute: 0, second: 0 };
  const at = (units: string) =>
    encodeTimeValue(parseTimeAxis(units, "standard") as never, epoch);
  const shift =
    (at("days since 2001-01-01 00:00:00.000015") -
      at("days since 2001-01-01 00:00:00")) *
    86400;
  // To 0.5 µs: the subtraction of two day counts near 11,000 holds that.
  expect(shift).toBeCloseTo(-15e-6, 6);
});
