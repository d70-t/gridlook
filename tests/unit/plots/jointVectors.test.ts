/* eslint-disable camelcase, max-lines-per-function -- CF metadata uses snake_case keys. */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { jointAlignment } from "@/lib/analysis/jointComponents.ts";
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
  attrs: Record<string, unknown> = {}
) {
  const a = await zarr.create(zarr.root(s).resolve(name), {
    shape,
    chunkShape: shape.length ? shape : [],
    dtype: "float64",
    dimensionNames: dims,
    attributes: attrs,
    fillValue: NaN,
  });
  if (shape.length === 0) {
    await zarr.set(a, null, data[0]);
    return;
  }
  await zarr.set(a, null, {
    data: Float64Array.from(data),
    shape,
    stride: shape.map((_, d) => shape.slice(d + 1).reduce((x, y) => x * y, 1)),
  });
}

async function axes(s: TStore, n = 1, lons = [0, 1e-6], lats = [0, 1e-6]) {
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
  await put(s, "lat", lats, [lats.length], ["lat"], { units: "degrees_north" });
}

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
  const def = {
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
  s.set(`/${name}/zarr.json`, new TextEncoder().encode(JSON.stringify(def)));
}

function traced(
  s: TStore,
  answer: (key: string, range: TRange) => Uint8Array | undefined
) {
  return {
    get: (key: string) => s.get(key),
    getRange: async (key: string, range: TRange) => answer(key, range),
  };
}

function context(s: unknown, name = "u"): Promise<TVariableContext> {
  return resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      s as never,
      "",
      ZARR_FORMAT.V3,
      `review51-${Math.random()}`
    ),
    name,
    new ByteLru(1024 * 1024)
  ) as Promise<TVariableContext>;
}

function region(variable = "u", jointWith?: string): TAnalysisQuery {
  return {
    version: 1,
    kind: "region-series",
    variable,
    ...(jointWith ? { jointWith } : {}),
    geometry: { kind: "box", west: -0.1, east: 0.1, south: -0.1, north: 0.1 },
    fixed: {},
    source: { ref: "fixture", versionStatus: "best-effort" },
    time: { start: 0, stop: 1 },
  } as TAnalysisQuery;
}

function plan(
  a: TVariableContext,
  query: TAnalysisQuery,
  partner?: TVariableContext,
  confirmed = false
) {
  return planAnalysis(
    a,
    query,
    new ReadContext(),
    undefined,
    confirmed,
    partner
  );
}

function shardIndex(entries: number): Uint8Array {
  const k = new BigUint64Array(2 * entries);
  for (let i = 1; i < Math.min(k.length, 32); i += 2) {
    k[i - 1] = BigInt((i - 1) * 4);
    k[i] = 8n;
  }
  return new Uint8Array(k.buffer);
}

const FIVE = new Uint8Array(Float64Array.of(5).buffer);
const named = (name: string) =>
  name === "u" ? "eastward_wind" : "northward_wind";

it("withholds a vector whose components' temporal bounds were not read", async () => {
  const n = 40;
  const open = async (name: string, span: number) => {
    const s = await store();
    await axes(s, n);
    const values = Array.from({ length: n }, (_, i) => [i - span, i]).flat();
    await put(
      s,
      name,
      Array(n * 4).fill(name === "u" ? 3 : 4),
      [n, 2, 2],
      ["time", "lat", "lon"],
      {
        units: "m s-1",
        standard_name: named(name),
        cell_methods: "time: mean",
      }
    );
    // Bounds too large to describe within the index budget.
    sharded(s, "t_bounds", [n, 2], ["time", "nv"], {}, [1, 131072], [1, 1]);
    const idx = new BigUint64Array(262144);
    idx[1] = 8n;
    idx[2] = 8n;
    idx[3] = 8n;
    const t = traced(s, (key, range) => {
      if ("suffixLength" in range) {
        return new Uint8Array(idx.buffer);
      }
      const row = Number(key.split("/")[3]);
      return new Uint8Array(
        Float64Array.of(values[2 * row + (range.offset ? 1 : 0)]).buffer
      );
    });
    return context(t, name);
  };
  const u = await open("u", 1);
  const v = await open("v", 0.25);
  const aligned = await jointAlignment(u, v, undefined);
  expect("reason" in aligned).toBe(true);
});

it("refuses winds at different scalar heights or reference surfaces", async () => {
  const scalar = async (name: string, z: number) => {
    const s = await store();
    await axes(s);
    await put(s, "height", [z], [], [], {
      standard_name: "height",
      positive: "up",
      units: "m",
    });
    await put(s, name, Array(4).fill(3), [1, 2, 2], ["time", "lat", "lon"], {
      units: "m s-1",
      standard_name: named(name),
      coordinates: "height",
    });
    return context(s, name);
  };
  const at10 = await scalar("u", 10);
  expect(
    "reason" in (await jointAlignment(at10, await scalar("v", 100), undefined))
  ).toBe(true);
  expect(
    "reason" in (await jointAlignment(at10, await scalar("v", 10), undefined))
  ).toBe(false);

  const surface = async (name: string, standard: string) => {
    const s = await store();
    await axes(s);
    await put(s, "lev", [100], [1], ["lev"], {
      standard_name: standard,
      axis: "Z",
      positive: "up",
      units: "m",
    });
    await put(
      s,
      name,
      Array(4).fill(3),
      [1, 1, 2, 2],
      ["time", "lev", "lat", "lon"],
      { units: "m s-1", standard_name: named(name) }
    );
    return context(s, name);
  };
  const height = await surface("u", "height");
  expect(
    "reason" in
      (await jointAlignment(height, await surface("v", "altitude"), 0))
  ).toBe(true);
  expect(
    "reason" in (await jointAlignment(height, await surface("v", "height"), 0))
  ).toBe(false);
});

it("prices a sharded area measure's indexes before planning reads them", async () => {
  const ny = 10;
  const s = await store();
  await axes(
    s,
    1,
    [0, 0.01],
    Array.from({ length: ny }, (_, k) => k * 0.01)
  );
  await put(s, "u", Array(ny * 2).fill(9), [1, ny, 2], ["time", "lat", "lon"], {
    cell_measures: "area: area",
  });
  sharded(
    s,
    "area",
    [ny, 2],
    ["lat", "lon"],
    { units: "m2" },
    [1, 524288],
    [1, 1]
  );
  const idx = shardIndex(524288);
  const keys: string[] = [];
  const t = traced(s, (key, range) => {
    if ("suffixLength" in range) {
      keys.push(key);
      return idx;
    }
    return FIVE;
  });
  const c = await context(t);
  const described = keys.length;
  const quote = await plan(c, region());
  // Unconfirmed: nothing more is read, and the quote names the indexes.
  expect(keys.length).toBe(described);
  expect(quote.estimate.modest).toBe(false);
  expect(quote.estimate.decodedBytes).toBeGreaterThanOrEqual(ny * idx.length);
  const confirmed = await plan(c, region(), undefined, true);
  const r = await confirmed.execute();
  expect(r.values[0]).toBeCloseTo(9);
});

it("reads each spatial shard index within the quoted bound", async () => {
  const nt = 65536;
  const nx = 20;
  const ny = 4;
  const s = await store();
  await axes(
    s,
    nt,
    Array.from({ length: nx }, (_, i) => i * 0.004),
    Array.from({ length: ny }, (_, i) => i * 0.004)
  );
  sharded(
    s,
    "u",
    [nt, ny, nx],
    ["time", "lat", "lon"],
    {},
    [65536, 4, 1],
    [1, 1, 1]
  );
  const idx = shardIndex(65536 * 4);
  const keys: string[] = [];
  const t = traced(s, (key, range) => {
    if ("suffixLength" in range) {
      keys.push(key);
      return idx;
    }
    return FIVE;
  });
  const p = await plan(await context(t), region(), undefined, true);
  const r = await p.execute();
  expect(r.values[0]).toBeCloseTo(5);
  expect(keys.length * idx.length).toBeLessThanOrEqual(p.estimate.decodedBytes);
});

it("settles an aborted read waiting behind another store's shard payload", async () => {
  const s = await store();
  for (const n of ["u", "v"]) {
    sharded(s, n, [1], ["time"], {}, [2359296], [1]);
  }
  const idx = shardIndex(2359296);
  let release!: () => void;
  let payload!: () => void;
  const started = new Promise<void>((resolve) => (payload = resolve));
  const gate = new Promise<void>((resolve) => (release = resolve));
  const events: string[] = [];
  const t = {
    get: (k: string) => s.get(k),
    getRange: async (k: string, r: TRange) => {
      events.push(k);
      if ("suffixLength" in r) {
        return idx;
      }
      if (k.startsWith("/u/")) {
        payload();
        await gate;
      }
      return FIVE;
    },
  };
  const ds = zarrAnalysisDatasetFromStore(
    t as never,
    "",
    ZARR_FORMAT.V3,
    "cancel51"
  );
  const a = await ds.openArray("u");
  const b = await ds.openArray("v");
  const held = a.readChunk([0]);
  await started;
  const ac = new AbortController();
  let settled = false;
  const waiting = b.readChunk([0], ac.signal).then(
    () => (settled = true),
    () => (settled = true)
  );
  await new Promise((resolve) => setTimeout(resolve, 5));
  ac.abort();
  await new Promise((resolve) => setTimeout(resolve, 10));
  expect(settled).toBe(true);
  release();
  await held;
  await waiting;
  expect(events.some((x) => x.startsWith("/v/"))).toBe(false);
});
