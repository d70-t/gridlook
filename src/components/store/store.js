import { defineStore } from "pinia";

export const useGlobeControlStore = defineStore("globeControl", {
  state: () => {
    return { showCoastLines: true, timeIndexSlider: 1, timeIndex: 1 };
  },
  actions: {
    toggleCoastLines() {
      console.log("TOGGLE COASTLIONES", this.showCoastLines);
      this.showCoastLines = !this.showCoastLines;
    },
  },
});
