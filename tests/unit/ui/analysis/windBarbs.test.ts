import { describe, expect, it } from "vitest";

import { windPairs } from "@/lib/analysis/windPair.ts";
import {
  barbParts,
  drawBarb,
  knotsPer,
  thinned,
  windFrom,
  windText,
} from "@/ui/analysis/windBarbs.ts";

// eslint-disable-next-line max-lines-per-function
describe("wind barbs", () => {
  it("counts pennants, full and half barbs to the nearest 5 knots", () => {
    expect(barbParts(2)).toMatchObject({ pennants: 0, full: 0, half: 0 });
    expect(barbParts(5)).toMatchObject({ pennants: 0, full: 0, half: 1 });
    expect(barbParts(17)).toMatchObject({ pennants: 0, full: 1, half: 1 });
    expect(barbParts(64)).toMatchObject({ pennants: 1, full: 1, half: 1 });
    expect(barbParts(103)).toMatchObject({ pennants: 2, full: 0, half: 1 });
  });

  it("gives the direction the wind blows from", () => {
    expect(windFrom(10, 0)).toBe(270); // westerly
    expect(windFrom(0, -10)).toBe(0); // northerly
    expect(windFrom(0, 10)).toBe(180);
    expect(windFrom(-10, 0)).toBe(90);
  });

  it("puts the wind in words for the readout", () => {
    expect(windText(-5, -5, "m s-1")).toBe(
      "Wind 14 kn (7.1 m s-1) from 45° (NE)"
    );
    expect(windText(10, 0, "knots")).toBe("Wind 10 kn from 270° (W)");
    expect(windText(0.5, 0.5, "m s-1")).toBe("Wind calm (0.7 m s-1)");
    expect(windText(Number.NaN, 1)).toBeUndefined();
  });

  it("converts speed units to knots, assuming m s-1 when unknown", () => {
    expect(knotsPer("m s-1").factor).toBeCloseTo(1.9438, 4);
    expect(knotsPer("m/s").assumed).toBeUndefined();
    expect(knotsPer("knots").factor).toBe(1);
    expect(knotsPer("km h-1").factor).toBeCloseTo(0.54, 2);
    expect(knotsPer("furlongs")).toMatchObject({ assumed: true });
    expect(100 * knotsPer("cm s^-1").factor).toBeCloseTo(1.944, 3);
    expect(knotsPer("m s**-1").assumed).toBeUndefined();
  });

  it("keeps real samples at least a gap apart, in axis order", () => {
    expect(thinned([0, 10, 20, 30, 40, 50], 25)).toEqual([0, 3]);
    expect(thinned([52, Number.NaN, 0, 26], 25)).toEqual([2, 3, 0]);
  });

  it("pairs eastward and northward components; refuses grid-relative ones", () => {
    const both = windPairs(
      { tas: {}, ua: {}, va: {}, uas: {}, vas: {} },
      "tas"
    );
    // Every candidate, so the one at the plot's level can be chosen.
    expect(both.pairs.map((p) => `${p.u}/${p.v}`)).toEqual([
      "ua/va",
      "uas/vas",
    ]);
    expect(windPairs({ tas: {} }, "tas")).toEqual({ pairs: [] });
    // Several pairs: other spellings too, the plotted variable's own first.
    const many = {
      tas: {},
      u10: {},
      v10: {},
      u100: {},
      v100: {},
      U10M: {},
      V10M: {},
    };
    expect(windPairs(many, "tas").pairs.map((p) => `${p.u}/${p.v}`)).toEqual([
      "u10/v10",
      "u100/v100",
      "U10M/V10M",
    ]);
    expect(windPairs(many, "u100").pairs[0]).toMatchObject({
      u: "u100",
      v: "v100",
    });
    // A name that only looks like a pair, but is not wind by standard name.
    expect(
      windPairs(
        { uice: { standardName: "sea_ice_x_velocity" }, vice: {} },
        "uice"
      ).pairs
    ).toEqual([]);
    const rotated = windPairs(
      { u: { standardName: "x_wind" }, v: { standardName: "y_wind" } },
      "u"
    );
    expect(rotated.pairs).toEqual([]);
    expect(rotated.reason).toMatch(/grid's own axes/);
  });

  it("refuses components whose units are no speed (review of interim8)", () => {
    const stress = windPairs(
      { u: { units: "N m-2" }, v: { units: "N m-2" } },
      "u"
    );
    expect(stress.pairs).toEqual([]);
    expect(stress.reason).toMatch(/N m-2, not a speed/);
    for (const units of ["m s-1", "m/s", "cm s-1", "km/h", "knots"]) {
      expect(windPairs({ u: { units }, v: { units } }, "u").pairs).toHaveLength(
        1
      );
    }
    // Undeclared units are taken as m s-1, as before.
    expect(windPairs({ u: {}, v: {} }, "u").pairs).toHaveLength(1);
  });

  it("draws the staff upwind, barbs clockwise of it in the north", () => {
    const lines: number[][] = [];
    let path: number[] = [];
    const context = {
      save() {},
      restore() {},
      beginPath() {
        path = [];
      },
      moveTo(x: number, y: number) {
        path.push(x, y);
      },
      lineTo(x: number, y: number) {
        path.push(x, y);
      },
      stroke() {
        lines.push(path);
      },
      fill() {},
      closePath() {},
      arc() {},
    } as unknown as CanvasRenderingContext2D;
    // A 10-knot westerly: the staff points west (left) from the station,
    // its barb north (up, smaller y) in the Northern Hemisphere.
    drawBarb(context, 100, 100, 10, 0, {
      length: 20,
      color: "#000",
      flip: false,
    });
    expect(lines[0]).toEqual([100, 100, 80, 100]);
    expect(lines[1][3]).toBeLessThan(lines[1][1]);
    lines.length = 0;
    drawBarb(context, 100, 100, 10, 0, {
      length: 20,
      color: "#000",
      flip: true,
    });
    expect(lines[1][3]).toBeGreaterThan(lines[1][1]);
  });
});

describe("currents drawn as arrows (25 Nov)", () => {
  it("points where the water goes, its length by speed", async () => {
    const { drawArrow, largestSpeed } =
      await import("@/ui/analysis/windBarbs.ts");
    const lines: number[][] = [];
    let path: number[] = [];
    const context = {
      save() {},
      restore() {},
      beginPath() {
        path = [];
      },
      moveTo(x: number, y: number) {
        path.push(x, y);
      },
      lineTo(x: number, y: number) {
        path.push(x, y);
      },
      stroke() {
        lines.push(path);
      },
      fill() {},
      arc() {},
      globalAlpha: 1,
    } as unknown as CanvasRenderingContext2D;
    // 0.5 m/s north-east beside 0.25 m/s east: no calm circles.
    const most = largestSpeed(
      [0.5 * Math.SQRT1_2, 0.25],
      [0.5 * Math.SQRT1_2, 0]
    );
    expect(most).toBeCloseTo(0.5);
    drawArrow(context, 100, 100, 0.5 * Math.SQRT1_2, 0.5 * Math.SQRT1_2, most, {
      length: 20,
      color: "#000",
    });
    // The shaft runs up and right (north-east), 20 px.
    const [x0, y0, x1, y1] = lines[0];
    expect([x0, y0]).toEqual([100, 100]);
    expect(x1 - x0).toBeCloseTo(20 * Math.SQRT1_2);
    expect(y1 - y0).toBeCloseTo(-20 * Math.SQRT1_2);
    lines.length = 0;
    drawArrow(context, 100, 100, 0.25, 0, most, { length: 20, color: "#000" });
    expect(lines[0].slice(0, 4)).toEqual([100, 100, 110, 100]);
  });
});

describe("wind rose", () => {
  it("bins winds by the direction they come from, currents by where they go", async () => {
    const { roseOf } = await import("@/ui/analysis/windFigures.ts");
    // Two westerlies (from 270°) and one calm, in m s-1.
    const wind = roseOf([5, 7, 0.1], [0, 0, 0], "m s-1", false);
    expect(wind.n).toBe(3);
    expect(wind.calm).toBeCloseTo(100 / 3);
    const west = wind.sectors[12];
    expect(west.reduce((a, b) => a + b, 0)).toBeCloseTo(200 / 3);
    // 5 m s-1 in the 4–6 class, 7 in 6–8.
    expect(west[2]).toBeCloseTo(100 / 3);
    expect(west[3]).toBeCloseTo(100 / 3);
    // A current flowing east is drawn towards the east (90°).
    const current = roseOf([0.3], [0], "m s-1", true);
    expect(current.sectors[4].reduce((a, b) => a + b, 0)).toBe(100);
    expect(current.convention).toBe("towards");
  });

  it("keeps the legend's calm share and sample count on separate lines", async () => {
    const { drawRose, roseOf } = await import("@/ui/analysis/windFigures.ts");
    const texts: string[] = [];
    const noop = () => {};
    const context = new Proxy(
      { fillText: (text: string) => texts.push(text) },
      {
        get: (target, key) =>
          key in target ? target[key as keyof typeof target] : noop,
        set: () => true,
      }
    ) as unknown as CanvasRenderingContext2D;
    const rose = roseOf([5, 7, 0.1], [0, 0, 0], "m s-1", false);
    drawRose(context, 600, 400, rose, {
      fg: "#000",
      muted: "#666",
      grid: "#ccc",
      ramp: ["#00f"],
    });
    expect(texts).toContain("calm 33 %");
    expect(texts).toContain("3 samples");
  });
});

// eslint-disable-next-line max-lines-per-function
describe("v24 review: extreme winds draw in bounded time", () => {
  /** A canvas that counts drawing calls. */
  function counting() {
    const calls = { fill: 0, stroke: 0, arc: 0 };
    const count = (name: keyof typeof calls) => () => {
      calls[name]++;
    };
    const noop = () => undefined;
    const context = {
      fill: count("fill"),
      stroke: count("stroke"),
      arc: count("arc"),
      measureText: () => ({ width: 10 }),
      setLineDash: noop,
      getLineDash: () => [],
      save: noop,
      restore: noop,
      beginPath: noop,
      closePath: noop,
      moveTo: noop,
      lineTo: noop,
      fillText: noop,
      strokeText: noop,
      translate: noop,
      rotate: noop,
      fillRect: noop,
      strokeRect: noop,
      clearRect: noop,
    } as unknown as CanvasRenderingContext2D;
    return { calls, context };
  }

  it("a barb of 1e20 knots has five pennants and an overflow ring", () => {
    expect(barbParts(1e20)).toEqual({
      pennants: 5,
      full: 0,
      half: 0,
      over: true,
    });
    expect(barbParts(250)).toMatchObject({ pennants: 5, over: false });
    const { calls, context } = counting();
    drawBarb(context, 0, 0, 1e20, 0, {
      length: 20,
      color: "#000",
      flip: false,
    });
    expect(calls.fill).toBe(5);
    expect(calls.arc).toBe(1);
  });

  it("a hodograph of 200,000 levels draws, and 1e20 gets a handful of rings", async () => {
    const { drawHodograph, ringStep } =
      await import("@/ui/analysis/windFigures.ts");
    const n = 200_000;
    const wind = {
      u: Array.from({ length: n }, (_, k) => Math.sin(k / 32_000) * 10),
      v: Array.from({ length: n }, (_, k) => Math.cos(k / 32_000) * 10),
      units: "m s-1",
      levels: Array.from({ length: n }, (_, k) => String(k)),
    };
    const { calls, context } = counting();
    const colours = {
      fg: "#000",
      grid: "#ccc",
      muted: "#888",
      line: "#00f",
      ramp: ["#000", "#fff"],
    };
    expect(() =>
      drawHodograph(context, 300, 300, wind, colours as never)
    ).not.toThrow();
    expect(Math.ceil(1e20 / ringStep(1e20))).toBeLessThanOrEqual(5);
    const huge = { u: [1e20], v: [0], units: "m s-1", levels: ["1"] };
    const rings = counting();
    drawHodograph(rings.context, 300, 300, huge, colours as never);
    expect(rings.calls.arc).toBeLessThan(20);
    expect(calls.stroke).toBeGreaterThan(0);
    // The trace drawn: a circle of about 950 px, not 200,000 dots.
    expect(calls.arc).toBeLessThan(5000);
  });

  it("takes velocities in mm s-1 as speeds and refuses temperatures (review of interim33)", () => {
    const currents = windPairs(
      { uo: { units: "mm s-1" }, vo: { units: "mm s-1" } },
      "uo"
    );
    expect(currents.pairs.map((p) => [p.u, p.v])).toEqual([["uo", "vo"]]);
    // 1,000 mm/s is 1 m/s, about 1.94 knots.
    expect(knotsPer("mm s-1").factor).toBeCloseTo(1.943844 / 1000, 6);
    const kelvin = windPairs({ u: { units: "K" }, v: { units: "K" } }, "u");
    expect(kelvin.pairs).toEqual([]);
    expect(kelvin.reason).toMatch(/not a speed/);
  });
});

it("turns a pair round only when its standard names say it is swapped (review of interim35)", () => {
  const swapped = windPairs(
    {
      u: { standardName: "northward_wind", units: "m s-1" },
      v: { standardName: "eastward_wind", units: "m s-1" },
    },
    "u"
  );
  expect(swapped.pairs[0]).toMatchObject({ u: "v", v: "u" });
  // Standard names spelled otherwise keep the pair as found (25 Nov: a
  // dataset lost its barbs).
  const other = windPairs(
    {
      uas: { standardName: "u-component of wind", units: "m s-1" },
      vas: { standardName: "v-component of wind", units: "m s-1" },
    },
    "uas"
  );
  expect(other.pairs[0]).toMatchObject({ u: "uas", v: "vas" });
});

it("refuses components whose standard names contradict a vector (review of interim37)", () => {
  const units = "m s-1";
  const both = windPairs(
    {
      u: { standardName: "eastward_wind", units },
      v: { standardName: "eastward_wind", units },
    },
    "u"
  );
  expect(both.pairs).toEqual([]);
  expect(both.reason).toMatch(/both eastward/);
  const mixed = windPairs(
    {
      u: { standardName: "eastward_wind", units },
      v: { standardName: "northward_sea_water_velocity", units },
    },
    "u"
  );
  expect(mixed.pairs).toEqual([]);
  expect(mixed.reason).toMatch(/different quantities/);
  // Matching components, and names with no stated direction, still pair.
  const current = windPairs(
    {
      uo: { standardName: "eastward_sea_water_velocity", units },
      vo: { standardName: "northward_sea_water_velocity", units: "mm s-1" },
    },
    "uo"
  );
  expect(current.pairs[0]).toMatchObject({ u: "uo", v: "vo" });
  const unnamed = windPairs({ u: { units }, v: { units } }, "u");
  expect(unnamed.pairs[0]).toMatchObject({ u: "u", v: "v" });
});

it("preserves the direction of displayed currents when thinning hides a stronger one", async () => {
  const { drawBarbGrid } = await import("@/ui/analysis/windBarbs.ts");
  const strokes: number[][] = [];
  let path: number[] = [];
  const context = {
    save() {},
    restore() {},
    beginPath() {
      path = [];
    },
    moveTo(x: number, y: number) {
      path.push(x, y);
    },
    lineTo(x: number, y: number) {
      path.push(x, y);
    },
    stroke() {
      strokes.push(path.slice(0, 4));
    },
    fill() {},
    arc() {},
  } as unknown as CanvasRenderingContext2D;
  drawBarbGrid(
    context,
    {
      rows: [0],
      columns: [0, 1, 30],
      gap: [20, 20],
      at: (_row, column) => [[0, 1, 30][column], 0],
      index: (_row, column) => column,
      flip: () => false,
    },
    {
      u: [0.2, 4, 0.2],
      v: [0, 0, 0],
      units: "m/s",
      current: true,
    },
    { length: 15, color: "#000" }
  );
  expect(strokes).toEqual([
    [0, 0, 15, 0],
    [30, 0, 45, 0],
  ]);
});

it("places a section's barb levels by any column with coordinates", async () => {
  const { barbLevels } = await import("@/ui/analysis/windBarbs.ts");
  // Nine columns, five levels at y = 10k; the middle column has none.
  const yOf = (s: number, k: number) => (s === 4 ? NaN : 10 * k);
  expect(barbLevels(9, 5, yOf)).toEqual([0, 10, 20, 30, 40]);
  expect(barbLevels(9, 5, () => NaN).every(Number.isNaN)).toBe(true);
});
