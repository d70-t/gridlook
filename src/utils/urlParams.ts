const URL_PARAMETERS = {
  VARNAME: "varname",
  COLORMAP: "colormap",
  INVERT_COLORMAP: "invertcolormap",
  POSTERIZE_LEVELS: "posterizelevels",
  HIDE_LOWER_BOUND: "hidelowerbound",
  HIDE_UPPER_BOUND: "hideupperbound",
  DISTRACTION_FREE: "distractionFree",
  USER_BOUNDS_LOW: "boundlow",
  USER_BOUNDS_HIGH: "boundhigh",
  CAMERA_PX: "px",
  CAMERA_PY: "py",
  CAMERA_ALT: "alt",
  MASK_MODE: "maskmode",
  MASK_USE_TEXTURE: "maskusetexture",
  STREAMLINES: "streamlines",
  STREAMLINE_U: "streamlineu",
  STREAMLINE_V: "streamlinev",
  VOLUME: "volume",
  VOLUME_STATE: "volumes",
  VOLUME_OPACITY: "volumeopacity",
  PROJECTION: "projection",
  LAT: "lat",
  LON: "lon",
  GRID_TYPE: "gridtype",
  CATALOG: "catalog",
  DIM_INDICES: "dimIndices",
  DIM_MIN_BOUNDS: "dimMinBounds",
  DIM_MAX_BOUNDS: "dimMaxBounds",
  LIVE: "live",
} as const;

type TURLParameterValues = (typeof URL_PARAMETERS)[keyof typeof URL_PARAMETERS];

export { URL_PARAMETERS };
export type { TURLParameterValues };
