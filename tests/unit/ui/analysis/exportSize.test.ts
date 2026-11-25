import { describe, expect, it } from "vitest";

import { chartValuesCsv } from "@/ui/analysis/chartValues.ts";
import {
  customLayout,
  MAX_SIDE,
  PNG_PRESETS,
  printedMillimetres,
} from "@/ui/analysis/exportSize.ts";

describe("PNG at any size", () => {
  it("scales the standard layout to the width and gives the chart the rest", () => {
    // 960 + 2 × 16 layout pixels across 3840 image pixels.
    const fit = customLayout({ width: 3840, height: 2160 }, 960, 100);
    expect(fit).toMatchObject({ ratio: 3840 / 992 });
    expect((fit as { chartHeight: number }).chartHeight).toBe(
      Math.floor(2160 / (3840 / 992) - 100)
    );
    // A trace under the chart takes its share.
    const traced = customLayout({ width: 3840, height: 2160 }, 960, 100, 260);
    expect((traced as { chartHeight: number }).chartHeight).toBe(
      Math.floor(2160 / (3840 / 992) - 360)
    );
  });

  it("refuses sizes browsers cannot draw or charts too short to read", () => {
    expect(customLayout({ width: 100, height: 800 }, 960, 100)).toMatchObject({
      error: expect.stringMatching(/at least 200/),
    });
    expect(
      customLayout({ width: MAX_SIDE + 1, height: 800 }, 960, 100)
    ).toMatchObject({ error: expect.stringMatching(/pixels a side/) });
    // 10,000 × 6,000 is 60 million pixels: over 200 MB a copy.
    expect(
      customLayout({ width: 10_000, height: 6_000 }, 960, 100)
    ).toMatchObject({
      error: expect.stringMatching(/50 million in all.*PDF or SVG/),
    });
    // 8K fits.
    expect(
      customLayout({ width: 7680, height: 4320 }, 960, 100)
    ).not.toHaveProperty("error");
    expect(customLayout({ width: 4000, height: 300 }, 960, 100)).toMatchObject({
      error: expect.stringMatching(/Too short/),
    });
  });

  it("offers presets that fit, and the print size of a width", () => {
    for (const preset of PNG_PRESETS) {
      expect(customLayout(preset, 960, 120), preset.name).not.toHaveProperty(
        "error"
      );
    }
    // 85 mm at 600 dpi is 2008 pixels, back to 85 mm.
    expect(printedMillimetres(2008, 600)).toBe(85);
  });
});

describe("chart values as shown", () => {
  it("lists each x with its value, overlays, bands and boxes; points after", () => {
    const csv = chartValuesCsv({
      mode: "cycle",
      x: [1, 2],
      y: [10, 20],
      xTitle: "Month",
      yTitle: "Mean, tas (K)",
      overlay: { values: [11, NaN], label: "3-month running mean" },
      band: { lower: [9, 19], upper: [12, 22], label: "Range" },
      boxes: [{ low: 1, q1: 2, median: 3, q3: 4, high: 5 }, undefined],
      points: { x: [5], y: [6], label: "yearly maxima" },
      readout: (i) => [["Jan", "Feb"][i]],
    });
    expect(csv.split("\n")).toEqual([
      'label,Month,"Mean, tas (K)",3-month running mean,Range (lower),Range (upper),low,q1,median,q3,high',
      "Jan,1,10,11,9,12,1,2,3,4,5",
      "Feb,2,20,,19,22,,,,,",
      "",
      'yearly maxima,Month,"Mean, tas (K)"',
      ",5,6",
      "",
    ]);
  });
});

// eslint-disable-next-line max-lines-per-function
describe("chart values as shown: ensemble members (v20 review)", () => {
  // eslint-disable-next-line max-lines-per-function
  it("adds the fan's percentiles and the chance above a value", async () => {
    const { chartValuesCsv } = await import("@/ui/analysis/chartValues.ts");
    const base = {
      mode: "time" as const,
      x: [0, 1],
      y: [10, 11],
      xTitle: "time",
      yTitle: "tas (K)",
      readout: (i: number) => [`2000-01-0${i + 1}`],
    };
    const fan = chartValuesCsv({
      ...base,
      members: {
        series: [
          [9, 10],
          [11, 12],
        ],
        view: "chance",
        chosen: 0,
        name: "member",
        p10: [9.2, 10.2],
        p50: [10, 11],
        p90: [10.8, 11.8],
        means: [9.5, 11.5],
        threshold: 10.5,
        chance: { share: [50, 100], above: [1, 2], valid: [2, 2] },
      },
    } as never);
    const [header, first] = fan.trim().split("\n");
    // The chance view draws the members faintly and the chance: as drawn.
    expect(header).toBe(
      "label,time,tas (K),member 0,member 1,members above 10.5 (%),members above 10.5,members with a value"
    );
    expect(first).toBe("2000-01-01,0,10,9,11,50,1,2");
    const plume = chartValuesCsv({
      ...base,
      members: {
        series: [
          [9, 10],
          [11, 12],
        ],
        view: "plume",
        chosen: 0,
        name: "member",
        p10: [0, 0],
        p50: [0, 0],
        p90: [0, 0],
        means: [0, 0],
      },
    } as never);
    expect(plume.split("\n")[0]).toBe("label,time,tas (K),member 0,member 1");
  });
});

// eslint-disable-next-line max-lines-per-function
describe("chart values as shown: every figure (v24 review)", () => {
  const base = {
    mode: "time" as const,
    x: [0, 1],
    y: [10, 11],
    xTitle: "time",
    yTitle: "tas (K)",
    readout: (i: number) => [`2000-01-0${i + 1}`],
  };

  it("plume and fan together write the members and the percentiles", async () => {
    const { chartValuesCsv } = await import("@/ui/analysis/chartValues.ts");
    const both = chartValuesCsv({
      ...base,
      members: {
        series: [
          [9, 10],
          [11, 12],
        ],
        view: "both",
        chosen: 0,
        name: "member",
        p10: [9.2, 10.2],
        p50: [10, 11],
        p90: [10.8, 11.8],
        means: [9.5, 11.5],
      },
    } as never);
    expect(both.split("\n")[0]).toBe(
      "label,time,tas (K),member 0,member 1,members P10,members median,members P90"
    );
  });

  it("writes the wind beside a series, and a distribution's curves", async () => {
    const { chartValuesCsv } = await import("@/ui/analysis/chartValues.ts");
    const wind = chartValuesCsv({
      ...base,
      wind: { u: [10, NaN], v: [0, 1], units: "m s-1", flip: false },
    }).split("\n");
    expect(wind[0]).toBe(
      "label,time,tas (K),eastward wind (m s-1),northward wind (m s-1),speed (kn),from (degrees)"
    );
    // A westerly of 10 m/s: from 270°, about 19.4 kn.
    expect(wind[1]).toMatch(/^2000-01-01,0,10,10,0,19\.4\d*,270$/);
    expect(wind[2]).toBe("2000-01-02,1,11,,1,,");
    const calm = chartValuesCsv({
      ...base,
      wind: { u: [0, 0], v: [0, 0], units: "m s-1", flip: false },
    }).split("\n");
    expect(calm[1]).toBe("2000-01-01,0,10,0,0,0,");
    const curves = chartValuesCsv({
      ...base,
      mode: "histogram",
      distribution: {
        curves: [{ label: "curve smoothed", x: [0, 1], y: [5, 6] }],
      },
    } as never);
    expect(curves).toContain(
      "curve smoothed,time,share per bin (%)\n,0,5\n,1,6"
    );
  });

  it("writes a rose, a hodograph and a scatter as drawn", async () => {
    const { hodographCsv, roseCsv, scatterCsv } =
      await import("@/ui/analysis/chartValues.ts");
    const { roseOf } = await import("@/ui/analysis/windFigures.ts");
    const rose = roseCsv(roseOf([10, 0, 0.1], [0, -10, 0], "m s-1", false));
    const lines = rose.trim().split("\n");
    expect(lines[0]).toMatch(/^"sector \(from, degrees\)",/);
    // Speed classes and calm carry their units (converted to m s-1).
    expect(lines[0]).toContain(",speed 0.5–2 m s-1 (%),");
    expect(lines.at(-2)).toMatch(/^"calm, below 0\.5 m s-1 \(%\)",/);
    expect(lines).toHaveLength(16 + 3);
    expect(lines.at(-1)).toBe("samples,3");
    expect(
      hodographCsv({
        u: [1, 2],
        v: [3, 4],
        units: "m s-1",
        levels: [1000.1, 1000.2],
        levelUnits: "hPa",
      })
    ).toBe(
      "level index,level (hPa),eastward (m s-1),northward (m s-1)\n0,1000.1,1,3\n1,1000.2,2,4\n"
    );
    expect(
      scatterCsv({
        x: [35, 34],
        y: [10, 5],
        xTitle: "so",
        yTitle: "thetao",
        title: "T–S",
        joined: true,
        breaks: [1],
      })
    ).toBe("so,thetao,starts a line\n35,10,1\n34,5,1\n");
  });
});
