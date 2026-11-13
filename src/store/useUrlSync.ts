import { watchDebounced } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { watch } from "vue";

import {
  URL_PARAMETERS,
  type TURLParameterValues,
} from "../utils/urlParams.ts";

import { formatLayersParam, type TLayerUrlEntry } from "./layerUrlState.ts";
import { useUrlParameterStore } from "./paramStore.ts";
import {
  LAYER_KINDS,
  useGlobeControlStore,
  type TGlobeControlStoreKeys,
  type TLayerEntry,
} from "./store.ts";

type TUrlSyncEntry = {
  key:
    | TGlobeControlStoreKeys
    | keyof ReturnType<typeof useUrlParameterStore>["$state"];
  param: TURLParameterValues;
  transform?: (v: unknown) => string | number;
  skip?: (v: unknown) => boolean;
};

const GLOBE_URL_SYNC_MAP: TUrlSyncEntry[] = [
  {
    key: "varnameSelector",
    param: URL_PARAMETERS.VARNAME,
    skip: (v) => !v || v === "-",
  },
  { key: "colormap", param: URL_PARAMETERS.COLORMAP },
  {
    key: "invertColormap",
    param: URL_PARAMETERS.INVERT_COLORMAP,
    transform: String,
  },
  {
    key: "posterizeLevels",
    param: URL_PARAMETERS.POSTERIZE_LEVELS,
    transform: String,
  },
  {
    key: "hideLowerBound",
    param: URL_PARAMETERS.HIDE_LOWER_BOUND,
    transform: String,
  },
  {
    key: "hideUpperBound",
    param: URL_PARAMETERS.HIDE_UPPER_BOUND,
    transform: String,
  },
  { key: "projectionMode", param: URL_PARAMETERS.PROJECTION },
  {
    key: "levelAuto",
    param: URL_PARAMETERS.LEVEL_AUTO,
    transform: (v) => (v ? "" : "false"),
  },
  {
    key: "levelWhole",
    param: URL_PARAMETERS.LEVEL_WHOLE,
    transform: (v) => (v ? "true" : ""),
  },
  {
    key: "levelRangeShared",
    param: URL_PARAMETERS.LEVEL_SHARED,
    transform: (v) => (v === undefined ? "" : String(v)),
  },
];

const URL_PARAM_SYNC_MAP: TUrlSyncEntry[] = [
  {
    key: "paramCameraPx",
    param: URL_PARAMETERS.CAMERA_PX,
  },
  {
    key: "paramCameraPy",
    param: URL_PARAMETERS.CAMERA_PY,
  },
  {
    key: "paramCameraAlt",
    param: URL_PARAMETERS.CAMERA_ALT,
  },
  {
    key: "paramGridType",
    param: URL_PARAMETERS.GRID_TYPE,
    transform: (v) => (v === undefined ? "" : String(v)),
  },
];

function getLayerUrlEntry(
  store: ReturnType<typeof useGlobeControlStore>,
  layer: TLayerEntry
): TLayerUrlEntry | undefined {
  const { visible, opacity } = layer;
  switch (layer.kind) {
    case LAYER_KINDS.COASTLINES:
      return {
        kind: LAYER_KINDS.COASTLINES,
        visible: store.showCoastLines,
        resolution: store.coastlineResolution,
      };
    case LAYER_KINDS.GRATICULES:
      return {
        kind: LAYER_KINDS.GRATICULES,
        visible: store.showGraticules,
        spacing: store.graticuleSpacing,
      };
    case LAYER_KINDS.GRID:
      return { kind: LAYER_KINDS.GRID, visible, opacity };
    case LAYER_KINDS.STREAMLINES: {
      const selection = store.streamlineSelection;
      return {
        kind: LAYER_KINDS.STREAMLINES,
        visible,
        opacity,
        u: selection.automatic ? undefined : selection.u,
        v: selection.automatic ? undefined : selection.v,
        magnitude: store.streamlineMagnitudeRequested,
      };
    }
    case LAYER_KINDS.VOLUME:
      return {
        kind: LAYER_KINDS.VOLUME,
        visible,
        opacity,
        selections: store.volumeSelections,
      };
    case LAYER_KINDS.BASEMAP:
      return {
        kind: LAYER_KINDS.BASEMAP,
        visible,
        opacity,
        provider: store.selectedBasemap,
        options: store.basemapOptions,
      };
    default:
      // texture layers are stored locally and never written to the URL
      return undefined;
  }
}

/* eslint-disable-next-line max-lines-per-function */
export function useUrlSync() {
  const store = useGlobeControlStore();
  const { userBoundsHigh, userBoundsLow, dimSlidersDisplay, projectionCenter } =
    storeToRefs(store);

  const urlParameterStore = useUrlParameterStore();

  function changeURLHash(
    entries: Partial<
      Record<TURLParameterValues | string, string | number | undefined>
    >
  ) {
    const [resource, ...paramArray] = location.hash.substring(1).split("::");
    const paramString = paramArray.join("&");
    const params = new URLSearchParams(paramString);

    for (const [key, value] of Object.entries(entries)) {
      if (value === undefined || value === "") {
        params.delete(key);
        continue;
      }
      params.set(key, value as string);
    }

    history.replaceState(
      null,
      "",
      document.location.pathname +
        "#" +
        resource +
        "::" +
        Object.entries(Object.fromEntries(params))
          .map(([k, v]) => `${k}=${v}`)
          .join("::")
    );
  }

  for (const { key, param, transform, skip } of GLOBE_URL_SYNC_MAP) {
    watch(
      () => (store as unknown as Record<string, unknown>)[key],
      (value) => {
        if (skip?.(value)) {
          return;
        }
        changeURLHash({
          [param]: transform ? transform(value) : (value as string | number),
        });
      }
    );
  }

  for (const { key, param, transform, skip } of URL_PARAM_SYNC_MAP) {
    watch(
      () => (urlParameterStore as unknown as Record<string, unknown>)[key],
      (value) => {
        if (skip?.(value)) {
          return;
        }
        changeURLHash({
          [param]: transform ? transform(value) : (value as string | number),
        });
      }
    );
  }

  // Writing `layers` also drops the legacy mask parameters it replaces.
  watchDebounced(
    () => {
      const entries: TLayerUrlEntry[] = [];
      for (const layer of store.layerStack) {
        const entry = getLayerUrlEntry(store, layer);
        if (entry) {
          entries.push(entry);
        }
      }
      return formatLayersParam(entries);
    },
    (layers) => {
      changeURLHash({
        [URL_PARAMETERS.LAYERS]: layers,
        [URL_PARAMETERS.MASK_MODE]: "",
        [URL_PARAMETERS.MASK_USE_TEXTURE]: "",
      });
    },
    { debounce: 100 }
  );

  // Debounced: user bounds
  watchDebounced(
    () => [userBoundsLow.value, userBoundsHigh.value],
    () => {
      const bothSet =
        userBoundsLow.value !== undefined && userBoundsHigh.value !== undefined;
      const bothUnset =
        userBoundsLow.value === undefined && userBoundsHigh.value === undefined;
      if (bothSet || bothUnset) {
        changeURLHash({
          [URL_PARAMETERS.USER_BOUNDS_LOW]: userBoundsLow.value as number,
          [URL_PARAMETERS.USER_BOUNDS_HIGH]: userBoundsHigh.value as number,
        });
      }
    },
    { debounce: 200 }
  );

  watchDebounced(
    () => [projectionCenter.value?.lat, projectionCenter.value?.lon],
    () => {
      const center = projectionCenter.value;
      if (!center) {
        return;
      }
      changeURLHash({
        [URL_PARAMETERS.LAT]: center.lat,
        [URL_PARAMETERS.LON]: center.lon,
      });
    },
    { debounce: 200 }
  );

  watch(
    () => dimSlidersDisplay.value,
    () => {
      const dimension = store.varinfo?.dimRanges;
      if (!dimension) {
        return;
      }
      const dimensionValues = {} as Record<string, string | number>;
      for (let i = 0; i < dimension.length; i++) {
        if (dimension[i] === null) {
          continue;
        }
        // In live mode the time index is driven by polling and re-seeded from
        // the server on load, so keep it out of the shareable URL.
        if (store.live && dimension[i]?.name === "time") {
          continue;
        }
        const val = store.dimSlidersDisplay[i];
        if (val !== null) {
          dimensionValues[`dimIndices_${dimension[i]?.name}` as string] = val;
        }
      }
      changeURLHash(dimensionValues);
    },
    { deep: true }
  );
}
