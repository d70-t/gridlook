import { watchThrottled } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { watch, type Ref } from "vue";

import { useUrlParameterStore } from "./paramStore.ts";
import { useGlobeControlStore } from "./store.ts";

import {
  EARTH_RADIUS_METERS,
  getGlobeFitCameraDistance,
} from "@/lib/camera/cameraSettings.ts";
import {
  hasLevels,
  levelHoldsVariable,
  levelOfVariable,
  selectLevel,
  variableOnLevel,
} from "@/lib/data/levels.ts";
import type { TSources } from "@/lib/types/GlobeTypes.ts";

/**
 * Pick a level at most this often while the camera moves, so a zoom swaps
 * levels as it passes them without a pick on every frame.
 */
export const LEVEL_PICK_INTERVAL_MS = 200;

export type TViewportSize = { width: number; height: number };

/**
 * Point the dataset and the variables shown at `level`. Variables are keyed
 * by their full path, so the varname (and with it the URL), a hand-picked
 * streamline pair and the volume's variables move to the level's group.
 */
function followLevel(
  store: ReturnType<typeof useGlobeControlStore>,
  sources: TSources | undefined,
  level: number
) {
  if (!sources) {
    return;
  }
  sources.selectedLevel = level;
  // a variable the level lacks keeps its name rather than a missing key
  const move = (name: string) =>
    levelHoldsVariable(sources.levels, name, level)
      ? variableOnLevel(sources.levels, name, level)
      : name;
  store.varnameSelector = move(store.varnameSelector);
  const selection = store.streamlineSelection;
  if (selection.u && selection.v && move(selection.u) !== selection.u) {
    // set as is: the grid rebuilds its streamlines with the level
    store.streamlineSelection = {
      ...selection,
      u: move(selection.u),
      v: move(selection.v),
    };
  }
  if (
    store.volumeSelections.some(({ variable }) => move(variable) !== variable)
  ) {
    store.volumeSelections = store.volumeSelections.map((selection) => ({
      ...selection,
      variable: move(selection.variable),
    }));
  }
}

/**
 * The level whose cells fit the screen: from the scale the scene measured,
 * or before the first frame from the URL camera, else the globe's fitted
 * one.
 */
function fittingLevel(
  store: ReturnType<typeof useGlobeControlStore>,
  levels: TSources["levels"],
  viewport: TViewportSize,
  cameraAlt: string | undefined
) {
  const altitude = Number(cameraAlt);
  const aspect = viewport.width / Math.max(viewport.height, 1);
  // only the levels that hold the variable shown can be picked
  const held = [...levels.keys()].filter((index) =>
    levelHoldsVariable(levels, store.varnameSelector, index)
  );
  const picked = selectLevel(
    store.metersPerPixel ?? {
      altitudeMeters: Number.isFinite(altitude)
        ? altitude
        : (getGlobeFitCameraDistance(aspect) - 1) * EARTH_RADIUS_METERS,
      viewportHeightPx: viewport.height,
    },
    // no level is too large where the grid loads only the view of it
    held.map((index) =>
      store.loadsLevelByView(index)
        ? { ...levels[index], cellCount: 0 }
        : levels[index]
    ),
    held.indexOf(store.selectedLevel)
  );
  return held[picked] ?? store.selectedLevel;
}

/**
 * Select the level a full-path varname names (from a link or the presenter),
 * without turning automatic selection off. The dataset reads the level at
 * once, before the switch reaches the watchers.
 */
function selectVariableLevel(
  store: ReturnType<typeof useGlobeControlStore>,
  sources: TSources | undefined,
  varname: string
) {
  const level = sources && levelOfVariable(sources.levels, varname);
  if (level === undefined) {
    return;
  }
  sources!.selectedLevel = level;
  store.selectLevel(level, false);
}

/**
 * Camera-driven level selection for multi-resolution datasets.
 *
 * The scene writes the ground metres one pixel covers below the camera into
 * the store, in whatever projection is shown; this watches it and, with
 * auto-selection on, writes the level whose cells best fit the screen into
 * the store, also while the camera is moving. `pickLevel` runs the same
 * choice on demand — before the first render, from the URL camera or else
 * the globe's fitted one — so a pyramid never opens on a level the renderer
 * cannot hold.
 *
 * A level switch moves the variables shown onto the new level (see
 * followLevel) and then runs `onLevelChange`; `selectVariableLevel` goes the
 * other way, selecting the level a full-path varname names.
 */
export function useLevelSelection(
  datasources: Ref<TSources | undefined>,
  getViewport: () => TViewportSize,
  onLevelChange?: () => void
) {
  const store = useGlobeControlStore();
  const { paramCameraAlt } = storeToRefs(useUrlParameterStore());

  function pickLevel() {
    const levels = datasources.value?.levels;
    if (
      !levels ||
      !hasLevels(levels, store.varnameSelector) ||
      !store.levelAuto
    ) {
      return;
    }
    store.selectLevel(
      fittingLevel(store, levels, getViewport(), paramCameraAlt.value),
      false
    );
  }

  watchThrottled(() => store.metersPerPixel, pickLevel, {
    throttle: LEVEL_PICK_INTERVAL_MS,
  });
  watch(
    () => [
      store.levelAuto,
      // back on a variable with levels after one without
      hasLevels(datasources.value?.levels ?? [], store.varnameSelector),
      ...(datasources.value?.levels ?? []).map((_, index) =>
        store.loadsLevelByView(index)
      ),
    ],
    pickLevel
  );
  watch(
    () => store.selectedLevel,
    (level) => {
      followLevel(store, datasources.value, level);
      onLevelChange?.();
    }
  );

  return {
    pickLevel,
    selectVariableLevel: (varname: string) =>
      selectVariableLevel(store, datasources.value, varname),
  };
}
