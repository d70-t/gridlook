/**
 * Cell areas of a latitude × longitude grid for area means. In order: the
 * variable's declared CF cell measure (`cell_measures: "area: areacella"`),
 * found in the dataset, its catalog routes, or (CMIP6, declared external)
 * the matching fixed-field store beside it, each checked against the grid;
 * then published latitude/longitude bounds; then, for a regular grid only,
 * edges halfway between centres (a labelled approximation).
 */
import { AnalysisInputError } from "./analysisErrors.ts";
import {
  chunkByteSize,
  MAX_STORED_CHUNK_BYTES,
  throwIfAborted,
  type TAnalysisArray,
} from "./chunkVisitor.ts";
import {
  readAllShared,
  readAlong,
  readNative,
  readNativeCells,
} from "./nativeGrid.ts";
import { SharedReads } from "./sharedRead.ts";
import {
  isMissing,
  openReferenced,
  type TAnalysisDataset,
} from "./sourceAdapter.ts";
import { isAreaUnit } from "./unitConvert.ts";

import {
  latitudeWeightAt,
  longitudeWeightAt,
  type TRectilinearAxis,
} from "@/lib/grids/analysisGrid.ts";

/** A declared, checked cell measure of a rectilinear grid. */
export type TCellAreas = {
  /** The measure's variable name (areacella). */
  name: string;
  /** Where it was found: the data store, or the store's address. */
  origin: string;
  units: string;
  array: TAnalysisArray;
  /** The dataset that reads it (the data store's, or the sibling's). */
  dataset: TAnalysisDataset;
  /** The grid's [latitude, longitude] dimension names. */
  dims: [string, string];
  /**
   * A sibling store's measure: that its coordinates are this grid's, checked
   * when an area plot first needs it, then kept. Throws the reason when they
   * are not.
   */
  verify?: (signal?: AbortSignal) => Promise<void>;
  /**
   * The stored coordinate chunks `verify` reads, and what they decode to
   * (their declared chunk shape and type, padding included); none once it
   * has checked.
   */
  verifyCost?: () => Promise<{ reads: number; bytes: number }>;
};

/** The measure a variable declares for its areas: `area: name`. */
export function declaredMeasure(attrs: Record<string, unknown>) {
  return /\barea:\s*(\S+)/.exec(String(attrs.cell_measures ?? ""))?.[1];
}

/** CMIP6 fixed-field tables of the usual measures. */
const FIXED_TABLE: Record<string, string> = {
  areacella: "fx",
  areacellr: "fx",
  areacello: "Ofx",
};

/**
 * The CMIP6 store holding a fixed field of the same model, experiment,
 * member and grid: `…/<table>/<variable>/<grid>/<version>` becomes
 * `…/<fixed table>/<measure>/<grid>/<version>`. Only for a store whose
 * address names the variable itself (a Data Reference Syntax path).
 */
export function cmip6FixedStore(
  store: string,
  variable: string,
  measure: string
) {
  const table = FIXED_TABLE[measure];
  const match = /^(.*)\/[^/]+\/([^/]+)\/(g[a-z0-9]*)\/(v\d{8})$/i.exec(
    store.replace(/\/+$/, "")
  );
  if (!table || !match || match[2] !== variable) {
    return undefined;
  }
  return `${match[1]}/${table}/${measure}/${match[3]}/${match[4]}/`;
}

type TGridAxes = {
  /** The field's latitude and longitude dimensions. */
  latDim: string;
  lonDim: string;
  /** Their coordinate variables. */
  latName: string;
  lonName: string;
  lat: TRectilinearAxis;
  lon: TRectilinearAxis;
};

/** Why a measure does not fit the grid, or undefined when it does. */
function misfit(measure: TAnalysisArray, grid: TGridAxes) {
  const dims = measure.dimensionNames;
  const length = (dim: string) =>
    dim === grid.latDim
      ? grid.lat.values.length
      : dim === grid.lonDim
        ? grid.lon.values.length
        : -1;
  // A scalar (rank 0) is one area for every cell, as on meshes.
  if (
    dims.length !== measure.shape.length ||
    dims.length > 2 ||
    dims.some((dim, d) => length(dim) !== measure.shape[d])
  ) {
    return `has dimensions (${dims.join(", ")}) and shape [${measure.shape.join(", ")}], not the grid's (${grid.latDim}, ${grid.lonDim}) [${grid.lat.values.length}, ${grid.lon.values.length}]`;
  }
  const units = String(measure.attrs.units ?? "");
  if (!isAreaUnit(units)) {
    return `is in ${units ? `"${units}"` : "no units"}, not an area`;
  }
  return undefined;
}

/** Whether a sibling store's coordinate equals the grid's axis. */
// eslint-disable-next-line max-lines-per-function
async function sameAxis(
  dataset: TAnalysisDataset,
  name: string,
  axis: TRectilinearAxis,
  turns = false,
  signal?: AbortSignal
) {
  const coordinate = await dataset.openArray(name);
  if (
    coordinate.shape.length !== 1 ||
    coordinate.shape[0] !== axis.values.length
  ) {
    return false;
  }
  const values = await readNative(
    dataset,
    coordinate,
    [coordinate.dimensionNames[0]],
    coordinate.shape,
    1,
    coordinate.attrs,
    signal
  );
  // Longitudes are the same places a whole turn apart.
  const gap = (a: number, b: number) => {
    const d = Math.abs(a - b);
    return turns ? Math.abs(d - 360 * Math.round(d / 360)) : d;
  };
  // To a thousandth of the local cell, 1e-6° at most, and the precision of the
  // values compared: a fixed 1e-6° took in most of a one-microdegree cell.
  const n = axis.values.length;
  const spacing = (at: number) =>
    n < 2
      ? Infinity
      : Math.abs(
          axis.values[Math.min(at + 1, n - 1)] -
            axis.values[Math.max(at - 1, 0)]
        ) / (at > 0 && at < n - 1 ? 2 : 1);
  const tolerance = (a: number, b: number, width: number) =>
    Math.min(
      1e-6,
      Math.max(
        1e-3 * width,
        8 * Number.EPSILON * Math.max(1, Math.abs(a), Math.abs(b))
      )
    );
  if (
    !values.every(
      (value, at) =>
        gap(value, axis.values[at]) <=
        tolerance(value, axis.values[at], spacing(at))
    )
  ) {
    return false;
  }
  // The same cells, not only the same centres: where both publish bounds they
  // agree too.
  const boundsName = coordinate.attrs.bounds;
  if (!axis.bounds || typeof boundsName !== "string") {
    return true;
  }
  const bounds = await dataset.openArray(boundsName);
  if (bounds.shape.length !== 2 || bounds.shape[0] !== axis.values.length) {
    return false;
  }
  // Bounds without units take their coordinate's, radians included.
  const edges = await readNative(
    dataset,
    bounds,
    bounds.dimensionNames,
    bounds.shape,
    undefined,
    bounds.attrs.units === undefined ? coordinate.attrs : bounds.attrs,
    signal
  );
  const ours = axis.bounds;
  // Each known edge against the field's known edge on the same side of the
  // cell's centre: one edge unknown says nothing against the match, but a known
  // edge that disagrees does.
  const side = (edge: number, centre: number) => {
    let d = edge - centre;
    if (turns) {
      d -= 360 * Math.round(d / 360);
    }
    return d < 0 ? 0 : 1;
  };
  // A cell's width as the arc between its edges that holds its centre: a
  // microdegree cell across the date line is a microdegree, not 360°.
  const arc = (pair: number[], centre: number) => {
    const raw = pair[1] - pair[0];
    if (!turns) {
      return Math.abs(raw);
    }
    if (Math.abs(raw) >= 360 - 1e-9) {
      return 360;
    }
    const [a, b] = raw >= 0 ? [pair[0], pair[1]] : [pair[1], pair[0]];
    const east = (((b - a) % 360) + 360) % 360;
    const off = (((centre - a) % 360) + 360) % 360;
    return off <= east + 1e-9 ? east : 360 - east;
  };
  for (let at = 0; at < axis.values.length; at++) {
    const centre = axis.values[at];
    const t = [edges[2 * at], edges[2 * at + 1]].filter(Number.isFinite);
    const m = [ours[2 * at], ours[2 * at + 1]].filter(Number.isFinite);
    const width =
      m.length === 2
        ? arc(m, centre)
        : t.length === 2
          ? arc(t, centre)
          : spacing(at);
    const near = (a: number, b: number) => gap(a, b) <= tolerance(a, b, width);
    if (t.length === 2 && m.length === 2) {
      // Both edges known: the same pair, in either order and convention; two
      // whole turns are one cell. The same width first: a cell collapsed to a
      // point is no whole turn whose edges coincide.
      const [wt, wm] = [arc(t, centre), arc(m, centre)];
      if (Math.abs(wt - wm) > tolerance(wt, wm, Math.max(wt, wm))) {
        return false;
      }
      const whole = (w: number) => turns && w >= 360 - 1e-9;
      if (
        !(whole(wt) && whole(wm)) &&
        !(near(t[0], m[0]) && near(t[1], m[1])) &&
        !(near(t[0], m[1]) && near(t[1], m[0]))
      ) {
        return false;
      }
      continue;
    }
    if (t.length + m.length === 3) {
      // One side knows both edges: the other's known edge is one of them.
      const [few, both] = t.length === 1 ? [t, m] : [m, t];
      if (!both.some((edge) => near(edge, few[0]))) {
        return false;
      }
      continue;
    }
    const known = (pair: number[]) => {
      const sides: (number | undefined)[] = [undefined, undefined];
      for (const edge of pair) {
        if (Number.isFinite(edge)) {
          sides[side(edge, centre)] = edge;
        }
      }
      return sides;
    };
    const theirs = known([edges[2 * at], edges[2 * at + 1]]);
    const mine = known([ours[2 * at], ours[2 * at + 1]]);
    for (const k of [0, 1]) {
      const [a, b] = [theirs[k], mine[k]];
      if (a !== undefined && b !== undefined && !near(a, b)) {
        return false;
      }
    }
  }
  return true;
}

/**
 * The variable's declared cell areas, checked against the grid: undefined
 * when none is declared or none is found (bounds then serve); a reason
 * when one is declared but unusable (wrong grid, units), so that the plot
 * says why rather than weighting by something else; a failed request is
 * thrown (reported, and asked again later).
 */
export async function resolveCellAreas(
  dataset: TAnalysisDataset,
  variable: string,
  array: TAnalysisArray,
  grid: TGridAxes
): Promise<TCellAreas | { reason: string; unreachable?: boolean } | undefined> {
  const name = declaredMeasure(array.attrs);
  if (!name) {
    return undefined;
  }
  const found = (
    measure: TAnalysisArray,
    owner: TAnalysisDataset,
    origin: string
  ): TCellAreas | { reason: string } => {
    const problem = misfit(measure, grid);
    return problem
      ? { reason: `The declared cell areas ${name} (${origin}) ${problem}.` }
      : {
          name,
          origin,
          units: String(measure.attrs.units),
          array: measure,
          dataset: owner,
          dims: [grid.latDim, grid.lonDim],
        };
  };
  try {
    const own = await openReferenced(dataset, array, name, variable);
    return found(own, dataset, "in the dataset");
  } catch (error) {
    if ((error as Error)?.name === "AbortError") {
      throw error;
    }
    // Unreachable for now: areas say why (and are asked again), points need
    // none.
    if (!isMissing(error)) {
      return {
        reason: `The declared cell areas ${name} could not be read: ${(error as Error).message}`,
        unreachable: true,
      };
    }
  }
  // CF allows the measure in another file; CMIP6 keeps it in the fixed
  // field of the same model, experiment, member and grid.
  return fixedFieldAreas(dataset, variable, name, grid, found);
}

/** A CMIP6 measure in the fixed-field store beside the data store. */

async function fixedFieldAreas(
  dataset: TAnalysisDataset,
  variable: string,
  name: string,
  grid: TGridAxes,
  found: (
    measure: TAnalysisArray,
    owner: TAnalysisDataset,
    origin: string
  ) => TCellAreas | { reason: string }
) {
  const store =
    dataset.location && cmip6FixedStore(dataset.location, variable, name);
  if (!store || !dataset.openStore) {
    return undefined;
  }
  let sibling: TAnalysisDataset;
  let measure: TAnalysisArray;
  try {
    sibling = await dataset.openStore(store);
    measure = await sibling.openArray(name);
  } catch (error) {
    if (isMissing(error)) {
      return undefined;
    }
    // Areas and points: only areas need it, so only areas say why.
    return {
      reason: `The declared cell areas ${name} could not be read from ${store}: ${(error as Error).message}`,
      unreachable: true,
    };
  }
  const result = found(measure, sibling, store);
  if ("reason" in result) {
    return result;
  }
  const check = siblingCheck(sibling, store, name, grid);
  return { ...result, verify: check.verify, verifyCost: check.cost };
}

/**
 * Same shape is not the same grid: the sibling's coordinates must agree.
 * Checked once, when an area plot needs it; a mismatch is kept. A coordinate
 * that could not be read is no mismatch: said so, and checked again next time.
 */
// eslint-disable-next-line max-lines-per-function
function siblingCheck(
  sibling: TAnalysisDataset,
  store: string,
  name: string,
  grid: TGridAxes
) {
  // One check shared by every plot that needs it, stopped when the last of them
  // is. Only an answer is kept.
  const shared = new SharedReads(1);
  let answer: Promise<void> | undefined;
  // Arrays the price found absent: one there now was not priced, so the check
  // stops before reading it.
  const absent = new Set<string>();
  // The arrays as priced: the check reads those, not ones opened again.
  const priced = new Map<string, TAnalysisArray>();
  const checked = Object.assign(Object.create(sibling) as TAnalysisDataset, {
    openArray: (path: string) =>
      priced.get(path)
        ? Promise.resolve(priced.get(path)!)
        : sibling.openArray(path),
  });
  const check = async (signal: AbortSignal) => {
    for (const path of absent) {
      const now = await sibling.openArray(path).then(
        () => true,
        () => false
      );
      if (now) {
        absent.clear();
        throw new Error(
          `The coordinates of the declared cell areas ${name} at ${store} were published while this plot was priced; plot again to price them.`
        );
      }
    }
    let matches: boolean;
    try {
      matches =
        absent.size === 0 &&
        (await sameAxis(checked, grid.latName, grid.lat, false, signal)) &&
        (await sameAxis(checked, grid.lonName, grid.lon, true, signal));
    } catch (error) {
      if ((error as Error)?.name === "AbortError" || !isMissing(error)) {
        throw (error as Error)?.name === "AbortError"
          ? error
          : new Error(
              `The coordinates of the declared cell areas ${name} at ${store} could not be read: ${(error as Error).message}`
            );
      }
      matches = false;
    }
    if (!matches) {
      throw new AnalysisInputError(
        `The declared cell areas ${name} at ${store} are on other latitudes or longitudes than this variable.`
      );
    }
  };
  const verify = async (signal?: AbortSignal) => {
    if (answer) {
      return answer;
    }
    try {
      await shared.share("check", 0, check, signal);
      answer = Promise.resolve();
    } catch (error) {
      // A mismatch is kept; an outage or a cancel is asked again.
      if (error instanceof AnalysisInputError) {
        answer = Promise.reject(error);
        answer.catch(() => undefined);
      }
      throw error;
    }
  };
  // The stored chunks the check reads (its coordinates and their bounds), from
  // their metadata alone: priced before any is read. None once checked. What
  // the check reads, as it reads it: each coordinate, and its bounds only where
  // this grid publishes its own, priced in bytes too (two padded chunks decoded
  // 512 KiB beside a 64-byte field).
  // eslint-disable-next-line max-lines-per-function
  const cost = async () => {
    if (answer) {
      return { reads: 0, bytes: 0 };
    }
    let [reads, bytes] = [0, 0];
    absent.clear();
    priced.clear();
    // Only an absent array costs nothing: a failed metadata request is an
    // unknown cost, and planning stops to be asked again.
    const openPriced = (path: string) =>
      sibling.openArray(path).catch((error: unknown) => {
        if (isMissing(error)) {
          return undefined;
        }
        throw new Error(
          `The coordinates of the declared cell areas ${name} at ${store} could not be read: ${(error as Error)?.message ?? error}`
        );
      });
    for (const [coordinate, axis] of [
      [grid.latName, grid.lat],
      [grid.lonName, grid.lon],
    ] as const) {
      const names = [coordinate];
      const array = await openPriced(coordinate);
      if (!array) {
        absent.add(coordinate);
      }
      const bounds = array?.attrs.bounds;
      if (axis.bounds && typeof bounds === "string") {
        names.push(bounds);
      }
      for (const path of names) {
        // Each opened once: the coordinate as found above.
        const found = path === coordinate ? array : await openPriced(path);
        if (found) {
          priced.set(path, found);
        }
        const n = found
          ? found.shape.reduce(
              (product, size, d) =>
                product * Math.ceil(size / Math.max(1, found.chunks[d])),
              1
            )
          : 0;
        // A chunk past the per-chunk limit is refused now, not after its
        // confirmation.
        const each = found ? chunkByteSize(found) : 0;
        if (each > MAX_STORED_CHUNK_BYTES) {
          throw new AnalysisInputError(
            `One stored chunk of ${path} at ${store}, which the declared cell areas ${name} are checked against, decodes to ${Math.round(each / 2 ** 20)} MiB; plots read at most ${MAX_STORED_CHUNK_BYTES / 2 ** 20} MiB per chunk.`
          );
        }
        reads += n;
        bytes += n * each;
      }
    }
    return { reads, bytes };
  };
  return { verify, cost };
}

type TAxisAreas = {
  lat: (i: number) => number;
  lon: (j: number) => number;
  invalid: number;
};
/**
 * A 0-D or 1-D measure as a row factor times a column factor (one of them 1):
 * the area of a cell is its value along the measure's own axis, read at the
 * selected rows (or columns) only, chunk by chunk. A missing, zero or negative
 * value weighs nothing; `invalid` counts the selected cells it covers.
 */
async function axisAreas(
  areas: TCellAreas,
  nlat: number,
  nlon: number,
  rows: ArrayLike<number>,
  cols: ArrayLike<number>,
  signal?: AbortSignal
): Promise<TAxisAreas> {
  const [dim] = areas.array.dimensionNames;
  const axis = dim === undefined ? -1 : areas.dims.indexOf(dim);
  const length = axis === 0 ? nlat : axis === 1 ? nlon : 1;
  if (dim !== undefined && (axis < 0 || areas.array.shape[0] !== length)) {
    throw new AnalysisInputError(
      `${areas.name} has ${areas.array.shape[0]} values along ${dim}; the grid has ${axis < 0 ? "no such axis" : length}.`
    );
  }
  const positive = (v: number) => (v > 0 && Number.isFinite(v) ? v : 0);
  const one = () => 1;
  if (axis < 0) {
    const value = positive(
      (await readAllShared(areas.dataset, areas.array))[0]
    );
    if (!value) {
      throw new AnalysisInputError(
        `The declared cell area ${areas.name} is not a positive number.`
      );
    }
    return { lat: () => value, lon: one, invalid: 0 };
  }
  const wanted = axis === 0 ? rows : cols;
  const at = await readAlong(areas.dataset, areas.array, wanted, signal);
  let bad = 0;
  for (const k of Array.from(wanted)) {
    bad += positive(at(k)) ? 0 : 1;
  }
  if (wanted.length && bad === wanted.length) {
    throw new AnalysisInputError(
      `The declared cell areas ${areas.name} hold no positive area here.`
    );
  }
  const value = (k: number) => positive(at(k));
  return {
    lat: axis === 0 ? value : one,
    lon: axis === 1 ? value : one,
    invalid: bad * (axis === 0 ? cols.length : rows.length),
  };
}

/**
 * Cell edges halfway between centres of a regular axis (spacings within
 * 1% of each other), outer edges half a spacing out, latitudes clamped to
 * the poles; undefined for an irregular axis (a Gaussian grid, stations).
 */
export function midpointBounds(values: ArrayLike<number>, latitude: boolean) {
  const n = values.length;
  if (n < 2) {
    return undefined;
  }
  const steps = Array.from({ length: n - 1 }, (_, at) =>
    Math.abs(values[at + 1] - values[at])
  );
  const sign = Math.sign(values[1] - values[0]);
  // A loop, not a spread: a 150,000-long axis overflowed the stack.
  let [smallest, largest] = [Infinity, -Infinity];
  for (const s of steps) {
    [smallest, largest] = [Math.min(smallest, s), Math.max(largest, s)];
  }
  if (
    !(smallest > 0) ||
    largest > smallest * 1.01 ||
    steps.some((_, at) => Math.sign(values[at + 1] - values[at]) !== sign)
  ) {
    return undefined;
  }
  const clamp = (value: number) =>
    latitude ? Math.max(-90, Math.min(90, value)) : value;
  const bounds = new Float64Array(2 * n);
  for (let at = 0; at < n; at++) {
    const before =
      at > 0
        ? (values[at - 1] + values[at]) / 2
        : values[0] - (values[1] - values[0]) / 2;
    const after =
      at < n - 1
        ? (values[at] + values[at + 1]) / 2
        : values[n - 1] + (values[n - 1] - values[n - 2]) / 2;
    bounds[2 * at] = clamp(Math.min(before, after));
    bounds[2 * at + 1] = clamp(Math.max(before, after));
  }
  return bounds;
}

type TWeightedGrid = {
  lat: TRectilinearAxis;
  lon: TRectilinearAxis;
  areas?: TCellAreas;
  approximateBounds?: boolean;
  inferredAxes?: ("latitude" | "longitude")[];
};

/**
 * Which edges were made halfway between centres, in words: one axis when
 * the other's bounds are published.
 */
export function inferredEdges(grid: TWeightedGrid) {
  const axes = grid.inferredAxes ?? ["latitude", "longitude"];
  return axes.length === 1
    ? `${axes[0]} edges halfway between centres (no ${axes[0]} bounds published; ${axes[0] === "latitude" ? "longitude" : "latitude"} bounds published)`
    : "edges halfway between centres (no bounds published)";
}

/** How a rectilinear grid's cells are weighted, in words for results. */
export function weightingLabel(grid: TWeightedGrid) {
  return grid.areas
    ? `model cell areas ${grid.areas.name} (${grid.areas.units}, ${grid.areas.origin})`
    : grid.approximateBounds
      ? (grid.inferredAxes?.length ?? 2) === 1
        ? `approximate spherical cell areas: ${inferredEdges(grid)}`
        : "approximate spherical cell areas: edges halfway between centres (no cell areas or bounds published)"
      : "spherical cell areas from latitude/longitude bounds";
}

/** Declared 2-D cell areas at the selected cells, and how many are invalid. */
async function declaredWeights(
  areas: TCellAreas,
  shape: number[],
  rows: ArrayLike<number>,
  cols: ArrayLike<number>,
  signal?: AbortSignal,
  positions?: ArrayLike<number>
) {
  const area = await readNativeCells(
    areas.dataset,
    areas.array,
    areas.dims,
    shape,
    rows,
    cols,
    signal,
    positions
  );
  let invalid = 0;
  const valid = (i: number, j: number) => {
    const v = area(i, j);
    return v > 0 && Number.isFinite(v) ? v : 0;
  };
  let cells = 0;
  if (positions) {
    cells = positions.length / 2;
    for (let at = 0; at + 1 < positions.length; at += 2) {
      invalid += valid(positions[at], positions[at + 1]) ? 0 : 1;
    }
  } else {
    cells = rows.length * cols.length;
    for (let r = 0; r < rows.length; r++) {
      for (let c = 0; c < cols.length; c++) {
        invalid += valid(rows[r], cols[c]) ? 0 : 1;
      }
    }
  }
  if (cells && invalid === cells) {
    throw new AnalysisInputError(
      `The declared cell areas ${areas.name} hold no positive area here.`
    );
  }
  return { at: valid, invalid };
}

/**
 * The weight of cell (i, j) for the selected rows and columns: the
 * declared areas (read once per grid), else spherical areas from bounds
 * (tables of the selected rows and columns only). `separable` is set when
 * the weight is a row factor times a column factor.
 */
/** The distinct rows and columns of (i, j) pairs, ascending. */
export function distinctOf(positions: ArrayLike<number>) {
  const [rows, cols] = [new Set<number>(), new Set<number>()];
  for (let at = 0; at + 1 < positions.length; at += 2) {
    rows.add(positions[at]);
    cols.add(positions[at + 1]);
  }
  const sorted = (s: Set<number>) => [...s].sort((a, b) => a - b);
  return [sorted(rows), sorted(cols)] as const;
}

// eslint-disable-next-line max-lines-per-function
export async function cellWeights(
  grid: TWeightedGrid,
  rows: ArrayLike<number>,
  cols: ArrayLike<number>,
  signal?: AbortSignal,
  /** The selected cells ((i, j) pairs): a 2-D measure is read under them. */
  positions?: ArrayLike<number>
): Promise<{
  at: (i: number, j: number) => number;
  separable?: { lat: (i: number) => number; lon: (j: number) => number };
  /** Cells of the grid without a valid declared area. */
  invalid: number;
}> {
  if (grid.areas) {
    const [nlat, nlon] = [grid.lat.values.length, grid.lon.values.length];
    // A 2-D measure: only the chunks under the selected cells.
    if (grid.areas.array.dimensionNames.length === 2) {
      return declaredWeights(
        grid.areas,
        [nlat, nlon],
        rows,
        cols,
        signal,
        positions
      );
    }
    // A measure along one axis (or one value): indexed there, never spread over
    // the grid.
    throwIfAborted(signal);
    // The rows and columns of the selected cells themselves, not of their
    // bounding rows and columns.
    const [ownRows, ownCols] = positions ? distinctOf(positions) : [rows, cols];
    const along = await axisAreas(
      grid.areas,
      nlat,
      nlon,
      ownRows,
      ownCols,
      signal
    );
    return {
      at: (i, j) => along.lat(i) * along.lon(j),
      separable: along,
      invalid: along.invalid,
    };
  }
  const latBounds = grid.lat.bounds!;
  const latW = new Map(
    Array.from(rows, (i) => [i, latitudeWeightAt(latBounds, i)])
  );
  const lonW = new Map(
    Array.from(cols, (j) => [j, longitudeWeightAt(grid.lon, j)])
  );
  // Unpublished bounds (NaN) weigh nothing: such cells are counted as
  // unweighed, not summed as NaN.
  const usable = (w: number | undefined) =>
    w !== undefined && w > 0 && Number.isFinite(w) ? w : 0;
  const lat = (i: number) => usable(latW.get(i));
  const lon = (j: number) => usable(lonW.get(j));
  const badRows = Array.from(latW.values()).filter((w) => !usable(w)).length;
  const badCols = Array.from(lonW.values()).filter((w) => !usable(w)).length;
  const invalid = badRows * lonW.size + badCols * latW.size - badRows * badCols;
  return { at: (i, j) => lat(i) * lon(j), separable: { lat, lon }, invalid };
}
