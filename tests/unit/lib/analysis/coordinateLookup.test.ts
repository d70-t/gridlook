/* eslint-disable max-lines-per-function -- one reproducer per finding. */
/* eslint-disable camelcase -- CF and Zarr metadata use snake_case keys. */
import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import {
  ownerKeys,
  zarrAnalysisDatasetFromStore,
} from "@/lib/analysis/sourceAdapter.ts";
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
  chunkShape = shape
) {
  const array = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape,
    dtype: "float64",
    dimensionNames: dims,
    attributes: attrs,
    fillValue: Number.NaN as never,
  });
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((product, n) => product * n, 1)
  );
  await zarr.set(array as never, null, {
    data: Float64Array.from(data),
    shape,
    stride,
  } as never);
}

async function newStore(...groups: string[]) {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  for (const group of groups) {
    await zarr.create(zarr.root(store).resolve(group), { attributes: {} });
  }
  return store;
}

function open(
  store: TStore,
  variable: string,
  dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `v14-${Math.random()}`
  )
) {
  return resolveVariableContext(
    dataset,
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
    ...extra,
  };
}

const POINT = { kind: "point", lat: 0, lon: 0 } as const;

async function grid(store: TStore, group = "") {
  await write(store, `${group}lat`, [0], [1], ["lat"], {
    units: "degrees_north",
  });
  await write(store, `${group}lon`, [0], [1], ["lon"], {
    units: "degrees_east",
  });
}

describe("v14 review: coordinate lookup", () => {
  it("2 | a same-named array along another dimension is not the time axis", async () => {
    const store = await newStore();
    await grid(store);
    await write(store, "actual_time", [0, 1, 2], [3], ["cycle"], {
      units: "days since 2000-01-01",
      standard_name: "time",
    });
    // Named like the field's dimension, but two values along `other`.
    await write(store, "cycle", [60, 61], [2], ["other"], {
      units: "days since 2000-01-01",
      standard_name: "time",
    });
    await write(store, "u", [5, 6, 7], [3, 1, 1], ["cycle", "lat", "lon"], {
      coordinates: "actual_time",
    });
    const context = await open(store, "u");
    const planned = await planAnalysis(
      context,
      query(ANALYSIS_KINDS.POINT_SERIES, "u", POINT, {
        time: { start: 0, stop: 3 },
      }),
      new ReadContext()
    );
    const result = await planned.execute();
    expect(result.values).toEqual([5, 6, 7]);
    expect(result.time!.raw).toEqual([0, 1, 2]);
  });

  it("3a | time bounds come from the coordinate's own group", async () => {
    const store = await newStore("axes", "fields");
    await grid(store, "fields/");
    await write(store, "axes/clock", [0, 2], [2], ["clock"], {
      units: "days since 2000-01-01",
      standard_name: "time",
      bounds: "clock_bounds",
    });
    await write(
      store,
      "axes/clock_bounds",
      [-1, 1, 1, 3],
      [2, 2],
      ["clock", "nv"]
    );
    // An unrelated array of the same name beside the field.
    await write(
      store,
      "fields/clock_bounds",
      [100, 200, 200, 300],
      [2, 2],
      ["clock", "nv"]
    );
    await write(store, "fields/u", [1, 2], [2, 1, 1], ["clock", "lat", "lon"], {
      coordinates: "/axes/clock",
    });
    const context = await open(store, "fields/u");
    expect(context.time?.dimension).toBe("clock");
    expect(context.time?.bounds).toEqual([-1, 1, 1, 3]);
  });

  it("3b | hybrid-pressure terms come from the coordinate's own group", async () => {
    const store = await newStore("axes", "fields");
    await grid(store, "fields/");
    await write(store, "fields/time", [0, 1], [2], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(store, "axes/lev", [0.5, 1], [2], ["layer"], {
      standard_name: "atmosphere_hybrid_sigma_pressure_coordinate",
      formula_terms: "ap: ap b: b ps: ps",
      positive: "down",
    });
    await write(store, "axes/ap", [0, 0], [2], ["layer"], { units: "Pa" });
    await write(store, "axes/b", [0.1, 0.5], [2], ["layer"], { units: "1" });
    await write(store, "axes/ps", [200, 400], [2], ["time"], { units: "Pa" });
    // Identically named, wrong terms beside the field.
    await write(store, "fields/ap", [100, 100], [2], ["layer"], {
      units: "Pa",
    });
    await write(store, "fields/b", [0.2, 0.2], [2], ["layer"], { units: "1" });
    await write(store, "fields/ps", [9000, 9000], [2], ["time"], {
      units: "Pa",
    });
    await write(
      store,
      "fields/ta",
      [1, 2, 3, 4],
      [2, 2, 1, 1],
      ["time", "layer", "lat", "lon"],
      { coordinates: "/axes/lev" }
    );
    const context = await open(store, "fields/ta");
    const levels: number[][] = [];
    for (const start of [0, 1]) {
      const planned = await planAnalysis(
        context,
        query(ANALYSIS_KINDS.PROFILE, "fields/ta", POINT, {
          time: { start, stop: start + 1 },
        }),
        new ReadContext()
      );
      levels.push((await planned.execute()).vertical!.values);
    }
    // ap + b | ps with the coordinate's own terms.
    expect(levels).toEqual([
      [20, 100],
      [40, 200],
    ]);
  });
});

describe("v14 review: live publication", () => {
  it("5 | a gap read before publication is read again afterwards", async () => {
    const store = await newStore();
    await grid(store);
    await write(store, "time", [...Array(12).keys()], [12], ["time"], {
      units: "days since 2000-01-01",
    });
    const values = Array.from({ length: 12 }, (_, t) => 100 * t);
    await write(
      store,
      "u",
      values,
      [12, 1, 1],
      ["time", "lat", "lon"],
      {},
      [1, 1, 1]
    );
    // Step 5 is not published yet.
    const [chunkKey] = [...store.keys()].filter((k) => /u\/c\/5\b/.test(k));
    const chunk = store.get(chunkKey)!;
    store.delete(chunkKey);
    const dataset = zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `live-${Math.random()}`
    );
    const context = await open(store, "u", dataset);
    const read = new ReadContext();
    const series = async (start: number, stop: number) =>
      (
        await planAnalysis(
          context,
          query(ANALYSIS_KINDS.POINT_SERIES, "u", POINT, {
            time: { start, stop },
          }),
          read
        )
      ).execute();
    const before = await series(0, 12);
    expect(before.values[5]).toBeNaN();
    expect(before.counters.absentChunks).toBe(1);
    // A cached gap still counts as one: the result is not complete.
    expect((await series(4, 7)).counters.absentChunks).toBe(1);
    store.set(chunkKey, chunk);
    for (const key of ownerKeys(dataset)) {
      read.forgetPublished(key, [], 5, 5);
    }
    const overlapping = await series(3, 8);
    expect(overlapping.values).toEqual([300, 400, 500, 600, 700]);
    expect(overlapping.counters.absentChunks).toBe(0);
    expect((await series(0, 12)).values).toEqual(values);
  });
});

describe("v14 review: decoding", () => {
  it("an unpacked value that overflows is missing, not infinite", async () => {
    const store = await newStore();
    const lats = [-15, -5, 5, 15];
    const lons = [5, 15, 25, 35, 45];
    await write(store, "lat", lats, [4], ["lat"], {
      units: "degrees_north",
      bounds: "lat_bnds",
    });
    await write(
      store,
      "lat_bnds",
      lats.flatMap((v) => [v - 5, v + 5]),
      [4, 2],
      ["lat", "nv"]
    );
    await write(store, "lon", lons, [5], ["lon"], {
      units: "degrees_east",
      bounds: "lon_bnds",
    });
    await write(
      store,
      "lon_bnds",
      lons.flatMap((v) => [v - 5, v + 5]),
      [5, 2],
      ["lon", "nv"]
    );
    await write(store, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    const stored = Array.from({ length: 20 }, (_, i) => (i === 7 ? 1e308 : 21));
    await write(store, "q", stored, [1, 4, 5], ["time", "lat", "lon"], {
      scale_factor: 2,
    });
    const context = await open(store, "q");
    const planned = await planAnalysis(
      context,
      query(
        ANALYSIS_KINDS.DISTRIBUTION,
        "q",
        { kind: "box", west: 0, east: 50, south: -20, north: 20 },
        { time: { start: 0, stop: 1 }, valueBins: 4 }
      ),
      new ReadContext()
    );
    const { histogram } = await planned.execute();
    expect(histogram!.validCells).toBe(19);
    expect(histogram!.mean).toBeCloseTo(42);
    expect(histogram!.constant).toBe(42);
  });
});
