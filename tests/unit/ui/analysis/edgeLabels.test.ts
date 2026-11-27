import { describe, expect, it } from "vitest";

import {
  describeGeometry,
  edgeDigits,
  lonSpanText,
} from "@/ui/analysis/plotLayout.ts";

describe("edges in words", () => {
  it("says all longitudes for a full turn", () => {
    expect(lonSpanText(-180, 180, false)).toBe("all longitudes");
    expect(lonSpanText(-180, 180)).toBe("all longitudes");
    expect(lonSpanText(170, -170, false)).toBe("170° E to 170° W");
  });

  it("keeps a tiny box's edges apart", () => {
    expect(edgeDigits(-0.001, 0.001)).toBe(3);
    expect(
      describeGeometry({
        kind: "box",
        west: -0.001,
        east: 0.001,
        south: -0.001,
        north: 0.001,
      })
    ).toBe("box 0.001° W to 0.001° E, 0.001° S to 0.001° N");
  });
});
