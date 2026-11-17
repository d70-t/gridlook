/* eslint-disable camelcase -- CF attribute names are snake_case. */
/**
 * Rotated-pole grids that publish only their rotated axes (`rlat`, `rlon`,
 * standard names grid_latitude/grid_longitude) and a
 * `rotated_latitude_longitude` grid mapping: the true latitude and
 * longitude of every cell, computed from the pole (CF conventions), as
 * two-dimensional coordinates the curvilinear locator reads like stored
 * ones. Without this such grids were refused (never misread as lat/lon).
 */
import type { TAnalysisArray, TStoredChunk } from "./chunkVisitor.ts";
import { toVec, type TVec3 } from "./sphere.ts";

const DEG = Math.PI / 180;

type TPole = {
  /** grid_north_pole_latitude / _longitude, degrees. */
  lat: number;
  lon: number;
  /** north_pole_grid_longitude: the true pole's rotated longitude. */
  gridLon: number;
};

function cross(a: TVec3, b: TVec3): TVec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/**
 * The rotation from rotated to true coordinates as a function: the rotated
 * pole is the true point (pole.lat, pole.lon); the rotated origin lies 90°
 * from it on the far side of its meridian, so the true north pole sits at
 * rotated longitude `gridLon` (0 by default).
 */
export function rotatedToTrue(pole: TPole) {
  const z = toVec(pole.lat, pole.lon);
  const x = toVec(90 - pole.lat, pole.lon + 180);
  const y = cross(z, x);
  return (rlat: number, rlon: number) => {
    const phi = rlat * DEG;
    const lambda = (rlon - pole.gridLon) * DEG;
    const [a, b, c] = [
      Math.cos(phi) * Math.cos(lambda),
      Math.cos(phi) * Math.sin(lambda),
      Math.sin(phi),
    ];
    const v = [0, 1, 2].map((k) => a * x[k] + b * y[k] + c * z[k]);
    const lat = Math.asin(Math.max(-1, Math.min(1, v[2]))) / DEG;
    const lon = Math.atan2(v[1], v[0]) / DEG;
    return { lat, lon };
  };
}

/** The inverse rotation: true latitude/longitude to rotated ones. */
export function trueToRotated(pole: TPole) {
  const z = toVec(pole.lat, pole.lon);
  const x = toVec(90 - pole.lat, pole.lon + 180);
  const y = cross(z, x);
  return (lat: number, lon: number) => {
    const v = toVec(lat, lon);
    const dot = (e: TVec3) => e[0] * v[0] + e[1] * v[1] + e[2] * v[2];
    const [a, b, c] = [dot(x), dot(y), dot(z)];
    return {
      rlat: Math.asin(Math.max(-1, Math.min(1, c))) / DEG,
      rlon: Math.atan2(b, a) / DEG + pole.gridLon,
    };
  };
}

/** The pole of a grid mapping, when it is a rotated pole. */
export function rotatedPoleOf(attrs: Record<string, unknown> | undefined) {
  if (attrs?.grid_mapping_name !== "rotated_latitude_longitude") {
    return undefined;
  }
  const lat = Number(attrs.grid_north_pole_latitude);
  const lon = Number(attrs.grid_north_pole_longitude);
  const gridLon = Number(attrs.north_pole_grid_longitude ?? 0);
  return Number.isFinite(lat) && Number.isFinite(lon)
    ? { lat, lon, gridLon: Number.isFinite(gridLon) ? gridLon : 0 }
    : undefined;
}

/** A computed coordinate as an array of one chunk (read like a stored one). */
export function computedArray(
  key: string,
  dims: string[],
  shape: number[],
  values: () => Float64Array | Promise<Float64Array>,
  attrs: Record<string, unknown>,
  coldReads?: () => number,
  backing?: { largest: number; held: number }
): TAnalysisArray {
  let chunk: TStoredChunk | undefined;
  return {
    ...(coldReads ? { coldReads } : {}),
    ...(backing?.held
      ? { backingChunkBytes: backing.largest, backingHeldBytes: backing.held }
      : {}),
    key,
    shape,
    chunks: shape,
    dtype: "float64",
    attrs,
    dimensionNames: dims,
    fillValue: Number.NaN,
    // Filled at the first read, after the grid's size checks.
    readChunk: async () =>
      (chunk ??= {
        data: await values(),
        shape,
        // Row-major, any rank (projected corners are three-dimensional).
        stride: shape.map((_, d) =>
          shape.slice(d + 1).reduce((p, n) => p * n, 1)
        ),
        absent: false,
      }),
  };
}

/**
 * True latitude and longitude over (rlat, rlon) from the decoded rotated
 * axes (degrees), as two computed arrays named for what they are.
 */
type TRotatedAxis = {
  dim: string;
  key: string;
  /** Decoded values, or how to read them (then `length` says how many). */
  values: ArrayLike<number> | (() => Promise<ArrayLike<number>>);
  length?: number;
  /** Stored chunks still to read for them (preflight counts these). */
  coldReads?: () => number;
  /** Decoded bytes of one of its stored chunks (padding included). */
  chunkBytes?: number;
};

// eslint-disable-next-line max-lines-per-function
export function trueCoordinates(
  rotated: { lat: TRotatedAxis; lon: TRotatedAxis },
  pole: TPole
) {
  const size = (axis: TRotatedAxis) =>
    typeof axis.values === "function" ? axis.length! : axis.values.length;
  const read = async (axis: TRotatedAxis) =>
    typeof axis.values === "function" ? axis.values() : axis.values;
  const [ny, nx] = [size(rotated.lat), size(rotated.lon)];
  // Computed when first read, not when the variable is described, the rotated
  // axes read then too: a large grid is refused by its cell count and its axis
  // reads are priced before anything is held or read.
  let both: Promise<{ lat: Float64Array; lon: Float64Array }> | undefined;
  const compute = () =>
    (both ??= (async () => {
      const [lats, lons] = await Promise.all([
        read(rotated.lat),
        read(rotated.lon),
      ]);
      const toTrue = rotatedToTrue(pole);
      const out = {
        lat: new Float64Array(ny * nx),
        lon: new Float64Array(ny * nx),
      };
      for (let j = 0; j < ny; j++) {
        for (let i = 0; i < nx; i++) {
          const p = toTrue(lats[j], lons[i]);
          out.lat[j * nx + i] = p.lat;
          out.lon[j * nx + i] = p.lon;
        }
      }
      return out;
    })().catch((error: unknown) => {
      // A failed read (a 503) is read again next time, not kept.
      both = undefined;
      throw error;
    }));
  const dims = [rotated.lat.dim, rotated.lon.dim];
  const key = `${rotated.lat.key}|${rotated.lon.key}|pole ${pole.lat} ${pole.lon} ${pole.gridLon}`;
  // Both axes' cold reads, counted once (on the latitudes).
  const coldReads =
    rotated.lat.coldReads || rotated.lon.coldReads
      ? () =>
          (rotated.lat.coldReads?.() ?? 0) + (rotated.lon.coldReads?.() ?? 0)
      : undefined;
  // Both stored axes are read at once to compute either.
  const [a, b] = [rotated.lat.chunkBytes ?? 0, rotated.lon.chunkBytes ?? 0];
  const backing = { largest: Math.max(a, b), held: a + b };
  return {
    lat: computedArray(
      `${key}|lat`,
      dims,
      [ny, nx],
      async () => (await compute()).lat,
      { standard_name: "latitude", units: "degrees_north" },
      coldReads,
      backing
    ),
    lon: computedArray(
      `${key}|lon`,
      dims,
      [ny, nx],
      async () => (await compute()).lon,
      { standard_name: "longitude", units: "degrees_east" },
      coldReads && (() => 0),
      backing
    ),
  };
}
