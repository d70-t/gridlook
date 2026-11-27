/* eslint-disable max-lines-per-function -- each grid builds its own fixture. */
/* eslint-disable camelcase -- CF and UGRID metadata use snake_case keys. */
import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { dropFrameDuplicates } from "@/lib/analysis/nativeGrid.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { rotatedToTrue } from "@/lib/analysis/rotatedPole.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import {
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  type TAnalysisQuery,
  type TGeometry,
} from "@/lib/analysis/types.ts";
import {
  ANALYSIS_GRID_KINDS,
  resolveVariableContext,
} from "@/lib/analysis/variableContext.ts";
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

describe("irregular sites", () => {
  async function sites() {
    const store = await newStore();
    await write(store, "time", [0, 1], [2], ["time"], TIME);
    await write(store, "lat", [0, 0], [2], ["site"], {
      units: "degrees_north",
    });
    await write(store, "lon", [179.8, -170], [2], ["site"], {
      units: "degrees_east",
    });
    // value 100 t + i
    await write(store, "tas", [0, 1, 100, 101], [2, 2], ["time", "site"], {
      coordinates: "lat lon",
    });
    return context(store, "tas");
  }

  it("keeps a region's centres, not the grid's geometry (review of interim33)", async () => {
    const { regionSelection } = await import("@/lib/analysis/operations.ts");
    const store = await newStore();
    await write(store, "time", [0], [1], ["time"], TIME);
    await write(store, "lat", [1, 2], [2], ["site"], {
      units: "degrees_north",
    });
    await write(store, "lon", [3, 4], [2], ["site"], {
      units: "degrees_east",
    });
    await write(store, "tas", [5, 6], [1, 2], ["time", "site"], {
      coordinates: "lat lon",
    });
    const ctx = await context(store, "tas");
    const selection = await regionSelection(
      ctx,
      { kind: "box", box: { south: 0, north: 5, west: 0, east: 5 } } as never,
      [],
      { geometryMs: 0 } as never
    );
    const grid = ctx.grid as { geometry: () => Promise<{ lat: Float64Array }> };
    // The geometry changes (another source's, released): the selection's
    // positions are its own.
    (await grid.geometry()).lat.fill(Number.NaN);
    expect(selection.positionOf!(new Float64Array(), 1)).toEqual([2, 4]);
  });

  it("finds the nearest site across 180°", async () => {
    const ctx = await sites();
    expect(ctx.grid.kind).toBe(ANALYSIS_GRID_KINDS.NATIVE);
    const series = await run(
      ctx,
      q(ANALYSIS_KINDS.POINT_SERIES, "tas", {
        kind: "point",
        lat: 0,
        lon: -179.9,
      })
    );
    expect(series.values).toEqual([0, 100]);
    expect(series.cell?.id).toBe("site=0");
    expect(series.cell?.selection).toMatch(/nearest site/);
  });

  it("leaves a gap beyond the cutoff", async () => {
    const ctx = await sites();
    const section = await run(
      ctx,
      q(
        ANALYSIS_KINDS.SECTION,
        "tas",
        {
          kind: "polyline",
          vertices: [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 10 },
          ],
        },
        { time: { start: 1, stop: 2 }, sectionSamples: 3 }
      )
    );
    expect(section.values.every(Number.isNaN)).toBe(true);
    expect(section.samples!.status).toEqual([
      "no stored cell",
      "no stored cell",
      "no stored cell",
    ]);
  });

  it("identifies a country station mean and its site coverage in the exported series", async () => {
    const { exportModel } = await import("@/lib/analysis/scientificExport.ts");
    const { chartSpec } = await import("@/ui/analysis/plotFigure.ts");
    const store = await newStore();
    await write(store, "time", [0], [1], ["time"], TIME);
    await write(store, "lat", [50, 51], [2], ["site"], {
      units: "degrees_north",
    });
    await write(store, "lon", [10, 11], [2], ["site"], {
      units: "degrees_east",
    });
    await write(store, "tas", [12, NaN], [1, 2], ["time", "site"], {
      coordinates: "lat lon",
    });
    const ctx = await context(store, "tas");
    const mean = await run(
      ctx,
      q(ANALYSIS_KINDS.REGION_SERIES, "tas", {
        kind: "country",
        id: "276",
        resolution: "50m",
      })
    );
    expect(mean.values).toEqual([12]);
    expect(mean.region?.sites).toBe(true);
    expect(mean.region?.coverage).toEqual([0.5]);
    const model = exportModel(mean);
    const variable = model.arrays.find((a) => a.name === "tas")!;
    const chart = chartSpec(mean)!;
    expect.soft(chart.readout(0).join(" ")).toMatch(/valid (sites|stations)/i);
    expect.soft(variable.attrs.cell_methods ?? "").not.toContain("area: mean");
    expect(model.arrays.some((a) => a.name === "valid_area_fraction")).toBe(
      false
    );
  });

  it("names a site mean's coverage columns as sites in its table", async () => {
    const { resultTable } = await import("@/lib/analysis/analysisExport.ts");
    const store = await newStore();
    await write(store, "time", [0], [1], ["time"], TIME);
    await write(store, "lat", [50, 51], [2], ["site"], {
      units: "degrees_north",
    });
    await write(store, "lon", [10, 11], [2], ["site"], {
      units: "degrees_east",
    });
    await write(store, "tas", [12, NaN], [1, 2], ["time", "site"], {
      coordinates: "lat lon",
    });
    const mean = await run(
      await context(store, "tas"),
      q(ANALYSIS_KINDS.REGION_SERIES, "tas", {
        kind: "country",
        id: "276",
        resolution: "50m",
      })
    );
    const table = resultTable(mean);
    expect(table.header).toContain("site_coverage");
    expect(table.header).toContain("valid_sites");
    expect(table.header).not.toContain("coverage");
  });

  it("describes equal-weight station statistics on the chart, in Method and in exports", async () => {
    const { chartSpec } = await import("@/ui/analysis/plotFigure.ts");
    const { methodSections } = await import("@/ui/analysis/methodFacts.ts");
    const { resultTable } = await import("@/lib/analysis/analysisExport.ts");
    const { exportModel } = await import("@/lib/analysis/scientificExport.ts");
    const mean = await run(
      await sites(),
      q(ANALYSIS_KINDS.REGION_SERIES, "tas", {
        kind: "box",
        west: 170,
        east: -160,
        south: -5,
        north: 5,
      })
    );
    expect(mean.values).toEqual([0.5, 100.5]);
    expect(mean.region?.sites).toBe(true);
    const method = methodSections(mean, { selection: "sites" })
      .flatMap((s) => s.rows)
      .find((r) => r.label === "Method");
    const spread = exportModel(mean).arrays.find((a) => a.name === "tas_std");
    expect.soft(chartSpec(mean)?.yTitle).not.toMatch(/area mean/i);
    expect.soft(method?.value).not.toMatch(/area-weighted/);
    expect.soft(resultTable(mean).header).not.toContain("area_std");
    expect(spread?.attrs.cell_methods ?? "").not.toContain(
      "area: standard_deviation"
    );
  });

  it("averages the sites inside, said so; other area plots stay refused (v27 review §4)", async () => {
    const ctx = await sites();
    // No area: distributions and Hovmöllers say why, and what is offered.
    expect(ctx.capabilities[ANALYSIS_KINDS.DISTRIBUTION]).toMatchObject({
      available: false,
      reason: expect.stringMatching(
        /no implied area.*averages the sites inside instead/
      ),
    });
    // The series: the plain mean of the two sites, each counted once.
    const mean = await run(
      ctx,
      q(ANALYSIS_KINDS.REGION_SERIES, "tas", {
        kind: "box",
        west: 170,
        east: -160,
        south: -5,
        north: 5,
      })
    );
    expect(mean.values).toEqual([0.5, 100.5]);
    expect(mean.region?.sites).toBe(true);
    expect(mean.region?.weighting).toMatch(/^equal weight per site/);
  });
});

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

  it("refuses a face field longer than the mesh (v20 review)", async () => {
    const store = await mesh(0, true);
    // Three values per time on a two-face mesh.
    await write(
      store,
      "extra",
      [10, 30, 50, 10, 30, 50],
      [2, 3],
      ["time", "face"],
      {
        mesh: "mesh",
        location: "face",
      }
    );
    const ctx = await context(store, "extra");
    expect(ctx.grid.kind).toBe(ANALYSIS_GRID_KINDS.UNSUPPORTED);
    expect((ctx.grid as { reason: string }).reason).toMatch(
      /3 values on face, the mesh 2 faces/
    );
  });

  const seamBox: TGeometry = {
    kind: "box",
    west: 170,
    east: -170,
    south: -10,
    north: 10,
  };

  for (const [startIndex, facesFirst] of [
    [0, true],
    [1, false],
  ] as const) {
    it(`means equal-area seam faces (start_index ${startIndex}, ${facesFirst ? "face, corner" : "corner, face"})`, async () => {
      const ctx = await context(await mesh(startIndex, facesFirst), "tos");
      const mean = await run(
        ctx,
        q(ANALYSIS_KINDS.REGION_SERIES, "tos", seamBox)
      );
      expect(mean.values[0]).toBeCloseTo(20, 12);
      expect(mean.values[1]).toBeCloseTo(20, 12);
      // A point on the shared edge belongs to the lower-numbered face.
      const edge = await run(
        ctx,
        q(ANALYSIS_KINDS.POINT_SERIES, "tos", {
          kind: "point",
          lat: 0,
          lon: 180,
        })
      );
      expect(edge.values).toEqual([10, 10]);
      const outside = await run(
        ctx,
        q(ANALYSIS_KINDS.POINT_SERIES, "tos", { kind: "point", lat: 0, lon: 0 })
      );
      expect(outside.values.every(Number.isNaN)).toBe(true);
    });
  }

  it("broadcasts a scalar face area to every face (review of interim26)", async () => {
    const store = await mesh(0, true);
    const area = await zarr.create(zarr.root(store as never).resolve("area"), {
      shape: [],
      chunkShape: [],
      dtype: "float64",
      attributes: { units: "m2" },
    });
    await zarr.set(area as never, null, 5 as never);
    await write(store, "tos2", [2, 8, 2, 8], [2, 2], ["time", "face"], {
      mesh: "mesh",
      location: "face",
      cell_measures: "area: area",
    });
    const ctx = await context(store, "tos2");
    const mean = await run(
      ctx,
      q(ANALYSIS_KINDS.REGION_SERIES, "tos2", seamBox)
    );
    // Equal weights: the mean of 2 and 8, not the first face alone.
    expect(Array.from(mean.values)).toEqual([5, 5]);
  });

  it("review41: a missing response for mesh areas does not block a healthy seam-point series", async () => {
    const store = await mesh(0, true);
    await write(store, "area", [1, 2], [2], ["face"], { units: "m2" });
    await write(store, "tos2", [2, 8, 2, 8], [2, 2], ["time", "face"], {
      mesh: "mesh",
      location: "face",
      cell_measures: "area: area",
    });
    const point = async () =>
      run(
        await context(store, "tos2"),
        q(ANALYSIS_KINDS.POINT_SERIES, "tos2", {
          kind: "point",
          lat: 0,
          lon: 180,
        })
      );
    expect((await point()).values).toEqual([2, 2]);
    const get = store.get.bind(store);
    store.get = (key: string) => {
      if (key === "/area/zarr.json") {
        throw new Error("503 Service Unavailable");
      }
      return get(key);
    };
    await expect(point()).resolves.toMatchObject({ values: [2, 2] });
  });

  it("independent review of interim41: an empty Box reads none of the declared areas", async () => {
    const store = await mesh(0, true);
    await write(store, "area", [1, 2], [2], ["face"], { units: "m2" });
    await write(store, "tos2", [2, 8, 2, 8], [2, 2], ["time", "face"], {
      mesh: "mesh",
      location: "face",
      cell_measures: "area: area",
    });
    let areaReads = 0;
    const get = store.get.bind(store);
    store.get = (key: string) => {
      areaReads += key.startsWith("/area/c/") ? 1 : 0;
      return get(key);
    };
    const box = {
      // Over the mesh, between its two face centres.
      kind: "box" as const,
      west: 176,
      east: 177,
      south: 3,
      north: 4,
    };
    for (const kind of [
      ANALYSIS_KINDS.REGION_SERIES,
      ANALYSIS_KINDS.HOVMOLLER_LON,
    ]) {
      await run(await context(store, "tos2"), q(kind, "tos2", box)).catch(
        () => undefined
      );
    }
    expect(areaReads).toBe(0);
  });

  it("independent review of interim41: refuses a declared face measure with no units", async () => {
    const store = await mesh(0, true);
    await write(store, "area", [1, 2], [2], ["face"]);
    await write(store, "tos2", [2, 8, 2, 8], [2, 2], ["time", "face"], {
      mesh: "mesh",
      location: "face",
      cell_measures: "area: area",
    });
    const region = (await context(store, "tos2")).capabilities[
      ANALYSIS_KINDS.REGION_SERIES
    ];
    expect(region.available).toBe(false);
    expect(region.reason).toMatch(/area have no units/);
  });

  it("refuses a declared face measure in seconds (review of interim37)", async () => {
    const store = await mesh(0, true);
    const area = await zarr.create(zarr.root(store as never).resolve("area"), {
      shape: [],
      chunkShape: [],
      dtype: "float64",
      attributes: { units: "s" },
    });
    await zarr.set(area as never, null, 5 as never);
    await write(store, "tos2", [2, 8, 2, 8], [2, 2], ["time", "face"], {
      mesh: "mesh",
      location: "face",
      cell_measures: "area: area",
    });
    const ctx = await context(store, "tos2");
    const region = ctx.capabilities[ANALYSIS_KINDS.REGION_SERIES];
    expect(region.available).toBe(false);
    expect(region.reason).toMatch(/"s", not an area/);
  });

  it("samples a path through both faces and marks the ends outside", async () => {
    const ctx = await context(await mesh(0, true), "tos");
    const path = await run(
      ctx,
      q(
        ANALYSIS_KINDS.SECTION,
        "tos",
        {
          kind: "polyline",
          vertices: [
            { lat: 0, lon: 172 },
            { lat: 0, lon: -172 },
          ],
        },
        { time: { start: 0, stop: 1 }, sectionSamples: 5 }
      )
    );
    expect(path.values.map((v) => (Number.isNaN(v) ? null : v))).toEqual([
      null,
      10,
      10,
      30,
      null,
    ]);
    expect(path.samples!.status[0]).toBe("no stored cell");
    expect(path.samples!.cells[3]).toBe("face=1");
  });

  it("bins a longitude × time band continuously across 180°", async () => {
    const ctx = await context(await mesh(0, true), "tos");
    const hov = await run(
      ctx,
      q(ANALYSIS_KINDS.HOVMOLLER_LON, "tos", seamBox, { binDegrees: 5 })
    );
    expect(hov.shape).toEqual([2, 4]);
    expect(
      hov.values.slice(0, 4).map((v) => (Number.isNaN(v) ? null : v))
    ).toEqual([null, 10, 30, null]);
  });

  it("loads the mesh geometry once for every plot and variable on it", async () => {
    const store = await mesh(0, true);
    const reads: string[] = [];
    const get = store.get.bind(store);
    store.get = (key: string) => {
      if (key.includes("node_lat/c")) {
        reads.push(key);
      }
      return get(key);
    };
    const dataset = zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `shared-${Math.random()}`
    );
    const cache = new ByteLru<BigInt64Array>(2 ** 20);
    const tos = await resolveVariableContext(dataset, "tos", cache);
    const point = { kind: "point" as const, lat: 1, lon: 178 };
    await run(tos, q(ANALYSIS_KINDS.POINT_SERIES, "tos", point));
    await run(tos, q(ANALYSIS_KINDS.REGION_SERIES, "tos", seamBox));
    const again = await resolveVariableContext(dataset, "tos", cache);
    await run(again, q(ANALYSIS_KINDS.POINT_SERIES, "tos", point));
    expect(reads).toHaveLength(1);
  });

  it("shares the mesh's coordinates between face and node fields (v8 review)", async () => {
    const store = await mesh(0, true);
    const reads: string[] = [];
    const get = store.get.bind(store);
    store.get = (key: string) => {
      if (/node_lat\/c|face_nodes\/c/.test(key)) {
        reads.push(key);
      }
      return get(key);
    };
    const dataset = zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `switch-${Math.random()}`
    );
    const cache = new ByteLru<BigInt64Array>(2 ** 20);
    const point = { kind: "point" as const, lat: 1, lon: 178 };
    const tos = await resolveVariableContext(dataset, "tos", cache);
    await run(tos, q(ANALYSIS_KINDS.POINT_SERIES, "tos", point));
    const zeta = await resolveVariableContext(dataset, "zeta", cache);
    await run(zeta, q(ANALYSIS_KINDS.POINT_SERIES, "zeta", point));
    // Nodes and connectivity once each, not once per field location.
    expect(reads).toHaveLength(2);
  });

  it("reads node data at the nearest node of the containing face", async () => {
    const store = await mesh(0, true);
    const nodal = await context(store, "zeta");
    const near = { kind: "point" as const, lat: -4, lon: -176 };
    const atNode = await run(
      nodal,
      q(ANALYSIS_KINDS.POINT_SERIES, "zeta", near)
    );
    expect(atNode.values).toEqual([103, 203]);
    expect(atNode.cell?.selection).toMatch(/nearest node/);
    const faces = await context(store, "tos");
    const atFace = await run(
      faces,
      q(ANALYSIS_KINDS.POINT_SERIES, "tos", near)
    );
    expect(atFace.values).toEqual([30, 30]);
  });

  it("means node values by lumped node areas (v27 review §4)", async () => {
    const nodal = await context(await mesh(0, true), "zeta");
    expect(nodal.capabilities[ANALYSIS_KINDS.REGION_SERIES].available).toBe(
      true
    );
    // Two congruent triangles (0,1,2) and (0,2,3): nodes 0 and 2 hold two
    // thirds of a triangle each, nodes 1 and 3 one third.
    const mean = await run(
      nodal,
      q(ANALYSIS_KINDS.REGION_SERIES, "zeta", seamBox)
    );
    expect(mean.values[0]).toBeCloseTo((100 * 2 + 101 + 102 * 2 + 103) / 6, 9);
    expect(mean.values[1]).toBeCloseTo((200 * 2 + 201 + 202 * 2 + 203) / 6, 9);
  });
});

describe("curvilinear cells", () => {
  it("maps a warped (j,i) location back through a transposed field (i,t,j)", async () => {
    const store = await newStore();
    await write(store, "time", [0, 1], [2], ["time"], TIME);
    const lat: number[] = [];
    const lon: number[] = [];
    for (let j = 0; j < 2; j++) {
      for (let i = 0; i < 3; i++) {
        lat.push(10 * j + i);
        lon.push(10 * i + 2 * j);
      }
    }
    await write(store, "lat", lat, [2, 3], ["j", "i"], {
      standard_name: "latitude",
      units: "degrees_north",
    });
    await write(store, "lon", lon, [2, 3], ["j", "i"], {
      standard_name: "longitude",
      units: "degrees_east",
    });
    const data: number[] = [];
    for (let i = 0; i < 3; i++) {
      for (let t = 0; t < 2; t++) {
        for (let j = 0; j < 2; j++) {
          data.push(100 * t + 10 * j + i);
        }
      }
    }
    await write(store, "thetao", data, [3, 2, 2], ["i", "time", "j"], {
      coordinates: "lat lon",
    });
    const ctx = await context(store, "thetao");
    expect(ctx.grid.kind).toBe(ANALYSIS_GRID_KINDS.NATIVE);
    const series = await run(
      ctx,
      q(ANALYSIS_KINDS.POINT_SERIES, "thetao", {
        kind: "point",
        lat: 12,
        lon: 22,
      })
    );
    expect(series.values).toEqual([12, 112]);
    expect(series.cell?.id).toBe("i=2, j=1");
    expect(series.cell?.selection).toMatch(/nearest cell centre/);
  });

  async function measured(second: number, secondArea = 3) {
    const store = await newStore();
    await write(store, "time", [0], [1], ["time"], TIME);
    await write(store, "lat", [0, 1], [1, 2], ["y", "x"], {
      standard_name: "latitude",
    });
    await write(store, "lon", [0, 10], [1, 2], ["y", "x"], {
      standard_name: "longitude",
    });
    await write(store, "cell_area", [1, secondArea], [1, 2], ["y", "x"], {
      units: "m2",
    });
    await write(store, "so", [2, second], [1, 1, 2], ["time", "y", "x"], {
      coordinates: "lat lon",
      cell_measures: "area: cell_area",
    });
    return context(store, "so");
  }

  const box: TGeometry = {
    kind: "box",
    west: -1,
    east: 11,
    south: -1,
    north: 2,
  };

  it("weights by the declared cell areas", async () => {
    const mean = await run(
      await measured(10),
      q(ANALYSIS_KINDS.REGION_SERIES, "so", box)
    );
    expect(mean.values).toEqual([8]);
    expect(mean.region!.coverage).toEqual([1]);
  });

  it("selects the one native centre that falls in Gabon for either regional plot", async () => {
    const ctx = await measured(10);
    const gabon = { kind: "country", id: "266", resolution: "110m" } as const;
    const mean = await run(ctx, q(ANALYSIS_KINDS.REGION_SERIES, "so", gabon));
    const dist = await run(ctx, q(ANALYSIS_KINDS.DISTRIBUTION, "so", gabon));
    expect(mean.values).toEqual([10]);
    expect(dist.histogram).toMatchObject({ selectedCells: 1, mean: 10 });
  });

  it("excludes zero-area observations from the histogram range and valid count", async () => {
    const result = await run(
      await measured(1e6, 0),
      q(ANALYSIS_KINDS.DISTRIBUTION, "so", box)
    );
    expect(result.histogram).toMatchObject({
      validCells: 1,
      selectedCells: 2,
      constant: 2,
      mean: 2,
      validFraction: 1,
    });
    expect(result.values).toEqual([1]);
  });

  it("drops a masked value from the mean and the covered area", async () => {
    const mean = await run(
      await measured(Number.NaN),
      q(ANALYSIS_KINDS.REGION_SERIES, "so", box)
    );
    expect(mean.values).toEqual([2]);
    expect(mean.region!.coverage).toEqual([0.25]);
  });

  it("permutes a measure stored (x, y) beside coordinates stored (y, x)", async () => {
    const store = await newStore();
    await write(store, "time", [0], [1], ["time"], TIME);
    await write(store, "lat", [0, 0, 1, 1], [2, 2], ["y", "x"], {
      standard_name: "latitude",
    });
    await write(store, "lon", [0, 10, 0, 10], [2, 2], ["y", "x"], {
      standard_name: "longitude",
    });
    // area(x, y): x=0 → [1, 5], x=1 → [2, 3].
    await write(store, "cell_area", [1, 5, 2, 3], [2, 2], ["x", "y"], {
      units: "m2",
    });
    await write(store, "so", [0, 10, 100, 0], [1, 2, 2], ["time", "y", "x"], {
      coordinates: "lat lon",
      cell_measures: "area: cell_area",
    });
    const mean = await run(
      await context(store, "so"),
      q(ANALYSIS_KINDS.REGION_SERIES, "so", box)
    );
    expect(mean.values[0]).toBeCloseTo(520 / 11, 10);
  });

  it("refuses a measure whose shape does not match the grid", async () => {
    const store = await newStore();
    await write(store, "time", [0], [1], ["time"], TIME);
    await write(store, "lat", [0, 1, 2], [1, 3], ["y", "x"], {
      standard_name: "latitude",
    });
    await write(store, "lon", [0, 5, 10], [1, 3], ["y", "x"], {
      standard_name: "longitude",
    });
    await write(store, "cell_area", [1, 1], [1, 2], ["y", "x"], {
      units: "m2",
    });
    await write(store, "so", [1, 2, 3], [1, 1, 3], ["time", "y", "x"], {
      coordinates: "lat lon",
      cell_measures: "area: cell_area",
    });
    await expect(
      run(
        await context(store, "so"),
        q(ANALYSIS_KINDS.REGION_SERIES, "so", box)
      )
    ).rejects.toThrow(/do not match the grid/);
  });

  it("routes a rotated grid with true 2-D coordinates to the curvilinear locator", async () => {
    const store = await newStore();
    await write(store, "rlat", [0, 1], [2], ["rlat"], {
      standard_name: "grid_latitude",
    });
    await write(store, "rlon", [0, 1], [2], ["rlon"], {
      standard_name: "grid_longitude",
    });
    await write(store, "lat", [50, 50.5, 51, 51.5], [2, 2], ["rlat", "rlon"], {
      standard_name: "latitude",
    });
    await write(store, "lon", [8, 9, 8.2, 9.2], [2, 2], ["rlat", "rlon"], {
      standard_name: "longitude",
    });
    await write(store, "tas", [1, 2, 3, 4], [2, 2], ["rlat", "rlon"], {
      coordinates: "lat lon",
    });
    const ctx = await context(store, "tas");
    expect(ctx.grid.kind).toBe(ANALYSIS_GRID_KINDS.NATIVE);
    const path = await run(
      ctx,
      q(
        ANALYSIS_KINDS.SECTION,
        "tas",
        {
          kind: "polyline",
          vertices: [
            { lat: 51, lon: 8.2 },
            { lat: 51.5, lon: 9.2 },
          ],
        },
        { sectionSamples: 2 }
      )
    );
    expect(path.values).toEqual([3, 4]);
  });

  it("locates on a rotated grid that names only rlat/rlon and its pole (v27 review §4)", async () => {
    const store = await newStore();
    await write(store, "rotated_pole", [0], [1], ["one"], {
      grid_mapping_name: "rotated_latitude_longitude",
      grid_north_pole_latitude: 39.25,
      grid_north_pole_longitude: -162,
    });
    await write(store, "rlat", [-1, 0, 1], [3], ["rlat"], {
      standard_name: "grid_latitude",
      units: "degrees",
    });
    await write(store, "rlon", [-1, 0, 1], [3], ["rlon"], {
      standard_name: "grid_longitude",
      units: "degrees",
    });
    await write(
      store,
      "tas",
      [1, 2, 3, 4, 5, 6, 7, 8, 9],
      [3, 3],
      ["rlat", "rlon"],
      { grid_mapping: "rotated_pole" }
    );
    const ctx = await context(store, "tas");
    expect(ctx.grid.kind).toBe(ANALYSIS_GRID_KINDS.NATIVE);
    // The true position of rotated (1, 1): the corner cell, value 9.
    const at = rotatedToTrue({ lat: 39.25, lon: -162, gridLon: 0 })(1, 1);
    const section = await run(
      ctx,
      q(
        ANALYSIS_KINDS.SECTION,
        "tas",
        {
          kind: "polyline",
          vertices: [
            { lat: at.lat, lon: at.lon },
            { lat: at.lat - 0.0001, lon: at.lon },
          ],
        },
        { sectionSamples: 2 }
      )
    );
    expect(section.values).toEqual([9, 9]);
  });

  it("final review of interim41: a rotated grid's large stored axis chunks are priced", async () => {
    const store = await newStore();
    await write(store, "rotated_pole", [0], [1], ["one"], {
      grid_mapping_name: "rotated_latitude_longitude",
      grid_north_pole_latitude: 39.25,
      grid_north_pole_longitude: -162,
    });
    // Two values each, in a declared chunk of 2^25 float64 (256 MiB);
    // nothing is written, so nothing large is held here.
    for (const name of ["rlat", "rlon"]) {
      await zarr.create(zarr.root(store).resolve(name), {
        shape: [2],
        chunkShape: [2 ** 25],
        dtype: "float64",
        dimensionNames: [name],
        attributes: {
          standard_name: name === "rlat" ? "grid_latitude" : "grid_longitude",
          units: "degrees",
        },
        fillValue: 0 as never,
      });
    }
    await write(store, "tas", [1, 2, 3, 4], [2, 2], ["rlat", "rlon"], {
      grid_mapping: "rotated_pole",
    });
    const ctx = await context(store, "tas");
    if (ctx.grid.kind !== ANALYSIS_GRID_KINDS.NATIVE) {
      throw Error("fixture grid");
    }
    // Each stored chunk is 256 MiB, not the computed 32 bytes; both are
    // held at once: 512 MiB of working memory, past the limit.
    expect(ctx.grid.geometryChunkBytes).toBe(2 ** 28);
    expect(ctx.grid.geometryBytes).toBeGreaterThan(2 * 2 ** 28);
    await expect(
      planAnalysis(
        ctx,
        q(ANALYSIS_KINDS.SECTION, "tas", {
          kind: "polyline",
          vertices: [
            { lat: 40, lon: -170 },
            { lat: 41, lon: -160 },
          ],
        }),
        new ReadContext()
      )
    ).rejects.toThrow(/MiB/);
  });

  it("review of interim43: two legal rotated axis chunks are two chunks, not one", async () => {
    const store = await newStore();
    await write(store, "rotated_pole", [0], [1], ["one"], {
      grid_mapping_name: "rotated_latitude_longitude",
      grid_north_pole_latitude: 39.25,
      grid_north_pole_longitude: -162,
    });
    // 17,000,000 float64 a declared chunk: 129.7 MiB each, 259.4 together.
    for (const name of ["rlat", "rlon"]) {
      await zarr.create(zarr.root(store).resolve(name), {
        shape: [2],
        chunkShape: [17_000_000],
        dtype: "float64",
        dimensionNames: [name],
        attributes: {
          standard_name: name === "rlat" ? "grid_latitude" : "grid_longitude",
          units: "degrees",
        },
        fillValue: 0 as never,
      });
    }
    await write(store, "tas", [1, 2, 3, 4], [2, 2], ["rlat", "rlon"], {
      grid_mapping: "rotated_pole",
    });
    const ctx = await context(store, "tas");
    if (ctx.grid.kind !== ANALYSIS_GRID_KINDS.NATIVE) {
      throw Error("fixture grid");
    }
    expect(ctx.grid.geometryChunkBytes).toBe(17_000_000 * 8);
    // Under the 256 MiB a chunk and the 512 MiB working limit: planned.
    await expect(
      planAnalysis(
        ctx,
        q(ANALYSIS_KINDS.SECTION, "tas", {
          kind: "polyline",
          vertices: [
            { lat: 40, lon: -170 },
            { lat: 41, lon: -160 },
          ],
        }),
        new ReadContext()
      )
    ).resolves.toBeDefined();
  });

  it("review of interim30: a rotated grid's axes are priced, not read, when it is described", async () => {
    const store = await newStore();
    await write(store, "rotated_pole", [0], [1], ["one"], {
      grid_mapping_name: "rotated_latitude_longitude",
      grid_north_pole_latitude: 39.25,
      grid_north_pole_longitude: -162,
    });
    const n = 100;
    for (const name of ["rlat", "rlon"]) {
      const axis = await zarr.create(zarr.root(store).resolve(name), {
        shape: [n],
        chunkShape: [1],
        dtype: "float64",
        dimensionNames: [name],
        attributes: {
          standard_name: name === "rlat" ? "grid_latitude" : "grid_longitude",
          units: "degrees",
        },
        fillValue: Number.NaN as never,
      });
      await zarr.set(axis as never, null, {
        data: Float64Array.from({ length: n }, (_, k) => k / 10 - 5),
        shape: [n],
        stride: [1],
      } as never);
    }
    await write(
      store,
      "tas",
      Array.from({ length: n * n }, (_, k) => k),
      [n, n],
      ["rlat", "rlon"],
      { grid_mapping: "rotated_pole" }
    );
    let axisReads = 0;
    const get = store.get.bind(store);
    store.get = (key: string) => {
      if (/\/?rl(at|on)\/c\//.test(key)) {
        axisReads++;
      }
      return get(key);
    };
    const ctx = await context(store, "tas");
    expect(axisReads).toBe(0);
    const grid = ctx.grid as unknown as { geometryReadsNow: () => number };
    expect(grid.geometryReadsNow()).toBe(2 * n);
  });

  it("counts a halo column and a fold row once (v27 review §4)", async () => {
    // 3 × 4 cells; the last column repeats the first (an ORCA halo) and the
    // top row's right half repeats its left half mirrored (a tripolar fold).
    const lat = [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2];
    const lon = [10, 11, 12, 10, 10, 11, 12, 10, 10, 11, 11, 10];
    const latA = Float64Array.from(lat);
    const lonA = Float64Array.from(lon);
    // Halo: (0,3), (1,3), (2,3); fold: (2,2) repeats (2,1).
    expect(dropFrameDuplicates(latA, lonA, [3, 4])).toBe(4);
    expect([3, 7, 10, 11].every((at) => Number.isNaN(latA[at]))).toBe(true);
    // A mean over the grid: each place once (values 0 and 30 by column).
    const store = await newStore();
    await write(store, "time", [0], [1], ["time"], TIME);
    await write(store, "lat", lat, [3, 4], ["y", "x"], {
      standard_name: "latitude",
    });
    await write(store, "lon", lon, [3, 4], ["y", "x"], {
      standard_name: "longitude",
    });
    await write(store, "cell_area", new Array(12).fill(1), [3, 4], ["y", "x"], {
      units: "m2",
    });
    await write(
      store,
      "so",
      [0, 0, 30, 0, 0, 0, 30, 0, 0, 0, 0, 0],
      [1, 3, 4],
      ["time", "y", "x"],
      { coordinates: "lat lon", cell_measures: "area: cell_area" }
    );
    const mean = await run(
      await context(store, "so"),
      q(ANALYSIS_KINDS.REGION_SERIES, "so", {
        kind: "box",
        west: 9.5,
        east: 12.5,
        south: -0.5,
        north: 2.5,
      })
    );
    // Eight distinct cells, two of them 30: 7.5 (the halo and fold copies
    // would have made it 5).
    expect(mean.values).toEqual([7.5]);
    expect(mean.region?.weighting).toMatch(
      /4 repeated cells of the grid \(halo or fold\) counted once/
    );
  });

  it("contains a location in a cell from its corners", async () => {
    const store = await newStore();
    await write(store, "lat", [0, 0], [1, 2], ["y", "x"], {
      standard_name: "latitude",
      bounds: "lat_bnds",
    });
    await write(store, "lon", [0.5, 1.5], [1, 2], ["y", "x"], {
      standard_name: "longitude",
      bounds: "lon_bnds",
    });
    // Corners counter-clockwise from the south-west.
    await write(
      store,
      "lat_bnds",
      [-1, -1, 1, 1, -1, -1, 1, 1],
      [1, 2, 4],
      ["y", "x", "nv"]
    );
    await write(
      store,
      "lon_bnds",
      [0, 1, 1, 0, 1, 2, 2, 1],
      [1, 2, 4],
      ["y", "x", "nv"]
    );
    await write(store, "h", [5, 7], [1, 2], ["y", "x"], {
      coordinates: "lat lon",
    });
    const ctx = await context(store, "h");
    expect(ctx.capabilities[ANALYSIS_KINDS.DISTRIBUTION].available).toBe(true);
    // Near the second cell's west edge: closer to the first centre, but
    // inside the second cell.
    const path = await run(
      ctx,
      q(
        ANALYSIS_KINDS.SECTION,
        "h",
        {
          kind: "polyline",
          vertices: [
            { lat: 0.9, lon: 1.05 },
            { lat: 0, lon: 3 },
          ],
        },
        { sectionSamples: 2 }
      )
    );
    expect(path.values[0]).toBe(7);
    expect(path.samples!.status[1]).toBe("no stored cell");
    expect(path.samples!.method).toMatch(/containing cell/);
  });
});

describe("native identity and containment (v6 review)", () => {
  /** Cells with corners: `cells` is a list of corner rings (lat, lon). */
  async function cellGrid(
    cells: [number, number][][],
    centres: [number, number][],
    units?: "radians"
  ) {
    const store = await newStore();
    const scale = units ? Math.PI / 180 : 1;
    const corners = cells[0].length;
    await write(store, "time", [0], [1], ["time"], TIME);
    const coord = (name: string, values: number[], bounds: string) =>
      write(store, name, values, [values.length], ["cell"], {
        units: units ?? (name === "lat" ? "degrees_north" : "degrees_east"),
        standard_name: name === "lat" ? "latitude" : "longitude",
        bounds,
      });
    await coord(
      "lat",
      centres.map(([la]) => la * scale),
      "lat_bnds"
    );
    await coord(
      "lon",
      centres.map(([, lo]) => lo * scale),
      "lon_bnds"
    );
    // Bounds without units inherit their coordinate's (CF 7.1).
    for (const [name, k] of [
      ["lat_bnds", 0],
      ["lon_bnds", 1],
    ] as const) {
      await write(
        store,
        name,
        cells.flatMap((ring) => ring.map((v) => v[k] * scale)),
        [cells.length, corners],
        ["cell", "nv"]
      );
    }
    await write(
      store,
      "v",
      cells.map((_, at) => at),
      [1, cells.length],
      ["time", "cell"],
      { coordinates: "lat lon" }
    );
    return context(store, "v");
  }

  /** 2 rows × 32 columns of 11.25° cells, centres stored in 0–360°. */
  function band() {
    const cells: [number, number][][] = [];
    const centres: [number, number][] = [];
    for (const [south, north] of [
      [-5, 0],
      [0, 5],
    ]) {
      for (let c = 0; c < 32; c++) {
        const west = c * 11.25;
        const east = west + 11.25;
        cells.push([
          [south, west],
          [south, east],
          [north, east],
          [north, west],
        ]);
        centres.push([(south + north) / 2, west + 5.625]);
      }
    }
    return { cells, centres };
  }

  const pick = async (
    ctx: Awaited<ReturnType<typeof context>>,
    lat: number,
    lon: number
  ) =>
    run(
      ctx,
      q(ANALYSIS_KINDS.POINT_SERIES, "v", { kind: "point", lat, lon })
    ).then((r) => r.values[0]);

  it("picks the same cell at −40° and 320°", async () => {
    const { cells, centres } = band();
    const ctx = await cellGrid(cells, centres);
    const expected = 32 + Math.floor(320 / 11.25);
    expect(await pick(ctx, 2.5, 320)).toBe(expected);
    expect(await pick(ctx, 2.5, -40)).toBe(expected);
    expect(await pick(ctx, 2.5, 680)).toBe(expected);
  });

  it("reads bounds without units in their coordinate's radians", async () => {
    const { cells, centres } = band();
    const ctx = await cellGrid(cells, centres, "radians");
    expect(await pick(ctx, 2.5, 20)).toBe(33);
    expect(await pick(ctx, -2.5, -40)).toBe(Math.floor(320 / 11.25));
  });

  it("contains points in a concave cell's arm, not in its notch, in both windings", async () => {
    const ring: [number, number][] = [
      [0, 0],
      [0, 10],
      [5, 10],
      [5, 5],
      [10, 5],
      [10, 0],
    ];
    for (const corners of [ring, [...ring].reverse()]) {
      const ctx = await cellGrid([corners], [[3, 3]]);
      expect(await pick(ctx, 8, 2)).toBe(0);
      expect(await pick(ctx, 2, 8)).toBe(0);
      expect(await pick(ctx, 8, 8)).toBeNaN();
    }
  });
});

describe("moving coordinates", () => {
  it("gives a reason for lat(time, site) instead of a static grid", async () => {
    const store = await newStore();
    await write(store, "time", [0, 1], [2], ["time"], TIME);
    await write(store, "lat", [10, 11, 20, 21], [2, 2], ["time", "site"], {
      standard_name: "latitude",
    });
    await write(store, "lon", [0, 1, 0, 1], [2, 2], ["time", "site"], {
      standard_name: "longitude",
    });
    await write(store, "v", [10, 11, 20, 21], [2, 2], ["time", "site"], {
      coordinates: "lat lon",
    });
    const ctx = await context(store, "v");
    expect(ctx.grid.kind).toBe(ANALYSIS_GRID_KINDS.UNSUPPORTED);
    expect((ctx.grid as { reason: string }).reason).toMatch(/vary along time/);
  });
});

describe("native geometry admission (v7 review)", () => {
  it("declines a one-face mesh whose node arrays hold 40 million nodes, before reading them", async () => {
    const store = await newStore();
    await write(store, "time", [0], [1], ["time"], TIME);
    await write(store, "mesh", [0], [1], ["one"], {
      cf_role: "mesh_topology",
      topology_dimension: 2,
      node_coordinates: "node_lon node_lat",
      face_node_connectivity: "face_nodes",
      face_dimension: "face",
    });
    // Metadata only: 40 M nodes, never written.
    for (const [name, standard] of [
      ["node_lat", "latitude"],
      ["node_lon", "longitude"],
    ]) {
      await zarr.create(zarr.root(store).resolve(name), {
        shape: [40_000_000],
        chunkShape: [1_000_000],
        dtype: "float64",
        dimensionNames: ["node"],
        attributes: { standard_name: standard },
        fillValue: Number.NaN as never,
      });
    }
    await write(
      store,
      "face_nodes",
      [0, 1, 2],
      [1, 3],
      ["face", "corner"],
      {},
      "int32"
    );
    await write(store, "tos", [10], [1, 1], ["time", "face"], {
      mesh: "mesh",
      location: "face",
    });
    const reads: string[] = [];
    const watched = new Proxy(store, {
      get(target, key, receiver) {
        const value = Reflect.get(target, key, receiver);
        return key === "get"
          ? (path: string) => {
              reads.push(path);
              return target.get(path);
            }
          : typeof value === "function"
            ? value.bind(target)
            : value;
      },
    });
    const ctx = await context(watched as never, "tos");
    expect(ctx.grid.kind).toBe(ANALYSIS_GRID_KINDS.UNSUPPORTED);
    expect((ctx.grid as { reason: string }).reason).toMatch(/40,000,000 cells/);
    expect(reads.some((path) => /node_lat\/c/.test(path))).toBe(false);
  });
});

describe("native geometry admission from stored chunks (v8 review)", () => {
  async function sites(count: number, chunk: number, latChunk = chunk) {
    const store = await newStore();
    await write(store, "time", [0], [1], ["time"], TIME);
    for (const [name, units, chunkShape] of [
      ["lat", "degrees_north", latChunk],
      ["lon", "degrees_east", chunk],
    ] as const) {
      const array = await zarr.create(zarr.root(store).resolve(name), {
        shape: [count],
        chunkShape: [chunkShape],
        dtype: "float64",
        dimensionNames: ["site"],
        attributes: { units },
        fillValue: Number.NaN as never,
      });
      if (chunkShape <= 2 ** 20) {
        await zarr.set(array as never, null, {
          data: Float64Array.from({ length: count }, (_, i) =>
            name === "lat" ? 0 : i * 0.1
          ),
          shape: [count],
          stride: [1],
        } as never);
      }
    }
    await write(
      store,
      "tas",
      Array.from({ length: count }, (_, i) => i),
      [1, count],
      ["time", "site"],
      { coordinates: "lat lon" }
    );
    return store;
  }

  it("refuses a 512 MiB declared coordinate chunk on a two-site grid, before reading it", async () => {
    const store = await sites(2, 2, 67_108_864);
    const reads: string[] = [];
    const get = store.get.bind(store);
    store.get = (key: string) => {
      if (key.includes("lat/c")) {
        reads.push(key);
      }
      return get(key);
    };
    const ctx = await context(store, "tas");
    expect(ctx.grid.kind).toBe(ANALYSIS_GRID_KINDS.NATIVE);
    await expect(
      planAnalysis(
        ctx,
        q(ANALYSIS_KINDS.POINT_SERIES, "tas", {
          kind: "point",
          lat: 0,
          lon: 0,
        }),
        new ReadContext()
      )
    ).rejects.toThrow(/declared chunk shape/);
    expect(reads).toEqual([]);
  });

  it("asks before many cold coordinate reads, and declining reads nothing (v9 review)", async () => {
    const store = await sites(256, 1);
    const reads: string[] = [];
    const get = store.get.bind(store);
    store.get = (key: string) => {
      if (/^\/?(lat|lon)\/c/.test(key)) {
        reads.push(key);
      }
      return get(key);
    };
    const ctx = await context(store, "tas");
    const planned = await planAnalysis(
      ctx,
      q(ANALYSIS_KINDS.SECTION, "tas", {
        kind: "polyline",
        vertices: [
          { lat: 0, lon: 0 },
          { lat: 0, lon: 25 },
        ],
      }),
      new ReadContext()
    );
    expect(planned.estimate.needsConfirmation).toBe(true);
    expect(planned.estimate.geometryReads).toBe(512);
    expect(reads).toEqual([]);
  });

  it("a second variable on loaded coordinates counts only its own new reads", async () => {
    const store = await sites(256, 1);
    await write(
      store,
      "area",
      Array.from({ length: 256 }, () => 1),
      [256],
      ["site"],
      { units: "m2" }
    );
    await write(
      store,
      "tas2",
      Array.from({ length: 256 }, (_, i) => i),
      [1, 256],
      ["time", "site"],
      { coordinates: "lat lon", cell_measures: "area: area" }
    );
    const dataset = zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `reuse-${Math.random()}`
    );
    const cache = new ByteLru<BigInt64Array>(2 ** 20);
    const first = await resolveVariableContext(dataset, "tas", cache);
    await run(
      first,
      q(ANALYSIS_KINDS.POINT_SERIES, "tas", { kind: "point", lat: 0, lon: 0.1 })
    );
    const second = await resolveVariableContext(dataset, "tas2", cache);
    const grid = second.grid as unknown as {
      geometryReadsNow: () => number;
      cornerAreas?: { readsNow: () => number };
    };
    // Coordinates are shared: nothing new to locate a point. The one-chunk area
    // array is an area plot's read.
    expect(grid.geometryReadsNow()).toBe(0);
    expect(grid.cornerAreas?.readsNow()).toBe(1);
  });

  it("counts cold coordinate reads separately, and none once loaded", async () => {
    const store = await sites(256, 1);
    const ctx = await context(store, "tas");
    const query = q(ANALYSIS_KINDS.POINT_SERIES, "tas", {
      kind: "point",
      lat: 0,
      lon: 0.1,
    });
    const cold = await planAnalysis(ctx, query, new ReadContext());
    expect(cold.estimate.geometryReads).toBe(512);
    expect(cold.estimate.modest).toBe(false);
    const fieldReads: string[] = [];
    const get = store.get.bind(store);
    store.get = (key: string) => {
      if (/^\/?tas\/c/.test(key)) {
        fieldReads.push(key);
      }
      return get(key);
    };
    const located = await planAnalysis(
      ctx,
      query,
      new ReadContext(),
      undefined,
      true
    );
    expect(located.estimate).toMatchObject({ chunks: 1, modest: true });
    expect(fieldReads).toEqual([]);
    expect((await located.execute()).values).toEqual([1]);
    expect(fieldReads.length).toBe(1);
    const warm = await planAnalysis(ctx, query, new ReadContext());
    expect(warm.estimate.geometryReads ?? 0).toBe(0);
    expect(warm.estimate.modest).toBe(true);
  });
});

describe("mesh metadata integrity (v9 review)", () => {
  it("refuses three node latitudes beside 80 million longitudes, reading neither", async () => {
    const store = await newStore();
    await write(store, "time", [0], [1], ["time"], TIME);
    await write(store, "mesh", [0], [1], ["one"], {
      cf_role: "mesh_topology",
      topology_dimension: 2,
      node_coordinates: "node_lon node_lat",
      face_node_connectivity: "face_nodes",
      face_dimension: "face",
    });
    await write(store, "node_lat", [0, 0, 1], [3], ["node"], {
      standard_name: "latitude",
    });
    await zarr.create(zarr.root(store).resolve("node_lon"), {
      shape: [80_000_000],
      chunkShape: [65_536],
      dtype: "float64",
      dimensionNames: ["node"],
      attributes: { standard_name: "longitude" },
      fillValue: Number.NaN as never,
    });
    await write(
      store,
      "face_nodes",
      [0, 1, 2],
      [1, 3],
      ["face", "corner"],
      {},
      "int32"
    );
    await write(store, "tos", [10], [1, 1], ["time", "face"], {
      mesh: "mesh",
      location: "face",
    });
    const reads: string[] = [];
    const get = store.get.bind(store);
    store.get = (key: string) => {
      if (/node_l(at|on)\/c/.test(key)) {
        reads.push(key);
      }
      return get(key);
    };
    const ctx = await context(store, "tos");
    expect(ctx.grid.kind).toBe(ANALYSIS_GRID_KINDS.UNSUPPORTED);
    expect((ctx.grid as { reason: string }).reason).toMatch(/disagree/);
    expect(reads).toEqual([]);
  });
});

describe("dimension roles before horizontal axes (v7 review)", () => {
  async function product(extra: (store: TStore) => Promise<void>) {
    const store = await newStore();
    await write(store, "record", [0], [1], ["record"], TIME);
    await write(store, "lat", [0, 1], [2], ["lat"], {
      units: "degrees_north",
    });
    await write(store, "lon", [0], [1], ["lon"], { units: "degrees_east" });
    await extra(store);
    return store;
  }

  it("a pressure dimension known only by its units is vertical", async () => {
    const store = await product(async (s) => {
      await write(s, "p", [850, 500], [2], ["p"], { units: "hPa" });
      await write(
        s,
        "air",
        [1, 2, 3, 4],
        [1, 2, 2, 1],
        ["record", "p", "lat", "lon"]
      );
    });
    const ctx = await context(store, "air");
    expect(ctx.vertical?.dimension).toBe("p");
    expect(ctx.vertical?.values).toEqual([850, 500]);
    expect(ctx.vertical?.positive).toBe("down");
    expect(ctx.capabilities[ANALYSIS_KINDS.PROFILE].available).toBe(true);
  });

  it("an auxiliary pressure(layer_id, lat, lon) makes layer_id vertical, not a fixed index", async () => {
    const store = await product(async (s) => {
      await write(s, "layer_id", [0, 1], [2], ["layer_id"]);
      await write(
        s,
        "pressure",
        [850, 849, 500, 499],
        [2, 2, 1],
        ["layer_id", "lat", "lon"],
        { units: "hPa" }
      );
      await write(
        s,
        "air",
        [10, 11, 20, 21],
        [1, 2, 2, 1],
        ["record", "layer_id", "lat", "lon"],
        { coordinates: "pressure" }
      );
    });
    const ctx = await context(store, "air");
    expect(ctx.vertical?.dimension).toBe("layer_id");
    expect(ctx.vertical?.note).toMatch(/pressure\(layer_id, lat, lon\)/);
    expect(ctx.others.map((o) => o.dimension)).not.toContain("layer_id");
    const section = await run(
      ctx,
      q(
        ANALYSIS_KINDS.SECTION,
        "air",
        {
          kind: "polyline",
          vertices: [
            { lat: 0, lon: 0 },
            { lat: 1, lon: 0 },
          ],
        },
        { sectionSamples: 2, time: { start: 0, stop: 1 } }
      )
    );
    // A curtain over both layers, not a surface path at layer 0.
    expect(section.shape).toEqual([2, 2]);
  });

  for (const [dim, attrs] of [
    ["plev", { units: "hPa" }],
    ["member", { standard_name: "realization" }],
  ] as const) {
    it(`refuses native positions that vary along ${dim}`, async () => {
      const store = await newStore();
      await write(store, dim, [0, 1], [2], [dim], attrs);
      await write(store, "lat", [10, 11, 20, 21], [2, 2], [dim, "site"], {
        standard_name: "latitude",
      });
      await write(store, "lon", [0, 1, 0, 1], [2, 2], [dim, "site"], {
        standard_name: "longitude",
      });
      await write(store, "v", [10, 11, 20, 21], [2, 2], [dim, "site"], {
        coordinates: "lat lon",
      });
      const ctx = await context(store, "v");
      expect(ctx.grid.kind).toBe(ANALYSIS_GRID_KINDS.UNSUPPORTED);
      expect((ctx.grid as { reason: string }).reason).toContain(
        `vary along ${dim}`
      );
    });
  }
});

describe("ensemble dimensions and surface heights (v8 review)", () => {
  // air(record, member, lat, lon): member 0 is 10 + lat, member 1 is 14 + lat.
  async function ensemble(extra: (store: TStore) => Promise<void>) {
    const store = await newStore();
    await write(store, "record", [0], [1], ["record"], TIME);
    await write(store, "member", [0, 1], [2], ["member"], {
      standard_name: "realization",
    });
    await write(store, "lat", [0, 1], [2], ["lat"], {
      units: "degrees_north",
    });
    await write(store, "lon", [0], [1], ["lon"], { units: "degrees_east" });
    await extra(store);
    return store;
  }
  const path = {
    kind: "polyline" as const,
    vertices: [
      { lat: 0, lon: 0 },
      { lat: 1, lon: 0 },
    ],
  };

  it("a member-varying surface height(member, lat, lon) is not a vertical axis", async () => {
    const store = await ensemble(async (s) => {
      await write(
        s,
        "height",
        [2, 2, 3, 3],
        [2, 2, 1],
        ["member", "lat", "lon"],
        {
          units: "m",
          standard_name: "height",
        }
      );
      await write(
        s,
        "air",
        [10, 11, 14, 15],
        [1, 2, 2, 1],
        ["record", "member", "lat", "lon"],
        { coordinates: "height" }
      );
    });
    const ctx = await context(store, "air");
    expect(ctx.vertical).toBeUndefined();
    expect(ctx.others.map((o) => o.dimension)).toContain("member");
    // Flagged, so a series can offer all members (plume, percentiles).
    expect(ctx.others.find((o) => o.dimension === "member")?.ensemble).toBe(
      true
    );
    const section = await run(
      ctx,
      q(ANALYSIS_KINDS.SECTION, "air", path, {
        sectionSamples: 2,
        fixed: { member: 0 },
        time: { start: 0, stop: 1 },
      })
    );
    expect(section.values).toEqual([10, 11]);
  });

  it("pressure(member, layer_id, lat, lon) makes layer_id vertical, never member", async () => {
    const store = await ensemble(async (s) => {
      await write(s, "layer_id", [0, 1], [2], ["layer_id"]);
      await write(
        s,
        "pressure",
        Array.from({ length: 8 }, (_, i) => 90000 - i * 1000),
        [2, 2, 2, 1],
        ["member", "layer_id", "lat", "lon"],
        { units: "Pa", standard_name: "air_pressure" }
      );
      // member m, layer k, lat j: 10 + 4 m + 4 k... member 0 levels 10/14.
      await write(
        s,
        "air",
        [10, 11, 14, 15, 18, 19, 22, 23],
        [1, 2, 2, 2, 1],
        ["record", "member", "layer_id", "lat", "lon"],
        { coordinates: "pressure" }
      );
    });
    const ctx = await context(store, "air");
    expect(ctx.vertical?.dimension).toBe("layer_id");
    const section = await run(
      ctx,
      q(ANALYSIS_KINDS.SECTION, "air", path, {
        sectionSamples: 2,
        fixed: { member: 0 },
        time: { start: 0, stop: 1 },
      })
    );
    expect(section.values).toEqual([10, 14, 11, 15]);
    // Physical pressure of member 0 at each column and level.
    expect(section.columnVertical).toEqual([90000, 88000, 89000, 87000]);
    expect(section.vertical?.units).toBe("Pa");
  });

  it("a pressure over two unresolved dimensions is reported, not drawn as a surface", async () => {
    const store = await ensemble(async (s) => {
      await write(s, "a", [0, 1], [2], ["a"]);
      await write(s, "b", [0, 1], [2], ["b"]);
      await write(
        s,
        "pressure",
        Array.from({ length: 8 }, (_, i) => 90000 - i * 1000),
        [2, 2, 2, 1],
        ["a", "b", "lat", "lon"],
        { units: "Pa", standard_name: "air_pressure" }
      );
      await write(
        s,
        "air",
        Array.from({ length: 8 }, (_, i) => i),
        [1, 2, 2, 2, 1],
        ["record", "a", "b", "lat", "lon"],
        { coordinates: "pressure" }
      );
    });
    const ctx = await context(store, "air");
    expect(ctx.vertical).toBeUndefined();
    const section = ctx.capabilities[ANALYSIS_KINDS.SECTION];
    expect(section.available).toBe(false);
    expect(section.reason).toMatch(/varies along a and b/);
  });

  it("a realization named only through run_id(run) is never vertical (v9 review)", async () => {
    const store = await newStore();
    await write(store, "record", [0], [1], ["record"], TIME);
    await write(store, "lat", [0, 1], [2], ["lat"], {
      units: "degrees_north",
    });
    await write(store, "lon", [0], [1], ["lon"], { units: "degrees_east" });
    await write(store, "run_id", [7, 8], [2], ["run"], {
      standard_name: "realization",
    });
    await write(
      store,
      "height",
      [2, 2, 3, 3],
      [2, 2, 1],
      ["run", "lat", "lon"],
      {
        units: "m",
        standard_name: "height",
      }
    );
    await write(
      store,
      "air",
      [10, 11, 14, 15],
      [1, 2, 2, 1],
      ["record", "run", "lat", "lon"],
      { coordinates: "run_id height" }
    );
    const ctx = await context(store, "air");
    expect(ctx.vertical).toBeUndefined();
    const section = await run(
      ctx,
      q(ANALYSIS_KINDS.SECTION, "air", path, {
        sectionSamples: 2,
        fixed: { run: 0 },
        time: { start: 0, stop: 1 },
      })
    );
    expect(section.values).toEqual([10, 11]);
  });
});

describe("feature coordinates are not motion (v9 review)", () => {
  it("a station_elevation(station) altitude keeps a static station grid", async () => {
    const store = await newStore();
    await write(store, "time", [0, 1], [2], ["time"], TIME);
    await write(store, "lat", [0, 10], [2], ["station"], {
      standard_name: "latitude",
      units: "degrees_north",
    });
    await write(store, "lon", [0, 10], [2], ["station"], {
      standard_name: "longitude",
      units: "degrees_east",
    });
    await write(store, "station_elevation", [100, 250], [2], ["station"], {
      standard_name: "altitude",
      units: "m",
      positive: "up",
    });
    await write(store, "tas", [4, 5, 104, 105], [2, 2], ["time", "station"], {
      coordinates: "lat lon station_elevation",
    });
    const ctx = await context(store, "tas");
    expect(ctx.grid.kind).toBe(ANALYSIS_GRID_KINDS.NATIVE);
    expect(ctx.vertical).toBeUndefined();
    const series = await run(
      ctx,
      q(ANALYSIS_KINDS.POINT_SERIES, "tas", { kind: "point", lat: 10, lon: 10 })
    );
    expect(series.values).toEqual([5, 105]);
  });

  it("refuses positions with a two-dimensional acquisition time", async () => {
    const store = await newStore();
    await write(store, "time", [0, 1, 2, 3], [2, 2], ["record", "site"], TIME);
    await write(store, "lat", [0, 0, 0, 0], [2, 2], ["record", "site"], {
      standard_name: "latitude",
    });
    await write(store, "lon", [0, 1, 0.5, 1.5], [2, 2], ["record", "site"], {
      standard_name: "longitude",
    });
    await write(store, "v", [10, 11, 20, 21], [2, 2], ["record", "site"], {
      coordinates: "time lat lon",
    });
    const ctx = await context(store, "v");
    expect(ctx.grid.kind).toBe(ANALYSIS_GRID_KINDS.UNSUPPORTED);
    expect((ctx.grid as { reason: string }).reason).toMatch(
      /vary along record/
    );
  });
});

describe("positions moving along an auxiliary time (v8 review)", () => {
  it("refuses lat(record, site) when time(record) is the auxiliary time", async () => {
    const store = await newStore();
    await write(store, "time", [0, 1], [2], ["record"], TIME);
    await write(store, "lat", [10, 11, 20, 21], [2, 2], ["record", "site"], {
      standard_name: "latitude",
    });
    await write(store, "lon", [0, 1, 0, 1], [2, 2], ["record", "site"], {
      standard_name: "longitude",
    });
    await write(store, "v", [10, 11, 20, 21], [2, 2], ["record", "site"], {
      coordinates: "time lat lon",
    });
    const ctx = await context(store, "v");
    expect(ctx.grid.kind).toBe(ANALYSIS_GRID_KINDS.UNSUPPORTED);
    expect((ctx.grid as { reason: string }).reason).toContain(
      "vary along record"
    );
  });
});

describe("UGRID topology references (v7 review)", () => {
  async function grouped(connectivity: number[], corners: number) {
    const store = await newStore();
    await zarr.create(zarr.root(store).resolve("topology"), {
      attributes: {},
    });
    await write(store, "time", [0], [1], ["time"], TIME);
    await write(store, "topology/mesh", [0], [1], ["one"], {
      cf_role: "mesh_topology",
      topology_dimension: 2,
      node_coordinates: "node_lon node_lat",
      face_node_connectivity: "face_nodes",
      face_coordinates: "face_lon face_lat",
      face_dimension: "face",
    });
    await write(store, "topology/node_lat", [0, 0, 1], [3], ["node"], {
      standard_name: "latitude",
    });
    await write(store, "topology/node_lon", [0, 1, 0], [3], ["node"], {
      standard_name: "longitude",
    });
    await write(store, "topology/face_lat", [0.5], [1], ["face"], {
      standard_name: "latitude",
    });
    await write(store, "topology/face_lon", [0.5], [1], ["face"], {
      standard_name: "longitude",
    });
    await write(
      store,
      "topology/face_nodes",
      connectivity,
      [1, corners],
      ["face", "corner"],
      { _FillValue: -1 },
      "int32"
    );
    await write(store, "tos", [7], [1, 1], ["time", "face"], {
      mesh: "topology/mesh",
      location: "face",
    });
    return context(store, "tos");
  }

  it("resolves names relative to the mesh's group and keeps the published centre", async () => {
    const ctx = await grouped([0, 1, 2], 3);
    expect(ctx.grid.kind).toBe(ANALYSIS_GRID_KINDS.NATIVE);
    // A small box around the published centre (0.5°, 0.5°), which the
    // computed centroid (~0.33°, ~0.33°) lies outside.
    const mean = await run(
      ctx,
      q(ANALYSIS_KINDS.REGION_SERIES, "tos", {
        kind: "box",
        west: 0.45,
        east: 0.55,
        south: 0.45,
        north: 0.55,
      })
    );
    expect(mean.values).toEqual([7]);
  });

  it("drops a face that refers past the last node instead of drawing it", async () => {
    const ctx = await grouped([0, 1, 99, 2], 4);
    const point = await run(
      ctx,
      q(ANALYSIS_KINDS.POINT_SERIES, "tos", {
        kind: "point",
        lat: 0.2,
        lon: 0.2,
      })
    );
    expect(point.values[0]).toBeNaN();
  });
});

describe("bounds resolve from their coordinate's group (v8 review)", () => {
  async function grouped(withBounds: boolean) {
    const store = await newStore();
    await zarr.create(zarr.root(store).resolve("grid"), { attributes: {} });
    await write(store, "time", [0], [1], ["time"], TIME);
    await write(store, "grid/lat", [0, 0], [2], ["cell"], {
      units: "degrees_north",
      bounds: "lat_bnds",
    });
    await write(store, "grid/lon", [0, 2], [2], ["cell"], {
      units: "degrees_east",
      bounds: "lon_bnds",
    });
    if (withBounds) {
      await write(
        store,
        "grid/lat_bnds",
        [-1, -1, 1, 1, -1, -1, 1, 1],
        [2, 4],
        ["cell", "corner"],
        { units: "degrees_north" }
      );
      await write(
        store,
        "grid/lon_bnds",
        [-1, 1, 1, -1, 1, 3, 3, 1],
        [2, 4],
        ["cell", "corner"],
        { units: "degrees_east" }
      );
    }
    await write(store, "tas", [5, 7], [1, 2], ["time", "cell"], {
      coordinates: "grid/lat grid/lon",
    });
    return context(store, "tas");
  }

  it("uses bounds named relative to grid/lat", async () => {
    const ctx = await grouped(true);
    expect(ctx.grid.kind).toBe(ANALYSIS_GRID_KINDS.NATIVE);
    expect((ctx.grid as { method: string }).method).toMatch(/containing cell/);
    const series = await run(
      ctx,
      q(ANALYSIS_KINDS.POINT_SERIES, "tas", {
        kind: "point",
        lat: 0.5,
        lon: 1.5,
      })
    );
    expect(series.values).toEqual([7]);
  });

  it("says so when declared bounds cannot be read", async () => {
    const ctx = await grouped(false);
    expect(ctx.grid.kind).toBe(ANALYSIS_GRID_KINDS.UNSUPPORTED);
    expect((ctx.grid as { reason: string }).reason).toMatch(
      /lat_bnds and lon_bnds .* cannot be read/
    );
  });
});

describe("a catalog level with separate grid and data stores (v9 review)", () => {
  it("reads ICON-like clat/clon and their bounds from the grid store", async () => {
    const { composeDatasets } = await import("@/lib/analysis/sourceAdapter.ts");
    const RAD = Math.PI / 180;
    const grid = await newStore();
    await write(
      grid,
      "clat",
      [0, 0].map((v) => v * RAD),
      [2],
      ["cell"],
      {
        standard_name: "latitude",
        units: "radian",
        bounds: "clat_bnds",
      }
    );
    await write(
      grid,
      "clon",
      [0.5, 2.5].map((v) => v * RAD),
      [2],
      ["cell"],
      {
        standard_name: "longitude",
        units: "radian",
        bounds: "clon_bnds",
      }
    );
    await write(
      grid,
      "clat_bnds",
      [-1, -1, 1, -1, -1, 1].map((v) => v * RAD),
      [2, 3],
      ["cell", "vertices"]
    );
    await write(
      grid,
      "clon_bnds",
      [-0.5, 1.5, 0.5, 1.5, 3.5, 2.5].map((v) => v * RAD),
      [2, 3],
      ["cell", "vertices"]
    );
    const data = await newStore();
    await write(data, "time", [0, 1], [2], ["time"], TIME);
    await write(data, "tas", [280, 290, 281, 291], [2, 2], ["time", "cell"], {
      coordinates: "clat clon",
    });
    const dataset = composeDatasets(
      zarrAnalysisDatasetFromStore(data as never, "", ZARR_FORMAT.V3, "data"),
      [zarrAnalysisDatasetFromStore(grid as never, "", ZARR_FORMAT.V3, "grid")]
    );
    const ctx = await resolveVariableContext(
      dataset,
      "tas",
      new ByteLru<BigInt64Array>(2 ** 20)
    );
    expect(ctx.grid.kind).toBe(ANALYSIS_GRID_KINDS.NATIVE);
    expect((ctx.grid as { method: string }).method).toMatch(/containing cell/);
    const series = await run(
      ctx,
      q(ANALYSIS_KINDS.POINT_SERIES, "tas", { kind: "point", lat: 0, lon: 2.4 })
    );
    expect(series.values).toEqual([290, 291]);
    expect(series.cell?.id).toBe("cell=1");
  });
});

describe("density-aware site lookup (v9 review)", () => {
  it("8 picks among 10,000 clustered stations test few candidates, exactly", async () => {
    const { SphereIndex } = await import("@/lib/analysis/nativeGrid.ts");
    let seed = 7;
    const random = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
    const n = 10_000;
    const lat = Float64Array.from({ length: n }, () => 45 + random() * 0.01);
    const lon = Float64Array.from({ length: n }, () => 7 + random() * 0.01);
    const index = new SphereIndex(lat, lon);
    let candidates = 0;
    for (let pick = 0; pick < 8; pick++) {
      const [plat, plon] = [45 + random() * 0.01, 7 + random() * 0.01];
      const found = index.nearest(plat, plon, 1)!;
      candidates += index.lastCandidates;
      // Brute force agrees.
      let best = -1;
      let bestD = Infinity;
      for (let at = 0; at < n; at++) {
        const d =
          (lat[at] - plat) ** 2 +
          ((lon[at] - plon) * Math.cos((45 * Math.PI) / 180)) ** 2;
        if (d < bestD) {
          [best, bestD] = [at, d];
        }
      }
      expect(found.item).toBe(best);
    }
    // Was 160,000 with uniform buckets.
    expect(candidates).toBeLessThan(8 * 200);
  });
});

describe("cell measures broadcast by dimension name (v9 review)", () => {
  it("area(j) weights a curvilinear (j, i) grid row by row: mean 8.5", async () => {
    const store = await newStore();
    await write(store, "time", [0], [1], ["time"], TIME);
    await write(store, "lat", [0, 0, 1, 1], [2, 2], ["j", "i"], {
      standard_name: "latitude",
      units: "degrees_north",
    });
    await write(store, "lon", [0, 1, 0, 1], [2, 2], ["j", "i"], {
      standard_name: "longitude",
      units: "degrees_east",
    });
    await write(store, "area", [1, 3], [2], ["j"], { units: "m2" });
    await write(store, "temp", [0, 2, 10, 12], [1, 2, 2], ["time", "j", "i"], {
      coordinates: "lat lon",
      cell_measures: "area: area",
    });
    const ctx = await context(store, "temp");
    expect(ctx.capabilities[ANALYSIS_KINDS.REGION_SERIES].available).toBe(true);
    const mean = await run(
      ctx,
      q(ANALYSIS_KINDS.REGION_SERIES, "temp", {
        kind: "box",
        west: -1,
        east: 2,
        south: -1,
        north: 2,
      })
    );
    expect(mean.values[0]).toBeCloseTo(8.5, 12);
  });
});

it("a fragmented declared cell measure does not block a nearest-site time series", async () => {
  const store = await newStore();
  const count = 8193;
  await write(store, "time", [0, 1], [2], ["time"], TIME);
  await write(store, "lat", Array(count).fill(50), [count], ["site"], {
    units: "degrees_north",
  });
  const lons = Array.from({ length: count }, (_, i) => 8 + i / count);
  await write(store, "lon", lons, [count], ["site"], { units: "degrees_east" });
  // A valid constant area, represented by the Zarr fill value in all chunks.
  await zarr.create(zarr.root(store).resolve("area"), {
    shape: [count],
    chunkShape: [1],
    dimensionNames: ["site"],
    dtype: "float64",
    fillValue: 1,
    attributes: { units: "m2" },
  });
  const values = [...Array(count).fill(42), ...Array(count).fill(43)];
  const point = { kind: "point", lat: 50, lon: 8 } as const;
  for (const name of ["control", "with_measure"]) {
    await write(store, name, values, [2, count], ["time", "site"], {
      coordinates: "lat lon",
      ...(name === "with_measure" ? { cell_measures: "area: area" } : {}),
    });
    const ctx = await context(store, name);
    const result = await run(ctx, q(ANALYSIS_KINDS.POINT_SERIES, name, point));
    expect(result.values).toEqual([42, 43]);
  }
});

async function meshWithFragmentedFaceAreas() {
  const store = await newStore();
  const faces = 8192;
  const nodes = faces * 3;
  const ids = Array.from({ length: nodes }, (_, k) => k);
  await write(store, "mesh", [0], [1], ["one"], {
    cf_role: "mesh_topology",
    topology_dimension: 2,
    node_coordinates: "node_lon node_lat",
    face_node_connectivity: "faces",
    face_dimension: "face",
  });
  const lon = ids.map(
    (k) => 8 + 0.01 * Math.floor(k / 3) + (k % 3 === 1 ? 0.01 : 0)
  );
  const lat = ids.map((k) => (k % 3 === 2 ? 0.01 : 0));
  await write(store, "node_lon", lon, [nodes], ["node"], {
    units: "degrees_east",
  });
  await write(store, "node_lat", lat, [nodes], ["node"], {
    units: "degrees_north",
  });
  await write(store, "faces", ids, [faces, 3], ["face", "nv"], {}, "int32");
  await write(store, "time", [0, 1], [2], ["time"], TIME);
  await zarr.create(zarr.root(store).resolve("area"), {
    shape: [faces],
    chunkShape: [1],
    dimensionNames: ["face"],
    dtype: "float64",
    fillValue: 1,
    attributes: { units: "m2" },
  });
  return { store, faces };
}

it("does not price UGRID face areas when locating a point", async () => {
  const { store, faces } = await meshWithFragmentedFaceAreas();
  const values = [...Array(faces).fill(42), ...Array(faces).fill(43)];
  for (const name of ["control", "measured"]) {
    await write(store, name, values, [2, faces], ["time", "face"], {
      mesh: "mesh",
      location: "face",
      ...(name === "measured" ? { cell_measures: "area: area" } : {}),
    });
    const ctx = await context(store, name);
    const series = await run(
      ctx,
      q(ANALYSIS_KINDS.POINT_SERIES, name, {
        kind: "point",
        lon: 8.002,
        lat: 0.002,
      })
    );
    expect(series.values).toEqual([42, 43]);
  }
});

it("asks before a cold locator that decodes much in a few chunks", async () => {
  // 1,001 × 300 cells with 16 corners, one chunk per array: four reads, about
  // 78 MiB of centres and corners.
  const store = await newStore();
  const declare = (
    path: string,
    shape: number[],
    dims: string[],
    attrs: Record<string, unknown> = {}
  ) =>
    zarr.create(zarr.root(store).resolve(path), {
      shape,
      chunkShape: shape,
      dtype: "float64",
      dimensionNames: dims,
      attributes: attrs,
      fillValue: Number.NaN as never,
    });
  await declare("lat", [1001, 300], ["y", "x"], {
    standard_name: "latitude",
    bounds: "lat_bnds",
  });
  await declare("lon", [1001, 300], ["y", "x"], {
    standard_name: "longitude",
    bounds: "lon_bnds",
  });
  await declare("lat_bnds", [1001, 300, 16], ["y", "x", "nv"]);
  await declare("lon_bnds", [1001, 300, 16], ["y", "x", "nv"]);
  await write(store, "time", [0], [1], ["time"], {
    units: "days since 2000-01-01",
  });
  await declare("h", [1, 1001, 300], ["time", "y", "x"], {
    coordinates: "lat lon",
  });
  const reads: string[] = [];
  const get = store.get.bind(store);
  store.get = (key: string) => {
    if (/\/c\//.test(key) && !/time/.test(key)) {
      reads.push(key);
    }
    return get(key);
  };
  const ctx = await context(store, "h");
  const planned = await planAnalysis(
    ctx,
    q(ANALYSIS_KINDS.POINT_SERIES, "h", { kind: "point", lat: 1, lon: 1 }),
    new ReadContext()
  );
  expect(planned.estimate.needsConfirmation).toBe(true);
  expect(planned.estimate.modest).toBe(false);
  expect(planned.estimate.workingBytes).toBeGreaterThan(64 * 2 ** 20);
  expect(planned.estimate.notes.join(" ")).toMatch(/holds about \d+ MiB/);
  expect(reads).toEqual([]);
});

it("applies the coordinate chunk limit to face areas and mesh coordinates together", async () => {
  const { store, faces } = await meshWithFragmentedFaceAreas();
  await write(
    store,
    "measured",
    Array(faces * 2).fill(42),
    [2, faces],
    ["time", "face"],
    {
      mesh: "mesh",
      location: "face",
      cell_measures: "area: area",
    }
  );
  const ctx = await context(store, "measured");
  const query = q(ANALYSIS_KINDS.REGION_SERIES, "measured", {
    kind: "country",
    id: "266",
    resolution: "50m",
  });
  await expect(planAnalysis(ctx, query, new ReadContext())).rejects.toThrow(
    /8,195.*8,192/
  );
});

it("weights two variables on one mesh by their own declared areas (review of interim35)", async () => {
  // Two faces; A declares areas [1, 9], B [9, 1]: one Box over both gives
  // A 90, 91 and B 10, 11, whichever is read first.
  const store = await newStore();
  await write(store, "mesh", [0], [1], ["one"], {
    cf_role: "mesh_topology",
    topology_dimension: 2,
    node_coordinates: "node_lon node_lat",
    face_node_connectivity: "faces",
    face_dimension: "face",
  });
  await write(store, "node_lon", [0, 1, 0, 2, 3, 2], [6], ["node"], {
    units: "degrees_east",
  });
  await write(store, "node_lat", [0, 0, 1, 0, 0, 1], [6], ["node"], {
    units: "degrees_north",
  });
  await write(
    store,
    "faces",
    [0, 1, 2, 3, 4, 5],
    [2, 3],
    ["face", "nv"],
    {},
    "int32"
  );
  await write(store, "time", [0, 1], [2], ["time"], TIME);
  await write(store, "area_a", [1, 9], [2], ["face"], { units: "m2" });
  await write(store, "area_b", [9, 1], [2], ["face"], { units: "m2" });
  for (const [name, measure] of [
    ["a", "area_a"],
    ["b", "area_b"],
  ]) {
    await write(store, name, [0, 100, 1, 101], [2, 2], ["time", "face"], {
      mesh: "mesh",
      location: "face",
      cell_measures: `area: ${measure}`,
    });
  }
  const box = { kind: "box", west: -1, east: 4, south: -1, north: 2 } as const;
  // One dataset, as the app opens it: the mesh is shared between them.
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `native-${Math.random()}`
  );
  const means = async () => {
    const out: Record<string, number[]> = {};
    for (const name of ["a", "b"]) {
      const ctx = await resolveVariableContext(
        dataset,
        name,
        new ByteLru<BigInt64Array>(2 ** 20)
      );
      const r = await run(ctx, q(ANALYSIS_KINDS.REGION_SERIES, name, box));
      out[name] = [...r.values];
    }
    return out;
  };
  const got = await means();
  expect(got.a[0]).toBeCloseTo(90, 9);
  expect(got.a[1]).toBeCloseTo(91, 9);
  expect(got.b[0]).toBeCloseTo(10, 9);
  expect(got.b[1]).toBeCloseTo(11, 9);
});

it("keeps distinct cells that share a centre or sit 1e-7° apart (review of interim37)", () => {
  // Two rows; the last column repeats the first at +180°/−180°.
  const lat = Float64Array.from([0.5, 0.5, 0.5, -0.5, -0.5, -0.5]);
  const lon = Float64Array.from([180, 0, -180, 180, 0, -180]);
  // Their outlines differ (one each side of the seam): both kept.
  expect(dropFrameDuplicates(lat, lon, [2, 3], () => false)).toBe(0);
  expect(Array.from(lat).every(Number.isFinite)).toBe(true);
  // The same outline: one stored twice, dropped.
  expect(dropFrameDuplicates(lat, lon, [2, 3], () => true)).toBe(2);
  // Centres 0.0000001° and 0.0000004° apart are two places.
  const near = Float64Array.from([1e-7, 4e-7]);
  expect(dropFrameDuplicates(near, Float64Array.from([5, 5]), [1, 2])).toBe(0);
});

it("independent review of interim41: keeps one copy of each outline at a shared centre in any column order", () => {
  // Cells A (+180°) and B (−180°) share a centre; B is repeated as a halo.
  // Outlines: A's is "A", both B columns "B".
  for (const order of [
    ["A", "B", "B"],
    ["B", "B", "A"],
    ["B", "A", "B"],
  ]) {
    const lon = Float64Array.from(
      [...order, ...order].map((cell) => (cell === "A" ? 180 : -180))
    );
    const lat = Float64Array.from([0.5, 0.5, 0.5, -0.5, -0.5, -0.5]);
    const outline = [...order, ...order];
    const dropped = dropFrameDuplicates(
      lat,
      lon,
      [2, 3],
      (first, other) => outline[first] === outline[other]
    );
    // One B in each row goes; A and the other B stay.
    expect(dropped).toBe(2);
    const kept = outline.filter((_, at) => Number.isFinite(lat[at]));
    expect(kept.sort()).toEqual(["A", "A", "B", "B"]);
  }
});
