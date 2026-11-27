/* eslint-disable camelcase -- CF and Zarr metadata use snake_case keys. */
/**
 * 25 Nov: Sentinel-2 L2A in EOPF Zarr (`measurements/reflectance/r720m`):
 * `b02(y, x)` on UTM zone 37N, `x`/`y` in metres (y running south), a
 * scalar `spatial_ref` with the CRS as WKT, and no latitude or longitude.
 * Plots refused it ("need the true latitude and longitude as auxiliary
 * coordinates"). Expected places come from proj4 itself.
 */
import proj4 from "proj4";
import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS, type TAnalysisQuery } from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

// The probe's own WKT (r720m/spatial_ref.crs_wkt).
const UTM37N =
  'PROJCS["WGS 84 / UTM zone 37N",GEOGCS["WGS 84",DATUM["WGS_1984",SPHEROID["WGS 84",6378137,298.257223563]],PRIMEM["Greenwich",0],UNIT["degree",0.0174532925199433,AUTHORITY["EPSG","9122"]],AUTHORITY["EPSG","4326"]],PROJECTION["Transverse_Mercator"],PARAMETER["latitude_of_origin",0],PARAMETER["central_meridian",39],PARAMETER["scale_factor",0.9996],PARAMETER["false_easting",500000],PARAMETER["false_northing",0],UNIT["metre",1],AXIS["Easting",EAST],AXIS["Northing",NORTH],AUTHORITY["EPSG","32637"]]';
const N = 152;
const STEP = 720;
// Pixel centres of the r720m transform (origin 200340, 4699680, north up).
const X = Float64Array.from({ length: N }, (_, i) => 200340 + STEP * (i + 0.5));
const Y = Float64Array.from(
  { length: N },
  (_, j) => 4699680 - STEP * (j + 0.5)
);
const value = (j: number, i: number) => j * 1000 + i;

/** x and y in metres, as EOPF writes them (float32, no standard name). */
async function writeAxes(group: zarr.Location<Map<string, Uint8Array>>) {
  for (const [name, values] of [
    ["x", X],
    ["y", Y],
  ] as const) {
    const axis = await zarr.create(group.resolve(name), {
      shape: [N],
      chunkShape: [N],
      dtype: "float32",
      dimensionNames: [name],
      attributes: { units: "m", long_name: `${name} coordinates` },
    });
    await zarr.set(axis as never, null, {
      data: Float32Array.from(values),
      shape: [N],
      stride: [1],
    } as never);
  }
}

async function buildStore() {
  const store = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(store), { attributes: {} });
  const group = zarr.root(store).resolve("r720m");
  await zarr.create(group, { attributes: { "proj:code": "EPSG:32637" } });
  await writeAxes(group);
  const ref = await zarr.create(group.resolve("spatial_ref"), {
    shape: [],
    chunkShape: [],
    dtype: "int64",
    attributes: {
      crs_wkt: UTM37N,
      spatial_ref: UTM37N,
      grid_mapping_name: "transverse_mercator",
      projected_crs_name: "WGS 84 / UTM zone 37N",
    },
  });
  void ref;
  const b02 = await zarr.create(group.resolve("b02"), {
    shape: [N, N],
    chunkShape: [N, N],
    dtype: "float32",
    dimensionNames: ["y", "x"],
    fillValue: Number.NaN as never,
    attributes: {
      units: "1",
      grid_mapping: "spatial_ref",
      long_name: "BOA reflectance",
    },
  });
  const data = new Float32Array(N * N);
  for (let j = 0; j < N; j++) {
    for (let i = 0; i < N; i++) {
      data[j * N + i] = value(j, i);
    }
  }
  await zarr.set(b02 as never, null, {
    data,
    shape: [N, N],
    stride: [N, 1],
  } as never);
  return store;
}

const store = await buildStore();
const lonLat = (i: number, j: number) =>
  proj4(UTM37N, "EPSG:4326", [X[i], Y[j]]);

async function context() {
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `s2-${Math.random()}`
  );
  return resolveVariableContext(
    dataset,
    "r720m/b02",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
}

describe("a projected grid with x/y and a CRS only", () => {
  it("is described as its projection, with an area and a path plot", async () => {
    const c = await context();
    expect(c.grid.kind).toBe("native");
    expect((c.grid as { label?: string }).label).toBe(
      "WGS 84 / UTM zone 37N 152 × 152 (latitude and longitude from x/y)"
    );
    // One scene, no time: a distribution over an area, a transect.
    expect(c.capabilities[ANALYSIS_KINDS.DISTRIBUTION].available).toBe(true);
    expect(c.capabilities[ANALYSIS_KINDS.SECTION].available).toBe(true);
  });
});

const query = (
  kind: TAnalysisQuery["kind"],
  geometry: TAnalysisQuery["geometry"]
): TAnalysisQuery => ({
  version: 1,
  kind,
  source: { ref: "memory://s2", versionStatus: "session" },
  variable: "r720m/b02",
  geometry,
  fixed: {},
});

async function run(q: TAnalysisQuery) {
  const planned = await planAnalysis(
    await context(),
    q,
    new ReadContext(),
    undefined,
    true
  );
  return planned.execute();
}

/** The cell (i, j) holding a place, by proj4's forward projection. */
function cellAt(lat: number, lon: number) {
  const [x, y] = proj4("EPSG:4326", UTM37N, [lon, lat]);
  return [Math.floor((x - 200340) / STEP), Math.floor((4699680 - y) / STEP)];
}

describe("an area plot on the projected grid", () => {
  it("weighs the cells of a box, as proj4 places their centres", async () => {
    const [lon0, lat0] = lonLat(40, 60);
    const [lon1, lat1] = lonLat(50, 50);
    const box = {
      kind: "box" as const,
      west: Math.min(lon0, lon1) - 0.001,
      east: Math.max(lon0, lon1) + 0.001,
      south: Math.min(lat0, lat1) - 0.001,
      north: Math.max(lat0, lat1) + 0.001,
    };
    const inside: number[] = [];
    for (let j = 0; j < N; j++) {
      for (let i = 0; i < N; i++) {
        const [lon, lat] = lonLat(i, j);
        if (
          lon >= box.west &&
          lon <= box.east &&
          lat >= box.south &&
          lat <= box.north
        ) {
          inside.push(value(j, i));
        }
      }
    }
    const r = await run(query(ANALYSIS_KINDS.DISTRIBUTION, box));
    const h = r.histogram!;
    expect(inside.length).toBeGreaterThan(100);
    expect(h.selectedCells).toBe(inside.length);
    expect(h.validCells).toBe(inside.length);
    // Spherical areas of nearly equal UTM cells: the plain mean, closely.
    const plain = inside.reduce((a, b) => a + b, 0) / inside.length;
    expect(Math.abs(h.mean - plain)).toBeLessThan(1);
    expect(h.weighting).toMatch(/spherical cell areas/);
  });
});

describe("a path plot on the projected grid", () => {
  it("reads a transect from the cells its samples fall in", async () => {
    const [lonA, latA] = lonLat(10, 20);
    const [lonB, latB] = lonLat(140, 120);
    const r = await run({
      ...query(ANALYSIS_KINDS.SECTION, {
        kind: "polyline",
        vertices: [
          { lat: latA, lon: lonA },
          { lat: latB, lon: lonB },
        ],
      }),
      sectionSamples: 50,
    });
    const s = r.samples!;
    expect(s.lats.length).toBe(r.values.length);
    let checked = 0;
    s.lats.forEach((lat, k) => {
      const [i, j] = cellAt(lat, s.lons[k]);
      // Away from cell edges (a sample within 1 m of one may go either way).
      const [x, y] = proj4("EPSG:4326", UTM37N, [s.lons[k], lat]);
      const fx = ((x - 200340) / STEP) % 1;
      const fy = ((4699680 - y) / STEP) % 1;
      if (Math.min(fx, 1 - fx, fy, 1 - fy) * STEP > 1) {
        expect(r.values[k]).toBe(value(j, i));
        checked++;
      }
    });
    expect(checked).toBeGreaterThan(40);
  });
});

// eslint-disable-next-line max-lines-per-function
it("interim48: published x bounds decide which projected cell a point is in", async () => {
  const local = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(local), { attributes: {} });
  const put = async (
    name: string,
    data: number[],
    shape: number[],
    dims: string[],
    attributes: Record<string, unknown>
  ) => {
    const array = await zarr.create(zarr.root(local).resolve(name), {
      shape,
      chunkShape: shape,
      dtype: "float64",
      dimensionNames: dims,
      fillValue: Number.NaN as never,
      attributes,
    });
    await zarr.set(array as never, null, {
      data: Float64Array.from(data),
      shape,
      stride: shape.map((_, d) =>
        shape.slice(d + 1).reduce((a, n) => a * n, 1)
      ),
    } as never);
  };
  await put("x", [500000, 501000], [2], ["x"], {
    units: "m",
    standard_name: "projection_x_coordinate",
    bounds: "x_bnds",
  });
  await put(
    "x_bnds",
    [499500, 500100, 500100, 501500],
    [2, 2],
    ["x", "nv"],
    {}
  );
  await put("y", [0, 1000], [2], ["y"], {
    units: "m",
    standard_name: "projection_y_coordinate",
  });
  const ref = await zarr.create(zarr.root(local).resolve("crs"), {
    shape: [],
    chunkShape: [],
    dtype: "int64",
    attributes: { crs_wkt: UTM37N, grid_mapping_name: "transverse_mercator" },
  });
  void ref;
  await put("time", [0], [1], ["time"], { units: "days since 2000-01-01" });
  await put("v", [0, 100, 0, 100], [1, 2, 2], ["time", "y", "x"], {
    units: "K",
    grid_mapping: "crs",
  });
  const c = await resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      local as never,
      "",
      ZARR_FORMAT.V3,
      `utm-${Math.random()}`
    ),
    "v",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
  // E = 500,300 m, N = 500 m: inside the second, wider column.
  const [lon, lat] = proj4(UTM37N, "EPSG:4326", [500300, 500]);
  const result = await (
    await planAnalysis(
      c,
      {
        version: 1,
        kind: ANALYSIS_KINDS.POINT_SERIES,
        geometry: { kind: "point", lat, lon },
        fixed: {},
        source: { ref: "x", versionStatus: "best-effort" },
        variable: "v",
        time: { start: 0, stop: 1 },
      } as TAnalysisQuery,
      new ReadContext()
    )
  ).execute();
  expect(result.values).toEqual([100]);
});
