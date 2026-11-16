import type { TRunSource } from "./analysisRunner.ts";
import type { TDistributionSummary } from "./distributionStats.ts";
import type { TIdEncoding } from "./identifiers.ts";
import type { TScreenFrame } from "./screenFrame.ts";
import type { TLatLon } from "./sphere.ts";

export const ANALYSIS_KINDS = {
  POINT_SERIES: "point-series",
  REGION_SERIES: "region-series",
  PROFILE: "profile",
  SECTION: "section",
  /** Time × level at a point. */
  TIME_DEPTH: "time-depth",
  /** Hovmöller: time × longitude, mean over a latitude band. */
  HOVMOLLER_LON: "hovmoller-lon",
  /** Hovmöller: time × latitude, mean over a longitude sector. */
  HOVMOLLER_LAT: "hovmoller-lat",
  /** Hovmöller: time × distance along a path, at a level. */
  HOVMOLLER_PATH: "hovmoller-path",
  /** Area-weighted distribution of values over a region at one time. */
  DISTRIBUTION: "distribution",
  /** Latitude × vertical at one time, mean over a longitude sector. */
  LAT_VERTICAL: "lat-vertical",
  LON_VERTICAL: "lon-vertical",
} as const;

export type TAnalysisKind =
  (typeof ANALYSIS_KINDS)[keyof typeof ANALYSIS_KINDS];

/** Plots over a time range (the others use one time step). */
/** The most values a plot's result may hold (planning refuses more). */
export const MAX_OUTPUT_VALUES = 4_000_000;

/** The most dates a result with rows of `rowValues` may hold. */
export function maxDatesFor(rowValues: number, limit = MAX_OUTPUT_VALUES) {
  return Math.floor(limit / Math.max(1, rowValues));
}

export const TIME_RANGE_KINDS: readonly TAnalysisKind[] = [
  ANALYSIS_KINDS.POINT_SERIES,
  ANALYSIS_KINDS.REGION_SERIES,
  ANALYSIS_KINDS.TIME_DEPTH,
  ANALYSIS_KINDS.HOVMOLLER_LON,
  ANALYSIS_KINDS.HOVMOLLER_LAT,
  ANALYSIS_KINDS.HOVMOLLER_PATH,
];

/** Plots at one fixed level (profiles, sections and time–depth span all). */
export const FIXED_LEVEL_KINDS: readonly TAnalysisKind[] = [
  ANALYSIS_KINDS.POINT_SERIES,
  ANALYSIS_KINDS.REGION_SERIES,
  ANALYSIS_KINDS.HOVMOLLER_LON,
  ANALYSIS_KINDS.HOVMOLLER_LAT,
  ANALYSIS_KINDS.HOVMOLLER_PATH,
  ANALYSIS_KINDS.DISTRIBUTION,
];

/** Plots whose second axis is sampled along a drawn path. */
export const PATH_KINDS: readonly TAnalysisKind[] = [
  ANALYSIS_KINDS.SECTION,
  ANALYSIS_KINDS.HOVMOLLER_PATH,
];

export const GEOMETRY_KINDS = {
  POINT: "point",
  BOX: "box",
  POLYGON: "polygon",
  POLYLINE: "polyline",
  COUNTRY: "country",
  SHAPE: "shape",
} as const;

/** Natural Earth boundary scales: 1:110 m, 1:50 m and 1:10 m. */
export const COUNTRY_RESOLUTIONS = {
  COARSE: "110m",
  MEDIUM: "50m",
  FINE: "10m",
} as const;
export type TCountryResolution =
  (typeof COUNTRY_RESOLUTIONS)[keyof typeof COUNTRY_RESOLUTIONS];
export type TCountryGeometry = {
  kind: typeof GEOMETRY_KINDS.COUNTRY;
  /** The first (or only) country. */
  id: string;
  resolution: TCountryResolution;
  /**
   * Several countries together: every id, sorted, `id` among them; absent for
   * one country (links of earlier versions).
   */
  ids?: string[];
};

/** The countries of a country selection, one or several. */
export function countryIds(geometry: TCountryGeometry) {
  return geometry.ids?.length ? geometry.ids : [geometry.id];
}

/** A selection of these countries: one keeps the earlier form. */
export function countriesGeometry(
  ids: string[],
  resolution: TCountryResolution
): TCountryGeometry {
  const unique = [...new Set(ids)].sort();
  return unique.length > 1
    ? { kind: GEOMETRY_KINDS.COUNTRY, id: unique[0], resolution, ids: unique }
    : { kind: GEOMETRY_KINDS.COUNTRY, id: unique[0], resolution };
}

/**
 * An imported shape (GeoJSON, KML/KMZ or a Shapefile): longitude/latitude
 * polygons with holes. A link carries it whole (compressed).
 */
export type TShapeGeometry = {
  kind: typeof GEOMETRY_KINDS.SHAPE;
  /** The file (and feature) name, for titles and exports. */
  name: string;
  /** GeoJSON MultiPolygon coordinates: polygons, rings, [lon, lat]. */
  polygons: number[][][][];
  /** Content hash: caches and identity without the coordinates. */
  digest: string;
  /**
   * Drawn with the Box tool on a map that is not a latitude/longitude grid: the
   * rectangle's footprint as traced there. Read as any shape, so older builds
   * select the same region.
   */
  drawn?: true;
  /** A drawn Box with a moved corner: its name is made from its rings. */
  edited?: true;
  /**
   * Whether each geographic pole was inside the drawn rectangle, decided once
   * where the drawing map showed it as a point. A grid centre at a pole follows
   * this, at every longitude.
   */
  poles?: { north: boolean; south: boolean };
  /**
   * The view it was drawn in: centres near its outline are decided as
   * that view showed them (screenFrame.ts). Part of its identity.
   */
  frame?: TScreenFrame;
};

export type TGeometry =
  | TCountryGeometry
  | TShapeGeometry
  | ({ kind: typeof GEOMETRY_KINDS.POINT } & TLatLon)
  | {
      kind: typeof GEOMETRY_KINDS.BOX;
      west: number;
      east: number;
      south: number;
      north: number;
    }
  | { kind: typeof GEOMETRY_KINDS.POLYGON; vertices: TLatLon[] }
  | { kind: typeof GEOMETRY_KINDS.POLYLINE; vertices: TLatLon[] };

/**
 * A geometry's identity for comparisons and keys: an imported shape by its
 * hash (its coordinates can be hundreds of thousands of numbers).
 */
export function geometryKey(geometry: TGeometry | undefined) {
  return geometry?.kind === GEOMETRY_KINDS.SHAPE
    ? `shape:${geometry.digest}`
    : JSON.stringify(geometry ?? null);
}

/** A public, credential-free reference to the analysed source. */
export type TSourceRef = {
  /** Stable source address without tokens or signed parameters. */
  ref: string;
  name?: string;
  /** Pinned snapshot or generation, when the source exposes one. */
  generation?: string;
  versionStatus: "pinned" | "best-effort" | "session";
  /** The catalog level read, when the catalog has several ("1 of 3: …"). */
  level?: string;
};

export const ALGORITHM_VERSION = 1;

/** The immutable request a plot window commits to. */
export type TAnalysisQuery = {
  version: typeof ALGORITHM_VERSION;
  kind: TAnalysisKind;
  source: TSourceRef;
  /** Variable path within the source. */
  variable: string;
  geometry: TGeometry;
  /**
   * Half-open index range along the time dimension; `fromEnd`: read from
   * its last date back (the earlier dates an Extend adds, so a stop keeps
   * those beside the plot).
   */
  time?: {
    start: number;
    stop: number;
    fromEnd?: boolean;
    /**
     * The stored slices read, when the dates chosen are not stored together
     * (timeSelection.ts): ascending, apart, from `start` to `stop`.
     */
    runs?: [number, number][];
  };
  /** Fixed index along the vertical dimension for series. */
  level?: number;
  /** Fixed index of every other non-spatial dimension. */
  fixed: Record<string, number>;
  /**
   * A partner's forecast lead asked for by its duration in seconds, per
   * dimension: found where the partner is read (its leads may not be
   * read yet where the query is made).
   */
  leadSeconds?: Record<string, number>;
  /**
   * The partner's lead interval in seconds, per dimension, when known:
   * which of two equal leads (a 6 h and a 24 h total ending at +48 h).
   */
  leadInterval?: Record<string, [number, number]>;
  /** HEALPix analysis order: the source order, or a published overview. */
  analysisOrder?: number;
  /** Section horizontal samples. */
  sectionSamples?: number;
  /** Minimum region coverage for displayed means (0..1), off when unset. */
  minCoverage?: number;
  /**
   * An area series of one vector component counted only where this other
   * component is valid too: both means over the same cells, matched by logical
   * index whatever their storage. Refused when the two are not on the same
   * cells.
   */
  jointWith?: string;
  /** `jointWith`'s source when it is not this one's (another store). */
  jointSource?: TRunSource;
  /** Hovmöller bin width in degrees (HEALPix sources; default from order). */
  binDegrees?: number;
  /** Number of value bins of a distribution. */
  valueBins?: number;
};

export type TWorkCounters = {
  plannedChunks: number;
  chunkReads: number;
  cacheHits: number;
  /** Reads joined while another analysis had the same chunk in flight. */
  sharedReads: number;
  absentChunks: number;
  decodedBytes: number;
  indexChunkReads: number;
  indexBytes: number;
  metadataReads: number;
  storeRequests: number;
  storeBytes: number;
  /** HTTP requests seen by the analysis worker (remote sources only). */
  physicalRequests: number;
  physicalBytes: number;
  geometryMs: number;
  /** Summed over concurrent reads, so it can exceed the wall clock. */
  readMs: number;
  /**
   * Part of readMs spent waiting for stored bytes (network or disk); the
   * rest decompresses and decodes them. Summed over concurrent reads.
   */
  fetchMs: number;
  /** Stored (compressed) bytes of the chunks read. */
  fetchedBytes: number;
  reduceMs: number;
  totalMs: number;
  queuedMs: number;
  /** Stored elements decoded and visited (selected elements only). */
  visitedElements: number;
  /** Most bytes held at once in per-chunk reduction arrays. */
  peakAccumulatorBytes: number;
  /** Other runs executing at the same time; store counts then include them. */
  overlappingRuns: number;
  /** Responses without a Content-Length, not included in physicalBytes. */
  physicalUnknownSizes: number;
};

/** Working memory one plot may use (its grid geometry included). */
export const MAX_WORKING_BYTES = 512 * 2 ** 20;

// Bins of a band or sector: at least this wide, and at most this many.
export const MIN_BIN_DEGREES = 0.01;
export const MAX_SPACE_BINS = 3600;
// Value bins of a distribution.
export const MAX_VALUE_BINS = 200;

export function emptyCounters(): TWorkCounters {
  return {
    plannedChunks: 0,
    chunkReads: 0,
    cacheHits: 0,
    sharedReads: 0,
    absentChunks: 0,
    decodedBytes: 0,
    indexChunkReads: 0,
    indexBytes: 0,
    metadataReads: 0,
    storeRequests: 0,
    storeBytes: 0,
    physicalRequests: 0,
    physicalBytes: 0,
    geometryMs: 0,
    visitedElements: 0,
    peakAccumulatorBytes: 0,
    overlappingRuns: 0,
    physicalUnknownSizes: 0,
    readMs: 0,
    fetchMs: 0,
    fetchedBytes: 0,
    reduceMs: 0,
    totalMs: 0,
    queuedMs: 0,
  };
}

type TTimeCoordinate = {
  dimension: string;
  raw: number[];
  /** Declared cell bounds, [start, end] per step, flat (when published). */
  bounds?: number[];
  /** Why declared bounds could not be used: durations are not guessed. */
  boundsUnread?: string;
  units?: string;
  calendar?: string;
  /** The coordinate's CF standard name (`forecast_reference_time`, …). */
  standardName?: string;
  /** Why raw values are shown instead of dates. */
  note?: string;
  /** Intensive or extensive (see quantityKind), when known. */
  quantity?: "intensive" | "extensive";
  /**
   * Forecast reference times with their valid times published beside
   * them (an auxiliary `time` coordinate), in the same units.
   */
  valid?: number[];
  /** Their published cells, [start, end] per row. */
  validBounds?: number[];
  /** Why those cells are declared but unknown. */
  validBoundsUnread?: string;
  /** Why the source's clocks cannot date its rows. */
  clockProblem?: string;
  /** Each valid time's own reference time, in the same units. */
  references?: number[];
};

/** A forecast's one reference time, named as a scalar coordinate. */
export type TReferenceTime = {
  name: string;
  value: number;
  units: string;
  calendar?: string;
};

type TVerticalCoordinate = {
  dimension: string;
  label: string;
  units?: string;
  positive?: "up" | "down";
  physical: boolean;
  note?: string;
  /** Coordinate values along the vertical dimension (model or physical). */
  values: number[];
  /** Published layer bounds, [low, high] per level, flat. */
  bounds?: number[];
  /** A formula axis's own (model) coordinate, e.g. sigma [0.5, 1]. */
  model?: { values: number[]; label: string };
  /**
   *  Positions from an auxiliary coordinate (`depth(obs)`): its name and
   * the dimension's own coordinate (observation IDs), when numeric.
   */
  auxiliary?: {
    name: string;
    native?: number[];
    /** 64-bit integer IDs exactly, as text, with their stored type. */
    nativeIds?: string[];
    nativeType?: string;
  };
  /** CF standard name of the physical positions, when known. */
  standardName?: string;
  /** Intensive or extensive (see quantityKind), when known. */
  quantity?: "intensive" | "extensive";
};

/** The one level a horizontal result was taken at (scalar coordinate). */
type TFixedLevel = {
  dimension: string;
  index: number;
  /** Physical position (source coordinate), when the axis has one. */
  value?: number;
  units?: string;
  positive?: "up" | "down";
  standardName?: string;
  /** Its published layer bounds, when the axis has them. */
  bounds?: [number, number];
};

/** Per sample: a value, a missing value in a stored cell, or no stored cell. */
export const SAMPLE_STATUS = {
  OK: "ok",
  MISSING: "missing",
  OUTSIDE: "no stored cell",
} as const;

export type TSampleStatus = (typeof SAMPLE_STATUS)[keyof typeof SAMPLE_STATUS];

/**
 * A cell's position from its locator, one exact decimal per dimension (a
 * HEALPix id above 2^53 stays exact); exports read it, never the label.
 */
type TCellIndex = { dims: string[]; values: string[] };

type TSampleInfo = {
  /** Metres along the path from its first point. */
  distances: number[];
  lats: number[];
  lons: number[];
  /** Decimal cell ids (HEALPix) or "i,j" (rectilinear); "" when outside. */
  cells: string[];
  /** Structured positions per sample (`values` empty when outside). */
  index?: { dims: string[]; values: string[][] };
  status: TSampleStatus[];
  /** How each sample found its value, e.g. "containing cell (from bounds)". */
  method: string;
  spacingMeters: number;
  radiusMeters: number;
  /** The path as sampled: validated vertices with repeats collapsed. */
  vertices: { lat: number; lon: number }[];
};

/** A section is a path (one value per sample) or a curtain (sample × level). */
export const SECTION_MODES = {
  PATH: "path",
  CURTAIN: "curtain",
} as const;

export type TAnalysisResult = {
  kind: TAnalysisKind;
  query: TAnalysisQuery;
  units?: string;
  /** CF `units_metadata` of the values (temperature: difference). */
  unitsMetadata?: string;
  /**
   * The variable's CF standard name as its dataset described it, frozen when
   * the plot became a snapshot ("" for none): another dataset's catalog never
   * says what these values are.
   */
  standardName?: string;
  /** CF `cell_methods` of the field ("time: mean", "time: maximum"…). */
  cellMethods?: string;
  longName?: string;
  /** Row-major values; NaN marks missing. */
  values: number[];
  shape: number[];
  dims: string[];
  time?: TTimeCoordinate;
  /** Valid times along `time`, initialized at this one reference time. */
  referenceTime?: TReferenceTime;
  vertical?: TVerticalCoordinate;
  /** The fixed level of a result without a vertical axis. */
  fixedLevel?: TFixedLevel;
  /**
   * The index chosen along each other dimension (an ensemble member with its
   * identifier): exported as scalar coordinates.
   */
  selections?: {
    dimension: string;
    index: number;
    id?: string;
    /** The source identifiers' stored type (`uint64`, `int16`, …). */
    idType?: string;
    /** Its identifier is the coordinate's declared missing value. */
    idMissing?: true;
    /**
     * How every identifier along the dimension is written: one 64-bit
     * integer type, float64, or text (identifiers.ts).
     */
    idEncoding?: TIdEncoding;
    ensemble?: boolean;
    /** A fixed forecast lead time: its value, units and CF name. */
    value?: number;
    units?: string;
    standardName?: string;
    /** Seconds in one unit of `value`. */
    seconds?: number;
    /** The lead's published interval (an accumulation's), in its units. */
    valueBounds?: [number, number];
    /**
     * The lead declares an interval that could not be read (missing or
     * malformed bounds): what it covers is unknown, so nothing interval-
     * sensitive pairs with it.
     */
    valueBoundsUnknown?: true;
  }[];
  /** Per-column physical vertical positions for sections (samples x levels). */
  columnVertical?: number[];
  region?: {
    totalCells: string;
    storedCells: number;
    coverage: number[];
    validCells: number[];
    footprintCoverage: number;
    weighting: string;
    /** A mean of sites (each counts once), not of an area. */
    sites?: boolean;
    /** Counted only where `query.jointWith` is valid too. */
    joint?: boolean;
    /**
     * Cells inside left out for want of an area: coverage is then of the
     * cells with one, and the footprint's total area is unknown.
     */
    unweighedCells?: number;
    /**
     * Per time step: the area-weighted standard deviation about the mean,
     * and the smallest and largest valid cell value in the area.
     */
    spread?: TAreaSpread;
  };
  samples?: TSampleInfo;
  sectionMode?: (typeof SECTION_MODES)[keyof typeof SECTION_MODES];
  /**
   * The second axis of a time × space result (time comes first; values are
   * row-major by time): longitude or latitude bins, path samples (distance
   * in metres) or levels.
   */
  axis?: {
    dimension: string;
    label: string;
    units?: string;
    values: number[];
    /** Edges of each bin (one more than the values), when binned. */
    bounds?: number[];
    /** How each value was formed, e.g. "mean over 5° S–5° N, area weighted". */
    reduction: string;
  };
  /** Valid-area fraction of each band or sector mean (same shape as values). */
  cellCoverage?: number[];
  /**
   * A distribution's cells for a map of the area (when it holds at most
   * MAX_FIELD_CELLS and the grid gives centres): every visited cell,
   * missing values NaN.
   */
  field?: { lat: number[]; lon: number[]; values: number[] };
  /** A distribution: shares of valid area per value bin. */
  histogram?: {
    edges: number[];
    validFraction: number;
    validCells: number;
    selectedCells: number;
    mean: number;
    weighting: string;
    /** Selected cells without a known area: left out of valid area. */
    unweighedCells?: number;
    /** Every valid value is this one: a single bin holds all valid area. */
    constant?: number;
    /** Percentiles, σ, skewness and a smoothed curve (two values or more). */
    summary?: TDistributionSummary;
  };
  cell?: {
    id: string;
    /** False when the cell is not stored (outside the grid, or absent from a packed source). */
    stored?: boolean;
    lat: number;
    lon: number;
    selection: string;
    /**
     * Decimals its centre needs to be told from its neighbours' (a grid of
     * microdegrees: 7), when the grid's spacing says.
     */
    decimals?: number;
    index?: TCellIndex;
    /**
     * The cell's extent in degrees (latitude, longitude), when known: its
     * published bounds, or its width; two equal centres are not the same
     * support when these differ.
     */
    footprint?: {
      lat: number;
      lon: number;
      /** Its south and west edges, when known (west in [−180, 180)). */
      south?: number;
      west?: number;
    };
  };
  grid: {
    kind: string;
    order?: number;
    frame?: string;
    indexValidation?: string;
    conflicts: string[];
  };
  decoding: string;
  approximation?: string;
  /** Set while a streamed series is incomplete: parts read so far. */
  partial?: {
    done: number;
    total: number;
    readUntil: number;
    /** Read from the end (`time.fromEnd`): dates before this are not read. */
    readFrom?: number;
    /**
     * `done` and `total` count stored chunks of one date (a cross-section
     * filling in), not dates: none of the date is complete yet.
     */
    chunks?: true;
    /** Counted only: nothing to draw until the end (formula heights). */
    countOnly?: true;
  };
  /**
   * A section filling in by chunks: 1 where a value has arrived, so a
   * missing value reads apart from one not read yet.
   */
  cellRead?: number[];
  notes: string[];
  counters: TWorkCounters;
};

/**
 * One streamed part of a series. The first update carries the result
 * skeleton (axes, labels, notes); later ones carry only the values from
 * `offset` on, so the time axis crosses the worker boundary once.
 */
type TAreaSpread = { std: number[]; min: number[]; max: number[] };

/** How an area series shows its spread: a ±1σ band or the min–max range. */
export const SPREAD_VIEWS = { STD: "std", RANGE: "range" } as const;
export type TSpreadView = (typeof SPREAD_VIEWS)[keyof typeof SPREAD_VIEWS];

export type TPartialUpdate = {
  base?: TAnalysisResult;
  /** The base's columns are cut to the steps read: pad them to this. */
  padTo?: number;
  offset: number;
  values: number[];
  coverage?: number[];
  validCells?: number[];
  spread?: TAreaSpread;
  cellCoverage?: number[];
  /** Single values at their places (a section's newly read cells). */
  cells?: { at: number[]; values: number[] };
  partial: NonNullable<TAnalysisResult["partial"]>;
  counters: TWorkCounters;
};

export type TPlanEstimate = {
  chunks: number;
  decodedBytes: number;
  workingBytes: number;
  outputValues: number;
  /**
   * Coordinate, bounds and topology chunks read before the first field
   * read when the native geometry is not loaded yet (0 when cached).
   */
  geometryReads?: number;
  /**
   * Ask before running even a streamed plot: the coordinate reads come
   * before anything is shown.
   */
  needsConfirmation?: boolean;
  /** Whether the request is small enough to start without confirmation. */
  modest: boolean;
  notes: string[];
  /**
   * Of `chunks` and `decodedBytes`, the other arrays' (a vector partner,
   * formula terms): stored along time their own way, so not shared by the
   * field's time chunks.
   */
  termChunks?: number;
  termBytes?: number;
  /**
   * The index runs each array's reads cover (the partner's at its own
   * rows), for pricing the shards they touch; planning only.
   */
  shardRuns?: {
    own: [number, number][][];
    partner?: [number, number][][];
  };
};
