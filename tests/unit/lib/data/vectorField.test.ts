import { describe, expect, it } from "vitest";

import {
  IrregularVectorField,
  RegularVectorField,
  detectVectorVariablePair,
  levelAxesAreIdentical,
  resolveVectorVariablePair,
} from "@/lib/data/vectorField.ts";

describe("levelAxesAreIdentical", () => {
  const pressureAxis = {
    dimensionName: "plev",
    values: [1000, 850, 700],
    units: "hPa",
  };

  it("accepts equal dimension names, ordered values, and units", () => {
    expect(levelAxesAreIdentical(pressureAxis, { ...pressureAxis })).toBe(true);
  });

  it.each([
    [{ ...pressureAxis, dimensionName: "level" }],
    [{ ...pressureAxis, values: [700, 850, 1000] }],
    [{ ...pressureAxis, units: "Pa" }],
  ])("rejects a different vertical axis", (differentAxis) => {
    expect(levelAxesAreIdentical(pressureAxis, differentAxis)).toBe(false);
  });
});

describe("detectVectorVariablePair", () => {
  it("detects u/v before ua/va", () => {
    expect(
      detectVectorVariablePair(["temperature", "va", "u", "ua", "v"])
    ).toEqual({ u: "u", v: "v", kind: "u/v" });
  });

  it("keeps paired variables in the same group", () => {
    expect(
      detectVectorVariablePair(
        ["surface/u", "surface/v", "atmosphere/ua", "atmosphere/va"],
        "atmosphere/va"
      )
    ).toEqual({
      u: "atmosphere/ua",
      v: "atmosphere/va",
      kind: "ua/va",
    });
  });

  it("does not return an incomplete pair", () => {
    expect(
      detectVectorVariablePair(["temperature", "u", "va"])
    ).toBeUndefined();
  });

  it("detects uas/vas and prefers it when one component is selected", () => {
    expect(detectVectorVariablePair(["u", "v", "uas", "vas"], "vas")).toEqual({
      u: "uas",
      v: "vas",
      kind: "uas/vas",
    });
  });

  it("detects u10/v10 components", () => {
    expect(detectVectorVariablePair(["temperature", "u10", "v10"])).toEqual({
      u: "u10",
      v: "v10",
      kind: "u10/v10",
    });
  });

  it("detects common ocean-current uo/vo components", () => {
    expect(detectVectorVariablePair(["temperature", "uo", "vo"])).toEqual({
      u: "uo",
      v: "vo",
      kind: "uo/vo",
    });
  });
});

describe("resolveVectorVariablePair groups", () => {
  it("only detects components in the selected scalar-variable group", () => {
    expect(
      resolveVectorVariablePair(
        ["surface/temperature", "atmosphere/u", "atmosphere/v"],
        "surface/temperature",
        { automatic: true }
      )
    ).toBeUndefined();

    expect(
      resolveVectorVariablePair(
        ["surface/temperature", "surface/uas", "surface/vas"],
        "surface/temperature",
        { automatic: true }
      )
    ).toEqual({
      u: "surface/uas",
      v: "surface/vas",
      kind: "uas/vas",
    });
  });

  it("rejects explicitly selected components from another group", () => {
    expect(
      resolveVectorVariablePair(
        ["surface/temperature", "ocean/uo", "ocean/vo"],
        "surface/temperature",
        {
          automatic: false,
          u: "ocean/uo",
          v: "ocean/vo",
        }
      )
    ).toBeUndefined();
  });
});

describe("resolveVectorVariablePair selection", () => {
  it("uses an explicitly selected compatible pair", () => {
    expect(
      resolveVectorVariablePair(["uo", "vo", "temperature"], "temperature", {
        automatic: false,
        u: "uo",
        v: "vo",
      })
    ).toEqual({ u: "uo", v: "vo", kind: "custom" });
  });

  it("rejects a selected variable that is not in the dataset", () => {
    expect(
      resolveVectorVariablePair(["uo"], "uo", {
        automatic: false,
        u: "uo",
        v: "vo",
      })
    ).toBeUndefined();
  });

  it("preserves an active automatic pair across scalar-variable changes", () => {
    expect(
      resolveVectorVariablePair(
        ["atmosphere/u", "atmosphere/v", "ocean/uo", "ocean/vo"],
        "ocean/temperature",
        { automatic: true },
        { u: "atmosphere/u", v: "atmosphere/v", kind: "u/v" }
      )
    ).toEqual({ u: "atmosphere/u", v: "atmosphere/v", kind: "u/v" });
  });

  it("replaces the active pair when components are selected explicitly", () => {
    expect(
      resolveVectorVariablePair(
        ["u", "v", "uo", "vo"],
        "temperature",
        { automatic: false, u: "uo", v: "vo" },
        { u: "u", v: "v", kind: "u/v" }
      )
    ).toEqual({ u: "uo", v: "vo", kind: "custom" });
  });
});

describe("IrregularVectorField", () => {
  it("interpolates unstructured component samples", () => {
    const field = new IrregularVectorField(
      new Float32Array([-1, -1, 1, 1]),
      new Float32Array([-1, 1, -1, 1]),
      new Float32Array([2, 4, 6, 8]),
      new Float32Array([8, 6, 4, 2])
    );

    expect(field.sample(-1, -1)?.u).toBeCloseTo(2);
    expect(field.sample(-1, -1)?.v).toBeCloseTo(8);
    expect(field.sample(0, 0)?.u).toBeCloseTo(5, 1);
  });

  it("advances through a steady unstructured field", () => {
    const field = new IrregularVectorField(
      new Float32Array([-5, -5, 5, 5]),
      new Float32Array([-5, 5, -5, 5]),
      new Float32Array(4).fill(10),
      new Float32Array(4).fill(0)
    );

    const next = field.advance(0, 0, 0.1);
    expect(next?.latitude).toBeCloseTo(0);
    expect(next?.longitude).toBeGreaterThan(0);
  });

  it("seeds by geographic area instead of native-cell order", () => {
    const field = new IrregularVectorField(
      new Float32Array([-5, -5, 5, 5]),
      new Float32Array([-5, 5, -5, 5]),
      new Float32Array(4).fill(1),
      new Float32Array(4).fill(1)
    );
    const randomValues = [0.5, 0.5];

    const seed = field.randomPosition(() => randomValues.shift()!);

    expect(seed.latitude).toBeCloseTo(0);
    expect(seed.longitude).toBeCloseTo(0);
  });
});

describe("RegularVectorField", () => {
  it("bilinearly samples ascending axes", () => {
    const field = new RegularVectorField(
      new Float32Array([0, 10]),
      new Float32Array([0, 10]),
      new Float32Array([0, 10, 20, 30]),
      new Float32Array([30, 20, 10, 0])
    );

    expect(field.sample(5, 5)).toEqual({
      u: 15,
      v: 15,
      speed: Math.hypot(15, 15),
    });
  });

  it("samples descending latitude and across a global longitude seam", () => {
    const field = new RegularVectorField(
      new Float32Array([10, 0]),
      new Float32Array([0, 120, 240]),
      new Float32Array([10, 20, 30, 40, 50, 60]),
      new Float32Array([1, 1, 1, 1, 1, 1])
    );

    expect(field.isGlobal).toBe(true);
    expect(field.sample(10, -60)?.u).toBeCloseTo(20);
    expect(field.sample(0, 300)?.u).toBeCloseTo(50);
  });

  it("advances eastward without introducing time dependence", () => {
    const field = new RegularVectorField(
      new Float32Array([-10, 10]),
      new Float32Array([-180, -60, 60]),
      new Float32Array(6).fill(10),
      new Float32Array(6).fill(0)
    );

    const next = field.advance(0, 0, 0.1);
    expect(next?.latitude).toBeCloseTo(0);
    expect(next?.longitude).toBeGreaterThan(0);
  });

  it("rejects missing component values", () => {
    const field = new RegularVectorField(
      new Float32Array([0, 10]),
      new Float32Array([0, 10]),
      new Float32Array([1, NaN, 1, 1]),
      new Float32Array([1, 1, 1, 1])
    );
    expect(field.sample(5, 5)).toBeUndefined();
  });
});

describe("RegularVectorField regional coordinates", () => {
  it.each([
    { longitudes: [265, 292.5, 320], u: [2, 4, 6, 8, 10, 12] },
    { longitudes: [320, 292.5, 265], u: [6, 4, 2, 12, 10, 8] },
  ])(
    "samples and advances regional 0–360 axes: $longitudes",
    ({ longitudes, u }) => {
      // Florence uses descending latitude and longitudes from 265 to 320.
      const field = new RegularVectorField(
        new Float32Array([45, 15]),
        new Float32Array(longitudes),
        new Float32Array(u),
        new Float32Array(6).fill(1)
      );

      expect(field.isGlobal).toBe(false);
      expect(field.sample(30, -81.25)?.u).toBeCloseTo(6);
      expect(field.sample(30, -81.25)).toEqual(field.sample(30, 278.75));
      const next = field.advance(30, 278.75, 0.025);
      expect(next?.longitude).toBeGreaterThan(278.75);
      expect(next?.latitude).toBeGreaterThan(30);
      expect(field.advance(30, -81.25, 0.025)?.longitude).toBeCloseTo(
        next!.longitude
      );

      expect(field.sample(30, -96)).toBeUndefined();
      expect(field.sample(30, -39)).toBeUndefined();
      expect(field.advance(30, 319.99, 0.025)).toBeUndefined();
      expect(field.advance(30, 265.01, -0.025)).toBeUndefined();
    }
  );

  it("keeps regional paths continuous across the antimeridian", () => {
    const field = new RegularVectorField(
      new Float32Array([-10, 10]),
      new Float32Array([170, 180, 190]),
      new Float32Array(6).fill(10),
      new Float32Array(6).fill(0)
    );

    const next = field.advance(0, 179.9, 0.025);
    expect(next?.longitude).toBeGreaterThan(180);
    expect(field.sample(0, -179)?.u).toBe(10);
    expect(
      field.advance(next!.latitude, next!.longitude, 0.025)?.longitude
    ).toBeGreaterThan(next!.longitude);
    expect(field.sample(0, -169)).toBeUndefined();
  });
});

describe("RegularVectorField seeding", () => {
  it("distributes random positions uniformly by spherical area", () => {
    const field = new RegularVectorField(
      new Float32Array([-60, 60]),
      new Float32Array([0, 180]),
      new Float32Array(4).fill(1),
      new Float32Array(4).fill(1)
    );

    const randomValues = [0.25, 0.5];
    const position = field.randomPosition(() => randomValues.shift()!);
    const expectedLatitude =
      (Math.asin(-Math.sin(Math.PI / 3) / 2) * 180) / Math.PI;

    expect(position.latitude).toBeCloseTo(expectedLatitude);
    expect(position.longitude).toBe(-180);
  });
});

describe("slow vector-field flow", () => {
  it("preserves slow velocity magnitude without a regional speed floor", () => {
    const field = new RegularVectorField(
      new Float32Array([-10, 10]),
      new Float32Array([-180, -60, 60]),
      new Float32Array([100, 0.1, 0.1, 100, 0.1, 0.1]),
      new Float32Array(6).fill(0)
    );

    const next = field.advance(0, 0, 0.1);
    expect(next?.longitude).toBeGreaterThan(0);
    expect(next?.longitude).toBeLessThan(0.005);
  });
});
