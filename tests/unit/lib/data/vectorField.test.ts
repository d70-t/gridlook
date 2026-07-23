import { describe, expect, it } from "vitest";

import {
  IrregularVectorField,
  RegularVectorField,
  detectVectorVariablePair,
  resolveVectorVariablePair,
} from "@/lib/data/vectorField.ts";

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
});

describe("resolveVectorVariablePair", () => {
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
