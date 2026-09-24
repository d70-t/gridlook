import { defineStore } from "pinia";

import {
  levelAxesAreIdentical,
  type TStreamlineLevelInfo,
  type TVectorVariablePair,
  type TVectorVariableSelection,
} from "@/lib/data/vectorField.ts";
import type { TVectorMagnitudeInfo } from "@/lib/data/vectorMagnitude.ts";
import {
  LAND_SEA_MASK_MODES,
  type TLandSeaMaskMode,
} from "@/lib/layers/landSeaMask.ts";
import type { TDistanceScale } from "@/lib/projection/distanceScale.ts";
import {
  PROJECTION_TYPES,
  type TProjectionCenter,
  type TProjectionType,
} from "@/lib/projection/projectionUtils.ts";
import type { TColorMap } from "@/lib/shaders/colormapShaders.ts";
import type { TVarInfo, TBounds } from "@/lib/types/GlobeTypes.ts";
import type { TBasemapEntry } from "@/utils/basemap.ts";
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
  STREAMLINES: "streamlines",
  VOLUME: "volume",
  TEXTURE: "texture",
  BASEMAP: "basemap",
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
  STREAMLINES: "streamlines",
  VOLUME: "volume",
  BASEMAP: "basemap",
} as const;

export const LAYER_OPACITY = {
  MIN: 0,
  MAX: 1,
  STEP: 0.05,
} as const;

export const STREAMLINE_LOADING_STAGES = {
  DATA: "Loading vector data",
  FIELD: "Preparing vector field",
  PATHS: "Computing streamlines",
} as const;

type TStreamlineLoadingStage =
  (typeof STREAMLINE_LOADING_STAGES)[keyof typeof STREAMLINE_LOADING_STAGES];

export type TLayerEntry = {
  id: string;
  kind: TLayerKind;
  name: string;
  visible: boolean;
  opacity: number;
  // land/sea cutout applied to texture layers
  maskMode: TLandSeaMaskMode;
};

export type TVolumeSelection = {
  variable: string;
  color: string;
  opacity: number;
};

function normalizeLayerOpacity(opacity: number) {
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

export const BUILTIN_LAYER_NAMES = {
  [LAYER_KINDS.COASTLINES]: "Coastlines",
  [LAYER_KINDS.GRATICULES]: "Lat/Lon grid",
  [LAYER_KINDS.GRID]: "Data grid",
  [LAYER_KINDS.MASK]: "Land/sea mask",
  [LAYER_KINDS.STREAMLINES]: "Flow streamlines",
  [LAYER_KINDS.VOLUME]: "Volume",
  [LAYER_KINDS.BASEMAP]: "Basemap",
} as const satisfies Record<
  Exclude<TLayerKind, typeof LAYER_KINDS.TEXTURE>,
  string
>;

type TBuiltinLayerKind = keyof typeof BUILTIN_LAYER_NAMES;
type TBuiltinLayerDefaults = Omit<TLayerEntry, "name" | "visible">;

const BUILTIN_LAYER_DEFAULTS: Record<TBuiltinLayerKind, TBuiltinLayerDefaults> =
  {
    [LAYER_KINDS.COASTLINES]: {
      id: BUILTIN_LAYER_IDS.COASTLINES,
      kind: LAYER_KINDS.COASTLINES,
      opacity: LAYER_OPACITY.MAX,
      maskMode: LAND_SEA_MASK_MODES.OFF,
    },
    [LAYER_KINDS.GRATICULES]: {
      id: BUILTIN_LAYER_IDS.GRATICULES,
      kind: LAYER_KINDS.GRATICULES,
      opacity: LAYER_OPACITY.MAX,
      maskMode: LAND_SEA_MASK_MODES.OFF,
    },
    [LAYER_KINDS.GRID]: {
      id: BUILTIN_LAYER_IDS.GRID,
      kind: LAYER_KINDS.GRID,
      opacity: LAYER_OPACITY.MAX,
      maskMode: LAND_SEA_MASK_MODES.OFF,
    },
    [LAYER_KINDS.MASK]: {
      id: BUILTIN_LAYER_IDS.MASK,
      kind: LAYER_KINDS.MASK,
      opacity: LAYER_OPACITY.MAX,
      maskMode: LAND_SEA_MASK_MODES.OFF,
    },
    [LAYER_KINDS.STREAMLINES]: {
      id: BUILTIN_LAYER_IDS.STREAMLINES,
      kind: LAYER_KINDS.STREAMLINES,
      opacity: 0.55,
      maskMode: LAND_SEA_MASK_MODES.OFF,
    },
    [LAYER_KINDS.VOLUME]: {
      id: BUILTIN_LAYER_IDS.VOLUME,
      kind: LAYER_KINDS.VOLUME,
      opacity: LAYER_OPACITY.MAX,
      maskMode: LAND_SEA_MASK_MODES.OFF,
    },
    [LAYER_KINDS.BASEMAP]: {
      id: BUILTIN_LAYER_IDS.BASEMAP,
      kind: LAYER_KINDS.BASEMAP,
      opacity: LAYER_OPACITY.MAX,
      maskMode: LAND_SEA_MASK_MODES.OFF,
    },
  };

const INITIAL_BUILTIN_LAYER_KINDS = [
  LAYER_KINDS.COASTLINES,
  LAYER_KINDS.GRID,
] as const satisfies readonly TBuiltinLayerKind[];

function createBuiltinLayer(kind: TBuiltinLayerKind): TLayerEntry {
  return {
    ...BUILTIN_LAYER_DEFAULTS[kind],
    name: BUILTIN_LAYER_NAMES[kind],
    visible: true,
  };
}

function initialLayerStack(): TLayerEntry[] {
  return INITIAL_BUILTIN_LAYER_KINDS.map(createBuiltinLayer);
}

export const useGlobeControlStore = defineStore("globeControl", {
  // eslint-disable-next-line max-lines-per-function
  state: () => {
    return {
      showCoastLines: true,
      showGraticules: false,
      showDistanceScale: false,
      coastlineResolution:
        COASTLINE_RESOLUTIONS.FIFTY_M as TCoastlineResolution,
      graticuleSpacing: GRATICULE_SPACINGS.THIRTY_DEGREES as TGraticuleSpacing,
      landSeaMaskChoice: LAND_SEA_MASK_MODES.OFF as TLandSeaMaskMode,
      // when true, use the textured versions; when false, use the simple versions
      landSeaMaskUseTexture: false,
      showBasemap: false,
      basemapAvailable: false,
      basemaps: undefined as TBasemapEntry[] | undefined,
      selectedBasemap: "osm" as string,
      varnameSelector: "-", // the varname currently selected in the dropdown
      varnameDisplay: "-", // the varname currently shown on the globe (will be updated after loading)
      loading: false,
      varinfo: undefined as TVarInfo | undefined, // info about a dataset coming directly from the data
      selection: { low: 0, high: 0 } as TBounds, // all the knobs and buttons in GlobeControl which do not require a reload
      histogram: undefined as number[] | undefined, // selection-range histogram bins
      fullHistogram: undefined as number[] | undefined, // fixed histogram over full data range
      histogramSummary: undefined as THistogramSummary | undefined, // full-resolution (4096-bin) summary
      colormap: "viridis" as TColorMap,
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
      distanceScale: null as TDistanceScale | null,
      basemapCatalogUrl: undefined as string | undefined,
      catalogUrl: undefined as string | undefined,
      catalogData: undefined as TCatalog | undefined,
      // ── Live datasets ──────────────────────────────────────────────
      // A live dataset exposes only the currently-available timestep and is
      // followed automatically by polling the store's timestep endpoints.
      live: false, // whether the current dataset is a live dataset
      livePaused: false, // user paused auto-following the newest timestep
      liveConnected: false, // whether the long-poll is currently connected
      liveTimestep: undefined as number | undefined, // latest known live index
      // layer panel stack, ordered top → bottom; order determines render order
      layerStack: initialLayerStack(),
      // incremented to request a GeoTIFF image-layer export of the current grid
      gridExportRequest: 0 as number,
      gridExportLoading: false,
      streamlineAvailable: false,
      streamlineIncompatibility: undefined as string | undefined,
      streamlineLoading: false,
      streamlineProgress: undefined as number | undefined,
      streamlineLoadingStage:
        STREAMLINE_LOADING_STAGES.DATA as TStreamlineLoadingStage,
      streamlinePair: undefined as TVectorVariablePair | undefined,
      streamlineSelection: {
        automatic: true,
      } as TVectorVariableSelection,
      streamlineLevelInfo: undefined as TStreamlineLevelInfo | undefined,
      streamlineLevelIndex: 0,
      streamlineSelectionRevision: 0,
      streamlineMagnitudeRequested: false,
      streamlineMagnitudeDisplayed: false,
      streamlineMagnitudeInfo: undefined as TVectorMagnitudeInfo | undefined,
      streamlineMagnitudeDerivable: false,
      streamlineScalarRevision: 0,
      // will get incremented each time a new dataset OR a new variable in the
      // same dataset is loaded; used to trigger reactivity in child components
      // that need to reload data when the variable changes
      // if the value is even, the change is a new dataset; if odd, it's a
      // variable change within the same dataset
      newDatasetSignifier: 0 as number,
      volumeSelections: [] as TVolumeSelection[],
      volumeLoading: false,
      volumeProgress: undefined as number | undefined,
      volumeAvailable: false,
    };
  },
  actions: {
    signifyDatasetChange() {
      if (this.newDatasetSignifier % 2 === 0) {
        this.newDatasetSignifier += 2;
      } else {
        this.newDatasetSignifier += 1;
      }
      this.resetStreamlineSelection();
      this.volumeSelections = [];
      this.volumeLoading = false;
      this.volumeProgress = undefined;
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
    setLive(live: boolean) {
      this.live = live;
      if (!live) {
        this.livePaused = false;
        this.liveConnected = false;
        this.liveTimestep = undefined;
      }
    },
    toggleLivePaused() {
      this.livePaused = !this.livePaused;
    },
    setLiveConnected(connected: boolean) {
      this.liveConnected = connected;
    },
    setLiveTimestep(timestep: number) {
      this.liveTimestep = timestep;
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
    toggleBasemap() {
      this.showBasemap = !this.showBasemap;
    },
    toggleGraticules() {
      this.showGraticules = !this.showGraticules;
    },
    startLoading() {
      this.loading = true;
      this.hoveredGridPoint = undefined;
    },
    stopLoading(updateDisplay = true) {
      this.loading = false;
      if (!updateDisplay) {
        return;
      }
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
    updateBasemaps(basemaps: TBasemapEntry[]) {
      this.basemaps = basemaps;
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
    removeLayer(id: string) {
      this.layerStack = this.layerStack.filter((layer) => layer.id !== id);
    },
    restoreBuiltinLayer(kind: TLayerKind) {
      if (
        kind === LAYER_KINDS.TEXTURE ||
        this.layerStack.some((layer) => layer.kind === kind)
      ) {
        return;
      }
      this.layerStack.unshift(createBuiltinLayer(kind));
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
    toggleLayerVisibility(id: string) {
      const layer = this.layerStack.find((entry) => entry.id === id);
      if (layer) {
        if (id === BUILTIN_LAYER_IDS.STREAMLINES) {
          this.setStreamlineLayerEnabled(!layer.visible);
        } else {
          layer.visible = !layer.visible;
        }
      }
    },
    isBasemapLayerEnabled() {
      return Boolean(
        this.layerStack.find((entry) => entry.id === BUILTIN_LAYER_IDS.BASEMAP)
          ?.visible
      );
    },
    setBasemapLayerEnabled(enabled: boolean) {
      if (enabled) {
        this.restoreBuiltinLayer(LAYER_KINDS.BASEMAP);
      }
      const layer = this.layerStack.find(
        (entry) => entry.id === BUILTIN_LAYER_IDS.BASEMAP
      );
      if (layer) {
        layer.visible = enabled;
      }
    },
    isStreamlineLayerEnabled() {
      return Boolean(
        this.layerStack.find(
          (entry) => entry.id === BUILTIN_LAYER_IDS.STREAMLINES
        )?.visible
      );
    },
    setStreamlineLayerEnabled(enabled: boolean) {
      if (enabled) {
        this.restoreBuiltinLayer(LAYER_KINDS.STREAMLINES);
      }
      const layer = this.layerStack.find(
        (entry) => entry.id === BUILTIN_LAYER_IDS.STREAMLINES
      );
      if (layer) {
        layer.visible = enabled;
        if (!enabled) {
          this.setStreamlineMagnitudeDisplayed(false);
        }
      }
    },
    isVolumeLayerEnabled() {
      return Boolean(
        this.layerStack.find((entry) => entry.id === BUILTIN_LAYER_IDS.VOLUME)
          ?.visible
      );
    },
    setVolumeLayerEnabled(enabled: boolean) {
      if (enabled) {
        this.restoreBuiltinLayer(LAYER_KINDS.VOLUME);
      }
      const layer = this.layerStack.find(
        (entry) => entry.id === BUILTIN_LAYER_IDS.VOLUME
      );
      if (layer) {
        layer.visible = enabled;
      }
    },
    setVolumeSelections(selections: TVolumeSelection[]) {
      this.volumeSelections = selections.slice(0, 4).map((selection) => ({
        variable: selection.variable,
        color: selection.color,
        opacity: normalizeLayerOpacity(selection.opacity),
      }));
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
    requestGridExport() {
      this.gridExportRequest++;
    },
    setStreamlinePair(pair?: TVectorVariablePair) {
      this.streamlinePair = pair;
      this.streamlineAvailable = pair !== undefined;
      this.streamlineIncompatibility = undefined;
    },
    setStreamlineSelection(selection: TVectorVariableSelection) {
      const previous = this.streamlineSelection;
      if (
        previous.automatic === selection.automatic &&
        previous.u === selection.u &&
        previous.v === selection.v
      ) {
        return;
      }
      this.streamlineSelection = selection;
      this.streamlineIncompatibility = undefined;
      this.streamlineLevelInfo = undefined;
      this.streamlineLevelIndex = 0;
      this.streamlineSelectionRevision++;
    },
    setStreamlineLevelInfo(info?: TStreamlineLevelInfo) {
      const previous = this.streamlineLevelInfo;
      const sameLevelAxis = Boolean(
        previous && info && levelAxesAreIdentical(previous, info)
      );
      if (sameLevelAxis || (!previous && !info)) {
        return;
      }
      this.streamlineLevelInfo = info;
      this.streamlineLevelIndex = 0;
    },
    setStreamlineLevelIndex(index: number, refresh = true) {
      const maximum = Math.max(
        0,
        (this.streamlineLevelInfo?.values.length ?? 1) - 1
      );
      const nextIndex = Math.min(maximum, Math.max(0, Math.trunc(index)));
      if (this.streamlineLevelIndex === nextIndex) {
        return;
      }
      this.streamlineLevelIndex = nextIndex;
      if (refresh) {
        this.streamlineSelectionRevision++;
      }
    },
    setStreamlineMagnitudeDisplayed(displayed: boolean, refresh = false) {
      this.streamlineMagnitudeRequested = displayed;
      if (this.streamlineMagnitudeDisplayed === displayed) {
        return;
      }
      this.streamlineMagnitudeDisplayed = displayed;
      if (refresh) {
        this.streamlineScalarRevision++;
      }
    },
    setStreamlineMagnitudeInfo(info?: TVectorMagnitudeInfo, derivable = false) {
      this.streamlineMagnitudeInfo = info
        ? {
            standardName: info.standardName,
            longName: info.longName,
            units: info.units,
          }
        : undefined;
      this.streamlineMagnitudeDerivable = Boolean(info && derivable);
      const shouldDisplay =
        this.streamlineMagnitudeRequested && this.streamlineMagnitudeDerivable;
      if (this.streamlineMagnitudeDisplayed === shouldDisplay) {
        return;
      }
      this.streamlineMagnitudeDisplayed = shouldDisplay;
      if (!shouldDisplay && this.varnameDisplay !== this.varnameSelector) {
        this.streamlineScalarRevision++;
      }
    },
    resetStreamlineSelection() {
      this.streamlinePair = undefined;
      this.streamlineAvailable = false;
      this.streamlineIncompatibility = undefined;
      this.streamlineLevelInfo = undefined;
      this.streamlineLevelIndex = 0;
      this.setStreamlineSelection({ automatic: true });
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
