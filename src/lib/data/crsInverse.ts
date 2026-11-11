import proj4 from "proj4";

/**
 * Inverse projection (x/y in the CRS to lon/lat on WGS84) over typed arrays.
 *
 * proj4 transforms one point object at a time through a generic pipeline
 * (sanity checks, axis and datum handling, an iterative latitude solve), which
 * costs about a microsecond a point: projecting the 9.2 M cell centres of a
 * 2 km ISMIP7 level took 9 s. The common CF grid mappings of polar data,
 * polar stereographic and Lambert conformal conic, are reimplemented here as
 * tight loops over typed arrays that follow proj4's formulas, with the
 * iterative conformal-to-geodetic latitude solve replaced by its closed series
 * in the eccentricity. Everything else (oblique stereographic, datum shifts,
 * prime meridians, unknown projections) still goes through proj4 point by
 * point, and proj4 keeps the forward direction everywhere.
 */

const WGS84 = "EPSG:4326";
const HALF_PI = Math.PI / 2;
const TWO_PI = 2 * Math.PI;
const R2D = 180 / Math.PI;
// proj4's constants: its EPSLN for the pole test and SPI for adjust_lon.
const EPSLN = 1.0e-10;
const SPI = 3.14159265359;
const PJD_WGS84 = 4;
const PJD_NODATUM = 5;
// The e^8 series for the geodetic latitude of a conformal latitude truncates
// at 1.1e-10 degrees for WGS84 (e = 0.082) and at 8e-10 degrees for e = 0.1;
// rounder ellipsoids are left to proj4's iteration.
const MAX_SERIES_ECCENTRICITY = 0.1;

// The fields of a proj4 Projection this module reads, set by its parsers and
// the stere/lcc init functions.
type TProjParams = {
  names?: string[];
  sphere?: boolean;
  a: number;
  e: number;
  k0: number;
  x0: number;
  y0: number;
  lat0: number;
  long0: number;
  coslat0: number;
  sinlat0: number;
  con: number;
  cons: number;
  ns: number;
  f0: number;
  rh: number;
  over?: boolean;
  to_meter?: number;
  from_greenwich?: number;
  datum?: { datum_type: number; a: number; es: number };
};

export type TLonLatArray = Float32Array | Float64Array;

export type TProjectedGridCoordinates = {
  // row-major over the (y, x) grid
  latitudes: Float32Array;
  longitudes: Float32Array;
};

/** Writes lon and lat in degrees of one projected point into out[0], out[1]. */
type TPointKernel = (x: number, y: number, out: Float64Array) => void;

export type TCrsInverse = {
  /** True when the typed-array path handles the CRS, else proj4 point by point. */
  isVectorised: boolean;
  /** lon/lat of every (y[j], x[i]) in row-major order. */
  grid(
    x: ArrayLike<number>,
    y: ArrayLike<number>,
    longitudes: TLonLatArray,
    latitudes: TLonLatArray
  ): void;
  /** lon/lat of the points (x[k], y[k]). */
  points(
    x: ArrayLike<number>,
    y: ArrayLike<number>,
    longitudes: TLonLatArray,
    latitudes: TLonLatArray
  ): void;
};

function adjustLon(x: number, skip: boolean | undefined) {
  if (skip || Math.abs(x) <= SPI) {
    return x;
  }
  return x - Math.sign(x) * TWO_PI;
}

/**
 * Coefficients of the series for the geodetic latitude phi of a conformal
 * latitude chi (Snyder, Map Projections, eq. 3-5):
 * phi = chi + A2 sin 2chi + A4 sin 4chi + A6 sin 6chi + A8 sin 8chi.
 */
function conformalSeries(e: number) {
  const e2 = e * e;
  const e4 = e2 * e2;
  const e6 = e4 * e2;
  const e8 = e4 * e4;
  return {
    a2: e2 / 2 + (5 * e4) / 24 + e6 / 12 + (13 * e8) / 360,
    a4: (7 * e4) / 48 + (29 * e6) / 240 + (811 * e8) / 11520,
    a6: (7 * e6) / 120 + (81 * e8) / 1120,
    a8: (4279 * e8) / 161280,
  };
}

/**
 * The geodetic latitude for proj4's ts = tan(pi/4 - chi/2), the closed form
 * of its iterative phi2z. The sines of the multiples of chi come from ts by
 * the double-angle formulas, so only one arctangent is evaluated.
 */
function createLatitudeFromTs(e: number) {
  const { a2, a4, a6, a8 } = conformalSeries(e);
  return (ts: number) => {
    const chi = HALF_PI - 2 * Math.atan(ts);
    // theta = atan(ts): sin 2chi = sin 4theta, cos 2chi = -cos 4theta
    const t2 = ts * ts;
    const d = 1 + t2;
    const sin2theta = (2 * ts) / d;
    const cos2theta = (1 - t2) / d;
    const sin2 = 2 * sin2theta * cos2theta;
    const cos2 = 2 * sin2theta * sin2theta - 1;
    const sin4 = 2 * sin2 * cos2;
    const cos4 = 1 - 2 * sin2 * sin2;
    const sin6 = sin4 * cos2 + cos4 * sin2;
    const sin8 = 2 * sin4 * cos4;
    return chi + a2 * sin2 + a4 * sin4 + a6 * sin6 + a8 * sin8;
  };
}

// proj4's stere inverse at a pole, ellipsoidal case.
function createPolarStereographicKernel(p: TProjParams): TPointKernel {
  const { x0, y0, con, lat0, long0, over } = p;
  const toMeter = p.to_meter ?? 1;
  const scale = p.cons / (2 * p.a * p.k0);
  const latitudeFromTs = createLatitudeFromTs(p.e);
  return (xIn, yIn, out) => {
    const x = xIn * toMeter - x0;
    const y = yIn * toMeter - y0;
    const rh = Math.sqrt(x * x + y * y);
    if (rh <= EPSLN) {
      out[0] = long0 * R2D;
      out[1] = lat0 * R2D;
      return;
    }
    out[1] = con * latitudeFromTs(rh * scale) * R2D;
    out[0] =
      con * adjustLon(con * long0 + Math.atan2(con * x, -con * y), over) * R2D;
  };
}

// proj4's stere inverse at a pole, spherical case.
function createPolarStereographicSphereKernel(p: TProjParams): TPointKernel {
  const { x0, y0, lat0, long0, sinlat0, coslat0, over } = p;
  const toMeter = p.to_meter ?? 1;
  const scale = 1 / (2 * p.a * p.k0);
  return (xIn, yIn, out) => {
    const x = xIn * toMeter - x0;
    const y = yIn * toMeter - y0;
    const rh = Math.sqrt(x * x + y * y);
    if (rh <= EPSLN) {
      out[0] = long0 * R2D;
      out[1] = lat0 * R2D;
      return;
    }
    const c = 2 * Math.atan(rh * scale);
    out[1] =
      Math.asin(Math.cos(c) * sinlat0 + (y * Math.sin(c) * coslat0) / rh) * R2D;
    out[0] = adjustLon(long0 + Math.atan2(x, lat0 > 0 ? -y : y), over) * R2D;
  };
}

// proj4's lcc inverse.
function createLambertConformalConicKernel(p: TProjParams): TPointKernel {
  const { x0, y0, k0, ns, long0, over } = p;
  const toMeter = p.to_meter ?? 1;
  const sign = ns > 0 ? 1 : -1;
  const radiusScale = 1 / (p.a * p.f0);
  const exponent = 1 / ns;
  const latitudeFromTs = createLatitudeFromTs(p.e);
  return (xIn, yIn, out) => {
    const x = (xIn * toMeter - x0) / k0;
    const y = p.rh - (yIn * toMeter - y0) / k0;
    const rh1 = sign * Math.sqrt(x * x + y * y);
    const theta = rh1 === 0 ? 0 : Math.atan2(sign * x, sign * y);
    out[1] =
      rh1 !== 0 || ns > 0
        ? latitudeFromTs(Math.pow(rh1 * radiusScale, exponent)) * R2D
        : -90;
    out[0] = adjustLon(theta / ns + long0, over) * R2D;
  };
}

// Whether proj4 would carry lon/lat from this CRS to EPSG:4326 unchanged, so
// that the projection's inverse alone gives the result.
function isWgs84Compatible(p: TProjParams) {
  const wgs84 = (proj4.WGS84 as unknown as TProjParams).datum!;
  const datum = p.datum;
  if (!datum || p.from_greenwich) {
    return false;
  }
  return (
    datum.datum_type === PJD_NODATUM ||
    (datum.datum_type === PJD_WGS84 &&
      datum.a === wgs84.a &&
      Math.abs(datum.es - wgs84.es) <= 5e-11)
  );
}

function createVectorisedKernel(crs: string): TPointKernel | null {
  let p: TProjParams;
  try {
    p = new proj4.Proj(crs) as unknown as TProjParams;
  } catch {
    return null;
  }
  if (!isWgs84Compatible(p) || !(p.sphere || p.e <= MAX_SERIES_ECCENTRICITY)) {
    return null;
  }
  const names = p.names ?? [];
  if (names.includes("stere") && Math.abs(p.coslat0) <= EPSLN) {
    return p.sphere
      ? createPolarStereographicSphereKernel(p)
      : createPolarStereographicKernel(p);
  }
  if (names.includes("lcc") && !p.sphere && Number.isFinite(p.ns) && p.ns) {
    return createLambertConformalConicKernel(p);
  }
  return null;
}

function createProj4Kernel(crs: string): TPointKernel {
  const transformer = proj4(crs, WGS84);
  return (x, y, out) => {
    const [lon, lat] = transformer.forward([x, y]);
    out[0] = lon;
    out[1] = lat;
  };
}

function createInverse(kernel: TPointKernel, isVectorised: boolean) {
  const out = new Float64Array(2);
  const inverse: TCrsInverse = {
    isVectorised,
    grid(x, y, longitudes, latitudes) {
      const columns = x.length;
      for (let j = 0; j < y.length; j++) {
        const yj = y[j];
        const rowOffset = j * columns;
        for (let i = 0; i < columns; i++) {
          kernel(x[i], yj, out);
          longitudes[rowOffset + i] = out[0];
          latitudes[rowOffset + i] = out[1];
        }
      }
    },
    points(x, y, longitudes, latitudes) {
      for (let k = 0; k < x.length; k++) {
        kernel(x[k], y[k], out);
        longitudes[k] = out[0];
        latitudes[k] = out[1];
      }
    },
  };
  return inverse;
}

/**
 * The inverse of `crs` (a WKT or PROJ string) to lon/lat in degrees: the
 * typed-array path for a polar stereographic or Lambert conformal conic CRS
 * on WGS84, proj4 point by point otherwise.
 */
export function createCrsInverse(crs: string): TCrsInverse {
  const kernel = createVectorisedKernel(crs);
  return kernel
    ? createInverse(kernel, true)
    : createInverse(createProj4Kernel(crs), false);
}

/** lon/lat of every (y[j], x[i]) cell centre; x and y as given without a CRS. */
export function projectGridToLonLat(
  x: ArrayLike<number>,
  y: ArrayLike<number>,
  crs: string | null
): TProjectedGridCoordinates {
  const count = x.length * y.length;
  const longitudes = new Float32Array(count);
  const latitudes = new Float32Array(count);
  if (crs) {
    createCrsInverse(crs).grid(x, y, longitudes, latitudes);
    return { latitudes, longitudes };
  }
  for (let j = 0; j < y.length; j++) {
    for (let i = 0; i < x.length; i++) {
      longitudes[j * x.length + i] = x[i];
      latitudes[j * x.length + i] = y[j];
    }
  }
  return { latitudes, longitudes };
}
