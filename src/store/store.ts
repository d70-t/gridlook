import { defineStore } from "pinia";

import {
  LAND_SEA_MASK_MODES,
  type TLandSeaMaskMode,
} from "@/lib/layers/landSeaMask";
import {
  PROJECTION_TYPES,
  type TProjectionCenter,
  type TProjectionType,
} from "@/lib/projection/projectionUtils";
import type { TColorMap } from "@/lib/shaders/colormapShaders";
import type { TVarInfo, TBounds } from "@/lib/types/GlobeTypes";
import type { TCatalog } from "@/utils/catalog";

export const UPDATE_MODE = {
  INITIAL_LOAD: "initialLoad",
  SLIDER_TOGGLE: "sliderToggle",
} as const;

export type TUpdateMode = (typeof UPDATE_MODE)[keyof typeof UPDATE_MODE];

export const HOVERED_GRID_POINT_STATUS = {
  VALUE: "value",
  MISSING: "missing",
} as const;

export type THoveredGridPointStatus =
  (typeof HOVERED_GRID_POINT_STATUS)[keyof typeof HOVERED_GRID_POINT_STATUS];

export type THoveredGridPoint = {
  lat: number;
  lon: number;
  value: number | null;
  status: THoveredGridPointStatus;
  screenX: number;
  screenY: number;
};

export const useGlobeControlStore = defineStore("globeControl", {
  state: () => {
    return {
      showCoastLines: true,
      showGraticules: false,
      // simplified UI choice (Off|Sea|Land|Globe) — used by controls
      landSeaMaskChoice: LAND_SEA_MASK_MODES.OFF as TLandSeaMaskMode,
      // when true, use the textured versions; when false, use the greyscale/solid versions
      landSeaMaskUseTexture: false,
      varnameSelector: "-", // the varname currently selected in the dropdown
      varnameDisplay: "-", // the varname currently shown on the globe (will be updated after loading)
      loading: false,
      varinfo: undefined as TVarInfo | undefined, // info about a dataset coming directly from the data
      selection: { low: 0, high: 0 } as TBounds, // all the knobs and buttons in GlobeControl which do not require a reload
      histogram: undefined as number[] | undefined, // selection-range histogram bins
      fullHistogram: undefined as number[] | undefined, // fixed histogram over full data range
      colormap: "turbo" as TColorMap,
      invertColormap: true,
      posterizeLevels: 0 as number,
      hideLowerBound: false,
      userBoundsLow: undefined as number | undefined,
      userBoundsHigh: undefined as number | undefined,
      dimSlidersValues: [] as (number | null)[],
      dimSlidersDisplay: [] as (number | null)[],
      isInitializingVariable: false,
      controlPanelVisible: true,
      datasetTitle: "" as string,
      projectionMode: PROJECTION_TYPES.NEARSIDE_PERSPECTIVE as TProjectionType,
      projectionCenter: { lat: 0, lon: 0 } as TProjectionCenter,
      isRotating: false,
      hoverEnabled: false,
      hoveredGridPoint: undefined as THoveredGridPoint | undefined,
      catalogUrl: undefined as string | undefined,
      catalogData: undefined as TCatalog | undefined,
    };
  },
  actions: {
    toggleRotating() {
      this.isRotating = !this.isRotating;
    },
    toggleHoverEnabled() {
      this.hoverEnabled = !this.hoverEnabled;
      if (!this.hoverEnabled) {
        this.clearHoveredGridPoint();
      }
    },
    toggleCoastLines() {
      this.showCoastLines = !this.showCoastLines;
    },
    toggleGraticules() {
      this.showGraticules = !this.showGraticules;
    },
    startLoading() {
      this.loading = true;
      this.hoveredGridPoint = undefined;
    },
    stopLoading() {
      this.loading = false;
      this.varnameDisplay = this.varnameSelector;
      for (let i = 0; i < this.dimSlidersValues.length; i++) {
        this.dimSlidersDisplay[i] = this.dimSlidersValues[i];
      }
    },
    updateVarInfo(
      varinfo: TVarInfo,
      indices: number[],
      updateMode: TUpdateMode
    ) {
      if (updateMode === UPDATE_MODE.INITIAL_LOAD) {
        this.isInitializingVariable = true;
        this.dimSlidersValues = indices;
        this.dimSlidersDisplay = indices;
      }

      this.varinfo = varinfo;
    },
    updateLowUserBound(low: number | string | undefined) {
      if (typeof low === "string") {
        if (low.trim() === "") {
          low = undefined;
        } else {
          low = parseFloat(low);
        }
      }
      this.userBoundsLow = low;
    },
    updateHighUserBound(high: number | string | undefined) {
      if (typeof high === "string") {
        if (high.trim() === "") {
          high = undefined;
        } else {
          high = parseFloat(high);
        }
      }
      this.userBoundsHigh = high;
    },
    resetUserBounds() {
      this.userBoundsLow = undefined;
      this.userBoundsHigh = undefined;
    },
    updateBounds(bounds: TBounds) {
      this.selection = bounds;
    },
    updateHistogram(histogram: number[] | undefined) {
      this.histogram = histogram;
    },
    updateFullHistogram(histogram: number[] | undefined) {
      this.fullHistogram = histogram;
    },
    setControlPanelVisible(visible: boolean) {
      this.controlPanelVisible = visible;
    },
    setHoveredGridPoint(point: THoveredGridPoint) {
      this.hoveredGridPoint = point;
    },
    clearHoveredGridPoint() {
      this.hoveredGridPoint = undefined;
    },
    resetExcept(keysToKeep: (keyof typeof this.$state)[] = []) {
      const state = this as Record<keyof typeof this.$state, unknown>;
      const saved = Object.fromEntries(
        keysToKeep.map((k) => {
          const val = state[k];
          return [
            k,
            val !== null && typeof val === "object"
              ? JSON.parse(JSON.stringify(val))
              : val,
          ];
        })
      );
      this.$reset();
      this.$patch(saved);
    },
  },
});
