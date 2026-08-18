import { defineStore } from "pinia";

import type { TColorMap } from "@/lib/shaders/colormapShaders.ts";
// import type { TURLParameterValues } from "../utils/urlParams";

/* Initial values of SOME of the URL parameters.
   They are getting set in the HashGlobeView via the function `onHashChange`
   After they are set, they will be used in the GlobeView to set initial state
   of the globe. After that, they are not used anymore.

   One exception are the camera params, which are not only used to set the
   initial camera state, but also to update the URL when the camera moves.
   */
export const useUrlParameterStore = defineStore("urlParams", {
  state: () => {
    return {
      paramVarname: undefined as string | undefined,
      paramCameraPx: undefined as string | undefined,
      paramCameraPy: undefined as string | undefined,
      paramCameraAlt: undefined as string | undefined,
      paramColormap: undefined as TColorMap | undefined,
      paramInvertColormap: undefined as string | undefined,
      paramPosterizeLevels: undefined as string | undefined,
      paramHideLowerBound: undefined as string | undefined,
      paramHideUpperBound: undefined as string | undefined,
      paramDistractionFree: undefined as string | undefined,
      paramMaskMode: undefined as string | undefined,
      paramMaskingUseTexture: undefined as string | undefined,
      paramStreamlines: undefined as string | undefined,
      paramStreamlineU: undefined as string | undefined,
      paramStreamlineV: undefined as string | undefined,
      paramDimIndices: {} as Record<string, string>,
      paramDimMinBounds: {} as Record<string, string>,
      paramDimMaxBounds: {} as Record<string, string>,
      paramBoundLow: undefined as string | undefined,
      paramBoundHigh: undefined as string | undefined,
      paramProjection: undefined as string | undefined,
      paramLat: undefined as string | undefined,
      paramLon: undefined as string | undefined,
      paramGridType: undefined as string | undefined,
      paramCatalog: undefined as string | undefined,
      paramLive: undefined as string | undefined,
    };
  },
  actions: {
    resetExceptCamera() {
      const keysToKeep = [
        "paramCameraPx",
        "paramCameraPy",
        "paramCameraAlt",
      ] as const;
      const state = this as Record<keyof typeof this.$state, unknown>;
      const saved = Object.fromEntries(
        keysToKeep.map((k) => {
          const val = state[k];
          // Deep-clone to avoid restoring stale object references
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

export const STORE_PARAM_MAPPING = {
  colormap: "paramColormap",
  varname: "paramVarname",
  px: "paramCameraPx",
  py: "paramCameraPy",
  alt: "paramCameraAlt",
  invertcolormap: "paramInvertColormap",
  posterizelevels: "paramPosterizeLevels",
  hidelowerbound: "paramHideLowerBound",
  hideupperbound: "paramHideUpperBound",
  distractionFree: "paramDistractionFree",
  maskmode: "paramMaskMode",
  maskusetexture: "paramMaskingUseTexture",
  streamlines: "paramStreamlines",
  streamlineu: "paramStreamlineU",
  streamlinev: "paramStreamlineV",
  dimIndices: "paramDimIndices",
  dimMinBounds: "paramDimMinBounds",
  dimMaxBounds: "paramDimMaxBounds",
  projection: "paramProjection",
  lat: "paramLat",
  lon: "paramLon",
  boundlow: "paramBoundLow",
  boundhigh: "paramBoundHigh",
  gridtype: "paramGridType",
  catalog: "paramCatalog",
  live: "paramLive",
} as const;
