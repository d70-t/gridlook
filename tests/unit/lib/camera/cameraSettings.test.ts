import { describe, expect, it } from "vitest";

import {
  CAMERA_VERTICAL_FOV_DEGREES,
  getCameraDistanceForVerticalSpan,
  getVisibleVerticalSpan,
} from "@/lib/camera/cameraSettings.ts";

describe("camera field of view", () => {
  it("uses a conventional 45 degree vertical lens", () => {
    expect(CAMERA_VERTICAL_FOV_DEGREES).toBe(45);
  });

  it("shows about 4971 km vertically at 6000 km above a plane", () => {
    expect(getVisibleVerticalSpan(6_000_000)).toBeCloseTo(4_970_563, -1);
  });

  it("converts between visible span and camera distance", () => {
    const span = 4.33;
    const distance = getCameraDistanceForVerticalSpan(span);

    expect(getVisibleVerticalSpan(distance)).toBeCloseTo(span);
  });
});
