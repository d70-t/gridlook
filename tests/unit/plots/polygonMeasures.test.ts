/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { shapeIdentity } from "@/lib/analysis/shapeImport.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS, type TGeometry } from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;

async function write(
  store: TStore,
  path: string,
  data: number[],
  shape: number[],
  dims: string[],
  attrs: Record<string, unknown> = {},
  chunks = shape
) {
  const array = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape: chunks,
    dtype: "float64",
    dimensionNames: dims,
    attributes: attrs,
    fillValue: Number.NaN as never,
  });
  await zarr.set(array as never, null, {
    data: Float64Array.from(data),
    shape,
    stride: shape.map((_, d) => shape.slice(d + 1).reduce((a, n) => a * n, 1)),
  } as never);
}

const square = (lat: number, lon: number): number[][] => [
  [lon - 1, lat - 0.01],
  [lon + 1, lat - 0.01],
  [lon + 1, lat + 0.01],
  [lon - 1, lat + 0.01],
  [lon - 1, lat - 0.01],
];

// eslint-disable-next-line max-lines-per-function
it("interim48: two cells of a polygon read the two rows of a 1-D cell measure", async () => {
  const n = 1024;
  const lats = Array.from({ length: n }, (_, i) => -40 + (80 * i) / (n - 1));
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "lat", lats, [n], ["lat"], { units: "degrees_north" });
  await write(store, "lon", [0, 10], [2], ["lon"], { units: "degrees_east" });
  await write(store, "time", [0], [1], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(
    store,
    "areacella",
    new Array(n).fill(1),
    [n],
    ["lat"],
    { units: "m2" },
    [1]
  );
  await write(
    store,
    "tas",
    new Array(2 * n).fill(2),
    [1, n, 2],
    ["time", "lat", "lon"],
    {
      units: "K",
      cell_measures: "area: areacella",
    }
  );
  let areaReads = 0;
  const counted = {
    get(key: string) {
      if (key.startsWith("/areacella/c/")) {
        areaReads++;
      }
      return store.get(key);
    },
  };
  const context = await resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      counted as never,
      "",
      ZARR_FORMAT.V3,
      `1d-${Math.random()}`
    ),
    "tas",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
  const polygons = [[square(-40, 0)], [square(40, 0)]];
  const geometry = {
    kind: "shape",
    name: "two cells",
    polygons,
    digest: shapeIdentity(polygons),
  } as TGeometry;
  const plan = await planAnalysis(
    context,
    {
      version: 1,
      kind: ANALYSIS_KINDS.REGION_SERIES,
      geometry,
      fixed: {},
      source: { ref: "x", versionStatus: "best-effort" },
      variable: "tas",
      time: { start: 0, stop: 1 },
    },
    new ReadContext()
  );
  const result = await plan.execute();
  expect(result.values).toEqual([2]);
  expect(result.region?.storedCells).toBe(2);
  expect(areaReads).toBe(2);
  expect(plan.estimate.modest).toBe(true);
});

it("interim48: distinct polar sectors are not all compared with each other, and a copied cap still goes", async () => {
  const { dropFrameDuplicates } = await import("@/lib/analysis/nativeGrid.ts");
  const n = 720;
  const lat = new Float64Array(2 * n);
  const lon = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    lat[i] = 90;
    lon[i] = (360 * i) / n;
    lat[n + i] = 87.5;
    lon[n + i] = (360 * i) / n;
  }
  // Each sector about its own point; the last copies the first.
  const about = (at: number) => {
    const i = at % n === n - 1 ? 0 : at % n;
    const t = (2 * Math.PI * i) / n;
    const z = at < n ? 0.999 : 0.99;
    return [Math.cos(t) * 0.04, Math.sin(t) * 0.04, z] as [
      number,
      number,
      number,
    ];
  };
  let compared = 0;
  const same = (a: number, b: number) => {
    compared++;
    const [p, q] = [about(a), about(b)];
    return p.every((x, k) => Math.abs(x - q[k]) < 1e-12);
  };
  const dropped = dropFrameDuplicates(lat, lon, [2, n], same, about);
  expect(dropped).toBeGreaterThanOrEqual(1);
  expect(compared).toBeLessThan(20 * n);
});

it("interim48: congruent fine cells have equal areas down to centimetres", async () => {
  const { sphericalArea } = await import("@/lib/analysis/nativeGrid.ts");
  const vec = (lat: number, lon: number) => {
    const [p, l] = [(lat * Math.PI) / 180, (lon * Math.PI) / 180];
    return [
      Math.cos(p) * Math.cos(l),
      Math.cos(p) * Math.sin(l),
      Math.sin(p),
    ] as [number, number, number];
  };
  for (const side of [0.01, 1e-6, 4e-7, 2e-7]) {
    const cell = (lon: number) => [
      vec(37.123 - side / 2, lon - side / 2),
      vec(37.123 - side / 2, lon + side / 2),
      vec(37.123 + side / 2, lon + side / 2),
      vec(37.123 + side / 2, lon - side / 2),
    ];
    const [a, b] = [
      sphericalArea(cell(10)),
      sphericalArea(cell(10 + 3 * side)),
    ];
    const expected =
      Math.cos((37.123 * Math.PI) / 180) * ((side * Math.PI) / 180) ** 2;
    expect(a / b).toBeCloseTo(1, 4);
    expect(a / expected).toBeCloseTo(1, 3);
  }
});

it("interim48: halos of any width are found, and a regional axis reads few bounds", async () => {
  const { repeatedColumns } = await import("@/lib/analysis/operations.ts");
  for (const halo of [1, 8, 9, 10]) {
    const own = Array.from({ length: 36 }, (_, j) => 5 + 10 * j);
    const values = [
      ...own.slice(36 - halo).map((v) => v - 360),
      ...own,
      ...own.slice(0, halo).map((v) => v + 360),
    ];
    const bounds = values.flatMap((v) => [v - 5, v + 5]);
    const repeated = repeatedColumns({ values, bounds });
    expect(repeated.size).toBe(2 * halo);
    // The inner columns stay.
    for (let j = halo; j < halo + 36; j++) {
      expect(repeated.has(j)).toBe(false);
    }
  }
  const n = 16_000;
  const values = Array.from({ length: n }, (_, j) => (j + 0.5) / n);
  const edges = Array.from({ length: n }, (_, j) => [
    j / n,
    (j + 1) / n,
  ]).flat();
  let reads = 0;
  const bounds = new Proxy(edges, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) {
        reads++;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  expect(repeatedColumns({ values, bounds }).size).toBe(0);
  expect(reads).toBeLessThan(4 * n);
});

// eslint-disable-next-line max-lines-per-function
it("interim48: a latitude/longitude grid from another prime meridian is refused, Greenwich's read", async () => {
  const open = async (meridian?: number) => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    await write(store, "lat", [0, 1], [2], ["lat"], { units: "degrees_north" });
    await write(store, "lon", [0, 1, 2], [3], ["lon"], {
      units: "degrees_east",
    });
    await write(store, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    const crs = await zarr.create(zarr.root(store).resolve("crs"), {
      shape: [],
      chunkShape: [],
      dtype: "int32",
      attributes: {
        grid_mapping_name: "latitude_longitude",
        ...(meridian === undefined
          ? {}
          : { longitude_of_prime_meridian: meridian }),
      },
    });
    void crs;
    await write(
      store,
      "tas",
      new Array(6).fill(1),
      [1, 2, 3],
      ["time", "lat", "lon"],
      {
        units: "K",
        grid_mapping: "crs",
      }
    );
    return resolveVariableContext(
      zarrAnalysisDatasetFromStore(
        store as never,
        "",
        ZARR_FORMAT.V3,
        `pm-${Math.random()}`
      ),
      "tas",
      new ByteLru<BigInt64Array>(2 ** 20)
    );
  };
  expect((await open()).grid.kind).toBe("rectilinear");
  expect((await open(0)).grid.kind).toBe("rectilinear");
  const paris = await open(2.33722917);
  expect(paris.grid.kind).toBe("unsupported");
  expect(JSON.stringify(paris.grid)).toMatch(/prime meridian 2.33722917/);
});

it("i48 review groups finely spaced distinct longitude columns without quadratic footprint comparisons", async () => {
  const { repeatedColumns } = await import("@/lib/analysis/operations.ts");
  const n = 1024;
  const step = 0.000005;
  const values = Array.from({ length: n }, (_, i) => 10 + i * step);
  const edges = values.flatMap((v) => [v - step / 2, v + step / 2]);
  let accesses = 0;
  const bounds = new Proxy(edges, {
    get(target, key, receiver) {
      if (typeof key === "string" && /^\d+$/.test(key)) {
        accesses++;
      }
      return Reflect.get(target, key, receiver);
    },
  });
  expect(repeatedColumns({ values, bounds }).size).toBe(0);
  expect(accesses).toBeLessThan(n * 32);
});

// eslint-disable-next-line max-lines-per-function -- compare two full gridded field fixtures.
it("i48 review gives the same curvilinear regional mean with zero or ten copied halo columns", async () => {
  // eslint-disable-next-line max-lines-per-function -- build and execute the real stored grid.
  const calculate = async (halo: number) => {
    const nx = 36,
      ny = 10,
      width = nx + 2 * halo;
    const source: TStore = new Map();
    await zarr.create(zarr.root(source), { attributes: {} });
    const physical = (at: number) => ((at % width) - halo + nx) % nx;
    const n = ny * width;
    const cells = Array.from({ length: n }, (_, i) => i);
    const lats = cells.map((at) => {
      const p = physical(at);
      return (
        5 * Math.floor(at / width) +
        0.1 * Math.sin((2 * Math.PI * p) / nx) +
        p * 0.001
      );
    });
    const lons = cells.map((at) => 5 + 10 * physical(at));
    await write(source, "lat", lats, [ny, width], ["y", "x"], {
      standard_name: "latitude",
      units: "degrees_north",
    });
    await write(source, "lon", lons, [ny, width], ["y", "x"], {
      standard_name: "longitude",
      units: "degrees_east",
    });
    await write(source, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(source, "area", Array(n).fill(1), [ny, width], ["y", "x"], {
      units: "km2",
    });
    const values = cells.map((at) =>
      [34, 35, 0, 1].includes(physical(at)) ? 100 : 0
    );
    await write(source, "tas", values, [1, ny, width], ["time", "y", "x"], {
      units: "K",
      coordinates: "lat lon",
      cell_measures: "area: area",
    });
    const ctx = await resolveVariableContext(
      zarrAnalysisDatasetFromStore(
        source as never,
        "",
        ZARR_FORMAT.V3,
        "halo-" + halo
      ),
      "tas",
      new ByteLru<BigInt64Array>(2 ** 20)
    );
    const plan = await planAnalysis(
      ctx,
      {
        version: 1,
        kind: ANALYSIS_KINDS.REGION_SERIES,
        geometry: { kind: "box", west: -180, east: 180, south: -80, north: 80 },
        fixed: {},
        source: { ref: "x", versionStatus: "best-effort" },
        variable: "tas",
        time: { start: 0, stop: 1 },
      },
      new ReadContext()
    );
    return plan.execute();
  };
  const clean = await calculate(0),
    withHalo = await calculate(10);
  expect(clean.region?.storedCells).toBe(360);
  expect(clean.values[0]).toBeCloseTo(100 / 9);
  expect({
    cells: withHalo.region?.storedCells,
    mean: withHalo.values[0],
  }).toEqual({ cells: clean.region?.storedCells, mean: clean.values[0] });
});

// eslint-disable-next-line max-lines-per-function -- both CRS coordinate sets are specified in the fixture.
it("i48 review matches each coordinate pair to its own meridian in a multi-CRS CF source", async () => {
  const source: TStore = new Map();
  await zarr.create(zarr.root(source), { attributes: {} });
  await write(source, "time", [0], [1], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(source, "lat", [0, 1], [2], ["lat"], { units: "degrees_north" });
  await write(
    source,
    "lon",
    [2.33722917, 3.33722917, 4.33722917, 5.33722917],
    [4],
    ["lon"],
    {
      units: "degrees_east",
    }
  );
  await zarr.create(zarr.root(source).resolve("paris"), {
    shape: [],
    chunkShape: [],
    dtype: "int32",
    attributes: {
      grid_mapping_name: "latitude_longitude",
      longitude_of_prime_meridian: 2.33722917,
    },
  });
  await zarr.create(zarr.root(source).resolve("greenwich"), {
    shape: [],
    chunkShape: [],
    dtype: "int32",
    attributes: {
      grid_mapping_name: "latitude_longitude",
      longitude_of_prime_meridian: 0,
    },
  });
  await write(source, "paris_lat", [0, 1], [2], ["lat"], {
    standard_name: "latitude",
    units: "degrees_north",
  });
  await write(source, "paris_lon", [0, 1, 2, 3], [4], ["lon"], {
    standard_name: "longitude",
    units: "degrees_east",
  });
  await write(
    source,
    "tas",
    [11, 22, 33, 44, 11, 22, 33, 44],
    [1, 2, 4],
    ["time", "lat", "lon"],
    {
      units: "K",
      coordinates: "paris_lat paris_lon",
      grid_mapping: "greenwich: lat lon paris: paris_lat paris_lon",
    }
  );
  const ctx = await resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      source as never,
      "",
      ZARR_FORMAT.V3,
      "expanded-crs"
    ),
    "tas",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
  if (ctx.grid.kind === "unsupported") {
    expect(ctx.grid.reason).toMatch(/meridian|mapping/);
  } else {
    const plan = await planAnalysis(
      ctx,
      {
        version: 1,
        kind: ANALYSIS_KINDS.POINT_SERIES,
        geometry: { kind: "point", lat: 0, lon: 2.33722917 },
        fixed: {},
        source: { ref: "x", versionStatus: "best-effort" },
        variable: "tas",
        time: { start: 0, stop: 1 },
      },
      new ReadContext()
    );
    expect((await plan.execute()).values[0]).toBe(11);
  }
});
