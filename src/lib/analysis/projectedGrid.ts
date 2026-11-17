/* eslint-disable camelcase -- CF attribute names are snake_case. */
/**
 * Projected grids that publish only their 1-D x/y axes and a CRS (25 Nov:
 * Sentinel-2 L2A in EOPF Zarr, `b02(y, x)` in metres on UTM zone 37N with
 * `spatial_ref.crs_wkt`, no latitude or longitude arrays). The true
 * latitude and longitude of every cell centre and corner are computed
 * through the CRS's inverse (the map's own, crsInverse.ts), as arrays the
 * curvilinear locator reads like stored ones: cells are found by their
 * outlines and weighed by their spherical areas, as on any grid with
 * corners. Without this such grids were refused.
 */
import proj4 from "proj4";

import { AnalysisInputError } from "./analysisErrors.ts";
import { axisSides, containingIndex, type TAxisLocator } from "./axisLocate.ts";
import type { TAnalysisArray } from "./chunkVisitor.ts";
import { computedArray } from "./rotatedPole.ts";

import { createCrsInverse } from "@/lib/data/crsInverse.ts";

/** CRS attributes, in the order a grid mapping is read for them. */
const CRS_ATTRIBUTES = [
  "crs_wkt",
  "spatial_ref",
  "proj4_params",
  "proj_params",
  "proj4",
] as const;

/**
 * A grid mapping's CRS as text (WKT or PROJ), when it is a projection
 * other than latitude/longitude or a rotated pole (handled elsewhere).
 */
export function projectedCrsOf(attrs: Record<string, unknown> | undefined) {
  const mapping = attrs?.grid_mapping_name;
  if (
    !attrs ||
    mapping === "latitude_longitude" ||
    mapping === "rotated_latitude_longitude" ||
    mapping === "healpix"
  ) {
    return undefined;
  }
  for (const name of CRS_ATTRIBUTES) {
    const text = attrs[name];
    if (typeof text === "string" && text.trim()) {
      try {
        createCrsInverse(text);
        return text;
      } catch {
        // Not a CRS proj4 reads: try the next attribute.
      }
    }
  }
  return undefined;
}

/** Metres per unit of a projected axis, or undefined for other units. */
export function metresPer(units: unknown) {
  const text = String(units ?? "m").trim();
  if (/^(m|meters?|metres?)$/i.test(text) || text === "") {
    return 1;
  }
  // Feet and miles too, each by its exact definition.
  const known: [RegExp, number][] = [
    [/^(km|kilometers?|kilometres?)$/i, 1000],
    [/^(ft|foot|feet|international_foot)$/i, 0.3048],
    [/^(us-ft|us_survey_foot|us_survey_feet|ftUS)$/i, 1200 / 3937],
    [/^(kmi|nautical_miles?)$/i, 1852],
    [/^(mi|miles?)$/i, 1609.344],
  ];
  return known.find(([pattern]) => pattern.test(text))?.[1];
}

/** Whether an axis is a projection's x (or y) by its attributes or name. */
export function isProjectedAxis(
  name: string,
  attrs: Record<string, unknown>,
  which: "x" | "y"
) {
  const standard = String(attrs.standard_name ?? "");
  return (
    standard === `projection_${which}_coordinate` ||
    String(attrs.axis ?? "").toLowerCase() === which ||
    new RegExp(`^${which}$`, "i").test(name)
  );
}

/**
 * Cell edges along an axis of centres: halfway between neighbours, half a
 * step beyond the ends.
 */
function edgesOf(centres: ArrayLike<number>) {
  const n = centres.length;
  const edges = new Float64Array(n + 1);
  if (n === 1) {
    edges[0] = centres[0] - 0.5;
    edges[1] = centres[0] + 0.5;
    return edges;
  }
  for (let k = 1; k < n; k++) {
    edges[k] = (centres[k - 1] + centres[k]) / 2;
  }
  edges[0] = centres[0] - (centres[1] - centres[0]) / 2;
  edges[n] = centres[n - 1] + (centres[n - 1] - centres[n - 2]) / 2;
  return edges;
}

/**
 * Four corners a cell from the (ny + 1) × (nx + 1) corner lattice,
 * counter-clockwise in the projection's plane whichever way the axes run
 * (`[dx, dy]`: their directions).
 */
function cornersOf(
  lattice: { lat: Float64Array; lon: Float64Array },
  nx: number,
  ny: number,
  [dx, dy]: [number, number]
) {
  const corners = {
    lat: new Float64Array(ny * nx * 4),
    lon: new Float64Array(ny * nx * 4),
  };
  const order: [number, number][] =
    dx * dy > 0
      ? [
          [0, 0],
          [0, 1],
          [1, 1],
          [1, 0],
        ]
      : [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const cell = (j * nx + i) * 4;
      order.forEach(([dj, di], k) => {
        const at = (j + dj) * (nx + 1) + i + di;
        corners.lat[cell + k] = lattice.lat[at];
        corners.lon[cell + k] = lattice.lon[at];
      });
    }
  }
  return corners;
}

/**
 * Latitude and longitude of every cell centre (ny × nx) and of its four
 * corners (ny × nx × 4, counter-clockwise in the projection's plane), from
 * the axes in metres.
 */
function projectedCentres(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  crs: string
) {
  const [nx, ny] = [x.length, y.length];
  const centres = {
    lat: new Float64Array(ny * nx),
    lon: new Float64Array(ny * nx),
  };
  createCrsInverse(crs).grid(x, y, centres.lon, centres.lat);
  return centres;
}

/** Largest sub-edge (degrees) of a refined cell outline. */
const REFINED_STEP = 0.25;
const MAX_REFINEMENT = 64;
/** Outline points inverted at once while refining (4 × 8 bytes each). */
export const REFINE_POINTS = 2 ** 16;

/**
 * The areas (steradians) of cells more than half a degree across, along their
 * sides straight in the projection's plane, each split into pieces of at most a
 * quarter degree; smaller cells are left out (great circles between their
 * corners differ from their sides by less). Keyed by j × nx + i.
 */
// eslint-disable-next-line max-lines-per-function
function refinedAreas(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  crs: string,
  published: { x?: ArrayLike<number>; y?: ArrayLike<number> } | undefined,
  /** Each refined cell's area, keyed j × nx + i, as it is computed. */
  apply: (key: number, area: number) => void
) {
  const inverse = createCrsInverse(crs);
  const [sx, sy] = [axisSides(x, published?.x), axisSides(y, published?.y)];
  const [nx, ny] = [x.length, y.length];
  // Sized in the plane (its scale near 1 where cells are large enough to
  // matter); each kept cell's outline inverted in one batch.
  const metres = crsUnitMetres(crs) ?? 1;
  const stepMetres = REFINED_STEP * DEGREE * 6371008.8;
  // In batches of at most REFINE_POINTS points, reused: memory stays bounded
  // whatever the grid.
  const [px, py] = [
    new Float64Array(REFINE_POINTS),
    new Float64Array(REFINE_POINTS),
  ];
  const [lon, lat] = [
    new Float64Array(REFINE_POINTS),
    new Float64Array(REFINE_POINTS),
  ];
  let cells: { key: number; k: number; from: number }[] = [];
  let used = 0;
  const flush = () => {
    inverse.points(px.subarray(0, used), py.subarray(0, used), lon, lat);
    for (const { key, k, from } of cells) {
      // The points were pushed side by side for each step: put them in
      // ring order (bottom, right, top, left).
      const ring: number[][] = [];
      for (let side = 0; side < 4; side++) {
        for (let s = 0; s < k; s++) {
          const at = from + 4 * s + side;
          ring.push(unitVector(lat[at], lon[at]));
        }
      }
      const area = polygonArea(ring);
      if (Number.isFinite(area) && area > 0) {
        apply(key, area);
      }
    }
    [cells, used] = [[], 0];
  };
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const [lx, hx, ly, hy] = [sx.low[i], sx.high[i], sy.low[j], sy.high[j]];
      if (![lx, hx, ly, hy].every(Number.isFinite) || hx <= lx || hy <= ly) {
        continue;
      }
      const size = Math.hypot(hx - lx, hy - ly) * metres;
      if (!(size > 2 * stepMetres)) {
        continue;
      }
      const k = Math.min(MAX_REFINEMENT, Math.ceil(size / stepMetres));
      if (used + 4 * k > REFINE_POINTS) {
        flush();
      }
      cells.push({ key: j * nx + i, k, from: used });
      for (let s = 0; s < k; s++) {
        const t = s / k;
        px.set([lx + (hx - lx) * t, hx, hx - (hx - lx) * t, lx], used);
        py.set([ly, ly + (hy - ly) * t, hy, hy - (hy - ly) * t], used);
        used += 4;
      }
    }
  }
  if (used) {
    flush();
  }
}

const DEGREE = Math.PI / 180;

function unitVector(lat: number, lon: number) {
  const [a, b] = [lat * DEGREE, lon * DEGREE];
  return [Math.cos(a) * Math.cos(b), Math.cos(a) * Math.sin(b), Math.sin(a)];
}

/**
 * A spherical polygon's area, a fan of triangles about its mean point
 * (Van Oosterom and Strackee's solid angle of each).
 */
function polygonArea(ring: number[][]) {
  const c = [0, 0, 0];
  for (const p of ring) {
    c[0] += p[0];
    c[1] += p[1];
    c[2] += p[2];
  }
  const norm = Math.hypot(c[0], c[1], c[2]);
  if (!norm) {
    return Number.NaN;
  }
  const m = c.map((v) => v / norm);
  let total = 0;
  for (let k = 0; k < ring.length; k++) {
    const [a, b] = [ring[k], ring[(k + 1) % ring.length]];
    const triple =
      m[0] * (a[1] * b[2] - a[2] * b[1]) +
      m[1] * (a[2] * b[0] - a[0] * b[2]) +
      m[2] * (a[0] * b[1] - a[1] * b[0]);
    const dots =
      1 +
      (m[0] * a[0] + m[1] * a[1] + m[2] * a[2]) +
      (a[0] * b[0] + a[1] * b[1] + a[2] * b[2]) +
      (b[0] * m[0] + b[1] * m[1] + b[2] * m[2]);
    total += 2 * Math.atan2(triple, dots);
  }
  return Math.abs(total);
}

/**
 * The four corners of every cell (ny × nx × 4), counter-clockwise in the
 * projection's plane: computed apart from the centres, so a grid located by its
 * centres alone never makes them.
 */
function projectedCorners(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  crs: string,
  /** Published cell bounds along x and y, [low, high] per cell, flat. */
  published?: { x?: ArrayLike<number>; y?: ArrayLike<number> }
) {
  const [nx, ny] = [x.length, y.length];
  const inverse = createCrsInverse(crs);
  if (published?.x || published?.y) {
    return boundedCorners(x, y, inverse, published);
  }
  // The corner lattice once ((ny + 1) × (nx + 1)), then four per cell.
  const [ex, ey] = [edgesOf(x), edgesOf(y)];
  const lattice = {
    lat: new Float64Array((ny + 1) * (nx + 1)),
    lon: new Float64Array((ny + 1) * (nx + 1)),
  };
  inverse.grid(ex, ey, lattice.lon, lattice.lat);
  return cornersOf(lattice, nx, ny, [
    Math.sign(x[nx - 1] - x[0]) || 1,
    Math.sign(y[ny - 1] - y[0]) || 1,
  ]);
}

/**
 * Corners from published bounds, transformed as they are: cells of their own
 * widths, with gaps between them where the bounds leave some. An axis without
 * bounds has edges halfway between its centres.
 */
// eslint-disable-next-line max-lines-per-function
function boundedCorners(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  inverse: ReturnType<typeof createCrsInverse>,
  published: { x?: ArrayLike<number>; y?: ArrayLike<number> }
) {
  const [nx, ny] = [x.length, y.length];
  // A missing far side keeps the published near one.
  const sides = axisSides;
  const [sx, sy] = [sides(x, published.x), sides(y, published.y)];
  // Each distinct edge value once along each axis: a lattice of them.
  const distinct = (side: { low: Float64Array; high: Float64Array }) => {
    const values = [...new Set([...side.low, ...side.high])].sort(
      (a, b) => a - b
    );
    return { values, at: new Map(values.map((v, k) => [v, k])) };
  };
  const [ux, uy] = [distinct(sx), distinct(sy)];
  const lattice = {
    lat: new Float64Array(uy.values.length * ux.values.length),
    lon: new Float64Array(uy.values.length * ux.values.length),
  };
  inverse.grid(ux.values, uy.values, lattice.lon, lattice.lat);
  const corners = {
    lat: new Float64Array(ny * nx * 4),
    lon: new Float64Array(ny * nx * 4),
  };
  const [dx, dy] = [
    Math.sign(x[nx - 1] - x[0]) || 1,
    Math.sign(y[ny - 1] - y[0]) || 1,
  ];
  // Counter-clockwise in the plane, as cornersOf orders them.
  const order: [0 | 1, 0 | 1][] =
    dx * dy > 0
      ? [
          [0, 0],
          [0, 1],
          [1, 1],
          [1, 0],
        ]
      : [
          [0, 0],
          [1, 0],
          [1, 1],
          [0, 1],
        ];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const cell = (j * nx + i) * 4;
      // Toward increasing index, as the lattice's corner order assumes.
      const xs = dx > 0 ? [sx.low[i], sx.high[i]] : [sx.high[i], sx.low[i]];
      const ys = dy > 0 ? [sy.low[j], sy.high[j]] : [sy.high[j], sy.low[j]];
      order.forEach(([dj, di], k) => {
        const at = uy.at.get(ys[dj])! * ux.values.length + ux.at.get(xs[di])!;
        corners.lat[cell + k] = lattice.lat[at];
        corners.lon[cell + k] = lattice.lon[at];
      });
    }
  }
  return corners;
}

/**
 * Metres in one horizontal unit of a CRS, as proj4 parses it (PROJ
 * `+to_meter`/`+units`, a WKT projected CRS's own UNIT, a compound CRS's
 * horizontal part); 1 when unsaid; undefined for a unit it does not know, which
 * is refused rather than read as metres.
 */
export function crsUnitMetres(crs: string) {
  let parsed: { to_meter?: number; units?: string };
  try {
    parsed = proj4.Proj(crs) as never;
  } catch {
    return undefined;
  }
  const factor = Number(parsed.to_meter);
  if (Number.isFinite(factor) && factor > 0) {
    return factor;
  }
  const units = String(parsed.units ?? "").trim();
  return units === "" || /^(m|meters?|metres?)$/i.test(units) ? 1 : undefined;
}

type TAxisSource = {
  dim: string;
  key: string;
  length: number;
  metres: number;
  values: () => Promise<ArrayLike<number>>;
  coldReads?: () => number;
  /** Decoded bytes of one of its stored chunks (padding included). */
  chunkBytes?: number;
  /** Its published cell bounds, [low, high] per cell, in its units. */
  bounds?: () => Promise<ArrayLike<number>>;
};

/**
 * True latitude and longitude of a projected grid's centres and corners,
 * as computed arrays over (y, x), made when first read (after the grid's
 * size checks): the centres for locating, the corners for outlines and
 * spherical areas.
 */
// eslint-disable-next-line max-lines-per-function
export function projectedCoordinateArrays(
  axes: { x: TAxisSource; y: TAxisSource },
  crs: string,
  crsKey: string
) {
  const [ny, nx] = [axes.y.length, axes.x.length];
  // The axes in the CRS's unit, read once for centres and corners alike.
  let scaledAxes:
    | Promise<{
        x: ArrayLike<number>;
        y: ArrayLike<number>;
        published?: { x?: ArrayLike<number>; y?: ArrayLike<number> };
      }>
    | undefined;
  const axesNow = () =>
    (scaledAxes ??= (async () => {
      const [x, y, bx, by] = await Promise.all([
        axes.x.values(),
        axes.y.values(),
        axes.x.bounds?.(),
        axes.y.bounds?.(),
      ]);
      // Axes in the CRS's own linear unit, as its inverse reads them: a
      // kilometre CRS is given kilometres, not metres.
      const unit = crsUnitMetres(crs);
      if (unit === undefined) {
        throw new AnalysisInputError(
          "The grid's coordinate reference system uses a length unit Gridlook does not know, so its cells cannot be placed."
        );
      }
      const scaled = (values: ArrayLike<number>, metres: number) =>
        metres === unit
          ? values
          : Float64Array.from(values, (value) => (value * metres) / unit);
      // Bounds kept cell by cell: a missing pair falls back alone, the other
      // cells keep their published edges.
      const usable = (b: ArrayLike<number> | undefined, n: number) =>
        b && b.length === 2 * n && Array.prototype.some.call(b, Number.isFinite)
          ? b
          : undefined;
      const [px, py] = [usable(bx, x.length), usable(by, y.length)];
      return {
        x: scaled(x, axes.x.metres),
        y: scaled(y, axes.y.metres),
        ...(px || py
          ? {
              published: {
                ...(px ? { x: scaled(px, axes.x.metres) } : {}),
                ...(py ? { y: scaled(py, axes.y.metres) } : {}),
              },
            }
          : {}),
      };
    })().catch((error: unknown) => {
      // A failed read is read again next time, not kept.
      scaledAxes = undefined;
      throw error;
    }));
  let centres: Promise<ReturnType<typeof projectedCentres>> | undefined;
  const centresNow = () =>
    (centres ??= axesNow()
      .then(({ x, y }) => projectedCentres(x, y, crs))
      .catch((error: unknown) => {
        centres = undefined;
        throw error;
      }));
  let corners: Promise<ReturnType<typeof projectedCorners>> | undefined;
  const cornersNow = () =>
    (corners ??= axesNow()
      .then(({ x, y, published }) => projectedCorners(x, y, crs, published))
      .catch((error: unknown) => {
        corners = undefined;
        throw error;
      }));
  const dims = [axes.y.dim, axes.x.dim];
  const key = `${axes.y.key}|${axes.x.key}|crs ${crsKey}`;
  const coldReads =
    axes.x.coldReads || axes.y.coldReads
      ? () => (axes.x.coldReads?.() ?? 0) + (axes.y.coldReads?.() ?? 0)
      : undefined;
  const make = (
    name: string,
    shape: number[],
    values: () => Promise<Float64Array>,
    attrs: Record<string, unknown>,
    first: boolean
  ): TAnalysisArray =>
    computedArray(
      `${key}|${name}`,
      shape.length === 3 ? [...dims, "corner"] : dims,
      shape,
      values,
      attrs,
      // Both axes' cold reads, counted once (on the centre latitudes).
      coldReads && (first ? coldReads : () => 0),
      // Both stored axes read at once to make any of them: held together,
      // each a chunk of its own size.
      {
        largest: Math.max(axes.x.chunkBytes ?? 0, axes.y.chunkBytes ?? 0),
        held: (axes.x.chunkBytes ?? 0) + (axes.y.chunkBytes ?? 0),
      }
    );
  return {
    lat: make(
      "lat",
      [ny, nx],
      async () => (await centresNow()).lat,
      { standard_name: "latitude", units: "degrees_north" },
      true
    ),
    lon: make(
      "lon",
      [ny, nx],
      async () => (await centresNow()).lon,
      { standard_name: "longitude", units: "degrees_east" },
      false
    ),
    bounds: {
      lat: make(
        "lat_bounds",
        [ny, nx, 4],
        async () => (await cornersNow()).lat,
        { units: "degrees_north" },
        false
      ),
      lon: make(
        "lon_bounds",
        [ny, nx, 4],
        async () => (await cornersNow()).lon,
        { units: "degrees_east" },
        false
      ),
    },
    // Large cells' areas along their own straight sides, not the great
    // circles between their corners.
    refinedAreas: async (apply: (key: number, area: number) => void) => {
      const { x, y, published } = await axesNow();
      refinedAreas(x, y, crs, published, apply);
    },
    // Points by their own x and y, against the cells' sides there.
    locate: {
      dims: [axes.y.dim, axes.x.dim],
      make: async () => {
        const { x, y, published } = await axesNow();
        const [sx, sy] = [
          axisSides(x, published?.x),
          axisSides(y, published?.y),
        ];
        const forward = proj4(crs);
        return (lat: number, lon: number) => {
          let p: number[];
          try {
            p = forward.forward([lon, lat]);
          } catch {
            return undefined;
          }
          const [i, j] = [containingIndex(sx, p[0]), containingIndex(sy, p[1])];
          return i >= 0 && j >= 0 ? ([j, i] as [number, number]) : undefined;
        };
      },
    } satisfies TAxisLocator,
  };
}
