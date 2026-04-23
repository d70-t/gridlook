/**
 * postMessage bridge for embedding gridlook in an <iframe>.
 *
 * Inbound messages (parent → iframe)
 * ------------------------------------
 * gridlook:navigate  — load a new dataset (full reset)
 *   { type, src: string, params?: Record<string, string> }
 *
 * gridlook:setParams — update live params without reloading
 *   { type, params: Record<string, string> }
 *
 * Outbound messages (iframe → parent)
 * ------------------------------------
 * gridlook:cameraState  — camera moved
 *   { type, camerastate: string }
 *
 * gridlook:varInfo  — variable loaded, dimension info available
 *   { type, dims: TGridlookDimInfo[] }
 *
 * Parameter keys follow URL_PARAMETERS (e.g. "varname", "colormap",
 * "camerastate"). Dimension indices use: "dimIndices_<name>".
 */

import { useEventListener } from "@vueuse/core";
import { storeToRefs } from "pinia";
import { watch, type Ref } from "vue";

import { GRID_TYPES, type T_GRID_TYPES } from "@/lib/data/gridTypeDetector.ts";
import {
  STORE_PARAM_MAPPING,
  useUrlParameterStore,
} from "@/store/paramStore.ts";
import { useGlobeControlStore } from "@/store/store.ts";
import type { TURLParameterValues } from "@/utils/urlParams.ts";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type TGlobeStore = ReturnType<typeof useGlobeControlStore>;
type TUrlStore = ReturnType<typeof useUrlParameterStore>;

type TNavigateMessage = {
  type: "gridlook:navigate";
  src: string;
  params?: Partial<Record<TURLParameterValues, string>>;
};

type TSetParamsMessage = {
  type: "gridlook:setParams";
  params: Partial<Record<TURLParameterValues, string>>;
};

export type TGridlookMessage = TNavigateMessage | TSetParamsMessage;

export type TGridlookCameraStateMessage = {
  type: "gridlook:cameraState";
  camerastate: string;
};

export type TGridlookDimInfo = {
  name: string;
  min: number;
  max: number;
  current: number;
};

export type TGridlookVarInfoMessage = {
  type: "gridlook:varInfo";
  dims: TGridlookDimInfo[];
};

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isGridlookMessage(data: unknown): data is TGridlookMessage {
  if (typeof data !== "object" || data === null) {
    return false;
  }
  const { type } = data as Record<string, unknown>;
  return type === "gridlook:navigate" || type === "gridlook:setParams";
}

function isNavigateMessage(msg: TGridlookMessage): msg is TNavigateMessage {
  return msg.type === "gridlook:navigate";
}

// ---------------------------------------------------------------------------
// navigate: seed urlParameterStore for the initial load (mirrors onHashChange)
// ---------------------------------------------------------------------------

function applyNavigateParams(
  params: Partial<Record<string, string>>,
  urlStore: TUrlStore
) {
  for (const [key, value] of Object.entries(params) as [string, string][]) {
    if (value === undefined) {
      continue;
    }
    if (key.startsWith("dimIndices_")) {
      urlStore[STORE_PARAM_MAPPING.dimIndices][
        key.substring("dimIndices_".length)
      ] = value;
    } else if (key.startsWith("dimMinBounds_")) {
      urlStore[STORE_PARAM_MAPPING.dimMinBounds][
        key.substring("dimMinBounds_".length)
      ] = value;
    } else if (key.startsWith("dimMaxBounds_")) {
      urlStore[STORE_PARAM_MAPPING.dimMaxBounds][
        key.substring("dimMaxBounds_".length)
      ] = value;
    } else {
      const mappingKey = key as keyof typeof STORE_PARAM_MAPPING;
      if (STORE_PARAM_MAPPING[mappingKey] === undefined) {
        continue;
      }
      if (
        STORE_PARAM_MAPPING[mappingKey] === STORE_PARAM_MAPPING.gridtype &&
        !Object.values(GRID_TYPES).includes(value as T_GRID_TYPES)
      ) {
        continue;
      }
      const prop = STORE_PARAM_MAPPING[mappingKey];
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      urlStore[prop] = value as any;
    }
  }
}

// ---------------------------------------------------------------------------
// setParams: write directly to the live store so watchers fire immediately
// ---------------------------------------------------------------------------

// One handler per supported key. camerastate is the only exception that writes
// to urlStore because useGridScene.ts watches paramCameraState to move the
// Three.js camera.
type TParamHandler = (
  store: TGlobeStore,
  urlStore: TUrlStore,
  value: string
) => void;

/* eslint-disable @typescript-eslint/no-explicit-any */
const PARAM_HANDLERS: Record<string, TParamHandler> = {
  camerastate: (_, u, v) => {
    u.paramCameraState = v;
  },
  colormap: (s, _, v) => {
    s.colormap = v as any;
  },
  invertcolormap: (s, _, v) => {
    s.invertColormap = v === "true";
  },
  posterizelevels: (s, _, v) => {
    s.posterizeLevels = parseInt(v, 10);
  },
  hidelowerbound: (s, _, v) => {
    s.hideLowerBound = v === "true";
  },
  maskmode: (s, _, v) => {
    s.landSeaMaskChoice = v as any;
  },
  maskusetexture: (s, _, v) => {
    s.landSeaMaskUseTexture = v === "true";
  },
  projection: (s, _, v) => {
    s.projectionMode = v as any;
  },
  projectionCenterLat: (s, _, v) => {
    s.projectionCenter = { ...s.projectionCenter, lat: parseFloat(v) };
  },
  projectionCenterLon: (s, _, v) => {
    s.projectionCenter = { ...s.projectionCenter, lon: parseFloat(v) };
  },
  boundlow: (s, _, v) => {
    s.userBoundsLow = parseFloat(v);
  },
  boundhigh: (s, _, v) => {
    s.userBoundsHigh = parseFloat(v);
  },
  varname: (s, _, v) => {
    s.varnameSelector = v;
  },
};
/* eslint-enable @typescript-eslint/no-explicit-any */

function applySetParams(
  params: Partial<Record<string, string>>,
  store: TGlobeStore,
  urlStore: TUrlStore
) {
  for (const [key, value] of Object.entries(params) as [string, string][]) {
    if (value === undefined) {
      continue;
    }
    if (key.startsWith("dimIndices_")) {
      const dimName = key.substring("dimIndices_".length);
      const idx =
        store.varinfo?.dimRanges.findIndex((r) => r?.name === dimName) ?? -1;
      if (idx !== -1) {
        const updated = [...store.dimSlidersValues];
        updated[idx] = parseInt(value, 10);
        store.dimSlidersValues = updated;
      }
    } else {
      PARAM_HANDLERS[key]?.(store, urlStore, value);
    }
  }
}

// ---------------------------------------------------------------------------
// Outbound: broadcast state changes to the parent page
// ---------------------------------------------------------------------------

function setupOutboundMessages(store: TGlobeStore, urlStore: TUrlStore): void {
  if (window.parent === window) {
    return;
  }

  const { paramCameraState } = storeToRefs(urlStore);

  watch(paramCameraState, (value) => {
    if (!value) {
      return;
    }
    const msg: TGridlookCameraStateMessage = {
      type: "gridlook:cameraState",
      camerastate: value,
    };
    window.parent.postMessage(msg, "*");
  });

  watch(
    () => store.varinfo,
    (varinfo) => {
      if (!varinfo) {
        return;
      }
      const dims: TGridlookDimInfo[] = varinfo.dimRanges
        .map((range, i) =>
          range === null
            ? null
            : {
                name: range.name,
                min: range.minBound,
                max: range.maxBound,
                current: store.dimSlidersValues[i] ?? range.minBound,
              }
        )
        .filter((d): d is TGridlookDimInfo => d !== null);
      const msg: TGridlookVarInfoMessage = { type: "gridlook:varInfo", dims };
      window.parent.postMessage(msg, "*");
    }
  );
}

// ---------------------------------------------------------------------------
// Composable
// ---------------------------------------------------------------------------

/** Call once inside HashGlobeView (or whichever component owns `src`). */
export function useIframeMessages(
  src: Ref<string>,
  defaultSrc: Ref<string>
): void {
  const store = useGlobeControlStore();
  const urlStore = useUrlParameterStore();

  function handleMessage(event: MessageEvent) {
    if (!isGridlookMessage(event.data)) {
      return;
    }
    const msg = event.data;
    if (isNavigateMessage(msg)) {
      urlStore.$reset();
      src.value = msg.src || defaultSrc.value;
      if (msg.params) {
        applyNavigateParams(msg.params, urlStore);
      }
      store.catalogUrl = msg.params?.catalog ?? store.catalogUrl;
    } else {
      applySetParams(msg.params, store, urlStore);
    }
  }

  useEventListener(window, "message", handleMessage);
  setupOutboundMessages(store, urlStore);
}
