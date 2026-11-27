import { describe, expect, it } from "vitest";

import { idMeaning, resizedRect } from "@/ui/analysis/plotLayout.ts";

const area = { width: 1000, height: 800 };
const start = { x: 300, y: 200, w: 400, h: 300 };

describe("window edges and IDs", () => {
  it("resizes from the left and top, the far sides staying put", () => {
    expect(resizedRect(start, "w", -100, 0, area)).toEqual({
      x: 200,
      y: 200,
      w: 500,
      h: 300,
    });
    expect(resizedRect(start, "nw", 50, 40, area)).toEqual({
      x: 350,
      y: 240,
      w: 350,
      h: 260,
    });
  });

  it("stops a left edge at the narrowest window and at the map's side", () => {
    expect(resizedRect(start, "w", 400, 0, area)).toEqual({
      x: 480,
      y: 200,
      w: 220,
      h: 300,
    });
    expect(resizedRect(start, "w", -900, 0, area)).toEqual({
      x: 0,
      y: 200,
      w: 700,
      h: 300,
    });
  });

  it("still resizes from the right and bottom, and moves", () => {
    expect(resizedRect(start, "se", 20, 30, area)).toEqual({
      x: 300,
      y: 200,
      w: 420,
      h: 330,
    });
    expect(resizedRect(start, "move", 20, -30, area)).toEqual({
      x: 320,
      y: 170,
      w: 400,
      h: 300,
    });
  });
});

describe("editing and naming, continued", () => {
  it("spells out a plot's ID", () => {
    expect(idMeaning("S5", "Cross-section")).toBe(
      "S5: Cross-section no. 5 (S = cross-section along a path)"
    );
    expect(idMeaning("A1", "Area time series")).toBe(
      "A1: Area time series no. 1 (A = area)"
    );
  });
});
