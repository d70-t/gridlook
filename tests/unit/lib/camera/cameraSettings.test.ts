import { describe, expect, it } from "vitest";

import {
  CAMERA_VERTICAL_FOV_DEGREES,
  getCameraDistanceForVerticalSpan,
  getGlobeFitCameraDistance,
  getVisibleVerticalSpan,
} from "@/lib/camera/cameraSettings.ts";

describe("camera field of view", () => {
  it("uses a narrow 7.5 degree vertical lens", () => {
    expect(CAMERA_VERTICAL_FOV_DEGREES).toBe(7.5);
  });

  it("shows about 787 km vertically at 6000 km above a plane", () => {
    expect(getVisibleVerticalSpan(6_000_000)).toBeCloseTo(786_522, -1);
  });

  it("converts between visible span and camera distance", () => {
    const span = 4.33;
    const distance = getCameraDistanceForVerticalSpan(span);

    expect(getVisibleVerticalSpan(distance)).toBeCloseTo(span);
  });
});

describe("globe framing", () => {
  it("fits the globe on the tighter axis of the viewport", () => {
    const tall = getGlobeFitCameraDistance(0.5);
    const square = getGlobeFitCameraDistance(1);
    const wide = getGlobeFitCameraDistance(2);
    expect(square).toBeCloseTo(1.05 / Math.sin((7.5 * Math.PI) / 360), 6);
    expect(wide).toBeCloseTo(square, 6);
    expect(tall).toBeGreaterThan(square);
  });
});
