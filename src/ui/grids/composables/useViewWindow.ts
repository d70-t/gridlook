import {
  coarsestLevel,
  DEFAULT_MAX_LEVEL_CELLS,
  DEFAULT_MAX_VIEW_CELLS,
} from "@/lib/data/levels.ts";
import type { TViewFootprint } from "@/lib/projection/viewFootprint.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";

/** A view window reaches this fraction of the view's size past every edge. */
export const VIEW_WINDOW_MARGIN = 0.5;

export type TViewWindowOptions<TWindow> = {
  getDatasources: () => TSources | undefined;
  /** Whether the level prepared can be loaded by view at all. */
  canLoadByView: () => boolean;
  /** Cells the whole level holds; 0 before a level is prepared. */
  levelCells: () => number;
  /**
   * The window of the level that covers `footprint`, grown by `margin` and
   * held to `maxCells`; null when the level holds nothing of the view.
   */
  window: (
    footprint: TViewFootprint,
    margin: number,
    maxCells: number
  ) => TWindow | null;
  /** Whether `loaded` holds every cell of `needed`. */
  covers: (loaded: TWindow, needed: TWindow) => boolean;
};

/**
 * The part of a level a grid loads, for grids that load only the view of a
 * large level: the level whole, or an index window around the view. The
 * grid supplies the window's shape and arithmetic; this decides when a level
 * is loaded by view, keeps the window loaded, and tells the data loader when
 * the view has left it.
 */
// eslint-disable-next-line max-lines-per-function
export function useViewWindow<TWindow>(options: TViewWindowOptions<TWindow>) {
  const store = useGlobeControlStore();
  // The loaded part of a level too large to load whole; null when the view
  // holds none of it, undefined when the whole level is loaded.
  let loaded: TWindow | null | undefined;

  /**
   * Whether the selected level is loaded by view: a large level other than
   * the coarsest, which is the backdrop of the others and is always loaded
   * whole. Streamlines, volumes and "Load whole level" read the whole level,
   * up to the whole-level cap.
   */
  function loadsByView() {
    const sources = options.getDatasources()!;
    const readsWholeLevel =
      store.levelWhole ||
      store.isStreamlineLayerEnabled() ||
      store.isVolumeLayerEnabled();
    return (
      options.canLoadByView() &&
      (sources.selectedLevel ?? 0) !== coarsestLevel(sources.levels) &&
      options.levelCells() >
        (readsWholeLevel ? DEFAULT_MAX_LEVEL_CELLS : DEFAULT_MAX_VIEW_CELLS)
    );
  }

  function viewWindow(margin: number) {
    return store.viewFootprint
      ? options.window(
          store.viewFootprint,
          margin,
          // The loaded window is held to the budget. The view it has to
          // cover is held to half of that, so that a view too large for the
          // budget still counts as covered and does not reload on every
          // move.
          margin > 0 ? DEFAULT_MAX_VIEW_CELLS : DEFAULT_MAX_VIEW_CELLS / 2
        )
      : null;
  }

  /** Whether the loaded window no longer covers the view. */
  function viewWindowStale() {
    if (options.levelCells() === 0) {
      return false;
    }
    if (!loadsByView()) {
      return loaded !== undefined;
    }
    if (loaded === undefined) {
      return true;
    }
    const needed = viewWindow(0);
    return (
      needed !== null && (loaded === null || !options.covers(loaded, needed))
    );
  }

  /** Choose the window to load for the view, or the whole level. */
  function applyViewWindow() {
    loaded = loadsByView() ? viewWindow(VIEW_WINDOW_MARGIN) : undefined;
    return loaded;
  }

  return {
    loadsByView,
    viewWindowStale,
    applyViewWindow,
    get window() {
      return loaded;
    },
  };
}
