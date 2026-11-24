/**
 * How each drawing tool is used, shown while it is armed (as the country
 * picker shows its own): a short looping sketch over the demo map and the
 * steps in words, the current one marked as the drawing goes on.
 */
import { ANALYSIS_KINDS, type TAnalysisKind } from "@/lib/analysis/types.ts";
import { DRAW_MODES, type TDrawMode } from "@/store/analysisStore.ts";

type TXY = { x: number; y: number };

export type TDrawGuide = {
  /** The steps, in order, in a few words each. */
  steps: string[];
  /** Where the sketch's hand presses (map units of the 240 × 150 demo). */
  points: TXY[];
  /** The sketch draws a closed outline (polygon) or a rectangle (box). */
  shape: "path" | "polygon" | "box" | "point";
};

const SECTION_POINTS = [
  { x: 58, y: 104 },
  { x: 118, y: 62 },
  { x: 188, y: 92 },
];
const POLYGON_POINTS = [
  { x: 84, y: 48 },
  { x: 168, y: 44 },
  { x: 184, y: 108 },
  { x: 92, y: 116 },
];

const POLYGON_STEPS = [
  "Click the corners of the area in turn",
  "Click the first point again to close it, or Finish",
  "Cells whose centres are inside are averaged by area",
];
const BOX_STEPS = [
  "Press on the map at one corner",
  "Drag to the opposite corner and let go (or click two corners)",
  "The box is what the rectangle covers on this map",
];

/** The guide for a drawing tool, for the plot it draws. */
export function drawGuide(
  mode: TDrawMode,
  kind: TAnalysisKind | undefined
): TDrawGuide | undefined {
  switch (mode) {
    case DRAW_MODES.POINT:
      return {
        steps: [
          "Click or tap a place on the map",
          "The plot opens; its label marks the place on the map",
        ],
        points: [{ x: 120, y: 70 }],
        shape: "point",
      };
    case DRAW_MODES.POLYLINE:
      return {
        steps: [
          "Click where the route starts",
          "Click at each bend: two points or more",
          kind === ANALYSIS_KINDS.HOVMOLLER_PATH
            ? "Finish: the field is sampled along the route at every date"
            : "Finish: the field is sampled along the route at every level",
        ],
        points: SECTION_POINTS,
        shape: "path",
      };
    case DRAW_MODES.POLYGON:
      return {
        steps: POLYGON_STEPS,
        points: POLYGON_POINTS,
        shape: "polygon",
      };
    case DRAW_MODES.BOX:
      return {
        steps: BOX_STEPS,
        points: [
          { x: 70, y: 42 },
          { x: 182, y: 112 },
        ],
        shape: "box",
      };
    default:
      return undefined;
  }
}

/** Which step the drawing is at, from the points placed so far. */
export function currentStep(mode: TDrawMode, placed: number) {
  switch (mode) {
    case DRAW_MODES.POLYLINE:
      return Math.min(placed, 2);
    case DRAW_MODES.POLYGON:
      return placed < 3 ? 0 : 1;
    case DRAW_MODES.BOX:
      return placed ? 1 : 0;
    default:
      return 0;
  }
}

/** A path through the points (closed for a polygon), and its length. */
export function sketchPath(points: TXY[], closed: boolean) {
  const all = closed ? [...points, points[0]] : points;
  let length = 0;
  for (let k = 1; k < all.length; k++) {
    length += Math.hypot(all[k].x - all[k - 1].x, all[k].y - all[k - 1].y);
  }
  return {
    d: all.map((p, k) => `${k ? "L" : "M"}${p.x} ${p.y}`).join(" "),
    length: Math.ceil(length),
  };
}

const SEEN_KEY = "gridlook.drawGuideSeen";

/** Tools whose guide folded away in this browser (after their first point). */
export function guidesSeen(): Set<string> {
  try {
    return new Set(
      JSON.parse(globalThis.localStorage?.getItem(SEEN_KEY) ?? "[]") as string[]
    );
  } catch {
    return new Set();
  }
}

export function markGuideSeen(mode: string) {
  try {
    const seen = guidesSeen().add(mode);
    globalThis.localStorage?.setItem(SEEN_KEY, JSON.stringify([...seen]));
  } catch {
    // Not remembered (private mode): shown again next time.
  }
}
