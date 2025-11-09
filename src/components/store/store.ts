import type { TVarInfo, TColorMap, TBounds } from "@/types/GlobeTypes";
import { defineStore } from "pinia";

export const LAND_SEA_MASK_MODES = {
  OFF: "off",
  SEA: "sea",
  LAND: "land",
  GLOBE: "globe",

  // Those types are only used in sharedGlobe
  SEA_GREY: "sea_grey",
  LAND_GREY: "land_grey",
  GLOBE_COLORED: "globe_colored",
} as const;

export const UPDATE_MODE = {
  INITIAL_LOAD: "initialLoad",
  SLIDER_TOGGLE: "sliderToggle",
} as const;

export type TLandSeaMaskMode =
  (typeof LAND_SEA_MASK_MODES)[keyof typeof LAND_SEA_MASK_MODES];

export type TUpdateMode = (typeof UPDATE_MODE)[keyof typeof UPDATE_MODE];

export const useGlobeControlStore = defineStore("globeControl", {
  state: () => {
    return {
      showCoastLines: true,
      // simplified UI choice (Off|Sea|Land|Globe) — used by controls
      landSeaMaskChoice: LAND_SEA_MASK_MODES.OFF as TLandSeaMaskMode,
      // when true, use the textured versions; when false, use the greyscale/solid versions
      landSeaMaskUseTexture: false,

      timeIndexSlider: 1, // the time index currently selected by the slider
      timeIndexDisplay: 1, // the time index currently shown on the globe (will be updated after loading)

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
      dimSlidersMinBounds: [] as number[],
      dimSlidersMaxBounds: [] as number[],
      isInitializingVariable: false,
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
      this.timeIndexDisplay = this.timeIndexSlider;
      this.varnameDisplay = this.varnameSelector;
      for (let i = 0; i < this.dimSlidersValues.length; i++) {
        this.dimSlidersDisplay[i] = this.dimSlidersValues[i];
      }
    },
    updateVarInfo(varinfo: TVarInfo, updateMode: TUpdateMode) {
      console.log("STORE: updateVarInfo", updateMode);
      if (updateMode === UPDATE_MODE.INITIAL_LOAD) {
        this.isInitializingVariable = true;
        this.dimSlidersDisplay.splice(0, this.dimSlidersDisplay.length);
        this.dimSlidersValues.splice(0, this.dimSlidersValues.length);
        for (let i = 0; i < varinfo.dimRanges.length; i++) {
          const d = varinfo.dimRanges[i];
          if (d === null) {
            this.dimSlidersDisplay.push(null);
            this.dimSlidersValues.push(null);
          } else {
            //if (d.end === 0) {
            this.dimSlidersDisplay.push(d.startPos);
            this.dimSlidersValues.push(d.startPos);
          }
          console.log("STORE: foo", this.dimSlidersDisplay[i]);
        }
        console.log(
          "STORE: dimSliderValues on UpdateVarInfo",
          this.dimSlidersValues
        );
      }

      this.varinfo = varinfo;
    },
    updateBounds(bounds: TBounds) {
      this.selection = bounds;
    },
  },
});
