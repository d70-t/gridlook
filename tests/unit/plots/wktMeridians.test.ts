/* eslint-disable camelcase, max-lines-per-function -- CF metadata uses snake_case keys. */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import {
  resolveVariableContext,
  wktPrimeMeridian,
} from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;

async function write(
  s: TStore,
  name: string,
  data: number[],
  shape: number[],
  dims: string[],
  attrs: Record<string, unknown> = {}
) {
  const a = await zarr.create(zarr.root(s).resolve(name), {
    shape,
    chunkShape: shape,
    dtype: "float64",
    dimensionNames: dims,
    attributes: attrs,
    fillValue: Number.NaN,
  });
  if (!shape.length) {
    return;
  }
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((p, n) => p * n, 1)
  );
  await zarr.set(a, null, { data: Float64Array.from(data), shape, stride });
}

async function gridWith(
  mapping: Record<string, unknown>,
  lat = "lat",
  lon = "lon"
) {
  const s: TStore = new Map();
  await zarr.create(zarr.root(s), { attributes: {} });
  await write(s, lat, [0, 1], [2], [lat], {
    units: "degrees_north",
    standard_name: lat === "lat" ? "latitude" : "grid_latitude",
  });
  await write(s, lon, [0, 1, 2], [3], [lon], {
    units: "degrees_east",
    standard_name: lon === "lon" ? "longitude" : "grid_longitude",
  });
  await write(s, "crs", [], [], [], mapping);
  await write(s, "tas", [0, 1, 2, 3, 4, 5], [2, 3], [lat, lon], {
    units: "K",
    grid_mapping: "crs",
  });
  return resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      s as never,
      "",
      ZARR_FORMAT.V3,
      `pm-${Math.random()}`
    ),
    "tas",
    new ByteLru(2 ** 20)
  );
}

const PARIS_WKT =
  'GEOGCRS["NTF (Paris)",DATUM["Nouvelle Triangulation Francaise (Paris)",ELLIPSOID["Clarke 1880 (IGN)",6378249.2,293.466021293627]],PRIMEM["Paris",2.5969213,ANGLEUNIT["grad",0.0157079632679489]],CS[ellipsoidal,2]]';

it("interim49: a WKT's prime meridian is read in its own angular unit", () => {
  expect(wktPrimeMeridian(PARIS_WKT)).toBeCloseTo(2.33722917, 7);
  expect(
    wktPrimeMeridian(
      'GEOGCS["x",PRIMEM["Paris",2.33722917],UNIT["degree",0.0174532925199433]]'
    )
  ).toBeCloseTo(2.33722917, 9);
  expect(wktPrimeMeridian('GEOGCS["x",PRIMEM["Greenwich",0]]')).toBe(0);
});

it("interim49: a WKT-only Paris meridian and a rotated pole on Paris are refused", async () => {
  const wkt = await gridWith({
    grid_mapping_name: "latitude_longitude",
    crs_wkt: PARIS_WKT,
  });
  expect(wkt.grid.kind === "unsupported" && wkt.grid.reason).toMatch(
    /prime meridian/
  );
  const rotated = await gridWith(
    {
      grid_mapping_name: "rotated_latitude_longitude",
      grid_north_pole_latitude: 90,
      grid_north_pole_longitude: 180,
      longitude_of_prime_meridian: 2.33722917,
    },
    "rlat",
    "rlon"
  );
  expect(rotated.grid.kind === "unsupported" && rotated.grid.reason).toMatch(
    /prime meridian/
  );
  const greenwich = await gridWith({
    grid_mapping_name: "latitude_longitude",
    crs_wkt: 'GEOGCS["x",PRIMEM["Greenwich",0]]',
  });
  expect(greenwich.grid.kind).not.toBe("unsupported");
});

it("interim49: projected axes are given in the CRS's unit, and a missing bound stays local", async () => {
  const { crsUnitMetres, projectedCoordinateArrays } =
    await import("@/lib/analysis/projectedGrid.ts");
  expect(crsUnitMetres("+proj=merc +units=km")).toBe(1000);
  expect(crsUnitMetres("+proj=merc +to_meter=0.3048")).toBe(0.3048);
  expect(
    crsUnitMetres(
      'PROJCRS["x",BASEGEOGCRS["g",DATUM["d",ELLIPSOID["e",6378137,298.25]],ANGLEUNIT["degree",0.0174532925199433]],CONVERSION["m",METHOD["Mercator"]],CS[Cartesian,2],LENGTHUNIT["kilometre",1000]]'
    )
  ).toBe(1000);
  const axis = (
    dim: string,
    values: number[],
    metres: number,
    bounds?: number[]
  ) => ({
    dim,
    key: dim,
    length: values.length,
    metres,
    values: async () => values,
    ...(bounds ? { bounds: async () => bounds } : {}),
  });
  const lonsOf = async (crs: string, metres: number, bounds: number[]) => {
    const arrays = projectedCoordinateArrays(
      {
        x: axis(
          "x",
          [500000, 501000, 502000].map((v) => v / metres),
          metres,
          bounds.map((v) => v / metres)
        ),
        y: axis(
          "y",
          [0, 1000].map((v) => v / metres),
          metres
        ),
      },
      crs,
      "k"
    );
    const chunk = await arrays.bounds.lon.readChunk([0, 0, 0]);
    return Array.from(chunk.data as Float64Array);
  };
  const utm = "+proj=utm +zone=37 +datum=WGS84";
  const full = await lonsOf(
    utm,
    1,
    [499500, 500100, 500100, 501500, 501500, 502500]
  );
  const partial = await lonsOf(utm, 1, [
    499500,
    500100,
    500100,
    501500,
    501500,
    Number.NaN,
  ]);
  // The first two columns' corners are unchanged by the third's missing edge.
  expect(partial.slice(0, 8)).toEqual(full.slice(0, 8));
  // Kilometre axes on a kilometre CRS: the same places as metres on metres.
  const km = await lonsOf(
    "+proj=utm +zone=37 +datum=WGS84 +units=km",
    1000,
    [499500, 500100, 500100, 501500, 501500, 502500]
  );
  km.slice(0, 8).forEach((v, k) => expect(v).toBeCloseTo(full[k], 9));
});
