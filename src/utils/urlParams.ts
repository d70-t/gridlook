const URL_PARAMETERS = {
  VARNAME: "varname",
  COLORMAP: "colormap",
  INVERT_COLORMAP: "invertcolormap",
  USER_BOUNDS_LOW: "boundlow",
  USER_BOUNDS_HIGH: "boundhigh",
  CAMERA_STATE: "camerastate",
  MASK_MODE: "maskmode",
  MASK_USE_TEXTURE: "maskusetexture",
  PROJECTION: "projection",
  PROJECTION_CENTER_LAT: "projectionCenterLat",
  PROJECTION_CENTER_LON: "projectionCenterLon",
  GRID_TYPE: "gridtype",
  DIM_INDICES: "dimIndices",
  DIM_MIN_BOUNDS: "dimMinBounds",
  DIM_MAX_BOUNDS: "dimMaxBounds",
} as const;

type TURLParameterValues = (typeof URL_PARAMETERS)[keyof typeof URL_PARAMETERS];

export { URL_PARAMETERS };
export type { TURLParameterValues };
