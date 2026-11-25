/* eslint-disable max-lines-per-function -- each grid builds its own fixture. */
/* eslint-disable camelcase -- CF and UGRID metadata use snake_case keys. */
import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import {
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  type TAnalysisQuery,
  type TGeometry,
} from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;

async function newStore() {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  return store;
}

async function write(
  store: TStore,
  path: string,
  data: number[],
  shape: number[],
  dims: string[],
  attrs: Record<string, unknown> = {},
  dtype: "float64" | "int32" = "float64"
) {
  const array = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape: shape,
    dtype,
    dimensionNames: dims,
    attributes: attrs,
    fillValue: (dtype === "int32" ? -1 : Number.NaN) as never,
  });
  if (!shape.length) {
    await zarr.set(array as never, null, data[0] as never);
    return;
  }
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((product, n) => product * n, 1)
  );
  await zarr.set(array as never, null, {
    data: dtype === "int32" ? Int32Array.from(data) : Float64Array.from(data),
    shape,
    stride,
  } as never);
}

function context(store: TStore, variable: string) {
  return resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `native-${Math.random()}`
    ),
    variable,
    new ByteLru<BigInt64Array>(2 ** 20)
  );
}

function q(
  kind: TAnalysisQuery["kind"],
  variable: string,
  geometry: TGeometry,
  extra: Partial<TAnalysisQuery> = {}
): TAnalysisQuery {
  return {
    version: ALGORITHM_VERSION,
    kind,
    source: { ref: "memory", versionStatus: "session" },
    variable,
    geometry,
    fixed: {},
    ...extra,
  };
}

async function run(
  ctx: Awaited<ReturnType<typeof context>>,
  query: TAnalysisQuery
) {
  const planned = await planAnalysis(ctx, query, new ReadContext());
  return planned.execute();
}

const TIME = { units: "days since 2000-01-01" };

describe("UGRID triangular mesh", () => {
  // Two congruent triangles across 180°: A(−5,175) B(5,175) C(5,−175)
  // D(−5,−175); faces ABC = 10 and ACD = 30.
  async function mesh(startIndex: 0 | 1, facesFirst: boolean) {
    const store = await newStore();
    await write(store, "time", [0, 1], [2], ["time"], TIME);
    await write(store, "mesh", [0], [1], ["one"], {
      cf_role: "mesh_topology",
      topology_dimension: 2,
      node_coordinates: "node_lon node_lat",
      face_node_connectivity: "face_nodes",
      face_dimension: "face",
    });
    await write(store, "node_lat", [-5, 5, 5, -5], [4], ["node"], {
      standard_name: "latitude",
      units: "degrees_north",
    });
    await write(store, "node_lon", [175, 175, -175, -175], [4], ["node"], {
      standard_name: "longitude",
      units: "degrees_east",
    });
    const faces = [
      [0, 1, 2],
      [0, 2, 3],
    ].map((face) => face.map((node) => node + startIndex));
    await write(
      store,
      "face_nodes",
      facesFirst
        ? faces.flat()
        : [0, 1, 2].flatMap((k) => faces.map((f) => f[k])),
      facesFirst ? [2, 3] : [3, 2],
      facesFirst ? ["face", "corner"] : ["corner", "face"],
      { start_index: startIndex, _FillValue: -1 },
      "int32"
    );
    await write(store, "tos", [10, 30, 10, 30], [2, 2], ["time", "face"], {
      mesh: "mesh",
      location: "face",
    });
    await write(
      store,
      "zeta",
      [100, 101, 102, 103, 200, 201, 202, 203],
      [2, 4],
      ["time", "node"],
      { mesh: "mesh", location: "node" }
    );
    return store;
  }

  it("honors declared mesh when group also has DGGS", async () => {
    const s = await mesh(0, true);
    const k = "/zarr.json",
      m = JSON.parse(new TextDecoder().decode(s.get(k)));
    m.attributes.dggs = {
      name: "healpix",
      refinement_level: 1,
      indexing_scheme: "nested",
      spatial_dimension: "hp_cell",
    };
    s.set(k, new TextEncoder().encode(JSON.stringify(m)));
    await write(
      s,
      "hp",
      Array.from({ length: 96 }, (_, k) => k),
      [2, 48],
      ["time", "hp_cell"]
    );
    expect((await context(s, "hp")).grid.kind).toBe("healpix");
    const b = await context(s, "tos");
    expect(b.grid.kind).toBe("native");
  });
  it("review of interim44: a declared mesh outranks a group-level HEALPix grid_mapping", async () => {
    const s = await mesh(0, true);
    const k = "/zarr.json",
      m = JSON.parse(new TextDecoder().decode(s.get(k)));
    m.attributes.grid_mapping = "hp_crs";
    s.set(k, new TextEncoder().encode(JSON.stringify(m)));
    await write(s, "hp_crs", [0], [], [], {
      grid_mapping_name: "healpix",
      healpix_nside: 2,
      healpix_order: "nest",
    });
    await write(
      s,
      "hp",
      Array.from({ length: 96 }, (_, k) => k),
      [2, 48],
      ["time", "hp_cell"]
    );
    expect((await context(s, "hp")).grid.kind).toBe("healpix");
    expect((await context(s, "tos")).grid.kind).toBe("native");
  });
  it("uses each face field’s own CF area measure for a box and shape", async () => {
    const s = await mesh(0, true);
    const d = zarrAnalysisDatasetFromStore(s as never, "", 3, "weighted43");
    for (const [name, weights] of [
      ["a", [1, 3]],
      ["b", [3, 1]],
    ] as const) {
      await write(s, name + "_area", [...weights], [2], ["face"], {
        units: "m2",
      });
      await write(s, name, [0, 100, 0, 100], [2, 2], ["time", "face"], {
        mesh: "mesh",
        location: "face",
        cell_measures: "area: " + name + "_area",
      });
    }
    for (const g of [
      { kind: "box", west: 170, east: -170, south: -10, north: 10 },
      {
        kind: "shape",
        name: "pair",
        format: "geojson",
        digest: "circle43",
        polygons: [
          [
            [
              [170, -10],
              [-170, -10],
              [-170, 10],
              [170, 10],
              [170, -10],
            ],
          ],
        ],
      },
    ] as const) {
      const out = [];
      for (const n of ["a", "b"]) {
        const c = await resolveVariableContext(d, n, new ByteLru(1024));
        const r = await run(
          c,
          q(ANALYSIS_KINDS.REGION_SERIES, n, g as TGeometry)
        );
        out.push(r.values[0]);
      }
      expect(out).toEqual([75, 25]);
    }
  });
  it("checks declared scalar area over both equal faces", async () => {
    const store = await mesh(0, true);
    await write(store, "area", [1], [], [], { units: "m2" });
    await write(store, "v", [2, 8, 2, 8], [2, 2], ["time", "face"], {
      mesh: "mesh",
      location: "face",
      cell_measures: "area: area",
    });
    const ctx = await context(store, "v");
    const result = await run(
      ctx,
      q(ANALYSIS_KINDS.REGION_SERIES, "v", {
        kind: "box",
        west: 170,
        east: -170,
        south: -10,
        north: 10,
      })
    );
    expect(result.values).toEqual([5, 5]);
  });
});
it("uses published rectilinear edges after retrying a failed metadata open", async () => {
  const store = await newStore();
  await write(store, "lat", [0, 10], [2], ["lat"], {
    units: "degrees_north",
    bounds: "lat_b",
  });
  await write(store, "lon", [0, 10], [2], ["lon"], {
    units: "degrees_east",
    bounds: "lon_b",
  });
  await write(store, "lat_b", [-5, 2, 2, 16], [2, 2], ["lat", "nv"]);
  await write(store, "lon_b", [-5, 5, 5, 15], [2, 2], ["lon", "nv"]);
  await write(store, "time", [0], [1], ["time"], TIME);
  await write(store, "v", [2, 2, 8, 8], [1, 2, 2], ["time", "lat", "lon"]);
  const ds = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    "rect-probe"
  );
  const cache = new ByteLru<BigInt64Array>(2 ** 20);
  const open = ds.openArray.bind(ds);
  let fail = true;
  ds.openArray = async (name) => {
    if (name === "lat_b" && fail) {
      throw new Error("HTTP 503");
    }
    return open(name);
  };
  const probe = async () =>
    run(
      await resolveVariableContext(ds, "v", cache),
      q(ANALYSIS_KINDS.REGION_SERIES, "v", {
        kind: "box",
        west: -1,
        east: 11,
        south: -1,
        north: 11,
      })
    );
  await expect(probe()).rejects.toThrow("503");
  fail = false;
  const healthy = await probe();
  expect(healthy.values[0]).toBeCloseTo(5.9814074755);
});

it("scalar area and fractional scaled coordinate grid", async () => {
  const store = await newStore();
  await write(store, "time", [0], [1], ["time"], TIME);
  await write(store, "lat", [-5, 5], [2], ["lat"], { units: "degrees_north" });
  await write(store, "lon", [0, 10], [2], ["lon"], { units: "degrees_east" });
  await write(store, "area", [1], [], [], { units: "m2" });
  await write(store, "v", [2, 2, 8, 8], [1, 2, 2], ["time", "lat", "lon"], {
    cell_measures: "area: area",
  });
  const ctx = await context(store, "v");
  const r = await run(
    ctx,
    q(ANALYSIS_KINDS.REGION_SERIES, "v", {
      kind: "box",
      west: -1,
      east: 11,
      south: -6,
      north: 6,
    })
  );
  expect(r.values).toEqual([5]);
});
it("two point stations placed on one dimension", async () => {
  const store = await newStore();
  await write(store, "time", [0], [1], ["time"], TIME);
  await write(store, "station_lat", [0, 80], [2], ["lon"], {
    standard_name: "latitude",
    units: "degrees",
  });
  await write(store, "lon", [0, 90], [2], ["lon"], {
    standard_name: "longitude",
    units: "degrees_east",
  });
  await write(store, "v", [10, 20], [1, 2], ["time", "lon"], {
    coordinates: "station_lat",
  });
  const ctx = await context(store, "v");
  const r = await run(
    ctx,
    q(ANALYSIS_KINDS.POINT_SERIES, "v", { kind: "point", lat: 80, lon: 0 })
  );
  expect(r.values).toEqual([20]);
});
it("detects CF rectilinear dimension coordinates named y and x", async () => {
  const store = await newStore();
  await write(store, "time", [0], [1], ["time"], TIME);
  await write(store, "y", [-5, 5], [2], ["y"], {
    standard_name: "latitude",
    axis: "Y",
    units: "degrees_north",
  });
  await write(store, "x", [0, 10], [2], ["x"], {
    standard_name: "longitude",
    axis: "X",
    units: "degrees_east",
  });
  await write(store, "v", [2, 2, 8, 8], [1, 2, 2], ["time", "y", "x"]);
  const ctx = await context(store, "v");
  expect(ctx.grid.kind).toBe("rectilinear");
});
it("forgets a temporary failure reading a rotated coordinate", async () => {
  const store = await newStore();
  await write(store, "time", [0], [1], ["time"], TIME);
  await write(store, "rlat", [0, 1], [2], ["rlat"], {
    standard_name: "grid_latitude",
    units: "degrees",
  });
  await write(store, "rlon", [0, 1], [2], ["rlon"], {
    standard_name: "grid_longitude",
    units: "degrees",
  });
  await write(store, "rotated", [0], [], [], {
    grid_mapping_name: "rotated_latitude_longitude",
    grid_north_pole_latitude: 90,
    grid_north_pole_longitude: 180,
  });
  await write(store, "v", [0, 1, 2, 3], [1, 2, 2], ["time", "rlat", "rlon"], {
    grid_mapping: "rotated",
  });
  const get = store.get.bind(store);
  let fail = true;
  let calls = 0;
  store.get = (k) => {
    if (k === "/rlat/c/0") {
      calls++;
      if (fail) {
        throw new Error("temporary 503");
      }
    }
    return get(k);
  };
  const ctx = await context(store, "v");
  const probe = () =>
    run(
      ctx,
      q(ANALYSIS_KINDS.POINT_SERIES, "v", { kind: "point", lat: 0, lon: 0 })
    );
  await expect(probe()).rejects.toThrow();
  fail = false;
  const retry = await probe().then(
    (r) => r.values,
    (e) => e.message
  );
  expect(retry).toEqual([0]);
  // Read again after the outage, not kept failed.
  expect(calls).toBeGreaterThan(1);
});
it("supports expanded CF notation for rotated grid mapping", async () => {
  const results = [];
  for (const gm of ["rotated", "rotated: rlon rlat"]) {
    const s = await newStore();
    await write(s, "time", [0], [1], ["time"], TIME);
    for (const dim of ["rlat", "rlon"]) {
      await write(s, dim, [0, 1], [2], [dim], {
        standard_name: dim === "rlat" ? "grid_latitude" : "grid_longitude",
        units: "degrees",
      });
    }
    await write(s, "rotated", [0], [], [], {
      grid_mapping_name: "rotated_latitude_longitude",
      grid_north_pole_latitude: 90,
      grid_north_pole_longitude: 180,
    });
    await write(s, "v", [10, 30, 40, 50], [1, 2, 2], ["time", "rlat", "rlon"], {
      grid_mapping: gm,
    });
    const c = await context(s, "v").catch((e) => e.message);
    if (typeof c === "string") {
      results.push(c);
      continue;
    }
    const r = await run(
      c,
      q(ANALYSIS_KINDS.POINT_SERIES, "v", { kind: "point", lat: 0, lon: 0 })
    ).then(
      (r) => r.values,
      (e) => e.message
    );
    results.push([c.grid.kind, r]);
  }
  expect(results[1]).toEqual(results[0]);
});
it("admits simple per-variable CF mapping beside group-level DGGS", async () => {
  const s = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(s), {
    attributes: {
      dggs: {
        name: "healpix",
        refinement_level: 1,
        indexing_scheme: "nested",
        spatial_dimension: "hp_cell",
      },
    },
  });
  await write(s, "time", [0, 1], [2], ["time"], TIME);
  await write(s, "lat", [-5, 5], [2], ["lat"], {
    standard_name: "latitude",
    units: "degrees_north",
  });
  await write(s, "lon", [0, 10], [2], ["lon"], {
    standard_name: "longitude",
    units: "degrees_east",
  });
  await write(s, "geo", [0], [], [], {
    grid_mapping_name: "latitude_longitude",
  });
  await write(
    s,
    "v",
    [10, 20, 30, 40, 11, 21, 31, 41],
    [2, 2, 2],
    ["time", "lat", "lon"],
    { grid_mapping: "geo" }
  );
  expect((await context(s, "v")).grid.kind).toBe("rectilinear");
});
it("accounts for both padded rotated backing chunks", async () => {
  const s = await newStore();
  await write(s, "time", [0], [1], ["time"], TIME);
  for (const d of ["rlat", "rlon"]) {
    await write(s, d, [0, 1], [2], [d], {
      standard_name: d === "rlat" ? "grid_latitude" : "grid_longitude",
      units: "degrees",
    });
    const k = "/" + d + "/zarr.json";
    const m = JSON.parse(new TextDecoder().decode(s.get(k)));
    m.chunk_grid.configuration.chunk_shape = [33554432];
    s.set(k, new TextEncoder().encode(JSON.stringify(m)));
  }
  await write(s, "rotated", [0], [], [], {
    grid_mapping_name: "rotated_latitude_longitude",
    grid_north_pole_latitude: 90,
    grid_north_pole_longitude: 180,
  });
  await write(s, "v", [10, 20, 30, 40], [1, 2, 2], ["time", "rlat", "rlon"], {
    grid_mapping: "rotated",
  });
  const get = s.get.bind(s);
  const seen: string[] = [];
  s.get = (k) => {
    if (k === "/rlat/c/0" || k === "/rlon/c/0") {
      seen.push(k);
      throw new Error("intercepted");
    }
    return get(k);
  };
  const c = await context(s, "v");
  const r = await run(
    c,
    q(ANALYSIS_KINDS.POINT_SERIES, "v", { kind: "point", lat: 0, lon: 0 })
  ).catch((e) => e.message);
  // Two 256 MiB chunks held at once: refused before either is read.
  expect(r).toMatch(/MiB/);
  expect(seen).toHaveLength(0);
});

it("permits two rotated chunks that separately meet 256 MiB and together meet 512 MiB", async () => {
  const s = await newStore();
  await write(s, "time", [0], [1], ["time"], TIME);
  for (const d of ["rlat", "rlon"]) {
    await write(s, d, [0, 1], [2], [d], {
      standard_name: d === "rlat" ? "grid_latitude" : "grid_longitude",
      units: "degrees",
    });
    const k = "/" + d + "/zarr.json";
    const m = JSON.parse(new TextDecoder().decode(s.get(k)));
    m.chunk_grid.configuration.chunk_shape = [17000000];
    s.set(k, new TextEncoder().encode(JSON.stringify(m)));
  }
  await write(s, "rotated", [0], [], [], {
    grid_mapping_name: "rotated_latitude_longitude",
    grid_north_pole_latitude: 90,
    grid_north_pole_longitude: 180,
  });
  await write(s, "v", [10, 20, 30, 40], [1, 2, 2], ["time", "rlat", "rlon"], {
    grid_mapping: "rotated",
  });
  const get = s.get.bind(s);
  const seen: string[] = [];
  s.get = (k) => {
    if (k === "/rlat/c/0" || k === "/rlon/c/0") {
      seen.push(k);
      throw new Error("intercepted");
    }
    return get(k);
  };
  const c = await context(s, "v");
  const r = await run(
    c,
    q(ANALYSIS_KINDS.POINT_SERIES, "v", { kind: "point", lat: 0, lon: 0 })
  ).catch((e) => e.message);
  // Admitted: the backing reads start (here intercepted, so it fails).
  expect(r).toMatch(/intercepted/);
  expect(seen.length).toBeGreaterThan(0);
});
it("locates the cell across the wrap boundary of a non-global longitude axis", async () => {
  const s = await newStore();
  const centres = [0, 40, 80, 120, 160, 200, 240, 280, 300];
  const edges = [-45, 20, 60, 100, 140, 180, 220, 260, 290, 305];
  await write(s, "time", [0], [1], ["time"], TIME);
  await write(s, "lat", [-5, 5], [2], ["lat"], { units: "degrees_north" });
  await write(s, "lon", centres, [9], ["lon"], {
    units: "degrees_east",
    bounds: "lon_bounds",
  });
  await write(
    s,
    "lon_bounds",
    centres.flatMap((_, i) => [edges[i], edges[i + 1]]),
    [9, 2],
    ["lon", "nv"]
  );
  await write(
    s,
    "v",
    [11, 2, 3, 4, 5, 6, 7, 8, 9, 11, 2, 3, 4, 5, 6, 7, 8, 9],
    [1, 2, 9],
    ["time", "lat", "lon"]
  );
  const c = await context(s, "v");
  const answers = [];
  for (const x of [-40, -20, 310]) {
    answers.push(
      await run(
        c,
        q(ANALYSIS_KINDS.POINT_SERIES, "v", { kind: "point", lat: -5, lon: x })
      ).then(
        (r) => r.values,
        (e) => e.message
      )
    );
  }
  expect(answers[0]).toEqual([11]);
  expect(answers[1]).toEqual([11]);
});

describe("independent review of interim43: the Method panel's point cell", () => {
  it("says when edges are inferred, and tells microdegree centres apart", async () => {
    const { methodSections } = await import("@/ui/analysis/methodFacts.ts");
    for (const bounded of [false, true]) {
      const store = await newStore();
      const n = 81;
      const axis = Array.from({ length: n }, (_, k) => (k - 40) * 1e-6);
      const edges = (values: number[]) =>
        values.flatMap((v) => [v - 5e-7, v + 5e-7]);
      await write(store, "lat", axis, [n], ["lat"], {
        units: "degrees_north",
        ...(bounded ? { bounds: "lat_bnds" } : {}),
      });
      await write(store, "lon", axis, [n], ["lon"], {
        units: "degrees_east",
        ...(bounded ? { bounds: "lon_bnds" } : {}),
      });
      if (bounded) {
        await write(store, "lat_bnds", edges(axis), [n, 2], ["lat", "nv"]);
        await write(store, "lon_bnds", edges(axis), [n, 2], ["lon", "nv"]);
      }
      await write(store, "time", [0], [1], ["time"], {
        units: "days since 2000-01-01",
      });
      await write(
        store,
        "tas",
        Array.from({ length: n * n }, (_, k) => k),
        [1, n, n],
        ["time", "lat", "lon"]
      );
      const result = await run(
        await context(store, "tas"),
        q(ANALYSIS_KINDS.POINT_SERIES, "tas", {
          kind: "point",
          lat: -0.0000194,
          lon: 0.0000194,
        })
      );
      expect(result.cell!.selection).toBe(
        bounded
          ? "containing cell (from bounds)"
          : "containing cell (edges halfway between centres; no bounds published)"
      );
      expect(result.cell!.decimals).toBe(7);
      const rows = methodSections(result as never, {} as never)
        .flatMap((section) => section.rows)
        .map((row) => `${row.label}: ${row.value}`);
      expect(rows.find((row) => row.startsWith("Cell:"))).toContain(
        "centre -0.0000190°, 0.0000190°"
      );
    }
  });
});
it("review of interim45: explicit coordinates outrank a group HEALPix grid found by a dimension's length", async () => {
  for (const declare of ["dggs", "grid_mapping"] as const) {
    const s = new Map<string, Uint8Array>();
    await zarr.create(zarr.root(s), {
      attributes:
        declare === "dggs"
          ? {
              dggs: {
                name: "healpix",
                refinement_level: 1,
                indexing_scheme: "nested",
              },
            }
          : { grid_mapping: "hp_crs" },
    });
    if (declare === "grid_mapping") {
      await write(s, "hp_crs", [0], [], [], {
        grid_mapping_name: "healpix",
        healpix_nside: 2,
        healpix_order: "nest",
      });
    }
    await write(s, "time", [0, 1], [2], ["time"], TIME);
    await write(s, "lat", [-5, 5], [2], ["lat"], {
      standard_name: "latitude",
      units: "degrees_north",
    });
    // 48 longitudes: an order-1 HEALPix cell count.
    const lons = Array.from({ length: 48 }, (_, k) => 7.5 * k);
    await write(s, "lon", lons, [48], ["lon"], {
      standard_name: "longitude",
      units: "degrees_east",
    });
    await write(
      s,
      "v",
      Array.from({ length: 2 * 2 * 48 }, (_, k) => k),
      [2, 2, 48],
      ["time", "lat", "lon"]
    );
    // The HEALPix sibling itself.
    await write(
      s,
      "hp",
      Array.from({ length: 96 }, (_, k) => k),
      [2, 48],
      ["time", "cell"]
    );
    expect((await context(s, "v")).grid.kind, declare).toBe("rectilinear");
    expect((await context(s, "hp")).grid.kind, declare).toBe("healpix");
  }
});
