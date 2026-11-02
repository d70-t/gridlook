import { describe, expect, it } from "vitest";

import {
  chooseRgbDimension,
  chooseRgbVariables,
  clampRgbChannels,
  createDefaultRgbSettings,
  getRgbDimensionOptions,
  getRgbVariableOptions,
  guessRgbVariables,
  interleaveRgba,
  mergeRgbBounds,
  resolveRgbDisplayRange,
  RGB_MAX_DIMENSION_LENGTH,
  resolveSiblingVariable,
} from "@/lib/data/rgbComposite.ts";

describe("getRgbDimensionOptions", () => {
  it("offers band-like dimensions, preferred names first", () => {
    const options = getRgbDimensionOptions(
      [
        { name: "member", startPos: 0, minBound: 0, maxBound: 3 },
        { name: "band", startPos: 0, minBound: 0, maxBound: 2 },
        { name: "level", startPos: 0, minBound: 0, maxBound: 1 },
        null,
      ],
      [{}, { current: "B04", values: ["B04", "B03", "B02"], attrs: {} }, {}, {}]
    );
    expect(options).toEqual([
      { name: "band", index: 1, labels: ["B04", "B03", "B02"] },
      { name: "member", index: 0, labels: ["0", "1", "2", "3"] },
    ]);
  });

  it("leaves out time and dimensions with many entries", () => {
    const options = getRgbDimensionOptions(
      [
        { name: "time", startPos: 0, minBound: 0, maxBound: 3 },
        { name: "t", startPos: 0, minBound: 0, maxBound: 3 },
        {
          name: "wavelength",
          startPos: 0,
          minBound: 0,
          maxBound: RGB_MAX_DIMENSION_LENGTH,
        },
        {
          name: "band",
          startPos: 0,
          minBound: 0,
          maxBound: RGB_MAX_DIMENSION_LENGTH - 1,
        },
      ],
      [{}, { current: 0, values: [0, 1, 2, 3], attrs: { axis: "T" } }, {}, {}]
    );
    expect(options.map((option) => option.name)).toEqual(["band"]);
  });

  it("returns nothing without dimension ranges", () => {
    expect(getRgbDimensionOptions(undefined, undefined)).toEqual([]);
  });
});

describe("chooseRgbDimension", () => {
  const options = [
    { name: "band", index: 1, labels: ["a", "b", "c"] },
    { name: "time", index: 0, labels: ["0", "1", "2"] },
  ];

  it("keeps a requested dimension and defaults to the first option", () => {
    expect(chooseRgbDimension(options, "time")?.name).toBe("time");
    expect(chooseRgbDimension(options)?.name).toBe("band");
  });

  it("does not replace a requested dimension the variable lacks", () => {
    expect(chooseRgbDimension(options, "wavelength")).toBeUndefined();
  });
});

it("clamps channels into the dimension", () => {
  expect(clampRgbChannels([3, 7, -1], 4)).toEqual([3, 3, 0]);
});

it("interleaves three channels into RGBA", () => {
  expect(Array.from(interleaveRgba([1, 2], [3, NaN], [5, 6]))).toEqual([
    1,
    3,
    5,
    1,
    2,
    NaN,
    6,
    1,
  ]);
  expect(() => interleaveRgba([1], [2, 3], [4])).toThrow();
});

it("merges channel bounds and resolves the display range", () => {
  const bounds = mergeRgbBounds([
    { min: 0.02, max: 0.2 },
    { min: NaN, max: NaN },
    { min: 0.01, max: 0.23 },
  ]);
  expect(bounds).toEqual({ low: 0.01, high: 0.23 });
  expect(mergeRgbBounds([{ min: NaN, max: NaN }])).toBeUndefined();

  const settings = createDefaultRgbSettings();
  expect(resolveRgbDisplayRange(settings, bounds)).toEqual(bounds);
  expect(resolveRgbDisplayRange({ ...settings, high: 0.3 }, bounds)).toEqual({
    low: 0.01,
    high: 0.3,
  });
  expect(resolveRgbDisplayRange(settings)).toEqual({ low: 0, high: 1 });
});

describe("getRgbVariableOptions", () => {
  const source = { store: "s", dataset: "d" };
  const vars = {
    "14/b02": { ...source, shape: [5] },
    "14/b03": { ...source, shape: [5] },
    "14/b04": { ...source, shape: [5] },
    "14/b8a": { ...source, shape: [5] },
    "14/cell_ids": { ...source, shape: [5], hidden: true },
    "14/scl": { ...source, shape: [2, 5] },
    "15/b04": { ...source, shape: [20] },
  };

  it("offers the variables of the current group with the same shape", () => {
    expect(getRgbVariableOptions(vars, "14/b04")).toEqual([
      "b02",
      "b03",
      "b04",
      "b8a",
    ]);
    expect(getRgbVariableOptions(vars, "15/b04")).toEqual(["b04"]);
  });
});

describe("RGB channel variables", () => {
  it("guesses red, green and blue from the names", () => {
    expect(guessRgbVariables(["b02", "b03", "b04", "b8a"])).toEqual([
      "b04",
      "b03",
      "b02",
    ]);
    expect(guessRgbVariables(["B02", "B03", "B04"])).toEqual([
      "B04",
      "B03",
      "B02",
    ]);
    expect(guessRgbVariables(["blue", "green", "red", "x"])).toEqual([
      "red",
      "green",
      "blue",
    ]);
    expect(guessRgbVariables(["a", "b", "c", "d"])).toEqual(["a", "b", "c"]);
    expect(guessRgbVariables(["a", "b"])).toBeUndefined();
  });

  it("keeps a choice only while all three are offered", () => {
    const options = ["b02", "b03", "b04", "b8a"];
    expect(chooseRgbVariables(options, ["b8a", "b04", "b03"])).toEqual([
      "b8a",
      "b04",
      "b03",
    ]);
    expect(chooseRgbVariables(options, ["b8a", "b05", "b03"])).toBeUndefined();
    expect(chooseRgbVariables(options)).toEqual(["b04", "b03", "b02"]);
  });

  it("resolves a basename in the group of the current variable", () => {
    expect(resolveSiblingVariable("14/b04", "b03")).toBe("14/b03");
    expect(resolveSiblingVariable("a/r10m/b04", "b02")).toBe("a/r10m/b02");
    expect(resolveSiblingVariable("t2m", "u10")).toBe("u10");
  });
});
