import { describe, expect, it } from "vitest";

import {
  calculateVectorMagnitude,
  getVectorMagnitudeBounds,
  resolveCfVectorMagnitude,
  resolveVectorMagnitude,
} from "@/lib/data/vectorMagnitude.ts";

function cfAttrs(standardName: string, units = "m s-1") {
  return { ["standard_name"]: standardName, units };
}

describe("vector magnitude", () => {
  it("computes wind speed while preserving missing component values", () => {
    const data = calculateVectorMagnitude(
      new Float32Array([3, 5, NaN]),
      new Float32Array([4, 12, 2])
    );

    expect(Array.from(data)).toEqual([5, 13, NaN]);
    expect(getVectorMagnitudeBounds(data)).toEqual({ min: 5, max: 13 });
  });

  it("returns NaN bounds when no finite samples exist", () => {
    const bounds = getVectorMagnitudeBounds(
      new Float32Array([NaN, Number.POSITIVE_INFINITY])
    );

    expect(bounds.min).toBeNaN();
    expect(bounds.max).toBeNaN();
  });

  it("rejects component arrays with different lengths", () => {
    expect(() =>
      calculateVectorMagnitude(new Float32Array(1), new Float32Array(2))
    ).toThrow("different data lengths");
  });
});

describe("CF vector magnitudes", () => {
  it.each([
    ["eastward_wind", "northward_wind", "wind_speed", "Wind speed"],
    [
      "eastward_sea_water_velocity",
      "northward_sea_water_velocity",
      "sea_water_speed",
      "Sea water speed",
    ],
    [
      "sea_ice_x_velocity",
      "sea_ice_y_velocity",
      "sea_ice_speed",
      "Sea ice speed",
    ],
  ])("maps %s and %s to %s", (u, v, standardName, longName) => {
    expect(resolveCfVectorMagnitude(cfAttrs(u), cfAttrs(v))).toEqual({
      standardName,
      longName,
      units: "m s-1",
    });
  });

  it("accepts CF grid-relative wind aliases", () => {
    expect(
      resolveCfVectorMagnitude(
        cfAttrs("grid_eastward_wind"),
        cfAttrs("grid_northward_wind")
      )?.standardName
    ).toBe("wind_speed");
  });

  it("does not invent a CF name for an unlisted directional pair", () => {
    const u = cfAttrs("eastward_water_vapor_flux", "kg m-1 s-1");
    const v = cfAttrs("northward_water_vapor_flux", "kg m-1 s-1");

    expect(resolveCfVectorMagnitude(u, v)).toBeUndefined();
    expect(resolveVectorMagnitude(u, v)).toEqual({
      longName: "Vector magnitude",
      units: "kg m-1 s-1",
    });
  });

  it.each([
    [{ units: "m s-1" }, { units: "m s-1" }],
    [cfAttrs("eastward_wind"), cfAttrs("northward_wind", "kn")],
    [cfAttrs("eastward_wind"), cfAttrs("northward_sea_water_velocity")],
  ])("rejects incompatible component metadata", (u, v) => {
    expect(resolveCfVectorMagnitude(u, v)).toBeUndefined();
  });
});

describe("generic vector magnitudes", () => {
  it("falls back to a generic magnitude for equal component units", () => {
    expect(
      resolveVectorMagnitude(
        { ["long_name"]: "Horizontal component", units: "kg m-1 s-1" },
        { ["long_name"]: "Vertical component", units: "kg m-1 s-1" }
      )
    ).toEqual({ longName: "Vector magnitude", units: "kg m-1 s-1" });
  });

  it("does not derive a generic magnitude from incompatible units", () => {
    expect(
      resolveVectorMagnitude({ units: "m s-1" }, { units: "kg s-1" })
    ).toBeUndefined();
  });
});
