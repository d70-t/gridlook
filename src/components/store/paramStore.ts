import type { TColorMap } from "@/types/GlobeTypes";
import { defineStore } from "pinia";
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
      paramTimeIndex: undefined as string | undefined,
      paramMinTimeBound: undefined as string | undefined,
      paramMaxTimeBound: undefined as string | undefined,
      paramCameraState: undefined as string | undefined,
      paramColormap: undefined as TColorMap | undefined,
      paramInvertColormap: undefined as string | undefined,
      paramMaskMode: undefined as string | undefined,
      paramMaskingUseTexture: undefined as string | undefined,
      paramDimIndices: {} as Record<string, string>,
      paramDimMinBounds: {} as Record<string, string>,
      paramDimMaxBounds: {} as Record<string, string>,
    };
  },
});

// type TUrlParameterState = keyof ReturnType<
//   typeof useUrlParameterStore
// >["$state"];

// Partial<
//   Record<TURLParameterValues, TUrlParameterState>
// > =

export const STORE_PARAM_MAPPING = {
  colormap: "paramColormap",
  varname: "paramVarname",
  timeindex: "paramTimeIndex",
  mintimebound: "paramMinTimeBound",
  maxtimebound: "paramMaxTimeBound",
  camerastate: "paramCameraState",
  invertcolormap: "paramInvertColormap",
  maskmode: "paramMaskMode",
  maskusetexture: "paramMaskingUseTexture",
  dimIndices: "paramDimIndices",
  dimMinBounds: "paramDimMinBounds",
  dimMaxBounds: "paramDimMaxBounds",
} as const;
