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
  // legacy, only read and translated into LAYERS
  MASK_MODE: "maskmode",
  MASK_USE_TEXTURE: "maskusetexture",
  LAYERS: "layers",
  PROJECTION: "projection",
  LAT: "lat",
  LON: "lon",
  GRID_TYPE: "gridtype",
  CATALOG: "catalog",
  BASEMAP_CATALOG: "basemapcatalog",
  DIM_INDICES: "dimIndices",
  DIM_MIN_BOUNDS: "dimMinBounds",
  DIM_MAX_BOUNDS: "dimMaxBounds",
  LIVE: "live",
  // "false" when the level is not picked from the zoom; absent otherwise
  LEVEL_AUTO: "levelauto",
} as const;

type TURLParameterValues = (typeof URL_PARAMETERS)[keyof typeof URL_PARAMETERS];

export { URL_PARAMETERS };
export type { TURLParameterValues };
