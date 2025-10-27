import type { TVarInfo, TColorMap, TBounds } from "@/types/GlobeTypes";
import { defineStore } from "pinia";
import { useUrlParameterStore } from "./paramStore";

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

export type TLandSeaMaskMode =
  (typeof LAND_SEA_MASK_MODES)[keyof typeof LAND_SEA_MASK_MODES];

export const useGlobeControlStore = defineStore("globeControl", {
  state: () => {
    return {
      showCoastLines: true,
      // simplified UI choice (Off|Sea|Land|Globe) — used by controls
      landSeaMaskChoice: LAND_SEA_MASK_MODES.OFF as TLandSeaMaskMode,
      // when true, use the textured versions; when false, use the greyscale/solid versions
      landSeaMaskUseTexture: true,
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
    },
    updateVarInfo(varinfo: TVarInfo) {
      const parameterStore = useUrlParameterStore();
      if (
        parameterStore.paramMinTimeBound !== undefined &&
        !isNaN(Number(parameterStore.paramMinTimeBound)) &&
        parameterStore.paramMaxTimeBound !== undefined &&
        !isNaN(Number(parameterStore.paramMaxTimeBound))
      ) {
        // update the time range if given in URL parameters
        varinfo.timeRange.start = Number(parameterStore.paramMinTimeBound);
        varinfo.timeRange.end = Number(parameterStore.paramMaxTimeBound);
      }
      this.varinfo = varinfo;
    },
    updateBounds(bounds: TBounds) {
      this.selection = bounds;
    },
  },
});
