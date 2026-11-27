/* eslint-disable max-lines-per-function -- one reproducer per finding. */
/* eslint-disable camelcase -- CF and Zarr metadata use snake_case keys. */
import { describe, expect, it, vi } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import {
  ANALYSIS_KINDS,
  type TAnalysisKind,
  type TGeometry,
} from "@/lib/analysis/types.ts";
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
  dtype: "float64" | "int64" = "float64"
) {
  const array = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape: shape,
    dtype,
    dimensionNames: dims,
    attributes: attrs,
    fillValue: (dtype === "int64" ? 0n : Number.NaN) as never,
  });
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((product, n) => product * n, 1)
  );
  await zarr.set(array as never, null, {
    data:
      dtype === "int64"
        ? BigInt64Array.from(data.map(BigInt))
        : Float64Array.from(data),
    shape,
    stride,
  } as never);
}

async function newStore() {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  return store;
}

function open(store: TStore, variable: string) {
  return resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `v24-${Math.random()}`
    ),
    variable,
    new ByteLru<BigInt64Array>(2 ** 20)
  );
}

function query(
  kind: TAnalysisKind,
  variable: string,
  geometry: TGeometry,
  extra: Record<string, unknown> = {}
) {
  return {
    version: 1 as const,
    kind,
    source: { ref: "memory", versionStatus: "session" as const },
    variable,
    fixed: {},
    geometry,
    time: { start: 0, stop: 1 },
    ...extra,
  };
}

async function run(
  store: TStore,
  variable: string,
  kind: TAnalysisKind,
  geometry: TGeometry
) {
  const planned = await planAnalysis(
    await open(store, variable),
    query(kind, variable, geometry),
    new ReadContext()
  );
  return planned.execute();
}

const square = (west: number, south: number, east: number, north: number) => ({
  kind: "polygon" as const,
  vertices: [
    { lat: south, lon: west },
    { lat: south, lon: east },
    { lat: north, lon: east },
    { lat: north, lon: west },
  ],
});

describe("v24 review: the field's declared coordinates place it", () => {
  /** Rows and columns in Australia, by the field's own coordinates. */
  async function declared(dimension: Record<string, unknown> = {}) {
    const store = await newStore();
    await write(store, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    // Arrays named like the dimensions, in Germany.
    await write(store, "lat", [50, 51], [2], ["lat"], {
      ...dimension,
      bounds: "lat_b",
    });
    await write(
      store,
      "lat_b",
      [49.5, 50.5, 50.5, 51.5],
      [2, 2],
      ["lat", "nv"]
    );
    await write(store, "lon", [10, 11], [2], ["lon"], {
      units: "degrees_east",
      bounds: "lon_b",
    });
    await write(store, "lon_b", [9.5, 10.5, 10.5, 11.5], [2, 2], ["lon", "nv"]);
    await write(store, "plat", [-25, -26], [2], ["lat"], {
      units: "degrees_north",
      standard_name: "latitude",
      bounds: "plat_b",
    });
    await write(
      store,
      "plat_b",
      [-24.5, -25.5, -25.5, -26.5],
      [2, 2],
      ["lat", "nv"]
    );
    await write(store, "plon", [135, 136], [2], ["lon"], {
      units: "degrees_east",
      standard_name: "longitude",
      bounds: "plon_b",
    });
    await write(
      store,
      "plon_b",
      [134.5, 135.5, 135.5, 136.5],
      [2, 2],
      ["lon", "nv"]
    );
    await write(store, "tas", [5, 6, 7, 8], [1, 2, 2], ["time", "lat", "lon"], {
      coordinates: "plat plon",
    });
    return store;
  }

  it("an area mean uses them, not same-named arrays elsewhere", async () => {
    const store = await declared({ units: "degrees_north" });
    const germany = await run(
      store,
      "tas",
      ANALYSIS_KINDS.REGION_SERIES,
      square(5, 47, 15, 55)
    ).catch((error: Error) => error);
    expect(
      germany instanceof Error || !Number.isFinite(germany.values[0])
    ).toBe(true);
    const australia = await run(
      store,
      "tas",
      ANALYSIS_KINDS.REGION_SERIES,
      square(130, -30, 140, -20)
    );
    expect(australia.values[0]).toBeCloseTo(6.5, 2);
  });

  it("pairs a declared auxiliary latitude with the longitude dimension for country selection", async () => {
    const store = await newStore();
    await write(store, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    // Another variable's latitude happens to have the same name and
    // length as the field's row dimension. The station axis is unrelated.
    const latitude = { units: "degrees_north", standard_name: "latitude" };
    await write(store, "lat", [50, 51], [2], ["station"], latitude);
    await write(store, "true_lat", [34.75, 35.25], [2], ["lat"], latitude);
    await write(store, "lon", [9, 9.5], [2], ["lon"], {
      units: "degrees_east",
      standard_name: "longitude",
    });
    await write(store, "tas", [5, 5, 5, 5], [1, 2, 2], ["time", "lat", "lon"], {
      coordinates: "true_lat",
    });
    const country = (id: string) =>
      run(store, "tas", ANALYSIS_KINDS.REGION_SERIES, {
        kind: "country",
        id,
        resolution: "50m",
      });
    const germany = await country("276");
    const tunisia = await country("788");
    expect([germany.region?.storedCells, tunisia.region?.storedCells]).toEqual([
      0, 4,
    ]);
    expect(germany.values[0]).toBeNaN();
    expect(tunisia.values[0]).toBeCloseTo(5);
  });

  it("a point uses them, and an index named like latitude is no coordinate", async () => {
    const store = await declared({ units: "degrees_north" });
    const at = await run(store, "tas", ANALYSIS_KINDS.POINT_SERIES, {
      kind: "point",
      lat: -26,
      lon: 135,
    });
    expect(at.values).toEqual([7]);
    // Indices with units 1: not latitudes, whatever their name.
    const indexed = await newStore();
    await write(indexed, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(indexed, "lat", [0, 1], [2], ["lat"], { units: "1" });
    await write(indexed, "lon", [0, 1], [2], ["lon"], { units: "1" });
    await write(indexed, "plat", [1, 0], [2], ["lat"], {
      units: "degrees_north",
    });
    await write(indexed, "plon", [0, 1], [2], ["lon"], {
      units: "degrees_east",
    });
    await write(
      indexed,
      "tas",
      [5, 6, 7, 8],
      [1, 2, 2],
      ["time", "lat", "lon"],
      { coordinates: "plat plon" }
    );
    const equator = await run(indexed, "tas", ANALYSIS_KINDS.POINT_SERIES, {
      kind: "point",
      lat: 0,
      lon: 0,
    });
    expect(equator.values).toEqual([7]);
  });

  it("an index named like latitude, with nothing declared, is refused with a reason", async () => {
    const store = await newStore();
    await write(store, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(store, "lat", [0, 1], [2], ["lat"], { units: "1" });
    await write(store, "lon", [0, 1], [2], ["lon"], {
      units: "degrees_east",
    });
    await write(store, "tas", [5, 6, 7, 8], [1, 2, 2], ["time", "lat", "lon"]);
    const context = await open(store, "tas");
    expect(context.grid.kind).toBe("unsupported");
    expect((context.grid as { reason: string }).reason).toMatch(
      /lat.*units "1"/
    );
  });

  it("a coordinate of another length than its dimension is refused", async () => {
    const store = await newStore();
    await write(store, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(store, "lat", [0, 1, 2], [3], ["lat"], {
      units: "degrees_north",
    });
    await write(store, "lon", [0, 1], [2], ["lon"], {
      units: "degrees_east",
    });
    // Its own lat dimension has two rows: zarr arrays do not share sizes.
    await write(store, "tas", [5, 6, 7, 8], [1, 2, 2], ["time", "lat", "lon"]);
    const context = await open(store, "tas");
    expect(context.grid.kind).toBe("unsupported");
    expect((context.grid as { reason: string }).reason).toMatch(
      /3 values for 2/
    );
  });
});

describe("v24 review: a failed read is not an undeclared variable", () => {
  /** Weekly one-day means of 1 mm/day; `failing` keys answer 503. */
  async function weekly() {
    const store = await newStore();
    await write(store, "lat", [0], [1], ["lat"], { units: "degrees_north" });
    await write(store, "lon", [0], [1], ["lon"], { units: "degrees_east" });
    await write(store, "time", [0, 7, 14], [3], ["time"], {
      units: "days since 2000-01-01",
      bounds: "time_bnds",
    });
    await write(
      store,
      "time_bnds",
      [0, 1, 7, 8, 14, 15],
      [3, 2],
      ["time", "nv"]
    );
    await write(store, "pr", [1, 1, 1], [3, 1, 1], ["time", "lat", "lon"], {
      units: "mm day-1",
    });
    return store;
  }
  const failing = (store: TStore, failed: (key: string) => boolean) => ({
    get: async (key: string) => {
      if (failed(key)) {
        throw new Error("HTTP 503");
      }
      return store.get(key);
    },
  });
  const describeWith = (store: unknown) =>
    resolveVariableContext(
      zarrAnalysisDatasetFromStore(
        store as never,
        "",
        ZARR_FORMAT.V3,
        `v24-${Math.random()}`
      ),
      "pr",
      new ByteLru<BigInt64Array>(2 ** 20)
    );

  it("declared bounds that answer 503 are reported, not dropped", async () => {
    const store = await weekly();
    const fine = await describeWith(store);
    expect(fine.time?.bounds).toEqual([0, 1, 7, 8, 14, 15]);
    expect(fine.time?.boundsUnread).toBeUndefined();
    for (const failed of [
      (key: string) => /time_bnds\/zarr\.json$/.test(key),
      (key: string) => /time_bnds\/c\//.test(key),
    ]) {
      const context = await describeWith(failing(store, failed));
      expect(context.time?.bounds).toBeUndefined();
      expect(context.time?.boundsUnread).toMatch(/time_bnds could not be read/);
      expect(context.time?.boundsFailed).toBe(true);
    }
  });
});

describe("v24 review: declared cell areas that cannot be read", () => {
  async function sites() {
    const store = await newStore();
    await write(store, "lat", [0, 1, 2], [3], ["site"], {
      units: "degrees_north",
    });
    await write(store, "lon", [0, 1, 2], [3], ["site"], {
      units: "degrees_east",
    });
    await write(store, "area", [1, 2, 3], [3], ["site"]);
    await write(store, "tas", [5, 6, 7], [3], ["site"], {
      coordinates: "lat lon",
      cell_measures: "area: area",
    });
    return store;
  }
  const answering = (store: TStore, error?: Error) => ({
    get: async (key: string) => {
      if (error && /^\/?area\//.test(key)) {
        throw error;
      }
      return store.get(key);
    },
  });
  const describe = (store: unknown) =>
    resolveVariableContext(
      zarrAnalysisDatasetFromStore(
        store as never,
        "",
        ZARR_FORMAT.V3,
        `v24-${Math.random()}`
      ),
      "tas",
      new ByteLru<BigInt64Array>(2 ** 20)
    );

  it("a 503 is reported, never replaced by spherical areas", async () => {
    // For area plots only: a point needs no areas.
    const context = await describe(
      answering(await sites(), new Error("HTTP 503"))
    );
    expect(context.grid.kind).toBe("native");
    expect(context.capabilities[ANALYSIS_KINDS.DISTRIBUTION]).toEqual({
      available: false,
      reason: expect.stringMatching(
        /declared cell areas area could not be read: HTTP 503/
      ),
    });
  });

  it("an area variable that is not in the source still falls back", async () => {
    const store = await sites();
    store.delete("/area/zarr.json");
    const context = await describe(store);
    expect(context.grid.kind).not.toBe("unsupported");
  });
});

describe("v24 review: packed int64 bounds", () => {
  it("are decoded exactly before they become floats", async () => {
    const store = await newStore();
    await write(store, "lat", [0], [1], ["lat"], { units: "degrees_north" });
    await write(store, "lon", [0], [1], ["lon"], { units: "degrees_east" });
    await write(store, "time", [0.5, 7.5], [2], ["time"], {
      units: "days since 2000-01-01",
      bounds: "time_bnds",
    });
    // 2^53 + 1 is no float64: Number would round it to 2^53 first.
    const big = 2n ** 53n;
    const bounds = await zarr.create(zarr.root(store).resolve("time_bnds"), {
      shape: [2, 2],
      chunkShape: [2, 2],
      dtype: "int64",
      dimensionNames: ["time", "nv"],
      attributes: { add_offset: -(2 ** 53) },
      fillValue: 0n as never,
    });
    await zarr.set(bounds as never, null, {
      data: BigInt64Array.from([big, big + 1n, big + 7n, big + 8n]),
      shape: [2, 2],
      stride: [2, 1],
    } as never);
    await write(store, "pr", [1, 1], [2, 1, 1], ["time", "lat", "lon"], {
      units: "mm day-1",
    });
    const context = await open(store, "pr");
    expect(context.time?.bounds).toEqual([0, 1, 7, 8]);
  });
});

describe("v24 review: a static 1-D vertical coordinate", () => {
  it("gives sections the physical levels a profile shows, not indices", async () => {
    const store = await newStore();
    await write(store, "lat", [0, 1], [2], ["lat"], { units: "degrees_north" });
    await write(store, "lon", [0], [1], ["lon"], { units: "degrees_east" });
    await write(store, "plev", [1000, 750, 500], [3], ["lev"], {
      units: "hPa",
      positive: "down",
      standard_name: "air_pressure",
    });
    await write(
      store,
      "ta",
      [280, 281, 270, 271, 260, 261],
      [3, 2, 1],
      ["lev", "lat", "lon"],
      { coordinates: "plev" }
    );
    const context = await open(store, "ta");
    expect(context.vertical?.kind).toBe("physical");
    expect(context.vertical?.values).toEqual([1000, 750, 500]);
    expect(context.vertical?.units).toBe("hPa");
  });
});

describe("v24 review: one remote coarse cell does not widen every search", () => {
  it("tests about as many footprints as without it", async () => {
    const { SphereIndex } = await import("@/lib/analysis/nativeGrid.ts");
    // 100 × 100 fine cells of 0.01°, and one cell of radius 5° at 10° E.
    const n = 100 * 100 + 1;
    const lat = new Float64Array(n);
    const lon = new Float64Array(n);
    const radii = new Float32Array(n);
    for (let i = 0; i < 100; i++) {
      for (let j = 0; j < 100; j++) {
        lat[i * 100 + j] = i * 0.01;
        lon[i * 100 + j] = j * 0.01;
        radii[i * 100 + j] = 0.0071;
      }
    }
    lat[n - 1] = 0.5;
    lon[n - 1] = 10;
    radii[n - 1] = 5;
    const index = new SphereIndex(lat, lon, radii);
    const tested: number[] = [];
    for (let k = 0; k < 96; k++) {
      const seen: number[] = [];
      index.covering(0.3 + k * 0.004, 0.2 + k * 0.006, (cell) =>
        seen.push(cell)
      );
      tested.push(index.lastCandidates);
      // The coarse cell does not reach this far west.
      expect(seen).not.toContain(n - 1);
      expect(seen.length).toBeGreaterThan(0);
    }
    // A few footprints a sample, not every cell within 5°.
    expect(Math.max(...tested)).toBeLessThanOrEqual(8);
    // The largest radius for everything would visit them all.
    let wide = 0;
    index.near(0.3, 0.2, 5, () => wide++);
    expect(wide).toBeGreaterThan(9000);
    // Inside the coarse cell, it is found.
    const there: number[] = [];
    index.covering(0.5, 10.5, (cell) => there.push(cell));
    expect(there).toContain(n - 1);
  });
});

describe("v24 review: a long area series prices and sends what it keeps", () => {
  async function oneCell(nt: number, chunk: number) {
    const store = await newStore();
    await write(store, "lat", [0], [1], ["lat"], {
      units: "degrees_north",
      bounds: "lat_b",
    });
    await write(store, "lat_b", [-0.5, 0.5], [1, 2], ["lat", "nv"]);
    await write(store, "lon", [0], [1], ["lon"], {
      units: "degrees_east",
      bounds: "lon_b",
    });
    await write(store, "lon_b", [-0.5, 0.5], [1, 2], ["lon", "nv"]);
    const time = Array.from({ length: nt }, (_, k) => k);
    await write(store, "time", time, [nt], ["time"], {
      units: "hours since 2000-01-01",
    });
    const array = await zarr.create(zarr.root(store).resolve("tas"), {
      shape: [nt, 1, 1],
      chunkShape: [chunk, 1, 1],
      dtype: "float64",
      dimensionNames: ["time", "lat", "lon"],
      attributes: {},
      fillValue: Number.NaN as never,
    });
    await zarr.set(array as never, null, {
      data: Float64Array.from(time),
      shape: [nt, 1, 1],
      stride: [1, 1, 1],
    } as never);
    return store;
  }
  const box = { kind: "box" as const, west: -1, east: 1, south: -1, north: 1 };

  it("a million dates of one cell is not modest", async () => {
    const store = await oneCell(1_000_000, 2000);
    const planned = await planAnalysis(
      await open(store, "tas"),
      query(ANALYSIS_KINDS.REGION_SERIES, "tas", box, {
        time: { start: 0, stop: 1_000_000 },
      }),
      new ReadContext()
    );
    expect(planned.estimate.chunks).toBe(500);
    // 64 bytes of accumulators and seven published numbers per step.
    expect(planned.estimate.workingBytes).toBeGreaterThan(
      1_000_000 * (64 + 56)
    );
    expect(planned.estimate.modest).toBe(false);
  });

  it("time parts share one chunk directory of the spatial runs", async () => {
    const { directoryBuilds } = await import("@/lib/analysis/chunkVisitor.ts");
    const store = await oneCell(4000, 1000);
    const planned = await planAnalysis(
      await open(store, "tas"),
      query(ANALYSIS_KINDS.REGION_SERIES, "tas", box, {
        time: { start: 0, stop: 4000 },
      }),
      new ReadContext()
    );
    const before = directoryBuilds.count;
    await planned.execute();
    // Four parts: each its own time run, the two spatial dimensions once.
    expect(directoryBuilds.count - before).toBe(4 + 2);
  });

  it("its first part carries the steps read, padded on the page", async () => {
    const { createPartialAssembler } =
      await import("@/lib/analysis/partialUpdates.ts");
    const nt = 20_000;
    const store = await oneCell(nt, 1000);
    const planned = await planAnalysis(
      await open(store, "tas"),
      query(ANALYSIS_KINDS.REGION_SERIES, "tas", box, {
        time: { start: 0, stop: nt },
      }),
      new ReadContext()
    );
    const sent: number[] = [];
    let latest: { values: number[] } | undefined;
    const assemble = createPartialAssembler((r) => (latest = r));
    const result = await planned.execute(undefined, {
      onPartial: (update) => {
        if (update.base) {
          sent.push(update.base.values.length);
        }
        assemble(update);
      },
    });
    expect(sent[0]).toBeLessThan(nt);
    expect(latest!.values).toHaveLength(nt);
    expect(result.values).toHaveLength(nt);
    expect(result.values[nt - 1]).toBe(nt - 1);
  });
});

describe("v24 review: geometry builds stop with their last waiter and their source", () => {
  it("an index of a million cells is built in steps and can be cancelled", async () => {
    const { SphereIndex } = await import("@/lib/analysis/nativeGrid.ts");
    const n = 1_000_000;
    const lat = Float64Array.from(
      { length: n },
      (_, k) => ((k * 7919) % 17_999) / 100 - 90
    );
    const lon = Float64Array.from(
      { length: n },
      (_, k) => ((k * 104_729) % 35_999) / 100 - 180
    );
    const controller = new AbortController();
    const building = SphereIndex.create(lat, lon, undefined, controller.signal);
    setTimeout(() => controller.abort(), 0);
    await expect(building).rejects.toThrow();
    // Built to the end, it answers as the one built at once.
    const stepwise = await SphereIndex.create(lat, lon);
    const atOnce = new SphereIndex(lat, lon);
    for (const [la, lo] of [
      [0, 0],
      [45.5, -120.25],
      [-89, 179],
    ]) {
      expect(stepwise.nearest(la, lo, 5)).toEqual(atOnce.nearest(la, lo, 5));
    }
  });

  it("releasing a source forgets its native geometry", async () => {
    const { AnalysisRunner } = await import("@/lib/analysis/analysisRunner.ts");
    const store = await newStore();
    await write(store, "lat", [0, 1, 2], [3], ["site"], {
      units: "degrees_north",
    });
    await write(store, "lon", [0, 1, 2], [3], ["site"], {
      units: "degrees_east",
    });
    await write(store, "tas", [5, 6, 7], [3], ["site"], {
      coordinates: "lat lon",
    });
    const runner = new AnalysisRunner();
    const source = {
      key: `release-${Math.random()}`,
      store: "memory",
      dataset: "",
      format: ZARR_FORMAT.V3,
    };
    (runner as unknown as { datasets: Map<string, unknown> }).datasets.set(
      source.key,
      Promise.resolve(
        zarrAnalysisDatasetFromStore(
          store as never,
          "",
          ZARR_FORMAT.V3,
          source.key
        )
      )
    );
    const context = await runner.context(source as never, "tas");
    const grid = context.grid as unknown as {
      geometry: () => Promise<unknown>;
      geometryReady: () => boolean;
    };
    await grid.geometry();
    expect(grid.geometryReady()).toBe(true);
    await runner.release(source.key);
    expect(grid.geometryReady()).toBe(false);
  });
});

describe("review of interim26: a 360° copy of the 0° column", () => {
  it("counts the column once in area means and longitude bands", async () => {
    const make = async (withCopy: boolean) => {
      const store = await newStore();
      await write(store, "time", [0], [1], ["time"], {
        units: "days since 2000-01-01",
      });
      await write(store, "lat", [-1, 1], [2], ["lat"], {
        units: "degrees_north",
        standard_name: "latitude",
      });
      const lons = withCopy ? [0, 90, 180, 270, 360] : [0, 90, 180, 270];
      await write(store, "lon", lons, [lons.length], ["lon"], {
        units: "degrees_east",
        standard_name: "longitude",
      });
      const row = withCopy ? [9, 1, 1, 1, 9] : [9, 1, 1, 1];
      await write(
        store,
        "tas",
        [...row, ...row],
        [1, 2, lons.length],
        ["time", "lat", "lon"]
      );
      return store;
    };
    // The 0° and 90° columns: 5 once, 6.33 with the copy counted.
    const box = {
      kind: "box" as const,
      south: -2,
      north: 2,
      west: -45,
      east: 135,
    };
    const [plain, copied] = await Promise.all(
      [false, true].map(
        async (withCopy) =>
          (
            await run(
              await make(withCopy),
              "tas",
              ANALYSIS_KINDS.REGION_SERIES,
              box
            )
          ).values[0]
      )
    );
    expect(copied).toBeCloseTo(plain, 12);
  });
});

it("review of interim30 N1: latitude and longitude on one dimension are stations", async () => {
  const store = await newStore();
  await write(store, "time", [0, 1], [2], ["time"], {
    units: "days since 2000-01-01",
  });
  // A dimension coordinate of longitudes, and latitudes along it.
  await write(store, "lon", [0, 90], [2], ["lon"], {
    units: "degrees_east",
    standard_name: "longitude",
  });
  await write(store, "lat", [0, 80], [2], ["lon"], {
    units: "degrees_north",
    standard_name: "latitude",
  });
  await write(store, "v", [10, 20, 11, 21], [2, 2], ["time", "lon"], {
    coordinates: "lat",
  });
  // 80°N, 0°E: the nearest station is 80°N, 90°E (value 20), 1,100 km
  // away; the equatorial one is 8,900 km away.
  const result = await run(store, "v", ANALYSIS_KINDS.POINT_SERIES, {
    kind: "point",
    lat: 80,
    lon: 0,
  });
  expect(result.values[0]).toBe(20);
  // 0°N, 90°E: 80° from the northern station, 90° from the equatorial one
  // (a product grid's latitude index chose the equatorial one).
  const east = await run(store, "v", ANALYSIS_KINDS.POINT_SERIES, {
    kind: "point",
    lat: 0,
    lon: 90,
  });
  expect(east.values[0]).toBe(20);
});

describe("review of interim30: only a genuine cyclic copy is dropped", () => {
  /** Two rows at ±0.5°, `lons` with their bounds, one value per column. */
  const grid = async (lons: number[], bounds: number[][], row: number[]) => {
    const store = await newStore();
    await write(store, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(store, "lat", [-0.5, 0.5], [2], ["lat"], {
      units: "degrees_north",
      standard_name: "latitude",
      bounds: "lat_bnds",
    });
    await write(store, "lat_bnds", [-1, 0, 0, 1], [2, 2], ["lat", "nv"]);
    await write(store, "lon", lons, [lons.length], ["lon"], {
      units: "degrees_east",
      standard_name: "longitude",
      bounds: "lon_bnds",
    });
    await write(
      store,
      "lon_bnds",
      bounds.flat(),
      [lons.length, 2],
      ["lon", "nv"]
    );
    await write(
      store,
      "tas",
      [...row, ...row],
      [1, 2, lons.length],
      ["time", "lat", "lon"]
    );
    return store;
  };
  const mean = async (
    store: Awaited<ReturnType<typeof grid>>,
    box: { west: number; east: number }
  ) =>
    (
      await run(store, "tas", ANALYSIS_KINDS.REGION_SERIES, {
        kind: "box" as const,
        south: -2,
        north: 2,
        ...box,
      })
    ).values[0];

  it("keeps distinct columns 0.4 microdegrees apart", async () => {
    const store = await grid(
      [0, 4e-7, 8e-7],
      [
        [-2e-7, 2e-7],
        [2e-7, 6e-7],
        [6e-7, 1e-6],
      ],
      [1, 100, 1]
    );
    expect(await mean(store, { west: -0.001, east: 0.001 })).toBeCloseTo(34, 9);
  });

  it("keeps an endpoint cell whose bounds are its own ([315°, 360°] beside [0°, 45°])", async () => {
    const store = await grid(
      [0, 90, 180, 270, 360],
      [
        [0, 45],
        [45, 135],
        [135, 225],
        [225, 315],
        [315, 360],
      ],
      [0, 0, 0, 0, 80]
    );
    // 80 over 45° of 360°.
    expect(await mean(store, { west: -180, east: 180 })).toBeCloseTo(10, 9);
  });

  it("still counts a real cyclic copy once", async () => {
    const store = await grid(
      [0, 90, 180, 270, 360],
      [
        [-45, 45],
        [45, 135],
        [135, 225],
        [225, 315],
        [315, 405],
      ],
      [9, 1, 1, 1, 9]
    );
    expect(await mean(store, { west: -180, east: 180 })).toBeCloseTo(3, 9);
  });
});

it("review of interim30 #25: a reused shape mask still says sites, not area", async () => {
  const store = await newStore();
  await write(store, "time", [0, 1], [2], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(store, "lat", [10, 12], [2], ["site"], {
    units: "degrees_north",
    standard_name: "latitude",
  });
  await write(store, "lon", [20, 22], [2], ["site"], {
    units: "degrees_east",
    standard_name: "longitude",
  });
  await write(store, "v", [1, 3, 5, 7], [2, 2], ["time", "site"], {
    coordinates: "lat lon",
  });
  const ring = [
    [15, 5],
    [30, 5],
    [30, 20],
    [15, 20],
    [15, 5],
  ];
  const shape = {
    kind: "shape" as const,
    name: "two stations",
    polygons: [[ring]],
    digest: `sites-${Math.random()}`,
  };
  const context = await open(store, "v");
  const at = async (start: number) =>
    (
      await planAnalysis(
        context,
        query(ANALYSIS_KINDS.REGION_SERIES, "v", shape, {
          time: { start, stop: start + 1 },
        }),
        new ReadContext()
      )
    ).execute();
  const cold = await at(0);
  const warm = await at(1);
  expect(cold.region?.sites).toBe(true);
  expect(warm.region?.sites).toBe(true);
  expect(warm.values[0]).toBe(6);
});

it("keeps country distribution map cells when a second plot reuses the mask", async () => {
  const store = await newStore();
  await write(store, "time", [0, 1], [2], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(store, "lat", [50, 51], [2], ["lat"], { units: "degrees_north" });
  await write(store, "lon", [10, 11], [2], ["lon"], { units: "degrees_east" });
  await write(
    store,
    "tas",
    [1, 2, 3, 4, 5, 6, 7, 8],
    [2, 2, 2],
    ["time", "lat", "lon"]
  );
  const context = await open(store, "tas");
  const country = { kind: "country", id: "276", resolution: "50m" } as const;
  const at = async (start: number) => {
    const q = query(ANALYSIS_KINDS.DISTRIBUTION, "tas", country, {
      time: { start, stop: start + 1 },
    });
    return (await planAnalysis(context, q, new ReadContext())).execute();
  };
  const first = await at(0);
  const second = await at(1);
  expect(first.field?.values).toEqual([1, 2, 3, 4]);
  expect(second.field?.values).toEqual([5, 6, 7, 8]);
  expect(second.field?.lat).toEqual(first.field?.lat);
  expect(second.field?.lon).toEqual(first.field?.lon);
});

it("reports selected rectilinear country cells that lack model areas", async () => {
  const store = await newStore();
  await write(store, "time", [0], [1], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(store, "lat", [50, 51], [2], ["lat"], { units: "degrees_north" });
  await write(store, "lon", [10, 11], [2], ["lon"], { units: "degrees_east" });
  await write(store, "area", [1, 1, 1, NaN], [2, 2], ["lat", "lon"], {
    units: "m2",
  });
  await write(store, "tas", [1, 2, 3, 90], [1, 2, 2], ["time", "lat", "lon"], {
    cell_measures: "area: area",
  });
  const result = await run(store, "tas", ANALYSIS_KINDS.REGION_SERIES, {
    kind: "country",
    id: "276",
    resolution: "50m",
  });
  expect(result.region?.storedCells).toBe(4);
  expect(result.values[0]).toBe(2);
  expect({
    cellsWithoutArea: result.region?.unweighedCells,
    footprint: result.region?.footprintCoverage,
  }).toEqual({ cellsWithoutArea: 1, footprint: 0.75 });
});

it("says when two variables' cells share a centre but not a size (review of interim33)", async () => {
  const { samplingNote } = await import("@/ui/analysis/scatterFigure.ts");
  const cellOf = async (half: number) => {
    const store = await newStore();
    await write(store, "time", [0, 1], [2], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(store, "lat", [0], [1], ["lat"], {
      units: "degrees_north",
      bounds: "lat_bnds",
    });
    await write(store, "lon", [0], [1], ["lon"], {
      units: "degrees_east",
      bounds: "lon_bnds",
    });
    await write(store, "lat_bnds", [-half, half], [1, 2], ["lat", "nv"]);
    await write(store, "lon_bnds", [-half, half], [1, 2], ["lon", "nv"]);
    await write(store, "t", [1, 2], [2, 1, 1], ["time", "lat", "lon"]);
    const result = await run(store, "t", ANALYSIS_KINDS.POINT_SERIES, {
      kind: "point",
      lat: 0,
      lon: 0,
    });
    return result.cell!;
  };
  const [small, large] = [await cellOf(2), await cellOf(20)];
  expect(small.footprint).toMatchObject({ lat: 4, lon: 4 });
  expect(large.footprint).toMatchObject({ lat: 40, lon: 40 });
  // Located by their edges.
  expect(
    samplingNote({ cell: small, name: "a" }, { cell: large, name: "b" })
  ).toMatch(
    /Other cells: a's spans 2° W to 2° E, 2° S to 2° N, b's 20° W to 20° E, 20° S to 20° N/
  );
  expect(
    samplingNote({ cell: small, name: "a" }, { cell: small, name: "b" })
  ).toBeUndefined();
});

it("finds latitude and longitude from the dimension coordinates' own metadata (review of interim33)", async () => {
  const store = await newStore();
  await write(store, "time", [0, 1], [2], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(store, "y", [10, 20], [2], ["y"], {
    standard_name: "latitude",
    units: "degrees_north",
    axis: "Y",
  });
  await write(store, "x", [30, 40], [2], ["x"], {
    standard_name: "longitude",
    units: "degrees_east",
    axis: "X",
  });
  // No `coordinates` attribute names them.
  await write(
    store,
    "v",
    [1, 2, 3, 4, 5, 6, 7, 8],
    [2, 2, 2],
    ["time", "y", "x"]
  );
  const result = await run(store, "v", ANALYSIS_KINDS.POINT_SERIES, {
    kind: "point",
    lat: 20,
    lon: 30,
  });
  // The first date at 20° N, 30° E.
  expect(result.values).toEqual([3]);
});

it("keeps two tiny endpoint cells apart, and one cyclic copy once (review of interim33)", async () => {
  const { repeatedColumns } = await import("@/lib/analysis/operations.ts");
  const columns = (values: number[], bounds?: number[]) =>
    repeatedColumns({
      values: Float64Array.from(values),
      ...(bounds ? { bounds: Float64Array.from(bounds) } : {}),
    });
  // Cells 0.000004° wide at each end of the turn: two cells.
  expect(
    columns(
      [0.000001, 180, 359.999999],
      [0, 0.000004, 0.000004, 359.999996, 359.999996, 360]
    ).size
  ).toBe(0);
  // [0, 45] beside [315, 360]: two cells.
  expect(columns([22.5, 180, 337.5], [0, 45, 45, 315, 315, 360]).size).toBe(0);
  // A true copy: [−45, 45] and [315, 405] at 0° and 360°.
  expect([...columns([0, 180, 360], [-45, 45, 45, 315, 315, 405])]).toEqual([
    2,
  ]);
  // Without bounds, centres exactly a turn apart.
  expect([...columns([0, 90, 180, 270, 360])]).toEqual([4]);
});

it("keeps country weights from separate groups with shared latitude and longitude apart", async () => {
  const store = await newStore();
  await write(store, "grid/lat", [50, 51], [2], ["lat"], {
    units: "degrees_north",
  });
  await write(store, "grid/lon", [10, 11], [2], ["lon"], {
    units: "degrees_east",
  });
  for (const group of ["a", "b"]) {
    await write(store, group + "/time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(
      store,
      group + "/area",
      [1, 1, 1, group === "a" ? 1 : 9],
      [2, 2],
      ["lat", "lon"],
      { units: "m2" }
    );
    await write(
      store,
      group + "/tas",
      [0, 0, 0, 100],
      [1, 2, 2],
      ["time", "lat", "lon"],
      { coordinates: "grid/lat grid/lon", cell_measures: "area: area" }
    );
  }
  const source = () =>
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      "group-areas"
    );
  const mean = async (group: string, dataset: ReturnType<typeof source>) => {
    const variable = group + "/tas";
    const context = await resolveVariableContext(
      dataset,
      variable,
      new ByteLru<BigInt64Array>(2 ** 20)
    );
    const q = query(ANALYSIS_KINDS.REGION_SERIES, variable, {
      kind: "country",
      id: "276",
      resolution: "50m",
    });
    const p = await planAnalysis(context, q, new ReadContext());
    return (await p.execute()).values[0];
  };
  const warm = source();
  expect(await mean("b", source())).toBe(75);
  expect(await mean("a", warm)).toBe(25);
  expect(await mean("b", warm)).toBe(75);
});

it("counts selected country cells whose published latitude bounds have no area", async () => {
  const store = await newStore();
  await write(store, "time", [0], [1], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(store, "lat", [50, 51], [2], ["lat"], {
    units: "degrees_north",
    bounds: "lat_bnds",
  });
  await write(store, "lon", [10, 11], [2], ["lon"], {
    units: "degrees_east",
    bounds: "lon_bnds",
  });
  await write(store, "lat_bnds", [49.5, 50.5, NaN, NaN], [2, 2], ["lat", "nv"]);
  await write(
    store,
    "lon_bnds",
    [9.5, 10.5, 10.5, 11.5],
    [2, 2],
    ["lon", "nv"]
  );
  await write(
    store,
    "tas",
    [4, 6, 100, 100],
    [1, 2, 2],
    ["time", "lat", "lon"]
  );
  const result = await run(store, "tas", ANALYSIS_KINDS.REGION_SERIES, {
    kind: "country",
    id: "276",
    resolution: "50m",
  });
  expect(result.region!.storedCells).toBe(4);
  expect(result.region!.unweighedCells).toBe(2);
  expect(result.region!.footprintCoverage).toBe(0.5);
  expect(result.region!.coverage).toEqual([1]);
  expect(result.values).toEqual([5]);
});

it("distributions and bands say which cells had no area (review of interim37)", async () => {
  const store = await newStore();
  await write(store, "time", [0, 1], [2], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(store, "lat", [50, 51], [2], ["lat"], { units: "degrees_north" });
  await write(store, "lon", [10, 11], [2], ["lon"], { units: "degrees_east" });
  await write(store, "area", [1, NaN, 1, NaN], [2, 2], ["lat", "lon"], {
    units: "m2",
  });
  await write(
    store,
    "tas",
    [1, 2, 3, 4, 1, 2, 3, 4],
    [2, 2, 2],
    ["time", "lat", "lon"],
    {
      cell_measures: "area: area",
    }
  );
  const box = {
    kind: "box" as const,
    west: 9.5,
    east: 11.5,
    south: 49.5,
    north: 51.5,
  };
  const run2 = async (kind: TAnalysisKind, extra = {}) =>
    (
      await planAnalysis(
        await open(store, "tas"),
        query(kind, "tas", box, extra),
        new ReadContext()
      )
    ).execute();
  const histogram = (
    await run2(ANALYSIS_KINDS.DISTRIBUTION, { time: { start: 0, stop: 1 } })
  ).histogram;
  expect(histogram?.unweighedCells).toBe(2);
  const bands = await run2(ANALYSIS_KINDS.HOVMOLLER_LON, {
    time: { start: 0, stop: 2 },
  });
  expect(JSON.stringify(bands)).toMatch(/2 cells without an area left out/);
});

it("a HEALPix mask reused by a field stored [cell, time] places each cell (review of interim37)", async () => {
  const store = await newStore();
  await write(store, "crs", [1], [1], ["one"], {
    grid_mapping_name: "healpix",
    healpix_nside: 1,
    healpix_order: "nest",
  });
  await write(store, "time", [0, 1], [2], ["time"], {
    units: "days since 2000-01-01",
  });
  const values = Array.from({ length: 24 }, (_, k) => k);
  await write(store, "a", values, [2, 12], ["time", "cell"], {
    grid_mapping: "crs",
  });
  await write(store, "b", values, [12, 2], ["cell", "time"], {
    grid_mapping: "crs",
  });
  const shape = {
    kind: "shape" as const,
    name: "band",
    polygons: [
      [
        [
          [-90, -60],
          [0, -60],
          [90, -60],
          [90, 60],
          [0, 60],
          [-90, 60],
          [-90, -60],
        ],
      ],
    ],
    digest: `band-${Math.random()}`,
  };
  // One dataset: its cell layout's mask is shared by both fields.
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `layouts-${Math.random()}`
  );
  const positions = async (variable: string) => {
    const r = await (
      await planAnalysis(
        await resolveVariableContext(
          dataset,
          variable,
          new ByteLru<BigInt64Array>(2 ** 20)
        ),
        query(ANALYSIS_KINDS.DISTRIBUTION, variable, shape),
        new ReadContext()
      )
    ).execute();
    return r.field!.lat.map((lat, k) => `${lat},${r.field!.lon[k]}`).sort();
  };
  const first = await positions("a");
  const second = await positions("b");
  expect(new Set(first).size).toBe(first.length);
  expect(first.length).toBeGreaterThan(1);
  expect(second).toEqual(first);
});

it("prices declared areas and the field together (review of interim37)", async () => {
  const store = await newStore();
  const [nlat, nlon] = [2048, 2560];
  await write(store, "time", [0, 1], [2], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(
    store,
    "lat",
    Array.from({ length: nlat }, (_, i) => -60 + (i * 120) / nlat),
    [nlat],
    ["lat"],
    { units: "degrees_north" }
  );
  await write(
    store,
    "lon",
    Array.from({ length: nlon }, (_, j) => -150 + (j * 300) / nlon),
    [nlon],
    ["lon"],
    { units: "degrees_east" }
  );
  // 40 MiB of areas and 40 MiB of field a date: each modest, not both.
  for (const [name, shape, dims, attrs] of [
    ["area", [nlat, nlon], ["lat", "lon"], { units: "m2" }],
    [
      "tas",
      [2, nlat, nlon],
      ["time", "lat", "lon"],
      { cell_measures: "area: area" },
    ],
  ] as const) {
    await zarr.create(zarr.root(store).resolve(name), {
      shape: [...shape],
      chunkShape: shape.length === 3 ? [1, nlat, nlon] : [...shape],
      dtype: "float64",
      dimensionNames: [...dims],
      attributes: attrs,
      fillValue: 1 as never,
    });
  }
  const planned = await planAnalysis(
    await open(store, "tas"),
    query(ANALYSIS_KINDS.REGION_SERIES, "tas", {
      kind: "box",
      west: -10,
      east: 10,
      south: -10,
      north: 10,
    }),
    new ReadContext()
  );
  expect(planned.estimate.decodedBytes).toBeGreaterThanOrEqual(80 * 2 ** 20);
  expect(planned.estimate.modest).toBe(false);
});

it("refuses declared areas past the working limit before reading any (review of interim37)", async () => {
  const store = await newStore();
  const [nlat, nlon] = [6144, 12288];
  await write(store, "time", [0, 1], [2], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(
    store,
    "lat",
    Array.from({ length: nlat }, (_, i) => -89.99 + (i * 179.98) / nlat),
    [nlat],
    ["lat"],
    { units: "degrees_north" }
  );
  await write(
    store,
    "lon",
    Array.from({ length: nlon }, (_, j) => -179.99 + (j * 359.98) / nlon),
    [nlon],
    ["lon"],
    { units: "degrees_east" }
  );
  // 288 area chunks of 2 MiB: 576 MiB held while weighing.
  await zarr.create(zarr.root(store).resolve("area"), {
    shape: [nlat, nlon],
    chunkShape: [512, 512],
    dtype: "float64",
    dimensionNames: ["lat", "lon"],
    attributes: { units: "m2" },
    fillValue: 1 as never,
  });
  await zarr.create(zarr.root(store).resolve("tas"), {
    shape: [2, nlat, nlon],
    chunkShape: [1, 512, 512],
    dtype: "float32",
    dimensionNames: ["time", "lat", "lon"],
    attributes: { cell_measures: "area: area" },
    fillValue: 1 as never,
  });
  const reads: string[] = [];
  const get = store.get.bind(store);
  store.get = ((key: string) => {
    reads.push(key);
    return get(key);
  }) as never;
  await expect(
    planAnalysis(
      await open(store, "tas"),
      query(ANALYSIS_KINDS.REGION_SERIES, "tas", {
        kind: "box",
        west: -179,
        east: 179,
        south: -89,
        north: 89,
      }),
      new ReadContext()
    )
  ).rejects.toThrow(
    // 288 tiles of 2 MiB, and the last one's source.
    /578 MiB of cell areas in memory while they are read; plots use at most 512 MiB/
  );
  expect(reads.filter((key) => key.startsWith("area/c/"))).toEqual([]);
});

it("a second field on a kept shape mask prices no area reads (review of interim37)", async () => {
  const store = await newStore();
  await write(store, "time", [0, 1], [2], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(store, "lat", [50, 51], [2], ["lat"], { units: "degrees_north" });
  await write(store, "lon", [10, 11], [2], ["lon"], { units: "degrees_east" });
  await write(store, "area", [1, 1, 1, 1], [2, 2], ["lat", "lon"], {
    units: "m2",
  });
  for (const name of ["a", "b"]) {
    await write(
      store,
      name,
      [1, 2, 3, 4, 5, 6, 7, 8],
      [2, 2, 2],
      ["time", "lat", "lon"],
      {
        cell_measures: "area: area",
      }
    );
  }
  // Each plot reads through its own guarded view of the source (new array
  // objects, so no decoded area chunks of the first): the kept mask is
  // the dataset's.
  const source = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `kept-mask-${Math.random()}`
  );
  const dataset = () => ({
    ...source,
    openArray: async (path: string) => ({ ...(await source.openArray(path)) }),
  });
  const shape = {
    kind: "shape" as const,
    name: "square",
    polygons: [
      [
        [
          [9, 49],
          [12, 49],
          [12, 52],
          [9, 52],
          [9, 49],
        ],
      ],
    ],
    digest: `square-${Math.random()}`,
  };
  const plan = async (variable: string) =>
    planAnalysis(
      await resolveVariableContext(
        dataset(),
        variable,
        new ByteLru<BigInt64Array>(2 ** 20)
      ),
      query(ANALYSIS_KINDS.REGION_SERIES, variable, shape, {
        time: { start: 0, stop: 2 },
      }),
      new ReadContext()
    );
  const first = await plan("a");
  expect(first.estimate.geometryReads).toBe(1);
  await first.execute();
  const second = await plan("b");
  expect(second.estimate.geometryReads ?? 0).toBe(0);
});

it("counts a box's unweighted cells along each axis (review of interim37)", async () => {
  const { regionSelection } = await import("@/lib/analysis/operations.ts");
  const store = await newStore();
  const [nlat, nlon] = [128, 200];
  await write(store, "time", [0], [1], ["time"], {
    units: "days since 2000-01-01",
  });
  const lat = Array.from({ length: nlat }, (_, i) => -63.5 + i);
  await write(store, "lat", lat, [nlat], ["lat"], {
    units: "degrees_north",
    bounds: "lat_bnds",
  });
  // One row's bounds unpublished.
  const bounds = lat.flatMap((v, i) =>
    i === 5 ? [NaN, NaN] : [v - 0.5, v + 0.5]
  );
  await write(store, "lat_bnds", bounds, [nlat, 2], ["lat", "nv"]);
  await write(
    store,
    "lon",
    Array.from({ length: nlon }, (_, j) => -99.5 + j),
    [nlon],
    ["lon"],
    { units: "degrees_east" }
  );
  await write(
    store,
    "tas",
    new Array(nlat * nlon).fill(1),
    [1, nlat, nlon],
    ["time", "lat", "lon"]
  );
  const context = await open(store, "tas");
  const gets = vi.spyOn(Map.prototype, "get");
  const selection = await regionSelection(
    context,
    {
      kind: "box",
      box: { south: -70, north: 70, west: -100, east: 100 },
    } as never,
    context.dims.map(() => []),
    { geometryMs: 0 } as never
  );
  const lookups = gets.mock.calls.length;
  gets.mockRestore();
  expect(selection.unweighed).toBe(200);
  expect(lookups).toBeLessThan(5_000);
});
