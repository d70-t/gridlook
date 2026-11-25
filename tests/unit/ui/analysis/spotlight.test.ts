import { describe, expect, it } from "vitest";

import { spotlightPath } from "@/ui/analysis/spotlight.ts";

const shape = (id: string, closed: boolean, paths: string[]) => ({
  id,
  closed,
  paths,
});

describe("spotlight", () => {
  it("lights a country or shape being chosen, all its rings in one path", () => {
    const d = spotlightPath([
      shape("w1", true, ["M0,0L9,0L9,9Z"]),
      shape("country-preview", true, ["M1,1L5,1L5,5Z", "M2,2L3,2L3,3Z"]),
    ]);
    // Both rings together, so the even–odd fill leaves the enclave dimmed.
    expect(d).toBe("M1,1L5,1L5,5Z M2,2L3,2L3,3Z");
  });

  it("lights a plot's area while its ID is pointed at, not otherwise", () => {
    const shapes = [shape("w1", true, ["M0,0L9,0L9,9Z"])];
    expect(spotlightPath(shapes)).toBeUndefined();
    expect(spotlightPath(shapes, "w1")).toBe("M0,0L9,0L9,9Z");
  });

  it("builds a plot's fill only while it is lit", () => {
    let built = 0;
    const lazy = {
      ...shape("w1", true, ["M0,0L9,0L9,9Z"]),
      lit: () => {
        built++;
        return ["M0,0L9,0L9,9Z"];
      },
    };
    const others = [lazy, { ...lazy, id: "w2" }, { ...lazy, id: "w3" }];
    expect(spotlightPath(others)).toBeUndefined();
    expect(built).toBe(0);
    expect(spotlightPath(others, "w2")).toBe("M0,0L9,0L9,9Z");
    expect(built).toBe(1);
  });

  it("never dims around a point or a path, or an area off screen", () => {
    expect(
      spotlightPath([shape("w1", false, ["M0,0L9,9"])], "w1")
    ).toBeUndefined();
    expect(spotlightPath([shape("shape-preview", true, [])])).toBeUndefined();
  });
});

describe("a box's spotlight is its inside (recording 21 Nov, v20 review)", () => {
  it("joins a box's edges into one ring in order around", async () => {
    const { ringAround } = await import("@/ui/analysis/spotlight.ts");
    // Edges as the overlay draws them: south W→E, east S→N, north W→E
    // (both parallels eastward), west N→S.
    const south = [
      [0, 0],
      [5, 0],
      [10, 0],
    ];
    const east = [
      [10, 0],
      [10, 10],
    ];
    const north = [
      [0, 10],
      [5, 10],
      [10, 10],
    ];
    const west = [
      [0, 10],
      [0, 0],
    ];
    const ring = ringAround([south, east, north, west], true);
    // Each step continues where the last ended: one closed ring.
    for (let at = 1; at < ring.length; at++) {
      const [a, b] = [ring[at - 1], ring[at]];
      expect(Math.hypot(a[0] - b[0], a[1] - b[1])).toBeLessThanOrEqual(10);
    }
    expect(ring[0]).toEqual(ring[ring.length - 1]);
    expect(ring.slice(5, 8)).toEqual([
      [10, 10],
      [5, 10],
      [0, 10],
    ]);
  });

  it("lights the ring, not the separate edges", () => {
    const box = {
      id: "w1",
      closed: true,
      paths: ["M0,0L5,1L10,0", "M10,0L10,10", "M0,10L5,9L10,10", "M0,10L0,0"],
      ring: ["M0,0L5,1L10,0L10,10L5,9L0,10Z"],
    };
    expect(spotlightPath([box], "w1")).toBe("M0,0L5,1L10,0L10,10L5,9L0,10Z");
  });
});
