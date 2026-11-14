/* eslint-disable max-lines-per-function -- fixture-heavy store cases. */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import type { TAnalysisQuery } from "@/lib/analysis/types.ts";
import {
  resolveVariableContext,
  type TVariableContext,
} from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;
type TRange = { suffixLength: number } | { offset: number; length: number };

async function store(): Promise<TStore> {
  const s: TStore = new Map();
  await zarr.create(zarr.root(s), { attributes: {} });
  return s;
}

async function put(
  s: TStore,
  name: string,
  data: number[],
  shape: number[],
  dims: string[],
  attrs: Record<string, unknown> = {},
  chunks = shape
) {
  const array = await zarr.create(zarr.root(s).resolve(name), {
    shape,
    chunkShape: chunks,
    dtype: "float64",
    dimensionNames: dims,
    attributes: attrs,
    fillValue: Number.NaN,
  });
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((a, b) => a * b, 1)
  );
  await zarr.set(array, null, {
    data: Float64Array.from(data),
    shape,
    stride,
  });
}

/** Daily time with bounds, and small longitude and latitude axes. */
async function axes(
  s: TStore,
  n = 1,
  lons = [0, 0.000001],
  lats = [0, 0.000001]
) {
  await put(
    s,
    "time",
    Array.from({ length: n }, (_, i) => i),
    [n],
    ["time"],
    {
      units: "days since 2000-01-01",
      bounds: "t_bounds",
    }
  );
  await put(
    s,
    "t_bounds",
    Array.from({ length: n }, (_, i) => [i - 0.5, i + 0.5]).flat(),
    [n, 2],
    ["time", "nv"]
  );
  await put(s, "lon", lons, [lons.length], ["lon"], { units: "degrees_east" });
  await put(s, "lat", lats, [lats.length], ["lat"], {
    units: "degrees_north",
  });
}

function context(s: object, name = "u"): Promise<TVariableContext> {
  return resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      s as never,
      "",
      ZARR_FORMAT.V3,
      `review-${Math.random()}`
    ),
    name,
    new ByteLru(1024 * 1024)
  );
}

function region(n = 1) {
  return {
    version: 1,
    kind: "region-series",
    variable: "u",
    geometry: { kind: "box", west: -0.1, east: 0.1, south: -0.1, north: 0.1 },
    fixed: {},
    source: { ref: "fixture", versionStatus: "best-effort" },
    time: { start: 0, stop: n },
  };
}

function plan(
  a: TVariableContext,
  q: object,
  b?: TVariableContext,
  yes = false
) {
  return planAnalysis(
    a,
    q as TAnalysisQuery,
    new ReadContext(),
    undefined,
    yes,
    b
  );
}

/** A sharded float64 array declared by its metadata alone. */
function sharded(
  s: TStore,
  name: string,
  shape: number[],
  dims: string[],
  attrs: Record<string, unknown>,
  outer: number[],
  inner: number[]
) {
  const bytes = { name: "bytes", configuration: { endian: "little" } };
  /* eslint-disable camelcase -- Zarr v3 metadata keys. */
  const meta = {
    zarr_format: 3,
    node_type: "array",
    shape,
    data_type: "float64",
    dimension_names: dims,
    chunk_grid: { name: "regular", configuration: { chunk_shape: outer } },
    chunk_key_encoding: {
      name: "default",
      configuration: { separator: "/" },
    },
    fill_value: "NaN",
    attributes: attrs,
    codecs: [
      {
        name: "sharding_indexed",
        configuration: {
          chunk_shape: inner,
          codecs: [bytes],
          index_codecs: [bytes],
        },
      },
    ],
  };
  /* eslint-enable camelcase */
  s.set(`/${name}/zarr.json`, new TextEncoder().encode(JSON.stringify(meta)));
}

/** The store, its byte ranges answered by `answer`. */
function traced(
  s: TStore,
  answer: (key: string, range: TRange) => Uint8Array | undefined
) {
  return {
    get: async (key: string) => s.get(key),
    getRange: async (key: string, range: TRange) => answer(key, range),
  };
}

/** An index whose first `cells` inner chunks hold one float64 value each. */
function indexOf(entries: number, present: number[]) {
  const index = new BigUint64Array(2 * entries).fill(2n ** 64n - 1n);
  for (const spot of present) {
    index[2 * spot] = 0n;
    index[2 * spot + 1] = 8n;
  }
  return new Uint8Array(index.buffer);
}

it("prices one shard index for a point series whose dates share one shard", async () => {
  const s = await store();
  await axes(s, 512);
  sharded(
    s,
    "u",
    [512, 2, 2],
    ["time", "lat", "lon"],
    {},
    [512, 1, 1],
    [1, 1, 1]
  );
  const indexBytes: number[] = [];
  const t = traced(s, (_k, r) => {
    if ("suffixLength" in r) {
      indexBytes.push(r.suffixLength);
      return indexOf(
        512,
        Array.from({ length: 512 }, (_, i) => i)
      );
    }
    return new Uint8Array(Float64Array.of(3).buffer);
  });
  const p = await plan(await context(t), {
    ...region(512),
    kind: "point-series",
    geometry: { kind: "point", lat: 0, lon: 0 },
  });
  const index = 512 * 16;
  expect(p.estimate.decodedBytes).toBeLessThan(2 * index + 512 * 8 * 2);
  const r = await p.execute();
  expect(r.values.every((v: number) => v === 3)).toBe(true);
  expect(indexBytes).toHaveLength(1);
});

it("quotes at least the index bytes a Box reads when its shards pass the kept budget", async () => {
  const s = await store();
  const lats = Array.from({ length: 5 }, (_, i) => i * 0.01);
  const lons = Array.from({ length: 16 }, (_, i) => i * 0.01);
  await axes(s, 12, lons, lats);
  // One shard per cell along all dates; 1 MiB index each (65,536 inner).
  sharded(
    s,
    "u",
    [12, 5, 16],
    ["time", "lat", "lon"],
    {},
    [65_536, 1, 1],
    [1, 1, 1]
  );
  let indexRead = 0;
  const t = traced(s, (_k, r) => {
    if ("suffixLength" in r) {
      indexRead += r.suffixLength;
      return indexOf(
        65_536,
        Array.from({ length: 12 }, (_, i) => i)
      );
    }
    return new Uint8Array(Float64Array.of(7).buffer);
  });
  const p = await plan(
    await context(t),
    {
      ...region(12),
      geometry: {
        kind: "box",
        west: -0.005,
        east: 0.155,
        south: -0.005,
        north: 0.045,
      },
    },
    undefined,
    true
  );
  expect(p.estimate.modest).toBe(false);
  const r = await p.execute();
  expect(r.values.every((v: number) => Math.abs(v - 7) < 1e-9)).toBe(true);
  expect(indexRead).toBeGreaterThan(80 * 2 ** 20);
  expect(p.estimate.decodedBytes).toBeGreaterThanOrEqual(indexRead);
  expect(p.estimate.notes.join(" ")).toMatch(/read them again/);
}, 120_000);

it("prices each sparse date's partner shard index", async () => {
  const n = 8;
  const s = await store();
  await axes(s, n);
  await put(
    s,
    "u",
    Array(n * 4).fill(8),
    [n, 2, 2],
    ["time", "lat", "lon"],
    {},
    [n, 2, 2]
  );
  sharded(
    s,
    "v",
    [n, 2, 2],
    ["time", "lat", "lon"],
    {},
    [1, 128, 128],
    [1, 1, 1]
  );
  let indexes = 0;
  const t = traced(s, (_k, r) => {
    if ("suffixLength" in r) {
      indexes++;
      return indexOf(128 * 128, [0, 1, 128, 129]);
    }
    return new Uint8Array(Float64Array.of(1).buffer);
  });
  const tiny = {
    kind: "box",
    south: -1e-7,
    north: 1e-7,
    west: -1e-7,
    east: 1e-7,
  };
  const p = await plan(
    await context(t, "u"),
    {
      ...region(7),
      geometry: tiny,
      time: {
        start: 0,
        stop: 7,
        runs: [
          [0, 1],
          [2, 3],
          [4, 5],
          [6, 7],
        ],
      },
      jointWith: "v",
    },
    await context(t, "v")
  );
  expect(p.estimate.termChunks).toBe(4);
  expect(p.estimate.decodedBytes).toBeGreaterThanOrEqual(4 * 128 * 128 * 16);
  expect((await p.execute()).values).toEqual([8, 8, 8, 8]);
  expect(indexes).toBe(4);
});

it("interim50: a partner's reordered dates are priced at its own rows", async () => {
  const n = 16;
  const u = await store();
  const v = await store();
  await axes(u, n);
  await axes(v, n);
  const times = [0, 4, 5, 6, 1, 7, 8, 9, 2, 10, 11, 12, 3, 13, 14, 15];
  await put(v, "time", times, [n], ["time"], {
    units: "days since 2000-01-01",
    bounds: "t_bounds",
  });
  await put(
    v,
    "t_bounds",
    times.flatMap((x) => [x - 0.5, x + 0.5]),
    [n, 2],
    ["time", "nv"]
  );
  await put(
    u,
    "u",
    Array(n * 4).fill(8),
    [n, 2, 2],
    ["time", "lat", "lon"],
    {},
    [n, 2, 2]
  );
  sharded(
    v,
    "v",
    [n, 2, 2],
    ["time", "lat", "lon"],
    {},
    [4, 64, 64],
    [1, 1, 1]
  );
  const index = indexOf(
    4 * 64 * 64,
    Array.from({ length: 4 * 64 * 64 }, (_, i) => i)
  );
  const requests: string[] = [];
  const t = traced(v, (k, r) => {
    if ("suffixLength" in r) {
      requests.push(k);
      return index;
    }
    return new Uint8Array(Float64Array.of(1).buffer);
  });
  const p = await plan(
    await context(u, "u"),
    {
      ...region(4),
      geometry: {
        kind: "box",
        west: -1e-7,
        east: 1e-7,
        south: -1e-7,
        north: 1e-7,
      },
      jointWith: "v",
    },
    await context(t, "v")
  );
  await p.execute();
  expect(requests).toHaveLength(4);
  expect(p.estimate.decodedBytes).toBeGreaterThanOrEqual(
    requests.length * index.byteLength
  );
});

it("interim50: one row of adjacent chunks in one shard is one index", async () => {
  const n = 64 * 80;
  const s = await store();
  await axes(
    s,
    1,
    Array.from({ length: n }, (_, k) => k * 0.01),
    [0, 1]
  );
  sharded(
    s,
    "u",
    [1, 2, n],
    ["time", "lat", "lon"],
    {},
    [1024, 1, 64],
    [1, 1, 1]
  );
  const index = indexOf(
    65536,
    Array.from({ length: 65536 }, (_, i) => i)
  );
  const requests: string[] = [];
  const t = traced(s, (k, r) => {
    if ("suffixLength" in r) {
      requests.push(k);
      return index;
    }
    return new Uint8Array(Float64Array.of(6).buffer);
  });
  const p = await plan(await context(t), {
    ...region(),
    geometry: {
      kind: "box",
      west: -0.001,
      east: 0.631,
      south: -0.001,
      north: 0.001,
    },
  });
  await p.execute();
  expect(requests).toHaveLength(1);
  expect(p.estimate.modest).toBe(true);
});

it("interim50: describing reads at most one budget of shard indexes in all", async () => {
  const n = 40;
  const s = await store();
  await axes(s, n);
  await put(s, "u", Array(n * 4).fill(22), [n, 2, 2], ["time", "lat", "lon"]);
  // 2 MiB of index per date's bounds: 80 MiB to read them all.
  sharded(s, "t_bounds", [n, 2], ["time", "nv"], {}, [1, 131072], [1, 1]);
  let bytes = 0;
  const t = traced(s, (_k, r) => {
    if ("suffixLength" in r) {
      bytes += r.suffixLength;
    }
    return undefined;
  });
  const c = await context(t);
  expect(bytes).toBe(0);
  expect(c.time?.boundsUnread).toMatch(/shard indexes/);
});

it("interim50: index fetches past the budget wait for those under way", async () => {
  const [n, nx, ny] = [12, 8, 4];
  const s = await store();
  await axes(
    s,
    n,
    Array.from({ length: nx }, (_, i) => i * 0.01),
    Array.from({ length: ny }, (_, i) => i * 0.01)
  );
  sharded(
    s,
    "u",
    [n, ny, nx],
    ["time", "lat", "lon"],
    {},
    [1, 2 ** 22, 1],
    [1, 1, 1]
  );
  let [live, peak] = [0, 0];
  const t = {
    get: async (k: string) => s.get(k),
    getRange: async (_k: string, r: TRange) => {
      if ("suffixLength" in r) {
        live += r.suffixLength;
        peak = Math.max(peak, live);
        await new Promise((resolve) => setTimeout(resolve, 2));
        live -= r.suffixLength;
      }
      return undefined;
    },
  };
  const p = await plan(await context(t as never), region(n), undefined, true);
  await p.execute();
  expect(peak).toBeLessThanOrEqual(64 * 2 ** 20);
}, 60_000);

it("interim50: two components' indexes are priced against one budget together", async () => {
  const [n, ny, nx] = [12, 5, 8];
  const s = await store();
  await axes(
    s,
    65536,
    Array.from({ length: nx }, (_, i) => i * 0.01),
    Array.from({ length: ny }, (_, i) => i * 0.01)
  );
  for (const name of ["u", "v"]) {
    sharded(
      s,
      name,
      [65536, ny, nx],
      ["time", "lat", "lon"],
      {},
      [65536, 1, 1],
      [1, 1, 1]
    );
  }
  const index = indexOf(
    65536,
    Array.from({ length: 65536 }, (_, i) => i)
  );
  const keys: string[] = [];
  const t = traced(s, (k, r) => {
    if ("suffixLength" in r) {
      keys.push(k);
      return index;
    }
    return new Uint8Array(Float64Array.of(1).buffer);
  });
  const p = await plan(
    await context(t, "u"),
    { ...region(n), jointWith: "v" },
    await context(t, "v"),
    true
  );
  await p.execute();
  expect(p.estimate.decodedBytes).toBeGreaterThanOrEqual(
    keys.length * index.byteLength
  );
  expect(p.estimate.notes.join(" ")).toMatch(/read them again/);
}, 120_000);
