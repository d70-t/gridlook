import { defineStore } from "pinia";

export const useGlobeControlStore = defineStore("globeControl", {
  state: () => {
    return {
      showCoastLines: true,
      timeIndexSlider: 1,
      timeIndex: 1,
      varnameSelector: "-",
      varname: "-",
    };
  },
  actions: {
    toggleCoastLines() {
      this.showCoastLines = !this.showCoastLines;
    },
  },
});
