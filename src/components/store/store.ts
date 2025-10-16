import type { TVarInfo, TColorMap, TBounds } from "@/types/GlobeTypes";
import { defineStore } from "pinia";

export const useGlobeControlStore = defineStore("globeControl", {
  state: () => {
    return {
      showCoastLines: true,
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
      this.varinfo = varinfo;
    },
    updateBounds(bounds: TBounds) {
      console.log("updateBounds", bounds);
      this.selection = bounds;
    },
  },
});
