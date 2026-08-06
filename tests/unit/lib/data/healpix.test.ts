import * as healpix from "@hscmap/healpix";
import { describe, expect, it } from "vitest";

import { healpixNestedPixelIndex } from "@/lib/data/healpix.ts";

function pixelCenter(nside: number, pixel: number) {
  const { theta, phi } = healpix.pix2ang_nest(nside, pixel);
  return {
    latitude: 90 - (theta * 180) / Math.PI,
    longitude: (((phi * 180) / Math.PI + 540) % 360) - 180,
  };
}

function longitudeDifference(a: number, b: number) {
  return Math.abs(((((a - b + 540) % 360) + 360) % 360) - 180);
}

describe("healpixNestedPixelIndex", () => {
  it("selects nearby northern pixels on exact base-face boundaries", () => {
    const nside = 64;
    for (const latitude of [45, 60, 70, 80]) {
      for (const longitude of [-180, -90, 0, 90, 180]) {
        const pixel = healpixNestedPixelIndex(nside, latitude, longitude);
        const center = pixelCenter(nside, pixel);
        expect(Math.abs(center.latitude - latitude)).toBeLessThan(2);
        expect(
          longitudeDifference(center.longitude, longitude) *
            Math.cos((latitude * Math.PI) / 180)
        ).toBeLessThan(2);
      }
    }
  });

  it("is continuous immediately around northern Greenwich", () => {
    const nside = 64;
    const centers = [-1e-8, 0, 1e-8].map((longitude) =>
      pixelCenter(nside, healpixNestedPixelIndex(nside, 60, longitude))
    );
    for (const center of centers) {
      expect(center.latitude).toBeCloseTo(60, 0);
      expect(longitudeDifference(center.longitude, 0)).toBeLessThan(2);
    }
  });
});
