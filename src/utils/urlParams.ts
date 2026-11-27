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
  // "true" when the selected level is loaded whole; absent otherwise
  LEVEL_WHOLE: "levelwhole",
  // "true" or "false" when the levels' colour range is not the variable's
  // default (shared, unless it sums over cells); absent otherwise
  LEVEL_SHARED: "levelshared",
  // analysis plot windows, written by the analysis store
  PLOTS: "plots",
} as const;

type TURLParameterValues = (typeof URL_PARAMETERS)[keyof typeof URL_PARAMETERS];

/**
 * The hash settings, each encoded on its own so a `+`, `%2B`, `&` or `::`
 * inside a value (a variable name, a catalog URL's query) reads back as
 * written. Slashes stay readable; comma and semicolon delimit the layers
 * format and stay readable there.
 */
export function formatHashParams(params: URLSearchParams) {
  return [...params.entries()]
    .map((entry) => {
      // A slash is safe in the hash and keeps paths readable (2/tas).
      const encoded = new URLSearchParams([entry])
        .toString()
        .replace(/%2F/g, "/");
      return entry[0] === URL_PARAMETERS.LAYERS
        ? encoded.replace(/%2C/g, ",").replace(/%3B/g, ";")
        : encoded;
    })
    .join("::");
}

export { URL_PARAMETERS };
export type { TURLParameterValues };
