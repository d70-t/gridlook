import { defineStore } from "pinia";

import type { TColorMap } from "@/lib/shaders/colormapShaders";
// import type { TURLParameterValues } from "../utils/urlParams";

/* Initial values of SOME of the URL parameters.
   They are getting set in the HashGlobeView via the function `onHashChange`
   After they are set, they will be used in the GlobeView to set initial state
   of the globe. After that, they are not used anymore.

   One exception is paramCameraState, which is not only used to set the initial
   camera state, but also to update the URL when the camera moves (shareGlobe.ts).
   */
export const useUrlParameterStore = defineStore("urlParams", {
  state: () => {
    return {
      paramVarname: undefined as string | undefined,
      paramCameraState: undefined as string | undefined,
      paramColormap: undefined as TColorMap | undefined,
      paramInvertColormap: undefined as string | undefined,
      paramMaskMode: undefined as string | undefined,
      paramMaskingUseTexture: undefined as string | undefined,
      paramDimIndices: {} as Record<string, string>,
      paramDimMinBounds: {} as Record<string, string>,
      paramDimMaxBounds: {} as Record<string, string>,
      paramProjection: undefined as string | undefined,
      paramProjectionCenterLat: undefined as string | undefined,
      paramProjectionCenterLon: undefined as string | undefined,
    };
  },
});

export const STORE_PARAM_MAPPING = {
  colormap: "paramColormap",
  varname: "paramVarname",
  camerastate: "paramCameraState",
  invertcolormap: "paramInvertColormap",
  maskmode: "paramMaskMode",
  maskusetexture: "paramMaskingUseTexture",
  dimIndices: "paramDimIndices",
  dimMinBounds: "paramDimMinBounds",
  dimMaxBounds: "paramDimMaxBounds",
  projection: "paramProjection",
  projectionCenterLat: "paramProjectionCenterLat",
  projectionCenterLon: "paramProjectionCenterLon",
} as const;
