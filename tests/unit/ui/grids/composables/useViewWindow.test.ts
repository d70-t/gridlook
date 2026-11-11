import { createPinia, setActivePinia } from "pinia";
import { beforeEach, expect, it, vi } from "vitest";

import {
  DEFAULT_MAX_LEVEL_CELLS,
  DEFAULT_MAX_VIEW_CELLS,
} from "@/lib/data/levels.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import {
  useViewWindow,
  VIEW_WINDOW_MARGIN,
} from "@/ui/grids/composables/useViewWindow.ts";

vi.stubGlobal("localStorage", { getItem: () => null });

// A window is the view's box in whatever units, grown by the margin.
type TBox = { min: number; max: number; maxCells: number };

const footprint = {
  latMin: 10,
  latMax: 20,
  lonStart: 30,
  lonSpan: 10,
  centreLat: 15,
  centreLon: 35,
};

function setup(levelCells: number, selectedLevel = 0) {
  setActivePinia(createPinia());
  const store = useGlobeControlStore();
  store.viewFootprint = { ...footprint };
  const sources = {
    selectedLevel,
    levels: [{ resolution: 1 }, { resolution: 2 }],
  } as unknown as TSources;
  const window = vi.fn(
    (fp: typeof footprint, margin: number, maxCells: number): TBox | null =>
      fp.latMin > 80
        ? null
        : {
            min: fp.latMin - margin * (fp.latMax - fp.latMin),
            max: fp.latMax + margin * (fp.latMax - fp.latMin),
            maxCells,
          }
  );
  const view = useViewWindow<TBox>({
    getDatasources: () => sources,
    canLoadByView: () => true,
    levelCells: () => levelCells,
    window,
    covers: (loaded, needed) =>
      loaded.min <= needed.min && needed.max <= loaded.max,
  });
  return { store, sources, view, window };
}

beforeEach(() => {
  vi.restoreAllMocks();
});

it("loads a large level by view, with the margin and the budget", () => {
  const { view, window } = setup(DEFAULT_MAX_VIEW_CELLS + 1);
  expect(view.loadsByView()).toBe(true);
  expect(view.viewWindowStale()).toBe(true);
  expect(view.applyViewWindow()).toEqual({
    min: 5,
    max: 25,
    maxCells: DEFAULT_MAX_VIEW_CELLS,
  });
  expect(window).toHaveBeenLastCalledWith(
    expect.objectContaining(footprint),
    VIEW_WINDOW_MARGIN,
    DEFAULT_MAX_VIEW_CELLS
  );
  expect(view.window).toEqual({ min: 5, max: 25, maxCells: 786432 });
  // the view it has to cover is held to half the budget
  expect(view.viewWindowStale()).toBe(false);
  expect(window).toHaveBeenLastCalledWith(
    expect.anything(),
    0,
    DEFAULT_MAX_VIEW_CELLS / 2
  );
});

it("is stale once the view leaves the window, and when it holds none", () => {
  const { store, view } = setup(DEFAULT_MAX_VIEW_CELLS + 1);
  view.applyViewWindow();
  store.viewFootprint = { ...footprint, latMin: 12, latMax: 22 };
  expect(view.viewWindowStale()).toBe(false);
  store.viewFootprint = { ...footprint, latMin: 20, latMax: 30 };
  expect(view.viewWindowStale()).toBe(true);
  // a view outside the level loads nothing, until it returns
  store.viewFootprint = { ...footprint, latMin: 85, latMax: 89 };
  expect(view.applyViewWindow()).toBeNull();
  expect(view.viewWindowStale()).toBe(false);
  store.viewFootprint = { ...footprint };
  expect(view.viewWindowStale()).toBe(true);
});

it("loads a small level, the coarsest level and a whole-level pick whole", () => {
  const small = setup(DEFAULT_MAX_VIEW_CELLS);
  expect(small.view.loadsByView()).toBe(false);
  expect(small.view.applyViewWindow()).toBeUndefined();
  expect(small.view.viewWindowStale()).toBe(false);

  const coarsest = setup(DEFAULT_MAX_VIEW_CELLS + 1, 1);
  expect(coarsest.view.loadsByView()).toBe(false);

  const { store, view } = setup(DEFAULT_MAX_VIEW_CELLS + 1);
  view.applyViewWindow();
  store.setLevelWhole(true);
  // the window on screen no longer matches what is wanted
  expect(view.viewWindowStale()).toBe(true);
  expect(view.applyViewWindow()).toBeUndefined();
  // but a level over the whole-level cap is still loaded by view
  const huge = setup(DEFAULT_MAX_LEVEL_CELLS + 1);
  huge.store.setLevelWhole(true);
  expect(huge.view.loadsByView()).toBe(true);
});

it("reports nothing stale before a level is prepared", () => {
  const { view } = setup(0);
  expect(view.viewWindowStale()).toBe(false);
});
