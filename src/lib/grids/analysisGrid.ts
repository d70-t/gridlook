import type { EllipsoidInput, GridOptions, IndexingScheme } from "healpix-geo";

/**
 * The spatial reference of a HEALPix source, shared by map picking and
 * analysis so both resolve the same cell for the same coordinate.
 */
const HEALPIX_FRAME_SOURCES = {
  EASYGEMS: "easygems",
  DGGS: "dggs",
  EASYGEMS_WITH_DGGS_ELLIPSOID: "easygems+dggs-ellipsoid",
  CELL_COUNT: "cell-count",
} as const;

type THealpixFrameSource =
  (typeof HEALPIX_FRAME_SOURCES)[keyof typeof HEALPIX_FRAME_SOURCES];

export type THealpixFrame = {
  options: GridOptions;
  source: THealpixFrameSource;
  /** Human-readable description of the reference body actually used. */
  ellipsoidLabel: string;
  /** Disagreements between metadata conventions, reported to the user. */
  conflicts: string[];
};

type TAttrs = Record<string, unknown>;

const NAMED_ELLIPSOIDS: Record<string, EllipsoidInput> = {
  // eslint-disable-next-line camelcase
  wgs84: { semi_major_axis: 6378137, inverse_flattening: 298.257223563 },
  // eslint-disable-next-line camelcase
  grs80: { semi_major_axis: 6378137, inverse_flattening: 298.257222101 },
};

function finitePositive(value: unknown) {
  const numeric = Number(value);
  return Number.isFinite(numeric) && numeric > 0 ? numeric : undefined;
}

function pick(attrs: TAttrs, keys: string[]) {
  for (const key of keys) {
    const value = finitePositive(attrs[key]);
    if (value !== undefined) {
      return value;
    }
  }
  return undefined;
}

/**
 * The healpix-geo form of a declared ellipsoid. Publishers spell the axes
 * differently (`semimajor_axis` in the DGGS examples), and healpix-geo
 * rejects anything but its exact keys, so known spellings are mapped.
 * Explicit axes take precedence over a name.
 */
export function normalizeEllipsoid(
  value: unknown
): { ellipsoid: EllipsoidInput | null; label: string } | { error: string } {
  if (value === null || value === undefined) {
    return { ellipsoid: null, label: "sphere, radius 6370997 m (default)" };
  }
  if (typeof value === "string") {
    const named = NAMED_ELLIPSOIDS[value.toLowerCase().replace(/[\s_-]/g, "")];
    return named
      ? { ellipsoid: named, label: value }
      : { error: `Unknown ellipsoid name "${value}".` };
  }
  if (typeof value !== "object") {
    return { error: `Unreadable ellipsoid ${JSON.stringify(value)}.` };
  }
  const attrs = value as TAttrs;
  const radius = pick(attrs, ["radius"]);
  const a = pick(attrs, ["semi_major_axis", "semimajor_axis", "semiMajorAxis"]);
  const b = pick(attrs, ["semi_minor_axis", "semiminor_axis", "semiMinorAxis"]);
  const inverseFlattening = pick(attrs, [
    "inverse_flattening",
    "inverseFlattening",
  ]);
  const name = typeof attrs.name === "string" ? attrs.name : undefined;
  if (radius !== undefined) {
    return { ellipsoid: { radius }, label: `sphere, radius ${radius} m` };
  }
  if (a !== undefined && inverseFlattening !== undefined) {
    return {
      // eslint-disable-next-line camelcase
      ellipsoid: { semi_major_axis: a, inverse_flattening: inverseFlattening },
      label: `${name ?? "ellipsoid"} (a ${a} m, 1/f ${inverseFlattening})`,
    };
  }
  if (a !== undefined && b !== undefined) {
    return {
      // eslint-disable-next-line camelcase
      ellipsoid: { semi_major_axis: a, semi_minor_axis: b },
      label: `${name ?? "ellipsoid"} (a ${a} m, b ${b} m)`,
    };
  }
  if (name) {
    return normalizeEllipsoid(name);
  }
  return { error: `Unreadable ellipsoid ${JSON.stringify(value)}.` };
}

function integerLevelFromNside(value: unknown) {
  const nside = Number(value);
  if (!Number.isInteger(nside) || nside <= 0) {
    return undefined;
  }
  const level = Math.log2(nside);
  return Number.isInteger(level) ? level : undefined;
}

function scheme(value: unknown): IndexingScheme | undefined {
  if (value === undefined || value === null) {
    return undefined;
  }
  const text = String(value).toLowerCase();
  return (text === "nest" ? "nested" : text) as IndexingScheme;
}

export type THealpixMetadata = {
  /** Attributes of the CF grid-mapping variable, if any. */
  crsAttrs?: TAttrs;
  /** The `dggs` group attribute, if any. */
  dggs?: TAttrs | null;
  /** Length of the cell axis, used only when nothing else is declared. */
  cellCount?: number;
};

function fromDggs(dggs: TAttrs, conflicts: string[]): THealpixFrame | null {
  const level = Number(dggs.refinement_level);
  const indexing = scheme(dggs.indexing_scheme);
  if (!Number.isInteger(level) || level < 0 || !indexing) {
    return null;
  }
  const ellipsoid = normalizeEllipsoid(dggs.ellipsoid);
  if ("error" in ellipsoid) {
    throw new Error(`HEALPix dggs metadata: ${ellipsoid.error}`);
  }
  return {
    options: { scheme: indexing, level, ellipsoid: ellipsoid.ellipsoid },
    source: HEALPIX_FRAME_SOURCES.DGGS,
    ellipsoidLabel: ellipsoid.label,
    conflicts,
  };
}

/**
 * Easygems (`healpix_nside`/`healpix_order` on the grid mapping) keeps
 * precedence for the level and scheme, as before. It cannot declare a
 * reference body, so an ellipsoid declared by the `dggs` convention of the
 * same level is now used instead of silently assuming the sphere.
 */
// eslint-disable-next-line max-lines-per-function
export function resolveHealpixFrame(meta: THealpixMetadata): THealpixFrame {
  const conflicts: string[] = [];
  const crs = meta.crsAttrs ?? {};
  const easyLevel = integerLevelFromNside(crs.healpix_nside);
  const easyScheme = scheme(crs.healpix_order);
  const dggs = meta.dggs ?? undefined;
  if (easyLevel !== undefined && easyScheme) {
    const frame: THealpixFrame = {
      options: { scheme: easyScheme, level: easyLevel },
      source: HEALPIX_FRAME_SOURCES.EASYGEMS,
      ellipsoidLabel: "sphere, radius 6370997 m (default)",
      conflicts,
    };
    if (dggs) {
      const dggsLevel = Number(dggs.refinement_level);
      const dggsScheme = scheme(dggs.indexing_scheme);
      if (
        dggsLevel !== easyLevel ||
        (dggsScheme && dggsScheme !== easyScheme)
      ) {
        conflicts.push(
          `Grid mapping says order ${easyLevel} (${easyScheme}), dggs metadata says order ${dggsLevel} (${dggsScheme}); the grid mapping is used.`
        );
        return frame;
      }
      // The map draws an Easygems grid on its sphere: plots locate cells in the
      // same frame, or a click would plot another cell than the one drawn under
      // it. A DGGS ellipsoid beside it is named, not applied.
      const ellipsoid = normalizeEllipsoid(dggs.ellipsoid);
      if ("error" in ellipsoid) {
        conflicts.push(`${ellipsoid.error} The default sphere is used.`);
      } else if (ellipsoid.ellipsoid) {
        conflicts.push(
          `The dggs metadata declares the ${ellipsoid.label} ellipsoid; the map draws this grid on its sphere (grid mapping), so plots use that sphere too.`
        );
      }
    }
    return frame;
  }
  if (dggs) {
    const frame = fromDggs(dggs, conflicts);
    if (frame) {
      return frame;
    }
  }
  const count = meta.cellCount ?? 0;
  const nside = Math.sqrt(count / 12);
  const level = integerLevelFromNside(nside);
  if (level !== undefined) {
    return {
      options: { scheme: "nested", level },
      source: HEALPIX_FRAME_SOURCES.CELL_COUNT,
      ellipsoidLabel: "sphere, radius 6370997 m (assumed)",
      conflicts,
    };
  }
  throw new Error(
    "Could not determine HEALPix grid parameters: no valid convention metadata on the grid mapping variable" +
      " or in the group metadata (tried the Easygems and dggs zarr conventions), and " +
      "the cell-dimension length is not 12 * nside^2."
  );
}

/** Whether a length is a whole HEALPix sphere (12 × 4^order cells). */
function isHealpixCount(length: number) {
  const nside = Math.sqrt(length / 12);
  return Number.isInteger(nside) && nside >= 1 && (nside & (nside - 1)) === 0;
}

/**
 * Index of the HEALPix cell axis among a variable's dimensions: the one its
 * metadata or cell coordinate names; otherwise the last whose length is
 * the level's cell count (`expected`, from the metadata), or any whole
 * sphere's. -1 when none is: a variable without cells (a global mean, a
 * single station), which a plot cannot place.
 */
export function healpixCellAxis(
  dimensionNames: string[],
  shape: number[],
  dggs?: TAttrs | null,
  coordinateDimension?: string,
  expected?: number
) {
  const declared =
    typeof dggs?.spatial_dimension === "string"
      ? dggs.spatial_dimension
      : coordinateDimension;
  const index = declared ? dimensionNames.indexOf(declared) : -1;
  if (index >= 0) {
    return index;
  }
  // A grid that names its spatial dimension: a field without it is not on the
  // grid, whatever axis has the same length. Likewise a cell coordinate's own
  // dimension.
  if (
    typeof dggs?.spatial_dimension === "string" ||
    coordinateDimension !== undefined
  ) {
    return -1;
  }
  for (let at = shape.length - 1; at >= 0; at--) {
    if (
      expected !== undefined
        ? shape[at] === expected
        : isHealpixCount(shape[at])
    ) {
      return at;
    }
  }
  return -1;
}

/**
 * A monotonic 1-D rectilinear axis with optional cell bounds. Longitudes may
 * be periodic.
 */
export type TRectilinearAxis = {
  values: Float64Array;
  /** `[low, high]` per cell, or undefined when not published. */
  bounds?: Float64Array;
  /** A global longitude axis: its ends are neighbours across the seam. */
  periodic: boolean;
  /** A longitude axis: equivalent longitudes (x ± 360) name the same place. */
  longitude?: boolean;
};

function wrapNear(value: number, reference: number) {
  return value + 360 * Math.round((reference - value) / 360);
}

/** Cell bounds `[low, high]` of a bounded cell, unwrapped about its centre. */
export function cellInterval(
  axis: TRectilinearAxis,
  at: number
): [number, number] {
  const centre = axis.values[at];
  let low = axis.bounds![2 * at];
  let high = axis.bounds![2 * at + 1];
  // Any longitude axis, global or regional: a bound written as 359° for a
  // cell centred on 0° means −1°. A full circle stays a full circle.
  if ((axis.periodic || axis.longitude) && Math.abs(high - low) >= 360 - 1e-9) {
    return [centre - 180, centre + 180];
  }
  if (axis.periodic || axis.longitude) {
    // Both edges together: the interval (or the rest of the circle, when
    // written across the seam) that holds the centre, whatever its width.
    const [a, b] = low <= high ? [low, high] : [high, low];
    const held = holding(a, b, centre) ?? holding(b, a + 360, centre);
    if (held) {
      return held;
    }
    low = wrapNear(low, centre);
    high = wrapNear(high, centre);
  }
  return low <= high ? [low, high] : [high, low];
}

/** `[low, high]` moved by whole turns to hold `centre`, if it can. */
function holding(
  low: number,
  high: number,
  centre: number
): [number, number] | undefined {
  const turns = Math.ceil((centre - high) / 360 - 1e-12);
  const [l, h] = [low + 360 * turns, high + 360 * turns];
  return l <= centre + 1e-9 && centre <= h + 1e-9 ? [l, h] : undefined;
}

/**
 * Whether a cell's upper bound is the outer edge of a non-periodic axis
 * (no other cell starts at or above it), so the edge belongs to this cell.
 */
function outerHigh(axis: TRectilinearAxis, at: number) {
  if (axis.periodic) {
    return false;
  }
  const high = cellInterval(axis, at)[1];
  for (const k of [0, axis.values.length - 1]) {
    if (k !== at && cellInterval(axis, k)[1] >= high) {
      return false;
    }
  }
  return true;
}

/** Index of the centre nearest to `x` on a monotonic axis (binary search). */
function nearestCentre(values: Float64Array, x: number) {
  const descending = values.length > 1 && values[values.length - 1] < values[0];
  let lo = 0;
  let hi = values.length - 1;
  while (lo < hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (descending ? values[mid] > x : values[mid] < x) {
      lo = mid + 1;
    } else {
      hi = mid;
    }
  }
  const before = Math.max(0, lo - 1);
  return Math.abs(values[before] - x) <= Math.abs(values[lo] - x) ? before : lo;
}

/**
 * Half the local spacing on one side of a centre, from its neighbour; on a
 * periodic axis the ends are neighbours across the seam.
 */
function halfSpacing(
  values: Float64Array,
  at: number,
  side: -1 | 1,
  periodic: boolean
) {
  const n = values.length;
  let neighbour = values[at + side];
  if (neighbour === undefined && periodic && n > 1) {
    neighbour = wrapNear(values[(at + side + n) % n], values[at]);
  }
  neighbour ??= values[at - side];
  return neighbour === undefined ? 0 : Math.abs(neighbour - values[at]) / 2;
}

/** A bounded axis: the cell whose bounds contain `x`, or -1. */
function locateBounded(axis: TRectilinearAxis, x: number, guess: number) {
  const { values, periodic } = axis;
  const cyclic = periodic || Boolean(axis.longitude);
  const inside = (at: number) => {
    const [low, high] = cellInterval(axis, at);
    // A full-circle cell holds every longitude, its seam included.
    if (cyclic && high - low >= 360 - 1e-9) {
      return Number.isFinite(x);
    }
    // Near the middle of the cell, not its representative centre, which may lie
    // far off it in a wide cell.
    const probe = cyclic ? wrapNear(x, (low + high) / 2) : x;
    // Half-open, except the axis' outer edge (90° N on a bounded
    // latitude axis): no cell lies beyond it to claim that edge.
    return (
      probe >= low && (probe < high || (probe === high && outerHigh(axis, at)))
    );
  };
  for (const at of [guess, guess - 1, guess + 1]) {
    if (at >= 0 && at < values.length && inside(at)) {
      return { index: at, nearest: false };
    }
  }
  // A longitude axis may hold the cell at the other end of the array: periodic,
  // or regional across the wrap. Each cell wraps the query near itself, so a
  // true gap stays missing.
  for (const at of cyclic ? [0, values.length - 1] : []) {
    if (inside(at)) {
      return { index: at, nearest: false };
    }
  }
  return { index: -1, nearest: false };
}

/**
 * Index of the cell containing `x`, or -1. With bounds, containment uses
 * the bounds (unwrapped about each centre on a periodic axis; a shared edge
 * belongs to the cell above it). Without bounds, the nearest centre within
 * half the local spacing on that side is returned with `nearest: true`.
 */
export function locateOnAxis(axis: TRectilinearAxis, x: number) {
  const { values, bounds, periodic } = axis;
  if (values.length === 0) {
    return { index: -1, nearest: !bounds };
  }
  const cyclic = periodic || Boolean(axis.longitude);
  const probeFor = (at: number) => (cyclic ? wrapNear(x, values[at]) : x);
  // On a periodic axis, search with the longitude wrapped into the axis'
  // own range (about its middle), whatever convention the query uses.
  const middle = (values[0] + values[values.length - 1]) / 2;
  const guess = nearestCentre(values, cyclic ? wrapNear(x, middle) : x);
  if (bounds) {
    return locateBounded(axis, x, guess);
  }
  let best = guess;
  if (periodic) {
    let bestDistance = Number.POSITIVE_INFINITY;
    for (const at of [guess, 0, values.length - 1]) {
      const distance = Math.abs(probeFor(at) - values[at]);
      if (distance < bestDistance) {
        best = at;
        bestDistance = distance;
      }
    }
  }
  const delta = probeFor(best) - values[best];
  const descending = values.length > 1 && values[values.length - 1] < values[0];
  const side = delta >= 0 !== descending ? 1 : -1;
  const inside =
    Math.abs(delta) <= halfSpacing(values, best, side, periodic) + 1e-12;
  return { index: inside ? best : -1, nearest: true };
}

/** Spherical weight of one latitude cell from its bounds. */
export function latitudeWeightAt(bounds: ArrayLike<number>, at: number) {
  const low = (Math.max(-90, Math.min(90, bounds[2 * at])) * Math.PI) / 180;
  const high =
    (Math.max(-90, Math.min(90, bounds[2 * at + 1])) * Math.PI) / 180;
  // sin h − sin l as 2 cos((h + l)/2) sin((h − l)/2): no cancellation in narrow
  // cells near a pole.
  return Math.abs(2 * Math.cos((high + low) / 2) * Math.sin((high - low) / 2));
}

/** Weight (radians of longitude) of one longitude cell from its bounds. */
export function longitudeWeightAt(axis: TRectilinearAxis, at: number) {
  const [low, high] = cellInterval(axis, at);
  return ((high - low) * Math.PI) / 180;
}

/** Weight (radians) of each longitude cell from its bounds. */
export function longitudeWeights(axis: TRectilinearAxis) {
  if (!axis.bounds) {
    return undefined;
  }
  return Float64Array.from(axis.values, (_, at) => longitudeWeightAt(axis, at));
}

/** Group paths of the levels a multiscale (pyramid) attribute publishes. */
export function publishedLevels(attrs: Record<string, unknown> | null) {
  const multiscales = attrs?.multiscales as unknown;
  if (Array.isArray(multiscales)) {
    return multiscales.flatMap((entry) =>
      ((entry as { datasets?: { path?: string }[] }).datasets ?? []).map((d) =>
        String(d.path)
      )
    );
  }
  const layout = (multiscales as { layout?: { asset?: string }[] } | undefined)
    ?.layout;
  return Array.isArray(layout)
    ? layout.map((entry) => String(entry.asset))
    : [];
}

/** Path inside the most specific published level containing the variable. */
export function pyramidRelativePath(variable: string, levels: string[]) {
  let own = "";
  for (const level of levels) {
    if (level.length > own.length && variable.startsWith(level + "/")) {
      own = level;
    }
  }
  return own ? variable.slice(own.length + 1) : undefined;
}
