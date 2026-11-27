import { describe, expect, it } from "vitest";

import {
  AZIMUTHAL_CLIP_ANGLE,
  withinAzimuthalClip,
} from "@/lib/projection/projectionUtils.ts";

describe("an azimuthal map picks only where it draws (review of interim8)", () => {
  it("shows places up to its clip angle from the centre, not beyond", () => {
    const centre = { lat: 0, lon: 0 };
    expect(AZIMUTHAL_CLIP_ANGLE).toBe(173);
    // Along the equator: the angle from the centre is the longitude.
    expect(withinAzimuthalClip(centre, 0, 172.9)).toBe(true);
    expect(withinAzimuthalClip(centre, 0, -172.9)).toBe(true);
    for (const lon of [174, 176, 179]) {
      expect(withinAzimuthalClip(centre, 0, lon)).toBe(false);
    }
    // Centred on the North Pole: the South Pole's neighbourhood is cut.
    const north = { lat: 90, lon: 0 };
    expect(withinAzimuthalClip(north, -82, 40)).toBe(true);
    expect(withinAzimuthalClip(north, -84, 40)).toBe(false);
  });
});
