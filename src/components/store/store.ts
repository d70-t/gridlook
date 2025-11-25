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
    updateVarInfo(varinfo: TVarInfo, updateMode: TUpdateMode) {
      if (updateMode === UPDATE_MODE.INITIAL_LOAD) {
        this.isInitializingVariable = true;
        const oldDimSlidersValues = this.dimSlidersValues.slice();
        const oldDimSlidersDisplay = this.dimSlidersDisplay.slice();
        const oldDimRanges = this.varinfo?.dimRanges;
        const newDimRanges = varinfo.dimRanges;

        this.dimSlidersDisplay.splice(0, this.dimSlidersDisplay.length);
        this.dimSlidersValues.splice(0, this.dimSlidersValues.length);
        for (let i = 0; i < varinfo.dimRanges.length; i++) {
          const d = varinfo.dimRanges[i];
          if (d === null) {
            this.dimSlidersDisplay.push(null);
            this.dimSlidersValues.push(null);
          } else {
            if (
              oldDimRanges &&
              i < oldDimRanges.length &&
              i < oldDimSlidersValues.length &&
              oldDimRanges[i]?.name === newDimRanges[i]?.name &&
              oldDimRanges[i]?.maxBound === newDimRanges[i]?.maxBound
            ) {
              // keep old value if dimension is the same and maxBound (=length) didn't change
              const oldValue = oldDimSlidersValues[i] as number;
              if (oldValue >= d.minBound && oldValue <= d.maxBound) {
                this.dimSlidersValues.push(oldValue);
                this.dimSlidersDisplay.push(oldDimSlidersDisplay[i]);
              } else {
                this.dimSlidersDisplay.push(d.startPos);
                this.dimSlidersValues.push(d.startPos);
              }
            } else {
              this.dimSlidersDisplay.push(d.startPos);
              this.dimSlidersValues.push(d.startPos);
            }
          }
        }
      }

      this.varinfo = varinfo;
    },
    updateBounds(bounds: TBounds) {
      this.selection = bounds;
    },
  },
});
