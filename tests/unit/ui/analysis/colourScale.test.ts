import { describe, expect, it } from "vitest";

import { getColormapScaleOffset } from "@/lib/shaders/gridShaders.ts";
import {
  extendsPast,
  HIDDEN,
  legendShades,
  paletteIndex,
  plotScale,
  shadeOf,
  type TMapColours,
} from "@/ui/analysis/colourScale.ts";

const map: TMapColours = {
  colormap: "viridis",
  invertColormap: false,
  posterizeLevels: 0,
  hideLowerBound: false,
  hideUpperBound: false,
  selection: { low: 270, high: 300 },
  varnameDisplay: "tas",
};

/** The map's fragment shader, step by step (scalarColormap + posterize). */
function shader(m: TMapColours, value: number) {
  const { low, high } = m.selection as { low: number; high: number };
  if (
    (m.hideLowerBound && value <= low) ||
    (m.hideUpperBound && value >= high)
  ) {
    return undefined;
  }
  const { addOffset, scaleFactor } = getColormapScaleOffset(
    low,
    high,
    m.invertColormap
  );
  let t = Math.min(1, Math.max(0, addOffset + scaleFactor * value));
  if (m.posterizeLevels > 1) {
    const step = Math.min(
      Math.floor(t * m.posterizeLevels),
      m.posterizeLevels - 1
    );
    t = step / (m.posterizeLevels - 1);
  }
  return t;
}

// eslint-disable-next-line max-lines-per-function
describe("a heatmap's colours are the map's", () => {
  const values = [260, 270, 271.5, 285, 299.9, 300, 310];

  it("uses the map's limits for the variable the map shows", () => {
    const scale = plotScale(map, {
      variable: "tas",
      sameSource: true,
      values: [200, 400],
    });
    expect(scale.from).toBe("map");
    // Not the plotted subset's own 200–400.
    expect([scale.low, scale.high]).toEqual([270, 300]);
  });

  it("matches the shader for every setting the map has", () => {
    for (const invertColormap of [false, true]) {
      for (const posterizeLevels of [0, 5]) {
        for (const hide of [false, true]) {
          const m = {
            ...map,
            invertColormap,
            posterizeLevels,
            hideLowerBound: hide,
            hideUpperBound: hide,
          };
          const scale = plotScale(m, {
            variable: "tas",
            sameSource: true,
            values,
          });
          for (const value of values) {
            const expected = shader(m, value);
            const got = shadeOf(scale, value);
            if (expected === undefined) {
              expect(got).toBeUndefined();
              expect(paletteIndex(scale, value)).toBe(HIDDEN);
            } else {
              expect(got).toBeCloseTo(expected, 12);
            }
          }
        }
      }
    }
  });

  it("changes with the map's limits", () => {
    const before = plotScale(map, {
      variable: "tas",
      sameSource: true,
      values,
    });
    const after = plotScale(
      { ...map, selection: { low: 280, high: 290 } },
      { variable: "tas", sameSource: true, values }
    );
    expect(paletteIndex(before, 285)).toBe(128);
    expect(paletteIndex(after, 285)).toBe(128);
    expect(paletteIndex(before, 280)).toBe(85);
    expect(paletteIndex(after, 280)).toBe(0);
  });

  it("keeps its own range, and says so, for another variable or dataset", () => {
    const other = plotScale(map, {
      variable: "pr",
      sameSource: true,
      values: [1, 3],
    });
    expect(other.from).toBe("own");
    expect([other.low, other.high]).toEqual([1, 3]);
    expect(other.note).toMatch(/map shows tas/);
    const snapshot = plotScale(map, {
      variable: "tas",
      sameSource: false,
      values: [1, 3],
    });
    expect(snapshot.from).toBe("own");
    // Before the map has loaded: its placeholder 0–0 is not a scale.
    const unloaded = plotScale(
      { ...map, selection: { low: 0, high: 0 } },
      { variable: "tas", sameSource: true, values: [1, 3] }
    );
    expect(unloaded.from).toBe("own");
  });

  it("marks ends the data reach past, and steps the legend like the map", () => {
    const scale = plotScale(
      { ...map, posterizeLevels: 3 },
      { variable: "tas", sameSource: true, values }
    );
    expect(extendsPast(scale, values)).toEqual({ below: true, above: true });
    expect(extendsPast(scale, [275, 280])).toEqual({
      below: false,
      above: false,
    });
    const shades = legendShades(scale, 6);
    expect(new Set(shades).size).toBe(3);
    expect(shades[0]).toBe(1);
    expect(shades[5]).toBe(0);
  });
});

it("keeps a cross-section's own colours whatever level the map shows", () => {
  const values = [30, 31, 32, 33.5];
  const hidden = { ...map, hideLowerBound: true, hideUpperBound: true };
  const atLevel = (low: number, high: number) =>
    plotScale(
      { ...hidden, selection: { low, high } },
      { variable: "tas", sameSource: true, values, slice: "levels" }
    );
  // Two map levels with different fitted limits: the section is unchanged.
  const [shallow, deep] = [atLevel(20, 31), atLevel(32, 40)];
  expect(shallow).toEqual(deep);
  expect([shallow.from, shallow.low, shallow.high]).toEqual(["own", 30, 33.5]);
  expect(shallow.note).toMatch(/every level/);
  expect(values.map((v) => shadeOf(shallow, v) !== undefined)).toEqual([
    true,
    true,
    true,
    true,
  ]);
  // One level, not the map's: its own range too; the map's level: the map's.
  expect(
    plotScale(map, {
      variable: "tas",
      sameSource: true,
      values,
      slice: "level",
    }).from
  ).toBe("own");
  expect(
    plotScale(map, {
      variable: "tas",
      sameSource: true,
      values,
      slice: "map",
    }).from
  ).toBe("map");
});

it("keeps a Hovmöller's own colours whatever date the map shows, unless the map's limits are fixed", () => {
  const values = [5, 6, 9];
  const at = (low: number, high: number, fixedLimits = false) =>
    plotScale(
      { ...map, selection: { low, high }, fixedLimits },
      { variable: "tas", sameSource: true, values, slice: "dates" }
    );
  expect(at(0, 6)).toEqual(at(7, 20));
  expect(at(0, 6).note).toMatch(/many dates/);
  // Limits the user fixed are the same on every date: shared.
  expect([at(0, 10, true).from, at(0, 10, true).low]).toEqual(["map", 0]);
});

it("interim49: saved custom limits count only while they are applied", async () => {
  const { customLimitsInUse } = await import("@/ui/analysis/colourScale.ts");
  // Custom 8–18 chosen: applied.
  expect(customLimitsInUse(true, 8, 18, { low: 8, high: 18 })).toBe(true);
  // Typed high below low: applied normalised.
  expect(customLimitsInUse(true, 18, 8, { low: 8, high: 18 })).toBe(true);
  // Back to Data: the typed values stay, the map's own range applies.
  expect(customLimitsInUse(true, 8, 18, { low: 4.23, high: 26.5 })).toBe(false);
  expect(customLimitsInUse(true, undefined, 18, { low: 8, high: 18 })).toBe(
    false
  );
  expect(customLimitsInUse(true, 8, 18, {})).toBe(false);
  // Data chosen: equal values are the slice's own range.
  expect(
    customLimitsInUse(false, 4.23, 26.53, { low: 4.23, high: 26.53 })
  ).toBe(false);
});
