import { describe, expect, it } from "vitest";

import {
  CAMERA_VERTICAL_FOV_DEGREES,
  EARTH_RADIUS_METERS,
} from "@/lib/camera/cameraSettings.ts";
import {
  coarsestLevel,
  currentLevel,
  DEFAULT_HYSTERESIS_ORDERS,
  DEFAULT_MAX_LEVEL_CELLS,
  DEFAULT_PIXELS_PER_CELL,
  exceedsCellCap,
  groundMetersPerPixel,
  selectLevel,
  type TLevelSelectionCamera,
} from "@/lib/data/levels.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";

// HEALPix cell size halves per order: sqrt(4π / (12 · 4^order)) radians.
function resolution(order: number) {
  return (EARTH_RADIUS_METERS * Math.sqrt(Math.PI / 3)) / 2 ** order;
}

function healpixLevel(order: number) {
  return { resolution: resolution(order), cellCount: 12 * 4 ** order };
}

const VIEWPORT_HEIGHT_PX = 1000;

/** The camera at which one cell of `targetMeters` spans the target pixels. */
function cameraFor(targetMeters: number): TLevelSelectionCamera {
  const halfFov = (CAMERA_VERTICAL_FOV_DEGREES * Math.PI) / 360;
  return {
    altitudeMeters:
      (targetMeters * VIEWPORT_HEIGHT_PX) /
      (2 * DEFAULT_PIXELS_PER_CELL * Math.tan(halfFov)),
    viewportHeightPx: VIEWPORT_HEIGHT_PX,
  };
}

// Orders 10..4, finest first, as a multiscales pyramid lists them.
const LADDER = [10, 9, 8, 7, 6, 5, 4].map(healpixLevel);
const ORDER_8 = 2;
const ORDER_7 = 3;

describe("currentLevel", () => {
  const sources: TSources = {
    zarr_format: ZARR_FORMAT.V3, // eslint-disable-line camelcase
    levels: [
      {
        grid: { store: "s", dataset: "0" },
        time: { store: "s", dataset: "0" },
        datasources: {},
      },
      {
        grid: { store: "s", dataset: "1" },
        time: { store: "s", dataset: "1" },
        datasources: {},
      },
    ],
  };

  it("reads the first level while nothing is selected", () => {
    expect(currentLevel(sources)).toBe(sources.levels[0]);
  });

  it("reads the selected level", () => {
    expect(currentLevel({ ...sources, selectedLevel: 1 })).toBe(
      sources.levels[1]
    );
  });
});

describe("groundMetersPerPixel", () => {
  it("scales with the camera height and the field of view", () => {
    const halfFov = (CAMERA_VERTICAL_FOV_DEGREES * Math.PI) / 360;
    const oneRadiusUp = {
      altitudeMeters: EARTH_RADIUS_METERS,
      viewportHeightPx: 1000,
    };
    expect(groundMetersPerPixel(oneRadiusUp)).toBeCloseTo(
      (2 * EARTH_RADIUS_METERS * Math.tan(halfFov)) / 1000,
      6
    );
    expect(
      groundMetersPerPixel({
        ...oneRadiusUp,
        altitudeMeters: 2 * EARTH_RADIUS_METERS,
      })
    ).toBeCloseTo(2 * groundMetersPerPixel(oneRadiusUp), 6);
    expect(
      groundMetersPerPixel({ ...oneRadiusUp, fovDegrees: 15 })
    ).toBeGreaterThan(groundMetersPerPixel(oneRadiusUp));
  });

  it("stays finite at the surface and on a zero-height viewport", () => {
    expect(
      groundMetersPerPixel({ altitudeMeters: 0, viewportHeightPx: 1000 })
    ).toBeGreaterThan(0);
    expect(
      Number.isFinite(
        groundMetersPerPixel({ altitudeMeters: 1e6, viewportHeightPx: 0 })
      )
    ).toBe(true);
  });
});

describe("selectLevel", () => {
  it("picks the level nearest the target in log2 cell size", () => {
    expect(selectLevel(cameraFor(resolution(8)), LADDER, 0)).toBe(ORDER_8);
    // the same pick from a measured ground scale instead of a camera
    expect(
      selectLevel(resolution(8) / DEFAULT_PIXELS_PER_CELL, LADDER, 0)
    ).toBe(ORDER_8);
    // Slightly finer than the geometric midpoint rounds to the finer level.
    expect(selectLevel(cameraFor(resolution(7.6)), LADDER, 0)).toBe(ORDER_8);
    expect(selectLevel(cameraFor(resolution(7.4)), LADDER, 0)).toBe(ORDER_7);
  });

  it("clamps to the ends of the ladder", () => {
    expect(selectLevel(cameraFor(resolution(20)), LADDER, 3)).toBe(0);
    expect(selectLevel(cameraFor(resolution(0)), LADDER, 3)).toBe(
      LADDER.length - 1
    );
  });

  it("keeps the active level until a better fit clears the hysteresis", () => {
    // The switch point sits half the hysteresis past the midpoint.
    const inside = DEFAULT_HYSTERESIS_ORDERS / 2 - 0.02;
    const outside = DEFAULT_HYSTERESIS_ORDERS / 2 + 0.02;
    // Zooming out from order 8 …
    expect(
      selectLevel(cameraFor(resolution(7.5 - inside)), LADDER, ORDER_8)
    ).toBe(ORDER_8);
    expect(
      selectLevel(cameraFor(resolution(7.5 - outside)), LADDER, ORDER_8)
    ).toBe(ORDER_7);
    // … and zooming in from order 7 are symmetric.
    expect(
      selectLevel(cameraFor(resolution(7.5 + inside)), LADDER, ORDER_7)
    ).toBe(ORDER_7);
    expect(
      selectLevel(cameraFor(resolution(7.5 + outside)), LADDER, ORDER_7)
    ).toBe(ORDER_8);
  });

  it("honours a custom hysteresis", () => {
    expect(
      selectLevel(cameraFor(resolution(7.4)), LADDER, ORDER_8, {
        hysteresisOrders: 0,
      })
    ).toBe(ORDER_7);
    expect(
      selectLevel(cameraFor(resolution(7.1)), LADDER, ORDER_8, {
        hysteresisOrders: 1,
      })
    ).toBe(ORDER_8);
  });
});

describe("selectLevel limits", () => {
  it("never picks a level with more cells than the cap", () => {
    const deep = [12, 11, 10, 9].map(healpixLevel);
    expect(DEFAULT_MAX_LEVEL_CELLS).toBe(12 * 4 ** 10);
    // The finest eligible level wins even from an ineligible active level.
    expect(selectLevel(cameraFor(resolution(12)), deep, 0)).toBe(2);
    expect(
      selectLevel(cameraFor(resolution(12)), deep, 0, {
        maxCells: 12 * 4 ** 12,
      })
    ).toBe(0);
    // Without a recorded count the estimate over-counts HEALPix (by π), so
    // order 10 (≈ 39.5 M estimated) is left out and order 9 (≈ 9.9 M) is kept.
    const unknownCounts = deep.map(({ resolution }) => ({ resolution }));
    expect(selectLevel(cameraFor(resolution(12)), unknownCounts, 0)).toBe(3);
  });

  it("over-counts levels whose cell count is unknown", () => {
    // A global 1/16° lat/lon level holds 5760 × 2880 ≈ 16.6 M cells, over the
    // cap; the next coarser 1/8° level (≈ 4.1 M) is eligible.
    const degree = (Math.PI / 180) * EARTH_RADIUS_METERS;
    const latLon = [1 / 16, 1 / 8].map((step) => ({
      resolution: step * degree,
    }));
    expect(selectLevel(cameraFor(degree / 16), latLon, 0)).toBe(1);
    // WebMercatorQuad zoom 4 holds (256 · 2⁴)² ≈ 16.8 M pixels; zoom 3 fits.
    const zoom = (z: number) => ({ resolution: 156543.03392804097 / 2 ** z });
    expect(
      selectLevel(cameraFor(zoom(4).resolution), [zoom(4), zoom(3)], 0)
    ).toBe(1);
  });

  it("counts the cells a sparse level stores, not the full sphere", () => {
    // A regional pyramid at orders 16..12 holding 2 million cells per level.
    const regional = [16, 15, 14, 13, 12].map((order) => ({
      resolution: resolution(order),
      cellCount: 2_000_000,
    }));
    expect(selectLevel(cameraFor(resolution(16)), regional, 4)).toBe(0);
  });

  it("flags the levels selection leaves out, estimated or counted", () => {
    expect(exceedsCellCap(healpixLevel(11))).toBe(true);
    expect(exceedsCellCap(healpixLevel(10))).toBe(false);
    // Order 10 without a count is estimated over the cap, as selectLevel does.
    expect(exceedsCellCap({ resolution: resolution(10) })).toBe(true);
    expect(exceedsCellCap({})).toBe(false);
  });

  it("falls back to the coarsest level when nothing fits the renderer", () => {
    const tooFine = [12, 11].map(healpixLevel);
    expect(selectLevel(cameraFor(resolution(12)), tooFine, 0)).toBe(1);
  });

  it("changes nothing for a single level or levels without a resolution", () => {
    expect(selectLevel(cameraFor(resolution(4)), [healpixLevel(8)], 0)).toBe(0);
    expect(
      selectLevel(cameraFor(resolution(8)), [{}, healpixLevel(8)], 0)
    ).toBe(0);
    expect(selectLevel(cameraFor(resolution(8)), [], 0)).toBe(0);
  });
});

it("names the coarsest level, when every level states its resolution", () => {
  expect(
    coarsestLevel([
      { resolution: 100 },
      { resolution: 400 },
      { resolution: 200 },
    ])
  ).toBe(1);
  expect(coarsestLevel([{ resolution: 100 }])).toBeUndefined();
  expect(coarsestLevel([{ resolution: 100 }, {}])).toBeUndefined();
});
