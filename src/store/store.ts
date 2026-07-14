import { defineStore } from "pinia";

import {
  LAND_SEA_MASK_MODES,
  type TLandSeaMaskMode,
} from "@/lib/layers/landSeaMask.ts";
import {
  PROJECTION_TYPES,
  type TProjectionCenter,
  type TProjectionType,
} from "@/lib/projection/projectionUtils.ts";
import type { TColorMap } from "@/lib/shaders/colormapShaders.ts";
import type { TVarInfo, TBounds } from "@/lib/types/GlobeTypes.ts";
import type { TCatalog } from "@/utils/catalog.ts";
import type { THistogramSummary } from "@/utils/histogram.ts";

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

export const LAYER_KINDS = {
  COASTLINES: "coastlines",
  GRATICULES: "graticules",
  GRID: "grid",
  MASK: "mask",
  TEXTURE: "texture",
} as const;

export type TLayerKind = (typeof LAYER_KINDS)[keyof typeof LAYER_KINDS];

export const COASTLINE_RESOLUTIONS = {
  TEN_M: "10m",
  FIFTY_M: "50m",
} as const;

export type TCoastlineResolution =
  (typeof COASTLINE_RESOLUTIONS)[keyof typeof COASTLINE_RESOLUTIONS];

export const GRATICULE_SPACINGS = {
  FIFTEEN_DEGREES: 15,
  THIRTY_DEGREES: 30,
} as const;

export type TGraticuleSpacing =
  (typeof GRATICULE_SPACINGS)[keyof typeof GRATICULE_SPACINGS];

export const BUILTIN_LAYER_IDS = {
  COASTLINES: "coastlines",
  GRATICULES: "graticules",
  GRID: "grid",
  MASK: "mask",
} as const;

export const LAYER_OPACITY = {
  MIN: 0,
  MAX: 1,
  STEP: 0.05,
} as const;

export type TLayerEntry = {
  id: string;
  kind: TLayerKind;
  name: string;
  visible: boolean;
  opacity: number;
  // land/sea cutout applied to texture layers
  maskMode: TLandSeaMaskMode;
};

export function normalizeLayerOpacity(opacity: number) {
  if (!Number.isFinite(opacity)) {
    return LAYER_OPACITY.MAX;
  }
  if (opacity < LAYER_OPACITY.MIN) {
    return LAYER_OPACITY.MIN;
  }
  if (opacity > LAYER_OPACITY.MAX) {
    return LAYER_OPACITY.MAX;
  }
  return opacity;
}

function builtinLayerStack(): TLayerEntry[] {
  // ordered top → bottom, as displayed in the layer panel
  return [
    {
      id: BUILTIN_LAYER_IDS.COASTLINES,
      kind: LAYER_KINDS.COASTLINES,
      name: "Coastlines",
      visible: true,
      opacity: LAYER_OPACITY.MAX,
      maskMode: LAND_SEA_MASK_MODES.OFF,
    },
    {
      id: BUILTIN_LAYER_IDS.GRATICULES,
      kind: LAYER_KINDS.GRATICULES,
      name: "Lat/Lon grid",
      visible: false,
      opacity: LAYER_OPACITY.MAX,
      maskMode: LAND_SEA_MASK_MODES.OFF,
    },
    {
      id: BUILTIN_LAYER_IDS.MASK,
      kind: LAYER_KINDS.MASK,
      name: "Land/sea mask",
      visible: true,
      opacity: LAYER_OPACITY.MAX,
      maskMode: LAND_SEA_MASK_MODES.OFF,
    },
    {
      id: BUILTIN_LAYER_IDS.GRID,
      kind: LAYER_KINDS.GRID,
      name: "Data grid",
      visible: true,
      opacity: LAYER_OPACITY.MAX,
      maskMode: LAND_SEA_MASK_MODES.OFF,
    },
  ];
}

export const useGlobeControlStore = defineStore("globeControl", {
  state: () => {
    return {
      showCoastLines: true,
      showGraticules: false,
      coastlineResolution:
        COASTLINE_RESOLUTIONS.FIFTY_M as TCoastlineResolution,
      graticuleSpacing: GRATICULE_SPACINGS.THIRTY_DEGREES as TGraticuleSpacing,
      landSeaMaskChoice: LAND_SEA_MASK_MODES.OFF as TLandSeaMaskMode,
      // when true, use the textured versions; when false, use the simple versions
      landSeaMaskUseTexture: false,
      varnameSelector: "-", // the varname currently selected in the dropdown
      varnameDisplay: "-", // the varname currently shown on the globe (will be updated after loading)
      loading: false,
      varinfo: undefined as TVarInfo | undefined, // info about a dataset coming directly from the data
      selection: { low: 0, high: 0 } as TBounds, // all the knobs and buttons in GlobeControl which do not require a reload
      histogram: undefined as number[] | undefined, // selection-range histogram bins
      fullHistogram: undefined as number[] | undefined, // fixed histogram over full data range
      histogramSummary: undefined as THistogramSummary | undefined, // full-resolution (4096-bin) summary
      colormap: "turbo" as TColorMap,
      invertColormap: false,
      posterizeLevels: 0 as number,
      hideLowerBound: false,
      hideUpperBound: false,
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
      // layer panel stack, ordered top → bottom; order determines render order
      layerStack: builtinLayerStack() as TLayerEntry[],
      // incremented to request a GeoTIFF image-layer export of the current grid
      gridExportRequest: 0 as number,
      gridExportLoading: false,
      // will get incremented each time a new dataset OR a new variable in the
      // same dataset is loaded; used to trigger reactivity in child components
      // that need to reload data when the variable changes
      // if the value is even, the change is a new dataset; if odd, it's a
      // variable change within the same dataset
      newDatasetSignifier: 0 as number,
    };
  },
  actions: {
    signifyDatasetChange() {
      if (this.newDatasetSignifier % 2 === 0) {
        this.newDatasetSignifier += 2;
      } else {
        this.newDatasetSignifier += 1;
      }
    },
    signifyVariableChange() {
      if (this.newDatasetSignifier % 2 === 0) {
        this.newDatasetSignifier += 1;
      } else {
        this.newDatasetSignifier += 2;
      }
    },
    selectVariable(varname: string) {
      if (this.varnameSelector === varname) {
        return;
      }
      this.startLoading();
      this.varnameSelector = varname;
      this.signifyVariableChange();
    },
    isNewDataset(): boolean {
      return this.newDatasetSignifier % 2 === 0;
    },
    isVariableChange(): boolean {
      return this.newDatasetSignifier % 2 === 1;
    },
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
    updateVarInfo(varinfo: TVarInfo, indices: number[]) {
      const sliderValuesChanged =
        indices.length !== this.dimSlidersValues.length ||
        indices.some((index, i) => index !== this.dimSlidersValues[i]);
      if (sliderValuesChanged) {
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
    updateHistogramSummary(summary: THistogramSummary | undefined) {
      this.histogramSummary = summary;
    },
    setControlPanelVisible(visible: boolean) {
      this.controlPanelVisible = visible;
    },
    addTextureLayer(id: string, name: string, visible = true) {
      // insert at the top of the stack
      this.layerStack.unshift({
        id,
        kind: LAYER_KINDS.TEXTURE,
        name,
        visible,
        opacity: LAYER_OPACITY.MAX,
        maskMode: LAND_SEA_MASK_MODES.OFF,
      });
    },
    removeTextureLayer(id: string) {
      this.layerStack = this.layerStack.filter((layer) => layer.id !== id);
    },
    updateTextureLayer(
      id: string,
      patch: Partial<Pick<TLayerEntry, "visible" | "maskMode">>
    ) {
      const layer = this.layerStack.find((entry) => entry.id === id);
      if (layer) {
        Object.assign(layer, patch);
      }
    },
    updateLayerOpacity(id: string, opacity: number) {
      const layer = this.layerStack.find((entry) => entry.id === id);
      if (layer) {
        layer.opacity = normalizeLayerOpacity(opacity);
      }
    },
    // moves the entry so it ends up at index `toIndex` of the resulting array
    moveLayer(id: string, toIndex: number) {
      const fromIndex = this.layerStack.findIndex((entry) => entry.id === id);
      if (fromIndex === -1) {
        return;
      }
      const [entry] = this.layerStack.splice(fromIndex, 1);
      const clamped = Math.max(0, Math.min(this.layerStack.length, toIndex));
      this.layerStack.splice(clamped, 0, entry);
    },
    /**
     * Keep historic default behaviour: the globe mask sits below the grid,
     * land/sea masks above. Called when the mask mode changes; the user can
     * still re-drag the mask afterwards.
     */
    positionMaskLayerForMode(mode: TLandSeaMaskMode) {
      const withoutMask = this.layerStack.filter(
        (entry) => entry.kind !== LAYER_KINDS.MASK
      );
      const gridIndex = withoutMask.findIndex(
        (entry) => entry.kind === LAYER_KINDS.GRID
      );
      const targetIndex =
        mode === LAND_SEA_MASK_MODES.GLOBE ? gridIndex + 1 : gridIndex;
      this.moveLayer(BUILTIN_LAYER_IDS.MASK, targetIndex);
    },
    requestGridExport() {
      this.gridExportRequest++;
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

export type TGlobeControlStoreKeys = keyof ReturnType<
  typeof useGlobeControlStore
>["$state"];
