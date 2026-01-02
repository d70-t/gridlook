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

export const UPDATE_MODE = {
  INITIAL_LOAD: "initialLoad",
  SLIDER_TOGGLE: "sliderToggle",
} as const;

export type TUpdateMode = (typeof UPDATE_MODE)[keyof typeof UPDATE_MODE];

export const useGlobeControlStore = defineStore("globeControl", {
  state: () => {
    return {
      showCoastLines: true,
      // simplified UI choice (Off|Sea|Land|Globe) — used by controls
      landSeaMaskChoice: LAND_SEA_MASK_MODES.OFF as TLandSeaMaskMode,
      // when true, use the textured versions; when false, use the greyscale/solid versions
      landSeaMaskUseTexture: false,
      varnameSelector: "-", // the varname currently selected in the dropdown
      varnameDisplay: "-", // the varname currently shown on the globe (will be updated after loading)
      loading: false,
      varinfo: undefined as TVarInfo | undefined, // info about a dataset coming directly from the data
      selection: { low: 0, high: 0 } as TBounds, // all the knobs and buttons in GlobeControl which do not require a reload
      colormap: "turbo" as TColorMap,
      invertColormap: true,
      userBoundsLow: undefined as number | undefined,
      userBoundsHigh: undefined as number | undefined,
      dimSlidersValues: [] as (number | null)[],
      dimSlidersDisplay: [] as (number | null)[],
      isInitializingVariable: false,
      controlPanelVisible: true,
      projectionMode: PROJECTION_TYPES.NEARSIDE_PERSPECTIVE as TProjectionType,
      projectionCenter: { lat: 0, lon: 0 } as TProjectionCenter,
    };
  },
  actions: {
    toggleCoastLines() {
      this.showCoastLines = !this.showCoastLines;
    },
    startLoading() {
      this.loading = true;
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
    updateBounds(bounds: TBounds) {
      this.selection = bounds;
    },
    setControlPanelVisible(visible: boolean) {
      this.controlPanelVisible = visible;
    },
  },
});
