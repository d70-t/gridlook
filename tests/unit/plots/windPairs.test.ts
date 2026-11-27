import { describe, expect, it } from "vitest";

import { windPairs } from "@/lib/analysis/windPair.ts";
import { isCurrentPair } from "@/store/analysisStore.ts";
import { roseOf } from "@/ui/analysis/windFigures.ts";

const meta = (u: string, v: string, east: string, north: string) => ({
  [u]: { units: "m s-1", standardName: east },
  [v]: { units: "m s-1", standardName: north },
});

describe("review of interim43: what a pair of components is", () => {
  it("draws CF winds named uo and vo as a wind, from where it comes", () => {
    for (const [u, v] of [
      ["u", "v"],
      ["uo", "vo"],
    ]) {
      const variables = meta(u, v, "eastward_wind", "northward_wind");
      const pair = windPairs(variables, u).pairs[0];
      expect(isCurrentPair(pair, variables)).toBe(false);
      // 3 east, 4 north: from 216.87°, sector SW (index 10 of 16).
      const rose = roseOf([3], [4], "m s-1", isCurrentPair(pair, variables));
      expect(rose.sectors.findIndex((s) => s.some((n) => n > 0))).toBe(10);
    }
  });

  it("refuses standard errors as components", () => {
    const variables = meta(
      "u",
      "v",
      "eastward_wind standard_error",
      "northward_wind standard_error"
    );
    const found = windPairs(variables, "u");
    expect(found.pairs).toEqual([]);
    expect(found.reason).toMatch(/standard error of eastward wind/);
  });

  it("keeps ocean currents named by their standard names", () => {
    const variables = meta(
      "uo",
      "vo",
      "eastward_sea_water_velocity",
      "northward_sea_water_velocity"
    );
    const pair = windPairs(variables, "uo").pairs[0];
    expect(isCurrentPair(pair, variables)).toBe(true);
  });
});
