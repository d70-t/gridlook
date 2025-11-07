const URL_PARAMETERS = {
  VARNAME: "varname",
  TIMEINDEX: "timeindex",
  COLORMAP: "colormap",
  INVERT_COLORMAP: "invertcolormap",
  USER_BOUNDS_LOW: "boundlow",
  USER_BOUNDS_HIGH: "boundhigh",
  MIN_TIME_BOUND: "mintimebound",
  MAX_TIME_BOUND: "maxtimebound",
  CAMERA_STATE: "camerastate",
  MASK_MODE: "maskmode",
  MASK_USE_TEXTURE: "maskusetexture",

  DIM_INDICES: "dimIndices",
  DIM_MIN_BOUNDS: "dimMinBounds",
  DIM_MAX_BOUNDS: "dimMaxBounds",
} as const;

type TURLParameterValues = (typeof URL_PARAMETERS)[keyof typeof URL_PARAMETERS];

export { URL_PARAMETERS };
export type { TURLParameterValues };
