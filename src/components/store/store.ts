import { defineStore } from "pinia";

export const useGlobeControlStore = defineStore("globeControl", {
  state: () => {
    return {
      showCoastLines: true,
      timeIndexSlider: 1,
      timeIndex: 1,
      varnameSelector: "-",
      varname: "-",
      loading: false,
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
    },
  },
});
