/**
 * Named shapes of a box: a box, a latitude band all the way round, a polar cap
 * down to a latitude, or the whole globe. They are boxes with every longitude
 * (west −180°, east 180°), so links and every grid read them as boxes; the mode
 * is read back from the numbers.
 */
import { boxLonSpan } from "@/lib/analysis/sphere.ts";

export const REGION_MODES = {
  BOX: "box",
  BAND: "band",
  CAP: "cap",
  GLOBE: "globe",
} as const;
export type TRegionMode = (typeof REGION_MODES)[keyof typeof REGION_MODES];

export const REGION_MODE_NAMES: Record<TRegionMode, string> = {
  box: "Box",
  band: "Latitude band",
  cap: "Polar cap",
  globe: "Whole globe",
};

type TBoxNumbers = { west: number; east: number; south: number; north: number };

/** The furthest a cap may reach, or a band extend, short of a pole. */
export const CAP_EDGE = 89.9999;
const BAND_EDGE = CAP_EDGE;

/** What a box is: all longitudes reaching a pole is a cap, both a globe. */
export function regionModeOf(box: TBoxNumbers): TRegionMode {
  if (boxLonSpan(box) !== 360) {
    return REGION_MODES.BOX;
  }
  const north = box.north >= 90;
  const south = box.south <= -90;
  return north && south
    ? REGION_MODES.GLOBE
    : north || south
      ? REGION_MODES.CAP
      : REGION_MODES.BAND;
}

/** The hemisphere of a cap, and the latitude it reaches down to. */
export function capOf(box: TBoxNumbers) {
  return box.north >= 90
    ? { hemisphere: "north" as const, limit: box.south }
    : { hemisphere: "south" as const, limit: box.north };
}

/** A cap of one hemisphere down to `limit` (its sign follows the pole). */
/**
 * How far a cap reaches: degrees from the equator toward its pole, below
 * zero past the equator (a box from 90°S to 10°N reaches −10°).
 */
export function capReach(cap: ReturnType<typeof capOf>) {
  return cap.hemisphere === "north" ? cap.limit : -cap.limit;
}

/** A cap of one hemisphere reaching `reach` (see capReach). */
export function capBox(hemisphere: "north" | "south", reach: number) {
  // Short of the pole only: a cap to 89.99° stays there.
  const edge = Math.min(CAP_EDGE, Math.max(-CAP_EDGE, reach));
  return hemisphere === "north"
    ? { west: -180, east: 180, south: edge, north: 90 }
    : { west: -180, east: 180, south: -90, north: -edge };
}

/** The box a mode starts from, keeping what it can of the current one. */
export function boxForMode(mode: TRegionMode, box: TBoxNumbers): TBoxNumbers {
  switch (mode) {
    case REGION_MODES.GLOBE:
      return { west: -180, east: 180, south: -90, north: 90 };
    case REGION_MODES.CAP: {
      // A box reaching a pole keeps its other latitude: a 359.2° box down
      // to 90°S becomes the whole cap to the same edge, not one at 60°.
      if (box.north >= 90 || box.south <= -90) {
        return box.north >= 90
          ? capBox("north", box.south)
          : capBox("south", -box.north);
      }
      const north = (box.south + box.north) / 2 >= 0;
      return capBox(north ? "north" : "south", 60);
    }
    case REGION_MODES.BAND: {
      // A band keeps the box's latitudes, short of a pole (that is a cap):
      // 89.25°N–89.75°N stays there.
      const south = Math.max(-BAND_EDGE, Math.min(box.south, box.north));
      const north = Math.min(BAND_EDGE, Math.max(box.south, box.north));
      return south < north
        ? { west: -180, east: 180, south, north }
        : { west: -180, east: 180, south: -10, north: 10 };
    }
    default:
      // Back to a box: 60° of longitude, the latitudes kept; the whole globe a
      // box round the equator.
      return regionModeOf(box) === REGION_MODES.BOX
        ? box
        : regionModeOf(box) === REGION_MODES.GLOBE
          ? { west: -30, east: 30, south: -60, north: 60 }
          : { west: -30, east: 30, south: box.south, north: box.north };
  }
}

/**
 * The visible edges of a box outline (south, east, north, west as drawn):
 * all longitudes have no east or west side, and a pole is no edge.
 */
export function drawnBoxEdges(box: TBoxNumbers) {
  if (boxLonSpan(box) !== 360) {
    return [0, 1, 2, 3];
  }
  return [box.south > -90 ? 0 : -1, box.north < 90 ? 2 : -1].filter(
    (edge) => edge >= 0
  );
}

/**
 * A box side a hair (10⁻⁶°) inside the box: the same meridian, drawn on the
 * world copy next to the box's inside. On a flat map whose seam is at 180° a
 * box reaching 180°E then ends at the right edge, not the left.
 */
export function besideInside<T extends { lon: number }>(
  side: T[],
  which: "east" | "west"
): T[] {
  const nudge = which === "east" ? -1e-6 : 1e-6;
  return side.map((p) => ({ ...p, lon: p.lon + nudge }));
}
