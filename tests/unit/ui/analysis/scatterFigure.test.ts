import { describe, expect, it } from "vitest";

import {
  isTemperatureSalinity,
  scatterOf,
} from "@/ui/analysis/scatterFigure.ts";

const thetao = {
  name: "thetao",
  values: [20, 15, NaN, 5],
  units: "degC",
  standardName: "sea_water_potential_temperature",
};
const so = {
  name: "so",
  values: [35.5, 35.2, 35, 34.8],
  units: "0.001",
  standardName: "sea_water_salinity",
};

describe("scatter against another variable", () => {
  it("plots the plotted variable against the other, missing pairs left out", () => {
    const s = scatterOf(
      { name: "tas", values: [1, 2, 3], units: "K" },
      { name: "hurs", values: [50, NaN, 70], units: "%" }
    );
    expect(s).toMatchObject({
      x: [50, 70],
      y: [1, 3],
      xTitle: "hurs (%)",
      yTitle: "tas (K)",
      title: "tas against hurs",
      joined: false,
    });
  });

  it("makes a T–S diagram: salinity on x, temperature on y, either way round", () => {
    expect(isTemperatureSalinity(thetao, so)).toBe(true);
    const levels = { levels: ["5 m", "50 m", "100 m", "500 m"] };
    for (const s of [
      scatterOf(thetao, so, levels),
      scatterOf(so, thetao, levels),
    ]) {
      expect(s.title).toBe("Temperature–salinity diagram");
      expect(s.x).toEqual([35.5, 35.2, 34.8]);
      expect(s.y).toEqual([20, 15, 5]);
      expect(s.joined).toBe(true);
      expect(s.ends).toEqual(["5 m", "500 m"]);
    }
  });

  it("knows salinity and temperature by name when standard names are missing", () => {
    expect(
      isTemperatureSalinity(
        { name: "thetao", values: [] },
        { name: "so", values: [] }
      )
    ).toBe(true);
    expect(
      isTemperatureSalinity(
        { name: "tas", values: [] },
        { name: "pr", values: [] }
      )
    ).toBe(false);
  });
});

describe("review of interim8: T–S names", () => {
  it("is a T–S diagram for seawater only", () => {
    const air = { name: "ta", values: [], standardName: "air_temperature" };
    expect(isTemperatureSalinity(air, so)).toBe(false);
    // A short name says nothing when the standard name says otherwise.
    expect(
      isTemperatureSalinity({ ...air, name: "temp" }, { ...so, name: "sal" })
    ).toBe(false);
    expect(
      isTemperatureSalinity(
        { ...thetao, standardName: "sea_water_conservative_temperature" },
        { ...so, standardName: "sea_water_absolute_salinity" }
      )
    ).toBe(true);
    expect(isTemperatureSalinity({ name: "t", values: [] }, so)).toBe(false);
    // Generic short names are no seawater quantities.
    expect(
      isTemperatureSalinity(
        { name: "temp", values: [] },
        { name: "salt", values: [] }
      )
    ).toBe(false);
  });
});

describe("v24 review: a joined profile across a missing level", () => {
  it("breaks the line there instead of joining the valid ends", async () => {
    const s = scatterOf(thetao, so, {
      levels: ["0 m", "10 m", "20 m", "30 m"],
    });
    expect(s.x).toEqual([35.5, 35.2, 34.8]);
    expect(s.breaks).toEqual([2]);
    const { drawScatter } = await import("@/ui/analysis/scatterFigure.ts");
    const paths: string[][] = [];
    const context = new Proxy(
      {},
      {
        get: (_target, name: string) =>
          name === "measureText"
            ? () => ({ width: 10 })
            : () => {
                if (name === "beginPath") {
                  paths.push([]);
                } else if (name === "moveTo" || name === "lineTo") {
                  paths.at(-1)?.push(name);
                }
              },
        set: () => true,
      }
    ) as unknown as CanvasRenderingContext2D;
    drawScatter(context, 300, 200, s, {
      fg: "#000",
      grid: "#ccc",
      line: "#00f",
    } as never);
    // The profile's line: two points, then a new start after the gap.
    expect(paths).toContainEqual(["moveTo", "lineTo", "moveTo"]);
    expect(paths).not.toContainEqual(["moveTo", "lineTo", "lineTo"]);
  });
});

describe("review of interim10: the threshold the chart uses", () => {
  it("leaves out of the scatter a mean the chart hides", async () => {
    const { coveredValues } = await import("@/ui/analysis/scatterFigure.ts");
    expect(coveredValues([100, 20], [0.01, 1], 0.8)).toEqual([NaN, 20]);
    expect(coveredValues([100, 20], [0.01, 1], undefined)).toEqual([100, 20]);
  });
});

describe("review of interim10: a dense scatter at screen cost", () => {
  it("draws 100,000 pairs as at most one square per 3 px cell", async () => {
    const { drawScatter, scatterOf } =
      await import("@/ui/analysis/scatterFigure.ts");
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const n = 100_000;
    const s = scatterOf(
      { name: "a", values: Array.from({ length: n }, random) },
      { name: "b", values: Array.from({ length: n }, random) }
    );
    let arcs = 0;
    let rects = 0;
    const context = new Proxy(
      {},
      {
        get: (_, key) =>
          key === "arc"
            ? () => arcs++
            : key === "fillRect"
              ? () => rects++
              : key === "measureText"
                ? () => ({ width: 10 })
                : () => {},
        set: () => true,
      }
    ) as unknown as CanvasRenderingContext2D;
    drawScatter(context, 800, 420, s, {
      fg: "#000",
      muted: "#666",
      grid: "#ccc",
      line: "#00f",
    });
    expect(arcs).toBe(0);
    // 720 × 360 px of plot in 3 px squares: at most 28,800.
    expect(rects).toBeLessThanOrEqual(28_800);
    expect(rects).toBeGreaterThan(1000);
  });
});
