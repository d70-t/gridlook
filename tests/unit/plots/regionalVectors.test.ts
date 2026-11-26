/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
/** Each stored chunk is read once for both, and priced at its own type. */
import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import {
  zarrAnalysisDatasetFromStore,
  type TAnalysisDataset,
} from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS, type TAnalysisQuery } from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;
const C = (shape: number[]) =>
  shape.map((_, d) => shape.slice(d + 1).reduce((a, n) => a * n, 1));

async function write(
  store: TStore,
  path: string,
  data: number[],
  shape: number[],
  dims: string[],
  attrs: Record<string, unknown> = {}
) {
  const array = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape: shape,
    dtype: "float64",
    dimensionNames: dims,
    attributes: attrs,
    fillValue: Number.NaN as never,
  });
  await zarr.set(array as never, null, {
    data: Float64Array.from(data),
    shape,
    stride: C(shape),
  } as never);
}

/** Two latitudes and two longitudes, one date, with bounds. */
async function grid() {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "lat", [-1, 1], [2], ["lat"], {
    units: "degrees_north",
    bounds: "lat_bnds",
  });
  await write(store, "lat_bnds", [-2, 0, 0, 2], [2, 2], ["lat", "nv"]);
  await write(store, "lon", [0, 1], [2], ["lon"], {
    units: "degrees_east",
    bounds: "lon_bnds",
  });
  await write(store, "lon_bnds", [-0.5, 0.5, 0.5, 1.5], [2, 2], ["lon", "nv"]);
  await write(store, "time", [0], [1], ["time"], {
    units: "days since 2000-01-01",
  });
  return store;
}

type TField = {
  dtype?: string;
  chunks?: number[];
  data?: ArrayLike<number | bigint>;
  fill?: unknown;
  codecs?: unknown[];
};

async function field(store: TStore, name: "uo" | "vo", f: TField = {}) {
  const dtype = f.dtype ?? "float64";
  const array = await zarr.create(zarr.root(store).resolve(name), {
    shape: [1, 2, 2],
    chunkShape: f.chunks ?? [1, 2, 2],
    dtype,
    dimensionNames: ["time", "lat", "lon"],
    attributes: {
      units: "m s-1",
      standard_name: `${name === "uo" ? "eastward" : "northward"}_sea_water_velocity`,
    },
    fillValue: (f.fill ??
      (dtype === "int64" ? 0n : dtype === "uint8" ? 255 : Number.NaN)) as never,
    ...(f.codecs ? { codecs: f.codecs } : {}),
  } as never);
  if (f.data) {
    await zarr.set(array as never, null, {
      data: f.data,
      shape: [1, 2, 2],
      stride: [4, 2, 1],
    } as never);
  }
  return array;
}

const open = (store: TStore) =>
  zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `pair-${Math.random()}`
  );

const BOX = { kind: "box", south: -2, north: 2, west: -1, east: 2 } as const;

async function region(
  own: TAnalysisDataset,
  variable: string,
  other: TAnalysisDataset,
  jointWith: string,
  read = new ReadContext(),
  geometry: TAnalysisQuery["geometry"] = BOX
) {
  const describe = (dataset: TAnalysisDataset, name: string) =>
    resolveVariableContext(dataset, name, new ByteLru<BigInt64Array>(2 ** 20));
  const [context, partner] = await Promise.all([
    describe(own, variable),
    describe(other, jointWith),
  ]);
  return planAnalysis(
    context,
    {
      version: 1,
      kind: ANALYSIS_KINDS.REGION_SERIES,
      geometry,
      fixed: {},
      source: { ref: "x", versionStatus: "best-effort" },
      variable,
      time: { start: 0, stop: 1 },
      jointWith,
    },
    read,
    undefined,
    false,
    partner
  );
}

async function both(u: TAnalysisDataset, v: TAnalysisDataset = u) {
  const read = new ReadContext();
  const [pu, pv] = await Promise.all([
    region(u, "uo", v, "vo", read),
    region(v, "vo", u, "uo", read),
  ]);
  const [ru, rv] = await Promise.all([pu.execute(), pv.execute()]);
  return { ru, rv, pu, pv };
}

// eslint-disable-next-line max-lines-per-function -- groups the vector fixtures.
describe("review of interim43: a regional vector on common cells", () => {
  it("pairs cells by position, not by stored offset, in another memory order", async () => {
    const store = await grid();
    await field(store, "uo", { data: new Float64Array([1, 10, 100, 1000]) });
    // V transposed in storage: only logical cell (0, 1) holds a value.
    await field(store, "vo", {
      data: new Float64Array([NaN, 3, NaN, NaN]),
      codecs: [
        { name: "transpose", configuration: { order: [0, 2, 1] } },
        { name: "bytes", configuration: { endian: "little" } },
      ],
    });
    const { ru, rv } = await both(open(store));
    expect([ru.values[0], rv.values[0]]).toEqual([10, 3]);
    expect(ru.region!.coverage[0]).toBeCloseTo(rv.region!.coverage[0], 12);
  });

  it("counts a chunk never written as its finite fill, for both", async () => {
    const store = await grid();
    const u = await field(store, "uo", { chunks: [1, 1, 2], fill: 5 });
    // Only U's second row is written; its first is the fill, 5 and 5.
    await zarr.set(u as never, [0, 1, null], {
      data: new Float64Array([10, 20]),
      shape: [2],
      stride: [1],
    } as never);
    await field(store, "vo", {
      chunks: [1, 1, 2],
      data: new Float64Array([NaN, NaN, 3, 3]),
    });
    const { ru, rv } = await both(open(store));
    expect(ru.values[0]).toBeCloseTo(15, 12);
    expect(rv.values[0]).toBe(3);
    expect(ru.region!.coverage).toEqual(rv.region!.coverage);
  });

  it("joins components chunked differently, and in two stores", async () => {
    const [a, b] = [await grid(), await grid()];
    await field(a, "uo", { data: new Float64Array([6, 0, NaN, 1]) });
    await field(b, "vo", {
      chunks: [1, 1, 1],
      data: new Float64Array([NaN, 0, 8, NaN]),
    });
    const { ru, rv } = await both(open(a), open(b));
    // The one cell both hold is calm.
    expect([ru.values[0], rv.values[0]]).toEqual([0, 0]);
  });

  it("joins a 64-bit integer component", async () => {
    const store = await grid();
    await field(store, "uo", {
      dtype: "int64",
      data: new BigInt64Array([1n, 3n, 5n, 7n]),
      fill: 0n,
    });
    await field(store, "vo", { data: new Float64Array([NaN, 3, NaN, NaN]) });
    const { ru } = await both(open(store));
    expect(ru.values).toEqual([3]);
  });

  it("reads each stored chunk once for both components", async () => {
    const store = await grid();
    await field(store, "uo", {
      chunks: [1, 1, 2],
      data: new Float64Array([6, 0, NaN, 1]),
    });
    await field(store, "vo", {
      chunks: [1, 1, 2],
      data: new Float64Array([NaN, 0, 8, NaN]),
    });
    const { ru, rv } = await both(open(store));
    // Two chunks each: four stored reads in all, the rest shared.
    expect(ru.counters.chunkReads + rv.counters.chunkReads).toBe(4);
  });

  it("prices each component's own type and keeps no float copy", async () => {
    const store = await grid();
    await field(store, "uo", { dtype: "uint8", chunks: [1, 2, 2] });
    await field(store, "vo", { dtype: "float64", chunks: [1, 2, 2] });
    const plan = await region(open(store), "uo", open(store), "vo");
    // One uint8 chunk of 4 values and one float64 chunk of 4.
    expect(plan.estimate.decodedBytes).toBe(4 + 32);
    expect(plan.estimate.chunks).toBe(2);
  });

  it("computes no vector for components on other cells", async () => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    await write(store, "lat", [0], [1], ["y"], {
      standard_name: "latitude",
      units: "degrees_north",
      bounds: "lat_b",
    });
    await write(store, "lat_b", [-1, 1], [1, 2], ["y", "nv"]);
    await write(store, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    // Staggered: U at 0° and 10°, V at 10° and 20°, same dimension names.
    for (const [d, lons, vals] of [
      ["u", [0, 10], [1, 10]],
      ["v", [10, 20], [3, NaN]],
    ] as const) {
      await write(store, `lon_${d}`, [...lons], [2], ["x"], {
        standard_name: "longitude",
        units: "degrees_east",
        bounds: `lon_b_${d}`,
      });
      await write(
        store,
        `lon_b_${d}`,
        lons.flatMap((x) => [x - 5, x + 5]),
        [2, 2],
        ["x", "nv"]
      );
      await write(store, `${d}o`, [...vals], [1, 1, 2], ["time", "y", "x"], {
        coordinates: `lat lon_${d}`,
        units: "m s-1",
        standard_name: `${d === "u" ? "eastward" : "northward"}_wind`,
      });
    }
    const dataset = open(store);
    await expect(
      region(dataset, "uo", dataset, "vo", new ReadContext(), {
        kind: "box",
        south: -1,
        north: 1,
        west: 9,
        east: 11,
      })
    ).rejects.toThrow(/latitudes or longitudes differ.*no vector/);
  });
});
