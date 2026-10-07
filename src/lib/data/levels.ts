import {
  CAMERA_VERTICAL_FOV_DEGREES,
  EARTH_RADIUS_METERS,
} from "@/lib/camera/cameraSettings.ts";
import type { TSourceLevel, TSources } from "@/lib/types/GlobeTypes.ts";

/**
 * The level every consumer of a dataset reads: `levels[selectedLevel]`, or
 * the first level while nothing has been selected (single-level datasets
 * never select anything, so they keep reading `levels[0]`).
 */
export function currentLevel(datasources: TSources): TSourceLevel {
  return datasources.levels[datasources.selectedLevel ?? 0];
}

/**
 * Index of the level with the largest cells. Grids that load only the view
 * draw it whole under a finer level and take the colour range from it, so
 * neither changes as the view moves. Undefined for a single level, or when a
 * level does not state its resolution.
 */
export function coarsestLevel(
  levels: readonly Pick<TSourceLevel, "resolution">[]
) {
  let coarsest: number | undefined;
  for (const [index, level] of levels.entries()) {
    if (levels.length < 2 || !(level.resolution! > 0)) {
      return undefined;
    }
    if (
      coarsest === undefined ||
      level.resolution! > levels[coarsest].resolution!
    ) {
      coarsest = index;
    }
  }
  return coarsest;
}

/** Shown in place of streamlines on a level that cannot be loaded whole. */
export const STREAMLINES_NEED_WHOLE_LEVEL =
  "Streamlines read a whole level, and this one is too large to load whole. Pick a coarser level.";

/** Target on-screen size of one cell, in pixels, at the sub-camera point. */
export const DEFAULT_PIXELS_PER_CELL = 16;

/**
 * Hysteresis in orders (log2 of cell size, so one order is one unit): another
 * level replaces the active one only when it fits the target better by at
 * least this margin. 0.5 would mean "never switch before the midpoint plus
 * half an order"; 0.35 keeps the dead band clear of the midpoint while still
 * switching before the mismatch reaches a full order.
 */
export const DEFAULT_HYSTERESIS_ORDERS = 0.35;

/**
 * Finest level the camera may pick on a grid that loads its levels whole, as
 * the number of cells one horizontal slice of the level holds (`cellCount`: the length of a HEALPix level's
 * `cell` dimension, however sparse, or `nlat · nlon` on a regular grid). Every
 * timestep of a variable fetches and decodes that many values into Float32
 * (about 50 MB at this cap), and a dense global HEALPix level builds textures
 * of the same size; a level above it is only ever reached by a manual pick.
 */
export const DEFAULT_MAX_LEVEL_CELLS = 12 * 4 ** 10;

/**
 * Cells a grid that loads only the view keeps on screen at once. A level
 * with more cells than this is loaded as a window around the view, reloaded
 * as the camera moves; the window is shrunk to this many cells when a level
 * picked by hand is too fine for the view.
 */
export const DEFAULT_MAX_VIEW_CELLS = 12 * 4 ** 8;

export type TLevelSelectionCamera = {
  /** Height of the camera above the globe's surface, metres. */
  altitudeMeters: number;
  viewportHeightPx: number;
  fovDegrees?: number;
};

export type TLevelSelectionOptions = {
  pixelsPerCell?: number;
  hysteresisOrders?: number;
  maxCells?: number;
};

/**
 * Ground metres covered by one screen pixel at the point of the globe nearest
 * the camera: the vertical field of view spans `2 h tan(fov/2)` at height `h`.
 */
export function groundMetersPerPixel(camera: TLevelSelectionCamera): number {
  const halfFov =
    ((camera.fovDegrees ?? CAMERA_VERTICAL_FOV_DEGREES) * Math.PI) / 360;
  const viewHeight = 2 * Math.max(camera.altitudeMeters, 1) * Math.tan(halfFov);
  return viewHeight / Math.max(camera.viewportHeightPx, 1);
}

/**
 * Cells a level holds: its recorded count, else an upper bound from its
 * resolution alone — a square grid as wide and as tall as the equator,
 * `(2πR / resolution)²`. That over-counts a global lat/lon grid (by 2) and a
 * HEALPix sphere (by π) and matches a WebMercatorQuad zoom level, so an
 * unknown count errs towards keeping a level out of automatic selection.
 */
function estimatedCellCount(
  level: Pick<TSourceLevel, "resolution" | "cellCount">
) {
  if (level.cellCount !== undefined) {
    return level.cellCount;
  }
  return ((2 * Math.PI * EARTH_RADIUS_METERS) / level.resolution!) ** 2;
}

/**
 * Whether a level holds more cells than `maxCells`, the check that keeps it
 * out of automatic selection. A level with neither a count nor a resolution
 * cannot be judged and is not over the cap.
 */
export function exceedsCellCap(
  level: Pick<TSourceLevel, "resolution" | "cellCount">,
  maxCells = DEFAULT_MAX_LEVEL_CELLS
) {
  if (level.cellCount === undefined && !(level.resolution! > 0)) {
    return false;
  }
  return estimatedCellCount(level) > maxCells;
}

/**
 * The level a camera should render: the level whose cells come nearest to
 * `pixelsPerCell` pixels at the sub-camera point (nearest in log2 cell size),
 * from the camera, or from the ground metres per pixel measured there,
 * skipping levels with more cells than `maxCells`, and keeping the active
 * level unless another fits better by more than `hysteresisOrders`. Returns
 * the index into `levels`; `active` when there is nothing to choose from
 * (fewer than two levels, or levels without a resolution).
 */
export function selectLevel(
  camera: TLevelSelectionCamera | number,
  levels: readonly Pick<TSourceLevel, "resolution" | "cellCount">[],
  active: number,
  options: TLevelSelectionOptions = {}
): number {
  const maxCells = options.maxCells ?? DEFAULT_MAX_LEVEL_CELLS;
  const candidates = levels
    .map((level, index) => ({ level, index }))
    .filter(
      ({ level }) => level.resolution !== undefined && level.resolution > 0
    );
  if (levels.length < 2 || candidates.length !== levels.length) {
    return active;
  }
  const target =
    (options.pixelsPerCell ?? DEFAULT_PIXELS_PER_CELL) *
    (typeof camera === "number" ? camera : groundMetersPerPixel(camera));
  const mismatch = (index: number) =>
    Math.abs(Math.log2(levels[index].resolution!) - Math.log2(target));
  const eligible = candidates.filter(
    ({ level }) => !exceedsCellCap(level, maxCells)
  );
  if (eligible.length === 0) {
    // Nothing fits the renderer: the coarsest level is the least harmful.
    let coarsest = candidates[0];
    for (const candidate of candidates) {
      if (candidate.level.resolution! > coarsest.level.resolution!) {
        coarsest = candidate;
      }
    }
    return coarsest.index;
  }
  let best = eligible[0].index;
  for (const { index } of eligible) {
    if (mismatch(index) < mismatch(best)) {
      best = index;
    }
  }
  const activeEligible = eligible.some(({ index }) => index === active);
  if (!activeEligible) {
    return best;
  }
  const hysteresis = options.hysteresisOrders ?? DEFAULT_HYSTERESIS_ORDERS;
  return mismatch(best) + hysteresis < mismatch(active) ? best : active;
}
