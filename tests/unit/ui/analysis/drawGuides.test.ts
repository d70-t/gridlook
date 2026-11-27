import { describe, expect, it } from "vitest";

import { ANALYSIS_KINDS } from "@/lib/analysis/types.ts";
import { DRAW_MODES } from "@/store/analysisStore.ts";
import {
  currentStep,
  drawGuide,
  sketchPath,
} from "@/ui/analysis/drawGuides.ts";

describe("how to draw, for each tool", () => {
  it("has steps for every drawing tool, the section's naming its levels", () => {
    for (const mode of [
      DRAW_MODES.POINT,
      DRAW_MODES.POLYLINE,
      DRAW_MODES.POLYGON,
      DRAW_MODES.BOX,
    ]) {
      expect(drawGuide(mode, undefined)?.steps.length).toBeGreaterThan(1);
    }
    expect(drawGuide(DRAW_MODES.NONE, undefined)).toBeUndefined();
    expect(
      drawGuide(DRAW_MODES.POLYLINE, ANALYSIS_KINDS.SECTION)?.steps.at(-1)
    ).toMatch(/every level/);
    expect(
      drawGuide(DRAW_MODES.POLYLINE, ANALYSIS_KINDS.HOVMOLLER_PATH)?.steps.at(
        -1
      )
    ).toMatch(/every date/);
  });

  it("marks the step the drawing is at", () => {
    expect(
      [0, 1, 2, 5].map((n) => currentStep(DRAW_MODES.POLYLINE, n))
    ).toEqual([0, 1, 2, 2]);
    expect([0, 2, 3].map((n) => currentStep(DRAW_MODES.POLYGON, n))).toEqual([
      0, 0, 1,
    ]);
    expect([0, 1].map((n) => currentStep(DRAW_MODES.BOX, n))).toEqual([0, 1]);
  });

  it("closes a polygon's sketch back to its first point", () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ];
    expect(sketchPath(square, true)).toEqual({
      d: "M0 0 L10 0 L10 10 L0 10 L0 0",
      length: 40,
    });
    expect(sketchPath(square, false).length).toBe(30);
  });
});
