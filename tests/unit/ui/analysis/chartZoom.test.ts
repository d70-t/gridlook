import { describe, expect, it } from "vitest";

import {
  cellUnder,
  dragRange,
  oneLine,
  titled,
} from "@/ui/analysis/chartZoom.ts";
import { orderedPoints } from "@/ui/analysis/seriesDates.ts";

describe("chart zoom and one-line readout", () => {
  const toValue = (pixel: number) => pixel * 10;

  it("zooms to a dragged stretch in either direction, not to a click", () => {
    expect(dragRange(100, 40, toValue)).toEqual({ min: 400, max: 1000 });
    expect(dragRange(40, 100, toValue)).toEqual({ min: 400, max: 1000 });
    expect(dragRange(50, 53, toValue)).toBeUndefined();
  });

  it("independent review of interim41: a deep zoom draws every shown sample as it is", () => {
    // 400,000 rows; zoomed to 21 of them on a 736 px chart.
    const n = 400_000;
    const x = Array.from({ length: n }, (_, at) => at);
    const y = x.map((at) => (at === 100 ? 0 : 10));
    const points = orderedPoints(x, y, 736, n, { min: 90, max: 110 });
    // The 21 shown and one neighbour each side, not 153,600.
    expect(points).toHaveLength(23);
    expect(points.find((p) => p.x === 100)?.y).toBe(0);
    expect(points.map((p) => p.i)).toEqual(
      Array.from({ length: 23 }, (_, k) => 89 + k)
    );
  });

  it("joins the readout into one line, the date first", () => {
    expect(
      oneLine(
        ["2020-01-15", "Mean 287.1 K"],
        [["2020-01-15", "Max 301 K"], [""]]
      )
    ).toBe("2020-01-15 — Mean 287.1 K — Max 301 K");
    expect(oneLine(["2020-01-15"], [["2020-01-15"]])).toBe("2020-01-15");
    expect(
      oneLine(["2021-01-14", "Near-surface air temperature: 289 K"], [])
    ).toBe("2021-01-14 — 289 K");
  });

  it("finds the cell under the pointer, the nearest centre when they overlap", () => {
    expect(cellUnder(5, [0, 10], [10, 20])).toBe(0);
    expect(cellUnder(15, [20, 10], [10, 20])).toBe(0);
    expect(cellUnder(25, [0, 10], [10, 20])).toBeUndefined();
    expect(cellUnder(9, [0, 8], [10, 10])).toBe(1);
  });

  it("puts the units after the value", () => {
    expect(titled("Depth (m)", "250")).toBe("Depth 250 m");
    expect(titled("Model level (index)", "12")).toBe("Model level 12");
    expect(titled("Latitude", "10° N")).toBe("Latitude 10° N");
  });
});
