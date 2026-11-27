import { describe, expect, it } from "vitest";

import { unitChoices } from "@/lib/analysis/displayUnits.ts";
import { converter } from "@/lib/analysis/unitConvert.ts";
import { accumulate } from "@/ui/analysis/timeViews.ts";

describe("review of interim37: rates in display units", () => {
  it("integrates speeds shown in mph or knots over time", () => {
    const days = [0.5, 1.5, 2.5];
    const bounds = [0, 1, 1, 2, 2, 3];
    const total = (units: string, value: number) =>
      accumulate(
        days,
        "days since 2000-01-01",
        [value, value, value],
        units,
        bounds,
        undefined,
        "mean"
      );
    const metres = total("m s-1", 1);
    expect(metres.y[2]).toBeCloseTo(259_200, 6);
    const mph = total("mph", converter("m s-1", "mph")!(1));
    expect(mph.units).toBe("mi");
    expect(mph.y[2]).toBeCloseTo(259_200 / 1609.344, 3);
    const knots = total("knots", converter("m s-1", "knots")!(1));
    expect(knots.units).toBe("nmi");
    expect(knots.y[2]).toBeCloseTo(259_200 / 1852, 3);
  });

  it("offers mm/day whatever the order of the rate's factors", () => {
    const labels = (units: string) =>
      unitChoices(units, undefined, "water").map((c) => c.label);
    expect(labels("kg s-1 m-2")).toContain("mm/day");
    expect(labels("kg s-1 m-2")).toEqual(
      labels("kg m-2 s-1").map((l) =>
        l.replace("kg m-2 s-1 (as", "kg s-1 m-2 (as")
      )
    );
    expect(converter("kg s-1 m-2", "mm/day")!(1)).toBeCloseTo(86_400, 6);
  });
});
