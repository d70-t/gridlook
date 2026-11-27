import { expect, it } from "vitest";

import { windLine } from "@/ui/analysis/windBarbs.ts";

it("reads out the wind of one sample, or says there is none (25 Nov)", () => {
  const wind = { u: [3, Number.NaN], v: [3, 1], units: "m s-1" };
  expect(windLine(wind, 0)).toMatch(
    /^Wind \d+ kn \(4\.2 m s-1\) from 225° \(SW\)$/
  );
  expect(windLine(wind, 1)).toBe("No wind here");
  expect(windLine({ ...wind, current: true }, 1)).toBe("No current here");
});
