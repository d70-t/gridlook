import { describe, expect, it } from "vitest";

import {
  besideInside,
  boxForMode,
  capBox,
  capOf,
  capReach,
  drawnBoxEdges,
  REGION_MODES,
  regionModeOf,
} from "@/ui/analysis/regionModes.ts";

const box = { west: 10, east: 40, south: 35, north: 55 };

it("v31: a box's mode is read from its numbers", () => {
  expect(regionModeOf(box)).toBe(REGION_MODES.BOX);
  expect(regionModeOf({ ...box, west: -180, east: 180 })).toBe(
    REGION_MODES.BAND
  );
  expect(regionModeOf({ west: -180, east: 180, south: 60, north: 90 })).toBe(
    REGION_MODES.CAP
  );
  expect(regionModeOf({ west: -180, east: 180, south: -90, north: 90 })).toBe(
    REGION_MODES.GLOBE
  );
  // A short box across the dateline stays a box.
  expect(regionModeOf({ west: 170, east: -170, south: 0, north: 10 })).toBe(
    REGION_MODES.BOX
  );
  // All longitudes the other way round (0..360) is a band too.
  expect(regionModeOf({ west: 0, east: 360, south: 0, north: 10 })).toBe(
    REGION_MODES.BAND
  );
});

it("v31: caps include their pole; modes start from the current box", () => {
  expect(capBox("south", 60)).toEqual({
    west: -180,
    east: 180,
    south: -90,
    north: -60,
  });
  expect(capOf(capBox("north", 66.5))).toEqual({
    hemisphere: "north",
    limit: 66.5,
  });
  expect(boxForMode(REGION_MODES.BAND, box)).toEqual({
    west: -180,
    east: 180,
    south: 35,
    north: 55,
  });
  expect(boxForMode(REGION_MODES.CAP, box)).toEqual(capBox("north", 60));
  expect(
    boxForMode(REGION_MODES.BOX, boxForMode(REGION_MODES.GLOBE, box))
  ).toEqual({ west: -30, east: 30, south: -60, north: 60 });
});

it("v31: a band or cap is drawn as latitude circles only", () => {
  expect(drawnBoxEdges(box)).toEqual([0, 1, 2, 3]);
  expect(drawnBoxEdges({ ...box, west: -180, east: 180 })).toEqual([0, 2]);
  expect(drawnBoxEdges(capBox("north", 60))).toEqual([0]);
  expect(drawnBoxEdges(capBox("south", 60))).toEqual([2]);
  expect(
    drawnBoxEdges({ west: -180, east: 180, south: -90, north: 90 })
  ).toEqual([]);
});

it("v31: titles name a band, a cap and the globe", async () => {
  const { describeGeometry } = await import("@/ui/analysis/plotLayout.ts");
  const named = (b: typeof box) => describeGeometry({ kind: "box", ...b });
  expect(named(capBox("north", 60))).toBe("polar cap north of 60.00° N");
  expect(named(capBox("south", 66.5))).toBe("polar cap south of 66.50° S");
  expect(named({ west: -180, east: 180, south: -10, north: 10 })).toBe(
    "latitude band 10.00° S to 10.00° N"
  );
  expect(named({ west: -180, east: 180, south: -90, north: 90 })).toBe(
    "whole globe"
  );
  expect(named(box)).toMatch(/^box /);
});

describe("a box's sides are drawn beside its inside", () => {
  it("draws a side at 180°E just west of the seam, one at 180°W just east", () => {
    const east = besideInside([{ lat: -60, lon: 180 }], "east");
    const west = besideInside([{ lat: -60, lon: -180 }], "west");
    // On a map whose seam is at ±180°: x from longitude, right edge 720.
    const x = (lon: number) => ((((lon + 180) % 360) + 360) % 360) * 2;
    expect(x(east[0].lon)).toBeGreaterThan(719.99);
    expect(x(west[0].lon)).toBeLessThan(0.01);
    expect(Math.abs(east[0].lon - 180)).toBeLessThan(1e-5);
  });
});

it("a box down to a pole becomes the cap to the same latitude", () => {
  // The user's A3: 359.21° of longitude, 90°S to 56.78184°S.
  const a3 = { west: -179.20845, east: 180, south: -90, north: -56.78184 };
  expect(boxForMode(REGION_MODES.CAP, a3)).toEqual(capBox("south", 56.78184));
  expect(capBox("south", 56.78184)).toMatchObject({
    west: -180,
    east: 180,
    south: -90,
    north: -56.78184,
  });
});

it("a box from 90°S past the equator stays the same cap (review of interim7)", () => {
  const across = { west: -179.2, east: 180, south: -90, north: 10 };
  const cap = boxForMode(REGION_MODES.CAP, across);
  expect(cap).toMatchObject({ west: -180, east: 180, south: -90, north: 10 });
  // Its reach is past the equator; set again, it stays put.
  expect(capReach(capOf(cap))).toBe(-10);
  expect(capBox("south", capReach(capOf(cap)))).toEqual(cap);
});

it("converting keeps the latitudes drawn (review of interim8)", () => {
  // A cap from 90°S to 75°S as a box: the same latitudes.
  expect(boxForMode(REGION_MODES.BOX, capBox("south", 75))).toEqual({
    west: -30,
    east: 30,
    south: -90,
    north: -75,
  });
  // A box at 89.25°N–89.75°N as a band: still there.
  expect(
    boxForMode(REGION_MODES.BAND, {
      west: 0,
      east: 10,
      south: 89.25,
      north: 89.75,
    })
  ).toEqual({ west: -180, east: 180, south: 89.25, north: 89.75 });
  // A box from 90°S to 89.99°S as a cap: to 89.99°S.
  expect(
    boxForMode(REGION_MODES.CAP, {
      west: 0,
      east: 10,
      south: -90,
      north: -89.99,
    })
  ).toMatchObject({ south: -90, north: -89.99 });
});
