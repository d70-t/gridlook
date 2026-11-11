import proj4 from "proj4";
import { describe, expect, it } from "vitest";

import {
  createCrsInverse,
  projectGridToLonLat,
} from "@/lib/data/crsInverse.ts";

// The crs_wkt the ISMIP7 stores carry (EPSG:3031 and EPSG:3413).
export const ANTARCTIC_POLAR_STEREOGRAPHIC_WKT =
  'PROJCS["WGS 84 / Antarctic Polar Stereographic",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Polar_Stereographic"],PARAMETER["latitude_of_origin",-71],PARAMETER["central_meridian",0],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","3031"]]';
export const NSIDC_NORTH_POLAR_STEREOGRAPHIC_WKT =
  'PROJCS["WGS 84 / NSIDC Sea Ice Polar Stereographic North",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433]],PROJECTION["Polar_Stereographic"],PARAMETER["latitude_of_origin",70],PARAMETER["central_meridian",-45],PARAMETER["false_easting",0],PARAMETER["false_northing",0],UNIT["metre",1],AUTHORITY["EPSG","3413"]]';

const MAX_DEGREES_OFF_PROJ4 = 1e-9;

function sampleAxis(from: number, to: number, count: number) {
  return Float64Array.from(
    { length: count },
    (_, k) => from + ((to - from) * k) / (count - 1)
  );
}

function expectGridMatchesProj4(
  crs: string,
  x: ArrayLike<number>,
  y: ArrayLike<number>
) {
  const transformer = proj4(crs, "EPSG:4326");
  const longitudes = new Float64Array(x.length * y.length);
  const latitudes = new Float64Array(x.length * y.length);
  const inverse = createCrsInverse(crs);
  inverse.grid(x, y, longitudes, latitudes);
  let worstLon = 0;
  let worstLat = 0;
  for (let j = 0; j < y.length; j++) {
    for (let i = 0; i < x.length; i++) {
      const [lon, lat] = transformer.forward([x[i], y[j]]);
      const k = j * x.length + i;
      worstLon = Math.max(worstLon, Math.abs(longitudes[k] - lon));
      worstLat = Math.max(worstLat, Math.abs(latitudes[k] - lat));
    }
  }
  expect(worstLon).toBeLessThanOrEqual(MAX_DEGREES_OFF_PROJ4);
  expect(worstLat).toBeLessThanOrEqual(MAX_DEGREES_OFF_PROJ4);
  return inverse;
}

describe("polar stereographic inverse", () => {
  it("matches proj4 over the Antarctic ISMIP7 grid and beyond, pole included", () => {
    const axis = sampleAxis(-6_000_000, 6_000_000, 201);
    const inverse = expectGridMatchesProj4(
      ANTARCTIC_POLAR_STEREOGRAPHIC_WKT,
      axis,
      axis
    );
    expect(inverse.isVectorised).toBe(true);
    const out = { lon: new Float64Array(1), lat: new Float64Array(1) };
    inverse.points([0], [0], out.lon, out.lat);
    expect(out.lat[0]).toBe(-90);
    // Down the y axis from the South Pole lies the 180° meridian.
    inverse.points([0], [-1000], out.lon, out.lat);
    expect(Math.abs(out.lon[0])).toBeCloseTo(180, 9);
  });

  it("matches proj4 over the Greenland grid with its -45° straight vertical longitude", () => {
    const x = sampleAxis(-1_000_000, 2_000_000, 97);
    const y = sampleAxis(-4_000_000, 1_000_000, 101);
    const inverse = expectGridMatchesProj4(
      NSIDC_NORTH_POLAR_STEREOGRAPHIC_WKT,
      x,
      y
    );
    expect(inverse.isVectorised).toBe(true);
    const out = { lon: new Float64Array(1), lat: new Float64Array(1) };
    inverse.points([0], [0], out.lon, out.lat);
    expect(out.lat[0]).toBe(90);
    // Down the y axis from the North Pole lies the -45° meridian.
    inverse.points([0], [-1000], out.lon, out.lat);
    expect(out.lon[0]).toBeCloseTo(-45, 9);
  });
});

describe("other polar stereographic forms", () => {
  it("accepts PROJ strings, true-scale latitudes and false origins", () => {
    const crs =
      "+proj=stere +lat_0=90 +lat_ts=60 +lon_0=10 +x_0=200000 +y_0=-100000 +ellps=WGS84 +units=m +no_defs";
    const inverse = expectGridMatchesProj4(
      crs,
      sampleAxis(-3_000_000, 3_000_000, 61),
      sampleAxis(-3_000_000, 3_000_000, 59)
    );
    expect(inverse.isVectorised).toBe(true);
  });

  it("handles the spherical form", () => {
    const crs =
      "+proj=stere +lat_0=-90 +lat_ts=-70 +lon_0=0 +a=6371229 +b=6371229 +units=m +no_defs";
    const inverse = expectGridMatchesProj4(
      crs,
      sampleAxis(-3_000_000, 3_000_000, 61),
      sampleAxis(-3_000_000, 3_000_000, 59)
    );
    expect(inverse.isVectorised).toBe(true);
  });
});

describe("Lambert conformal conic inverse", () => {
  it("matches proj4 with two standard parallels", () => {
    const crs =
      "+proj=lcc +lat_1=33 +lat_2=45 +lat_0=40 +lon_0=-97 +x_0=0 +y_0=0 +ellps=WGS84 +units=m +no_defs";
    const inverse = expectGridMatchesProj4(
      crs,
      sampleAxis(-3_000_000, 3_000_000, 61),
      sampleAxis(-2_000_000, 2_000_000, 59)
    );
    expect(inverse.isVectorised).toBe(true);
  });

  it("matches proj4 with one standard parallel in the south", () => {
    const crs =
      "+proj=lcc +lat_1=-30 +lat_0=-30 +lon_0=140 +x_0=1000000 +y_0=2000000 +ellps=GRS80 +towgs84=0,0,0 +units=m +no_defs";
    const inverse = expectGridMatchesProj4(
      crs,
      sampleAxis(-2_000_000, 4_000_000, 61),
      sampleAxis(-1_000_000, 5_000_000, 59)
    );
    expect(inverse.isVectorised).toBe(true);
  });
});

describe("proj4 fallback", () => {
  it.each([
    [
      "oblique stereographic",
      "+proj=stere +lat_0=52 +lon_0=5 +ellps=WGS84 +units=m +no_defs",
    ],
    [
      "web mercator",
      "+proj=merc +a=6378137 +b=6378137 +lat_ts=0 +lon_0=0 +x_0=0 +y_0=0 +k=1 +units=m +no_defs",
    ],
    [
      "a datum shift",
      "+proj=stere +lat_0=90 +lat_ts=70 +lon_0=-45 +ellps=intl +towgs84=-87,-98,-121 +units=m +no_defs",
    ],
  ])("leaves %s to proj4", (_name, crs) => {
    const inverse = expectGridMatchesProj4(
      crs,
      sampleAxis(-1_000_000, 1_000_000, 11),
      sampleAxis(-1_000_000, 1_000_000, 13)
    );
    expect(inverse.isVectorised).toBe(false);
  });
});

describe("projectGridToLonLat", () => {
  it("returns row-major Float32 lon/lat, or the axes without a CRS", () => {
    const projected = projectGridToLonLat(
      new Float32Array([0, 100000]),
      new Float32Array([-100000, 0, 100000]),
      ANTARCTIC_POLAR_STEREOGRAPHIC_WKT
    );
    expect(projected.latitudes).toHaveLength(6);
    expect(projected.latitudes[2]).toBe(-90);
    expect(projected.longitudes[5]).toBeCloseTo(45, 4);
    expect(projected.latitudes[5]).toBeLessThan(-88);

    const plain = projectGridToLonLat(
      new Float32Array([10, 20]),
      new Float32Array([-5, 5]),
      null
    );
    expect(Array.from(plain.longitudes)).toEqual([10, 20, 10, 20]);
    expect(Array.from(plain.latitudes)).toEqual([-5, -5, 5, 5]);
  });
});
