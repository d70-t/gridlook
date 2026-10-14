import { around, distance } from "geokdbush";
import { Ellipsoid, nested, ring, zuniq, type Grid } from "healpix-geo";
import KDBush from "kdbush";
import proj4 from "proj4";

import type { TVectorSample } from "./vectorField.ts";

export const PATHLINE_GRID = {
  REGULAR: "regular",
  PROJECTED: "projected",
  POINTS: "points",
  HEALPIX: "healpix",
} as const;
type TCoordinates = Float32Array | Float64Array;
export type TPathlineGrid =
  | { kind: typeof PATHLINE_GRID.REGULAR; x: TCoordinates; y: TCoordinates }
  | {
      kind: typeof PATHLINE_GRID.PROJECTED;
      x: TCoordinates;
      y: TCoordinates;
      crs: string;
    }
  | {
      kind: typeof PATHLINE_GRID.POINTS;
      latitudes: TCoordinates;
      longitudes: TCoordinates;
    }
  | { kind: typeof PATHLINE_GRID.HEALPIX; grid: Grid; cells?: number[] };
export type TPathlineGridContext = {
  grid: TPathlineGrid;
  spatialDimensionNames: string[];
  spatialShape: number[];
};
export type TPathlineValues = {
  u: Float32Array;
  v: Float32Array;
  gridRelative: boolean;
};
export type TPathlineField = {
  values: TPathlineValues;
  /** Eastward/northward velocity in metres per second. No visual speed scaling. */
  sample: (latitude: number, longitude: number) => TVectorSample | undefined;
};
type TWeights = { indices: number[]; weights: number[] };
const RAD = Math.PI / 180;
// Metric of the geographic target CRS used by proj4 (WGS84).
const WGS84_ECCENTRICITY_SQUARED = 0.0066943799901413165;
const wrap = (angle: number) => ((((angle + 180) % 360) + 360) % 360) - 180;

function validateAxis(axis: TCoordinates) {
  if (axis.length < 2) {
    throw new Error("Pathlines require two horizontal grid dimensions.");
  }
  const sign = Math.sign(axis[1] - axis[0]);
  for (let i = 0; i < axis.length; i++) {
    if (
      !Number.isFinite(axis[i]) ||
      !sign ||
      (i && Math.sign(axis[i] - axis[i - 1]) !== sign)
    ) {
      throw new Error(
        "Pathline grid axes must be finite and strictly monotonic."
      );
    }
  }
}

function bracket(axis: TCoordinates, value: number, longitude = false) {
  const ascending = axis[0] < axis.at(-1)!;
  const index = (i: number) => (ascending ? i : axis.length - 1 - i);
  const first = axis[index(0)];
  const last = axis[index(axis.length - 1)];
  if (longitude) {
    const global = last - first + Math.abs(axis[1] - axis[0]) >= 359.5;
    value = global
      ? ((((value - first) % 360) + 360) % 360) + first
      : (first + last) / 2 + wrap(value - (first + last) / 2);
    if (global && value > last) {
      return {
        lo: index(axis.length - 1),
        hi: index(0),
        alpha: (value - last) / (first + 360 - last),
      };
    }
  }
  if (value < first || value > last) {
    return;
  }
  let lo = 0;
  let hi = axis.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (axis[index(mid)] <= value) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  return {
    lo: index(lo),
    hi: index(hi),
    alpha: (value - axis[index(lo)]) / (axis[index(hi)] - axis[index(lo)]),
  };
}

function regularWeights(
  x: TCoordinates,
  y: TCoordinates,
  lon: number,
  lat: number,
  geographic: boolean
): TWeights | undefined {
  const bx = bracket(x, lon, geographic);
  const by = bracket(y, lat);
  if (!bx || !by) {
    return;
  }
  const a = bx.alpha;
  const b = by.alpha;
  return {
    indices: [
      by.lo * x.length + bx.lo,
      by.lo * x.length + bx.hi,
      by.hi * x.length + bx.lo,
      by.hi * x.length + bx.hi,
    ],
    weights: [(1 - a) * (1 - b), a * (1 - b), (1 - a) * b, a * b],
  };
}

// eslint-disable-next-line max-lines-per-function
function pointWeights(
  grid: Extract<TPathlineGrid, { kind: typeof PATHLINE_GRID.POINTS }>
) {
  const { latitudes, longitudes } = grid;
  if (!latitudes.length || latitudes.length !== longitudes.length) {
    throw new Error("Pathline coordinates have incompatible lengths.");
  }
  // ponytail: one synchronous O(n log n) index build per job. Move it to a
  // geometry worker if measured large-grid preparation pauses warrant it.
  const index = new KDBush(latitudes.length);
  let south = 90,
    north = -90,
    west = 180,
    east = -180;
  for (let i = 0; i < latitudes.length; i++) {
    const lat = latitudes[i],
      lon = wrap(longitudes[i]);
    if (!Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90) {
      throw new Error("Pathlines require finite geographic coordinates.");
    }
    south = Math.min(south, lat);
    north = Math.max(north, lat);
    west = Math.min(west, lon);
    east = Math.max(east, lon);
    index.add(lon, lat);
  }
  index.finish();
  // ponytail: native inverse-distance samples with a spacing-based search radius.
  // Masks and bounding boxes define validity; exact coastlines need cell topology.
  const radius =
    4 *
    Math.sqrt(
      Math.max(
        1,
        (north - south) *
          (east - west) *
          111 ** 2 *
          Math.cos(((north + south) / 2) * RAD)
      ) / latitudes.length
    );
  return {
    buffers: [index.data],
    sample(lat: number, lon: number): TWeights | undefined {
      lon = wrap(lon);
      if (
        lat < south ||
        lat > north ||
        (east - west < 300 && (lon < west || lon > east))
      ) {
        return;
      }
      const indices = around(index, lon, lat, 4, radius);
      if (!indices.length) {
        return;
      }
      const weights: number[] = [];
      let total = 0;
      for (const i of indices) {
        const separation = distance(
          lon,
          lat,
          wrap(longitudes[i]),
          latitudes[i]
        );
        if (separation < 1e-6) {
          return { indices: [i], weights: [1] };
        }
        const weight = 1 / separation ** 2;
        weights.push(weight);
        total += weight;
      }
      return { indices, weights: weights.map((weight) => weight / total) };
    },
  };
}

/** Build the spatial index once; every original-time field shares it. */
// eslint-disable-next-line max-lines-per-function
export function createPathlineGrid(grid: TPathlineGrid) {
  let length: number;
  let buffers: ArrayBufferLike[] = [];
  let extraBytes = 0;
  let weights: (lat: number, lon: number) => TWeights | undefined;
  const projection =
    grid.kind === PATHLINE_GRID.PROJECTED
      ? proj4(grid.crs, "EPSG:4326")
      : undefined;
  const geographicX =
    grid.kind !== PATHLINE_GRID.PROJECTED ||
    new proj4.Proj(grid.crs).names.some(
      (name) => name === "longlat" || name === "ob_tran"
    );
  if (grid.kind === PATHLINE_GRID.POINTS) {
    length = grid.latitudes.length;
    const points = pointWeights(grid);
    buffers = [
      ...points.buffers,
      grid.latitudes.buffer,
      grid.longitudes.buffer,
    ];
    weights = points.sample;
  } else if (grid.kind === PATHLINE_GRID.HEALPIX) {
    length = grid.cells?.length ?? 12 * grid.grid.nside ** 2;
    if (grid.grid.scheme === "zuniq" && (!grid.cells || grid.grid.level > 24)) {
      throw new Error(
        "Zuniq pathlines require explicit, exactly representable cell IDs (level <= 24)."
      );
    }
    const cells = grid.cells
      ? new Map(grid.cells.map((cell, i) => [cell, i]))
      : undefined;
    if (
      cells &&
      (cells.size !== length ||
        grid.cells!.some((cell) => !Number.isInteger(cell) || cell < 0))
    ) {
      throw new Error("Invalid HEALPix pathline cell coordinates.");
    }
    // Map entries are browser-owned allocations; reserve 64 bytes per entry.
    extraBytes = (grid.cells?.length ?? 0) * 72;
    const ellipsoid = Ellipsoid.from(
      grid.grid.flattening === 0
        ? { radius: grid.grid.semiMajorAxis }
        : {
            // eslint-disable-next-line camelcase -- healpix-geo input keys
            semi_major_axis: grid.grid.semiMajorAxis,
            // eslint-disable-next-line camelcase -- healpix-geo input keys
            inverse_flattening: 1 / grid.grid.flattening,
          }
    );
    const pixelAt = { nested, ring, zuniq }[grid.grid.scheme].lonLatToHealpix;
    const level = grid.grid.level;
    weights = (lat, lon) => {
      const pixel = Number(pixelAt(lon, lat, level, ellipsoid));
      const i = cells ? cells.get(pixel) : pixel;
      return i !== undefined && i >= 0 && i < length
        ? { indices: [i], weights: [1] }
        : undefined;
    };
  } else {
    validateAxis(grid.x);
    validateAxis(grid.y);
    length = grid.x.length * grid.y.length;
    buffers = [grid.x.buffer, grid.y.buffer];
    weights = (lat, lon) => {
      const [x, y] = projection ? projection.inverse([lon, lat]) : [lon, lat];
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        return;
      }
      return regularWeights(grid.x, grid.y, x, y, geographicX);
    };
  }
  // Adjacent time fields sample identical coordinates. Keep only the latest
  // geometry lookup (including misses), independently of field values/masks.
  let lastLat = NaN,
    lastLon = NaN;
  let cachedWeights: TWeights | undefined;
  let cachedBasis: number[][] | undefined;
  function lookupAt(lat: number, lon: number) {
    if (lat !== lastLat || lon !== lastLon) {
      lastLat = lat;
      lastLon = lon;
      cachedWeights = weights(lat, lon);
      cachedBasis = undefined;
    }
    return cachedWeights;
  }
  function basis(lat: number, lon: number) {
    const [x, y] = projection!.inverse([lon, lat]);
    const direction = (dx: number, dy: number) => {
      const a = projection!.forward([x - dx, y - dy]);
      const b = projection!.forward([x + dx, y + dy]);
      const e = wrap(b[0] - a[0]) * Math.cos(lat * RAD),
        n =
          ((b[1] - a[1]) * (1 - WGS84_ECCENTRICITY_SQUARED)) /
          (1 - WGS84_ECCENTRICITY_SQUARED * Math.sin(lat * RAD) ** 2);
      const norm = Math.hypot(e, n);
      return [e / norm, n / norm];
    };
    // Central differences work for projected metres and rotated degrees.
    return [direction(1e-3, 0), direction(0, 1e-3)];
  }
  return {
    length,
    buffers,
    extraBytes,
    /** Deterministic callers supply unit-interval coordinates, never Math.random. */
    seedPosition(u: number, v: number) {
      if (grid.kind === PATHLINE_GRID.POINTS) {
        const index = Math.floor(u * length);
        return {
          latitude: grid.latitudes[index],
          longitude: grid.longitudes[index],
        };
      }
      if (grid.kind === PATHLINE_GRID.HEALPIX) {
        const index = Math.floor(u * length);
        const cell = grid.cells ? grid.cells[index] : index;
        const [longitude, latitude] = grid.grid.healpixToLonLat(
          new BigUint64Array([BigInt(cell)])
        );
        return { latitude, longitude };
      }
      const x = grid.x[0] + u * (grid.x.at(-1)! - grid.x[0]);
      if (projection) {
        const y = grid.y[0] + v * (grid.y.at(-1)! - grid.y[0]);
        const [longitude, latitude] = projection.forward([x, y]);
        return { latitude, longitude };
      }
      const a = Math.sin(grid.y[0] * RAD),
        b = Math.sin(grid.y.at(-1)! * RAD);
      return { latitude: Math.asin(a + v * (b - a)) / RAD, longitude: x };
    },
    // eslint-disable-next-line max-lines-per-function
    field(
      u: Float32Array,
      v: Float32Array,
      gridRelative: boolean
    ): TPathlineField {
      if (u.length !== length || v.length !== length) {
        throw new Error("Velocity components do not match the pathline grid.");
      }
      if (gridRelative && !projection) {
        throw new Error(
          "Grid-relative velocity requires a supported grid projection."
        );
      }
      return {
        values: { u, v, gridRelative },
        sample(lat, lon) {
          if (
            !Number.isFinite(lat) ||
            !Number.isFinite(lon) ||
            Math.abs(lat) >= 90
          ) {
            return;
          }
          const lookup = lookupAt(lat, lon);
          if (!lookup) {
            return;
          }
          let east = 0,
            north = 0;
          for (let k = 0; k < lookup.indices.length; k++) {
            const i = lookup.indices[k],
              weight = lookup.weights[k];
            if (weight === 0) {
              continue;
            }
            if (!Number.isFinite(u[i]) || !Number.isFinite(v[i])) {
              return;
            }
            east += u[i] * weight;
            north += v[i] * weight;
          }
          if (gridRelative) {
            const [ex, ey] = (cachedBasis ??= basis(lat, lon));
            [east, north] = [
              east * ex[0] + north * ey[0],
              east * ex[1] + north * ey[1],
            ];
          }
          return Number.isFinite(east) && Number.isFinite(north)
            ? { u: east, v: north, speed: Math.hypot(east, north) }
            : undefined;
        },
      };
    },
  };
}

/** Time is elapsed dataset seconds from the first prepared source timestep. */
export function samplePathlineTime(
  times: readonly number[],
  fields: readonly TPathlineField[],
  latitude: number,
  longitude: number,
  seconds: number
) {
  if (
    !Number.isFinite(seconds) ||
    times.length !== fields.length ||
    !times.length ||
    seconds < times[0] ||
    seconds > times.at(-1)!
  ) {
    return;
  }
  let lo = 0,
    hi = times.length - 1;
  while (hi - lo > 1) {
    const mid = (lo + hi) >> 1;
    if (times[mid] <= seconds) {
      lo = mid;
    } else {
      hi = mid;
    }
  }
  if (seconds === times[lo]) {
    return fields[lo].sample(latitude, longitude);
  }
  if (seconds === times[hi]) {
    return fields[hi].sample(latitude, longitude);
  }
  const a = fields[lo].sample(latitude, longitude),
    b = fields[hi].sample(latitude, longitude);
  if (!a || !b) {
    return;
  }
  const alpha = (seconds - times[lo]) / (times[hi] - times[lo]);
  const u = a.u * (1 - alpha) + b.u * alpha,
    v = a.v * (1 - alpha) + b.v * alpha;
  return { u, v, speed: Math.hypot(u, v) };
}
