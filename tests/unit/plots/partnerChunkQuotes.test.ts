/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
import { expect, it } from "vitest";
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
      time: { start: 0, stop: context.time!.raw.length },
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

const dataset = (
  store: TStore | { get: (key: string) => unknown },
  name: string
) => zarrAnalysisDatasetFromStore(store as never, "", ZARR_FORMAT.V3, name);

// eslint-disable-next-line max-lines-per-function
async function fanout(n: number, execute: boolean) {
  const s: TStore = new Map();
  await zarr.create(zarr.root(s), { attributes: {} });
  for (const dim of ["lat", "lon"]) {
    const axis = Array.from({ length: n }, (_, i) => i / 10);
    await write(s, dim, axis, [n], [dim], {
      units: dim === "lat" ? "degrees_north" : "degrees_east",
      bounds: `${dim}_b`,
    });
    await write(
      s,
      `${dim}_b`,
      axis.flatMap((x) => [x - 0.05, x + 0.05]),
      [n, 2],
      [dim, "nv"]
    );
  }
  await write(s, "time", [0], [1], ["time"], {
    units: "days since 2000-01-01",
  });
  for (const v of ["uo", "vo"]) {
    const a = await zarr.create(zarr.root(s).resolve(v), {
      shape: [1, n, n],
      chunkShape: v === "uo" ? [1, n, n] : [1, 1, 1],
      dtype: "float64",
      dimensionNames: ["time", "lat", "lon"],
      attributes: {
        units: "m s-1",
        standard_name: v === "uo" ? "eastward_wind" : "northward_wind",
      },
      fillValue: Number.NaN as never,
    });
    if (execute) {
      await zarr.set(a as never, null, {
        data: new Float64Array(n * n).fill(v === "uo" ? 5 : 3),
        shape: [1, n, n],
        stride: [n * n, n, 1],
      } as never);
    }
  }
  const gets = { u: 0, v: 0 };
  const ds = dataset(
    {
      get(k: string) {
        gets.u += k.startsWith("/uo/c/") ? 1 : 0;
        gets.v += k.startsWith("/vo/c/") ? 1 : 0;
        return s.get(k);
      },
    },
    `overlap-${Math.random()}`
  );
  const p = await region(ds, "uo", ds, "vo", new ReadContext(), {
    kind: "box",
    south: -0.025,
    north: 0.025,
    west: -0.025,
    east: 0.025,
  });
  const r = execute ? await p.execute() : undefined;
  return { estimate: p.estimate, gets, values: r?.values };
}

it("reads the partner chunks the plan quotes, no more", async () => {
  // One selected cell; U in one chunk, V one chunk per cell: 1 + 1 reads
  // (1 + 1,024 before).
  const small = await fanout(32, true);
  expect(small.values).toEqual([5]);
  expect(small.estimate.chunks).toBe(2);
  expect(small.gets).toEqual({ u: 1, v: 1 });
  // 448 × 448: still two, planned.
  expect((await fanout(448, false)).estimate.chunks).toBe(2);
});

it("does not pair raw dates of other origins", async () => {
  const u = await grid();
  const v = await grid();
  await field(u, "uo", { data: new Float64Array([1, 2, 3, 4]) });
  await field(v, "vo", { data: new Float64Array([NaN, 3, NaN, NaN]) });
  const meta = JSON.parse(new TextDecoder().decode(v.get("/time/zarr.json")));
  meta.attributes.units = "days since 2020-01-01";
  v.set("/time/zarr.json", new TextEncoder().encode(JSON.stringify(meta)));
  await expect(
    both(dataset(u, "time-u"), dataset(v, "time-v"))
  ).rejects.toThrow(/their dates differ/);
});

it("pairs the same date written from another origin", async () => {
  // V counts days from a day earlier: its row 1 is U's row 0.
  const u = await grid();
  const v = await grid();
  for (const [store, origin, values] of [
    [u, "2000-01-01", [0, 1]],
    [v, "1999-12-31", [0, 1]],
  ] as const) {
    await write(store, "time", [...values], [2], ["time"], {
      units: `days since ${origin}`,
    });
  }
  // U on 1 and 2 January; V on 31 December and 1 January.
  await write(
    u,
    "uo",
    [6, 0, NaN, NaN, 1, 1, 1, 1],
    [2, 2, 2],
    ["time", "lat", "lon"],
    {
      units: "m s-1",
      standard_name: "eastward_sea_water_velocity",
    }
  );
  await write(
    v,
    "vo",
    [1, 1, 1, 1, NaN, 0, 8, NaN],
    [2, 2, 2],
    ["time", "lat", "lon"],
    {
      units: "m s-1",
      standard_name: "northward_sea_water_velocity",
    }
  );
  const { ru, rv } = await both(dataset(u, "origin-u"), dataset(v, "origin-v"));
  // 1 January: only the calm cell is both; 2 January: V has no date.
  expect(ru.values[0]).toBe(0);
  expect(ru.values[1]).toBeNaN();
  expect(rv.values[1]).toBe(0);
});

it("refuses the same centres with other edges", async () => {
  const u = await grid();
  const v = await grid();
  await field(u, "uo", { data: new Float64Array([1, 10, 1, 10]) });
  await field(v, "vo", { data: new Float64Array([3, 30, 3, 30]) });
  v.set(
    "/lon_bnds/c/0/0",
    new Uint8Array(Float64Array.from([-0.5, 0.9, 0.9, 1.5]).buffer)
  );
  await expect(
    both(dataset(u, "edge-u"), dataset(v, "edge-v"))
  ).rejects.toThrow(/other edges/);
});

it("keeps one second apart: 10 and 20 at the shared seconds", async () => {
  const base = 1700000000;
  const u = await grid();
  const v = await grid();
  for (const [store, off, name, raw] of [
    [u, 0, "uo", [10, 20, 10, 20, 10, 20, 10, 20, 10, 20, 10, 20]],
    [v, 1, "vo", [3, NaN, 3, NaN, NaN, 3, NaN, 3, 3, NaN, 3, NaN]],
  ] as const) {
    await write(
      store,
      "time",
      [base + off, base + off + 1, base + off + 2],
      [3],
      ["time"],
      {
        units: "seconds since 1970-01-01",
      }
    );
    await write(store, name, [...raw], [3, 2, 2], ["time", "lat", "lon"], {
      units: "m s-1",
      standard_name: name === "uo" ? "eastward_wind" : "northward_wind",
    });
  }
  const { ru } = await both(dataset(u, "u-epoch"), dataset(v, "v-epoch"));
  expect(ru.values[0]).toBeNaN();
  expect(ru.values[1]).toBeCloseTo(10);
  expect(ru.values[2]).toBeCloseTo(20);
});

it("pairs identical stations published by two stores", async () => {
  const sources: TAnalysisDataset[] = [];
  for (const [name, values] of [
    ["uo", [1, 2, 3]],
    ["vo", [NaN, 3, NaN]],
  ] as const) {
    const s: TStore = new Map();
    await zarr.create(zarr.root(s), { attributes: {} });
    await write(s, "lat", [-1, 0, 1], [3], ["station"], {
      units: "degrees_north",
      standard_name: "latitude",
    });
    await write(s, "lon", [0, 1, 2], [3], ["station"], {
      units: "degrees_east",
      standard_name: "longitude",
    });
    await write(s, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(s, name, [...values], [1, 3], ["time", "station"], {
      coordinates: "lat lon",
      units: "m s-1",
      standard_name: name === "uo" ? "eastward_wind" : "northward_wind",
    });
    sources.push(dataset(s, `stations-${name}`));
  }
  const { ru, rv } = await both(sources[0], sources[1]);
  expect([ru.values[0], rv.values[0]]).toEqual([2, 3]);
});

// A future implementation can refuse mismatched support or align it correctly.
function equivalentOrRefused<T>(run: Promise<T>, reason: RegExp) {
  return run.catch((error) => {
    expect(String(error)).toMatch(reason);
    return undefined;
  });
}

it("keeps the two means of a joint vector on one physical area weighting", async () => {
  const datasets: TAnalysisDataset[] = [];
  for (const [name, data, weights] of [
    ["uo", [0, 10, 0, 10], [9, 1, 9, 1]],
    ["vo", [0, 30, 0, 30], [1, 9, 1, 9]],
  ] as const) {
    const s = await grid();
    await write(s, "areacello", [...weights], [2, 2], ["lat", "lon"], {
      units: "m2",
    });
    await write(s, name, [...data], [1, 2, 2], ["time", "lat", "lon"], {
      units: "m s-1",
      cell_measures: "area: areacello",
      standard_name:
        name === "uo"
          ? "eastward_sea_water_velocity"
          : "northward_sea_water_velocity",
    });
    datasets.push(dataset(s, "different-weights-" + name));
  }
  // Every valid cell has V = 3 U. A common weighting preserves that identity;
  // refusing incompatible weights before the reduction is also valid.
  const answer = await equivalentOrRefused(
    both(datasets[0], datasets[1]),
    /weight|area|measure/i
  );
  if (answer) {
    expect(answer.rv.values[0]).toBeCloseTo(3 * answer.ru.values[0]);
  }
});

it("does not combine different realizations that share a stored dimension index", async () => {
  const datasets: TAnalysisDataset[] = [];
  for (const [name, members] of [
    ["uo", [1, 2]],
    ["vo", [2, 1]],
  ] as const) {
    const s = await grid();
    await write(s, "member", [...members], [2], ["member"], {
      standard_name: "realization",
      units: "1",
    });
    const values = members.flatMap((member) =>
      name === "uo"
        ? [7, 42, 7, 42]
        : member === 1
          ? [0, NaN, 0, NaN]
          : [NaN, 0, NaN, 0]
    );
    await write(
      s,
      name,
      values,
      [1, 2, 2, 2],
      ["time", "member", "lat", "lon"],
      {
        units: "m s-1",
        standard_name:
          name === "uo"
            ? "eastward_sea_water_velocity"
            : "northward_sea_water_velocity",
      }
    );
    datasets.push(dataset(s, "reordered-member-" + name));
  }
  const plan = await equivalentOrRefused(
    region(datasets[0], "uo", datasets[1], "vo"),
    /realization|member|dimension/i
  );
  if (plan) {
    const answer = await plan.execute();
    expect(answer.region?.joint).toBe(true);
    expect(answer.values[0]).toBeCloseTo(7);
  }
});

it("does not pair an instantaneous component with a daily mean at the same stamp", async () => {
  const datasets: TAnalysisDataset[] = [];
  for (const [name, method] of [
    ["uo", "time: point"],
    ["vo", "time: mean"],
  ] as const) {
    const s = await grid();
    await write(s, "time", [0.5], [1], ["time"], {
      units: "days since 2000-01-01",
      bounds: "time_bnds",
    });
    await write(s, "time_bnds", [0, 1], [1, 2], ["time", "nv"]);
    await write(s, name, [0, 10, 0, 10], [1, 2, 2], ["time", "lat", "lon"], {
      units: "m s-1",
      cell_methods: method,
      standard_name:
        name === "uo"
          ? "eastward_sea_water_velocity"
          : "northward_sea_water_velocity",
    });
    datasets.push(dataset(s, "different-support-" + name));
  }
  const answer = await equivalentOrRefused(
    both(datasets[0], datasets[1]),
    /time|method|interval|support|instant|statistic|mean/i
  );
  expect(answer?.ru.region?.joint ?? false).toBe(false);
});

it("distinguishes mirrored cell footprints that have identical centres, areas and radii", async () => {
  const datasets: TAnalysisDataset[] = [];
  for (const [name, edges] of [
    ["uo", [-1.5, 0.5, 1.5, -0.5]],
    ["vo", [-0.5, 1.5, 0.5, -1.5]],
  ] as const) {
    const s: TStore = new Map();
    await zarr.create(zarr.root(s), { attributes: {} });
    for (const [axis, standard, units] of [
      ["lat", "latitude", "degrees_north"],
      ["lon", "longitude", "degrees_east"],
    ] as const) {
      await write(s, axis, [0], [1], ["cell"], {
        standard_name: standard,
        units,
        bounds: axis + "_bnds",
      });
    }
    await write(s, "lat_bnds", [-1, -1, 1, 1], [1, 4], ["cell", "nv"]);
    await write(s, "lon_bnds", [...edges], [1, 4], ["cell", "nv"]);
    await write(s, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(s, name, [2], [1, 1], ["time", "cell"], {
      coordinates: "lat lon",
      units: "m s-1",
      standard_name: name === "uo" ? "eastward_wind" : "northward_wind",
    });
    datasets.push(dataset(s, "different-polygons-" + name));
  }
  const answer = await equivalentOrRefused(
    both(datasets[0], datasets[1]),
    /cell|footprint|edge|outline|grid/i
  );
  expect(answer?.ru.region?.joint ?? false).toBe(false);
});

/** U and V of a 2 × 2 cell box in two stores, written by `write`. */
async function pair(
  fields: Record<
    "uo" | "vo",
    {
      values: number[];
      extra?: (s: TStore) => Promise<void>;
      attrs?: Record<string, unknown>;
      dims?: string[];
      shape?: number[];
    }
  >
) {
  const out: TAnalysisDataset[] = [];
  for (const name of ["uo", "vo"] as const) {
    const f = fields[name];
    const s = await grid();
    await f.extra?.(s);
    await write(
      s,
      name,
      f.values,
      f.shape ?? [1, 2, 2],
      f.dims ?? ["time", "lat", "lon"],
      {
        units: "m s-1",
        standard_name:
          name === "uo"
            ? "eastward_sea_water_velocity"
            : "northward_sea_water_velocity",
        ...f.attrs,
      }
    );
    out.push(dataset(s, `pair45-${name}-${Math.random()}`));
  }
  return out;
}

it("review of interim45: member 41 of U pairs with member 41 of V, stored elsewhere", async () => {
  const members = (ids: number[]) => async (s: TStore) =>
    write(s, "member", ids, [2], ["member"], { standard_name: "realization" });
  const N = NaN;
  const [u, v] = await pair({
    uo: {
      values: [6, 0, N, N, 1, 1, 1, 1],
      shape: [1, 2, 2, 2],
      dims: ["time", "member", "lat", "lon"],
      extra: members([41, 57]),
    },
    vo: {
      values: [1, 1, 1, 1, N, 0, 8, N],
      shape: [1, 2, 2, 2],
      dims: ["time", "member", "lat", "lon"],
      extra: members([57, 41]),
    },
  });
  const result = await (await region(u, "uo", v, "vo")).execute();
  // The one cell both components of member 41 have is calm.
  expect(result.region?.joint).toBe(true);
  expect(result.values[0]).toBeCloseTo(0);
  expect(result.region?.coverage[0]).toBeCloseTo(0.25);
});

it("review of interim45: identical area measures in two stores still pair", async () => {
  const areas = async (s: TStore) =>
    write(s, "areacello", [1, 2, 3, 4], [2, 2], ["lat", "lon"], {
      units: "m2",
    });
  const attrs = { cell_measures: "area: areacello" };
  const [u, v] = await pair({
    uo: { values: [1, 2, 3, 4], extra: areas, attrs },
    vo: { values: [3, 6, 9, 12], extra: areas, attrs },
  });
  const { ru, rv } = await both(u, v);
  expect(ru.region?.joint).toBe(true);
  expect(rv.values[0]).toBeCloseTo(3 * ru.values[0]);
});

it("review of interim45: two means of one cell pair whatever their stamps; maxima do not", async () => {
  const stamped = (at: number) => async (s: TStore) => {
    s.delete("/time/zarr.json");
    s.delete("/time/c/0");
    await write(s, "time", [at], [1], ["time"], {
      units: "days since 2000-01-01",
      bounds: "time_bnds",
    });
    await write(s, "time_bnds", [0, 1], [1, 2], ["time", "nv"]);
  };
  const means = await pair({
    uo: {
      values: [1, 2, 3, 4],
      extra: stamped(0.25),
      attrs: { cell_methods: "time: mean" },
    },
    vo: {
      values: [1, 2, 3, 4],
      extra: stamped(0.75),
      attrs: { cell_methods: "time: mean" },
    },
  });
  expect((await both(means[0], means[1])).ru.region?.joint).toBe(true);
  const maxima = await pair({
    uo: {
      values: [3, 3, 3, 3],
      extra: stamped(0.5),
      attrs: { cell_methods: "time: maximum" },
    },
    vo: {
      values: [4, 4, 4, 4],
      extra: stamped(0.5),
      attrs: { cell_methods: "time: maximum" },
    },
  });
  await expect(both(maxima[0], maxima[1])).rejects.toThrow(
    /maximum of each component/
  );
});

it("review of interim45: a slice without the partner's date is missing, not a refusal", async () => {
  const days = (raw: number[]) => async (s: TStore) => {
    s.delete("/time/zarr.json");
    s.delete("/time/c/0");
    await write(s, "time", raw, [raw.length], ["time"], {
      units: "days since 2000-01-01",
    });
  };
  const [u, v] = await pair({
    uo: {
      values: [0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2],
      shape: [3, 2, 2],
      extra: days([0, 10, 1]),
    },
    vo: { values: [0, 0, 0, 0], extra: days([0]) },
  });
  const describe = (dataset: TAnalysisDataset, name: string) =>
    resolveVariableContext(dataset, name, new ByteLru<BigInt64Array>(2 ** 20));
  const [context, partner] = await Promise.all([
    describe(u, "uo"),
    describe(v, "vo"),
  ]);
  const planned = await planAnalysis(
    context,
    {
      version: 1,
      kind: ANALYSIS_KINDS.REGION_SERIES,
      geometry: BOX,
      fixed: {},
      source: { ref: "x", versionStatus: "best-effort" },
      variable: "uo",
      // Days 0 and 1: stored rows 0 and 2, two slices.
      time: {
        start: 0,
        stop: 3,
        runs: [
          [0, 1],
          [2, 3],
        ],
      },
      jointWith: "vo",
    },
    new ReadContext(),
    undefined,
    false,
    partner
  );
  const result = await planned.execute();
  expect(result.values[0]).toBeCloseTo(0);
  expect(result.values[1]).toBeNaN();
});

it("review of interim45: two components' native geometries are admitted together", async () => {
  const station = async (name: "uo" | "vo") => {
    const s: TStore = new Map();
    await zarr.create(zarr.root(s), { attributes: {} });
    await write(s, "lat", [0, 1], [2], ["cell"], {
      standard_name: "latitude",
      units: "degrees_north",
    });
    await write(s, "lon", [0, 1], [2], ["cell"], {
      standard_name: "longitude",
      units: "degrees_east",
    });
    await write(s, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(s, name, [1, 2], [1, 2], ["time", "cell"], {
      coordinates: "lat lon",
      units: "m s-1",
      standard_name: name === "uo" ? "eastward_wind" : "northward_wind",
    });
    return resolveVariableContext(
      dataset(s, `geometry-pair-${name}`),
      name,
      new ByteLru<BigInt64Array>(2 ** 20)
    );
  };
  const [u, v] = await Promise.all([station("uo"), station("vo")]);
  const sized = (ctx: typeof u, bytes: number) =>
    ({ ...ctx, grid: { ...ctx.grid, geometryBytes: bytes } }) as typeof u;
  const plan = (bytes: number) =>
    planAnalysis(
      sized(u, bytes),
      {
        version: 1,
        kind: ANALYSIS_KINDS.REGION_SERIES,
        geometry: BOX,
        fixed: {},
        source: { ref: "x", versionStatus: "best-effort" },
        variable: "uo",
        time: { start: 0, stop: 1 },
        jointWith: "vo",
      },
      new ReadContext(),
      undefined,
      false,
      sized(v, bytes)
    );
  await expect(plan(300 * 2 ** 20)).rejects.toThrow(/together/);
  await expect(plan(1024)).resolves.toBeDefined();
});

it("interim47 independent: transposed area storage does not change a joint vector identity", async () => {
  const measure = (dims: string[]) => async (s: TStore) =>
    write(s, "area", [1, 1, 9, 9], [2, 2], dims, { units: "m2" });
  const attrs = { cell_measures: "area: area" };
  const [u, v] = await pair({
    uo: { values: [0, 0, 10, 10], attrs, extra: measure(["lat", "lon"]) },
    vo: { values: [0, 0, 30, 30], attrs, extra: measure(["lon", "lat"]) },
  });
  const result = await equivalentOrRefused(both(u, v), /area|weight|measure/i);
  if (result) {
    expect(result.rv.values[0]).toBeCloseTo(3 * result.ru.values[0]);
  }
});

it("interim47 independent: componentwise maxima within days followed by a mean cannot make a vector", async () => {
  const period = async (s: TStore) => {
    await write(s, "time", [1], [1], ["time"], {
      units: "days since 2000-01-01",
      bounds: "time_bnds",
    });
    await write(s, "time_bnds", [0, 2], [1, 2], ["time", "nv"]);
  };
  // Each day contains just (3,0) and (0,4). No speed exceeds 4 m/s.
  const attrs = {
    cell_methods: "time: maximum within days time: mean over days",
  };
  const [u, v] = await pair({
    uo: { values: [3, 3, 3, 3], attrs, extra: period },
    vo: { values: [4, 4, 4, 4], attrs, extra: period },
  });
  const result = await equivalentOrRefused(
    both(u, v),
    /method|maximum|nonlinear|vector|statistic/i
  );
  if (result) {
    expect(
      Math.hypot(result.ru.values[0], result.rv.values[0])
    ).toBeLessThanOrEqual(4);
  }
});

// eslint-disable-next-line max-lines-per-function -- one paired store fixture tracks both read counts.
it("interim47 independent: a selected cell quotes both full area comparisons before reading", async () => {
  const n = 8;
  const gets = [0, 0];
  const out: TAnalysisDataset[] = [];
  for (const [id, name] of ["uo", "vo"].entries()) {
    const s = await grid();
    for (const [axis, units] of [
      ["lat", "degrees_north"],
      ["lon", "degrees_east"],
    ]) {
      await write(
        s,
        axis,
        Array.from({ length: n }, (_, i) => i),
        [n],
        [axis],
        { units }
      );
    }
    const area = await zarr.create(zarr.root(s).resolve("area"), {
      shape: [n, n],
      chunkShape: [1, 1],
      dtype: "float64",
      dimensionNames: ["lat", "lon"],
      attributes: { units: "m2" },
      fillValue: 1,
    });
    await zarr.set(area as never, null, {
      data: new Float64Array(n * n).fill(1),
      shape: [n, n],
      stride: [n, 1],
    } as never);
    await write(
      s,
      name,
      new Array(n * n).fill(1),
      [1, n, n],
      ["time", "lat", "lon"],
      {
        units: "m s-1",
        cell_measures: "area: area",
        standard_name: name === "uo" ? "eastward_wind" : "northward_wind",
      }
    );
    out.push(
      dataset(
        {
          get(key: string) {
            if (key.startsWith("/area/c/")) {
              gets[id]++;
            }
            return s.get(key);
          },
        },
        `cost47-${name}-${Math.random()}`
      )
    );
  }
  const plan = await region(out[0], "uo", out[1], "vo", new ReadContext(), {
    kind: "box",
    south: -0.1,
    north: 0.1,
    west: -0.1,
    east: 0.1,
  });
  const quoted = plan.estimate.geometryReads ?? 0;
  const observed = gets[0] + gets[1];
  expect(
    observed,
    `${gets[0]} own + ${gets[1]} partner reads, quoted ${quoted}`
  ).toBeLessThanOrEqual(quoted);
});

it("interim47 independent: a 128 MiB partner area tile waits for confirmation", async () => {
  const out: TAnalysisDataset[] = [];
  let attempted = 0;
  for (const name of ["uo", "vo"] as const) {
    const s = await grid();
    await zarr.create(zarr.root(s).resolve("area"), {
      shape: [2, 2],
      chunkShape: name === "uo" ? [2, 2] : [4096, 4096],
      dtype: "float64",
      dimensionNames: ["lat", "lon"],
      attributes: { units: "m2" },
      fillValue: 1,
    });
    await write(s, name, [1, 1, 1, 1], [1, 2, 2], ["time", "lat", "lon"], {
      units: "m s-1",
      cell_measures: "area: area",
      standard_name: name === "uo" ? "eastward_wind" : "northward_wind",
    });
    out.push(
      dataset(
        {
          get(key: string) {
            if (name === "vo" && key.startsWith("/area/c/")) {
              attempted++;
              throw new Error(
                "test stopped an unconfirmed 128 MiB chunk at the store"
              );
            }
            return s.get(key);
          },
        },
        `padded-partner-${name}-${Math.random()}`
      )
    );
  }
  await region(out[0], "uo", out[1], "vo").catch(() => undefined);
  expect(attempted).toBe(0);
});

it("i48 review keeps sub-square-metre vector weighting invariant to reporting areas in km2", async () => {
  const measure = (area: number[]) => async (s: TStore) =>
    write(s, "area", area, [2, 2], ["lat", "lon"], { units: "km2" });
  const attrs = { cell_measures: "area: area" };
  const [u, v] = await pair({
    uo: {
      values: [0, 10, 0, 10],
      attrs,
      extra: measure([9e-10, 1e-10, 9e-10, 1e-10]),
    },
    vo: {
      values: [0, 30, 0, 30],
      attrs,
      extra: measure([1e-10, 9e-10, 1e-10, 9e-10]),
    },
  });
  const result = await equivalentOrRefused(both(u, v), /area|weight|measure/i);
  if (result) {
    expect(result.rv.values[0]).toBeCloseTo(3 * result.ru.values[0]);
  }
});

it("i48 review resolves identically named cell measures inside different groups of one dataset", async () => {
  const store = await grid();
  for (const [group, name, values, areas] of [
    ["east", "uo", [0, 10, 0, 10], [9, 1, 9, 1]],
    ["north", "vo", [0, 30, 0, 30], [1, 9, 1, 9]],
  ] as const) {
    for (const [path, data] of await grid()) {
      store.set("/" + group + path, data);
    }
    await write(store, group + "/area", [...areas], [2, 2], ["lat", "lon"], {
      units: "m2",
    });
    await write(
      store,
      group + "/" + name,
      [...values],
      [1, 2, 2],
      ["time", "lat", "lon"],
      {
        units: "m s-1",
        cell_measures: "area: area",
        standard_name: name === "uo" ? "eastward_wind" : "northward_wind",
      }
    );
  }
  const ds = dataset(store, "two-groups");
  const joint = async (own: string, other: string) =>
    (await region(ds, own, ds, other)).execute();
  const result = await equivalentOrRefused(
    Promise.all([joint("east/uo", "north/vo"), joint("north/vo", "east/uo")]),
    /area|weight|measure/i
  );
  if (result) {
    expect(result[1].values[0]).toBeCloseTo(3 * result[0].values[0]);
  }
});

it("i48 review pairs curvilinear regional components only on their effective declared areas", async () => {
  const stores: TAnalysisDataset[] = [];
  for (const [name, values, areas] of [
    ["uo", [0, 10, 0, 10], [9, 1, 9, 1]],
    ["vo", [0, 30, 0, 30], [1, 9, 1, 9]],
  ] as const) {
    const s: TStore = new Map();
    await zarr.create(zarr.root(s), { attributes: {} });
    await write(s, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(s, "lat", [0, 0.1, 1, 1.1], [2, 2], ["y", "x"], {
      standard_name: "latitude",
      units: "degrees_north",
    });
    await write(s, "lon", [0, 1, 0.1, 1.1], [2, 2], ["y", "x"], {
      standard_name: "longitude",
      units: "degrees_east",
    });
    await write(s, "area", [...areas], [2, 2], ["y", "x"], { units: "km2" });
    await write(s, name, [...values], [1, 2, 2], ["time", "y", "x"], {
      coordinates: "lat lon",
      units: "m s-1",
      cell_measures: "area: area",
      standard_name: name === "uo" ? "eastward_wind" : "northward_wind",
    });
    stores.push(dataset(s, "curved-" + name));
  }
  const result = await equivalentOrRefused(
    both(stores[0], stores[1]),
    /area|weight|measure|coordinates/i
  );
  if (result) {
    expect(result.rv.values[0]).toBeCloseTo(3 * result.ru.values[0]);
  }
});
