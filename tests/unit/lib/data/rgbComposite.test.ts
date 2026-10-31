import { describe, expect, it } from "vitest";

import {
  chooseRgbDimension,
  clampRgbChannels,
  createDefaultRgbSettings,
  getRgbDimensionOptions,
  interleaveRgba,
  mergeRgbBounds,
  resolveRgbDisplayRange,
} from "@/lib/data/rgbComposite.ts";

describe("getRgbDimensionOptions", () => {
  it("offers non-spatial dimensions with three or more entries, bands first", () => {
    const options = getRgbDimensionOptions(
      [
        { name: "time", startPos: 0, minBound: 0, maxBound: 788 },
        { name: "band", startPos: 0, minBound: 0, maxBound: 2 },
        { name: "level", startPos: 0, minBound: 0, maxBound: 1 },
        null,
      ],
      [{}, { current: "B04", values: ["B04", "B03", "B02"], attrs: {} }, {}, {}]
    );
    expect(options).toEqual([
      { name: "band", index: 1, labels: ["B04", "B03", "B02"] },
      {
        name: "time",
        index: 0,
        labels: Array.from({ length: 789 }, (_, i) => String(i)),
      },
    ]);
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
