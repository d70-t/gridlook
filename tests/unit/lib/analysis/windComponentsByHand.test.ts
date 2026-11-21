/* eslint-disable camelcase -- variable names as datasets spell them. */
/**
 * 25 Nov: CIOFS (ROMS on a regular grid) stores its currents as
 * `u_eastward` and `v_northward` in "meter second-1", beside `salt`,
 * `temp` and `zeta`, in each `multiscale/N` group. They had no barbs:
 * neither the names nor the units were recognized.
 */
import { describe, expect, it } from "vitest";

import {
  guessComponents,
  speedFactor,
  windPairs,
} from "@/lib/analysis/windPair.ts";
import { isCurrentPair, oceanVertical } from "@/store/analysisStore.ts";

const CIOFS: Record<string, { units?: string; standardName?: string }> = {};
for (const group of ["multiscale/0/", "multiscale/2/"]) {
  CIOFS[`${group}salt`] = { units: "1e-3" };
  CIOFS[`${group}temp`] = { units: "Celsius" };
  CIOFS[`${group}zeta`] = { units: "meter" };
  CIOFS[`${group}u_eastward`] = { units: "meter second-1" };
  CIOFS[`${group}v_northward`] = { units: "meter second-1" };
}

describe("components with ROMS names and units", () => {
  it("reads UDUNITS words as a speed", () => {
    expect(speedFactor("meter second-1")).toBe(1);
    expect(speedFactor("metres second-1")).toBe(1);
    expect(speedFactor("centimeter second-1")).toBe(0.01);
  });

  it("pairs u_eastward with v_northward in the plotted group, as a current", () => {
    const { pairs } = windPairs(CIOFS, "multiscale/2/salt");
    expect(pairs[0]).toMatchObject({
      u: "multiscale/2/u_eastward",
      v: "multiscale/2/v_northward",
    });
    // No standard names: salinity beside them makes them a current,
    // drawn going towards (not a wind, coming from).
    expect(isCurrentPair(pairs[0], CIOFS)).toBe(true);
  });

  it("keeps a wind a wind, and standard names first", () => {
    const air: Record<string, { units?: string; standardName?: string }> = {
      u_eastward: { units: "m s-1" },
      v_northward: { units: "m s-1" },
      tas: { units: "K" },
    };
    const [pair] = windPairs(air, "tas").pairs;
    expect(isCurrentPair(pair, air)).toBe(false);
    // Standard names that say wind win over salinity beside them.
    const said = {
      ...CIOFS,
      "multiscale/2/u_eastward": {
        units: "m s-1",
        standardName: "eastward_wind",
      },
      "multiscale/2/v_northward": {
        units: "m s-1",
        standardName: "northward_wind",
      },
    };
    expect(
      isCurrentPair(
        { u: "multiscale/2/u_eastward", v: "multiscale/2/v_northward" },
        said
      )
    ).toBe(false);
  });
});

describe("components no rule recognizes", () => {
  const odd = {
    "ocean/ue": { units: "m s-1" },
    "ocean/vn": { units: "m s-1" },
    "ocean/salt": {},
    "air/tas": { units: "K" },
  };

  it("are not paired by themselves", () => {
    expect(windPairs(odd, "ocean/salt").pairs).toEqual([]);
  });

  it("are guessed for the picker, in the plotted group, as speeds", () => {
    expect(guessComponents(odd, "ocean/salt")).toEqual({
      u: "ocean/ue",
      v: "ocean/vn",
    });
    // Not a speed: no guess.
    expect(
      guessComponents(
        { a_east: { units: "K" }, a_north: { units: "K" } },
        "a_east"
      )
    ).toBeUndefined();
  });
});

describe("ocean data by its depth axis (25 Nov: Currents, not Barbs)", () => {
  const depth = {
    dimension: "Depth",
    kind: "physical",
    units: "m",
    positive: "down" as const,
  };
  const pressure = {
    dimension: "plev",
    kind: "physical",
    units: "hPa",
    positive: "down" as const,
  };

  it("knows a depth axis from a pressure axis", () => {
    expect(oceanVertical(depth)).toBe(true);
    expect(oceanVertical({ ...depth, dimension: "z", units: "metres" })).toBe(
      true
    );
    expect(
      oceanVertical({
        dimension: "lev",
        kind: "formula",
        standardName: "ocean_s_coordinate_g2",
      })
    ).toBe(true);
    expect(oceanVertical(pressure)).toBe(false);
    expect(oceanVertical(undefined)).toBe(false);
  });

  it("makes u and v without standard names a current on a depth axis", () => {
    const plain: Record<string, { units?: string; standardName?: string }> = {
      u: { units: "m s-1" },
      v: { units: "m s-1" },
    };
    expect(isCurrentPair({ u: "u", v: "v" }, plain, true)).toBe(true);
    expect(isCurrentPair({ u: "u", v: "v" }, plain, false)).toBe(false);
    // Standard names that say wind win over the depth axis.
    const wind = {
      u: { standardName: "eastward_wind" },
      v: { standardName: "northward_wind" },
    };
    expect(isCurrentPair({ u: "u", v: "v" }, wind, true)).toBe(false);
  });
});

it("independent review of interim41: a speed and a vertical velocity are no horizontal pair", async () => {
  const { contradicted } = await import("@/lib/analysis/windPair.ts");
  const pair = { u: "u", v: "v" } as never;
  for (const names of [
    ["wind_speed", "upward_air_velocity"],
    ["northward_wind", "wind_speed"],
  ]) {
    expect(
      contradicted(
        { u: { standardName: names[0] }, v: { standardName: names[1] } },
        pair
      )
    ).toMatch(/not an eastward or northward component/);
  }
  // Names spelled otherwise still pass by their variable names.
  expect(
    contradicted(
      {
        u: { standardName: "u-component of wind" },
        v: { standardName: "v-component of wind" },
      },
      pair
    )
  ).toBeUndefined();
});
