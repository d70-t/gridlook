/* eslint-disable camelcase, max-lines-per-function -- CF fixtures per case. */
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

async function put(
  s: TStore,
  name: string,
  shape: number[],
  dims: string[],
  values: number[],
  attrs: Record<string, unknown> = {}
) {
  const a = await zarr.create(zarr.root(s).resolve(name), {
    shape,
    chunkShape: name === "v" ? [1, 8, 12] : shape,
    dimensionNames: dims,
    dtype: "float64",
    fillValue: NaN,
    attributes: attrs,
  });
  await zarr.set(a as never, null, {
    shape,
    stride: shape.map((_, i) => shape.slice(i + 1).reduce((x, y) => x * y, 1)),
    data: Float64Array.from(values),
  } as never);
}

/**
 * A 12-column curvilinear ring, 8 rows, with its first five columns repeated
 * after the last (120 K in column 0, 0 K elsewhere), its copies' values
 * missing. Either its latitudes are in eight shards, or its field in shards,
 * each behind a large index.
 */
async function make(missing: string, source: "coordinate" | "field") {
  const [n, ny, nx] = [12, 8, 17];
  const s: TStore = new Map();
  await zarr.create(zarr.root(s), { attributes: {} });
  const [lats, lons, temps]: number[][] = [[], [], []];
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const col = i % n;
      lats.push(-35 + 10 * j + 0.2 * Math.sin((2 * Math.PI * col) / n));
      lons.push(-165 + 30 * col + 0.2 * j);
      const masked =
        (missing === "copies" && i >= n) || (missing === "originals" && i < 5);
      temps.push(
        masked
          ? NaN
          : col === 0
            ? missing === "conflict" && i >= n
              ? 240
              : 120
            : 0
      );
    }
  }
  await put(s, "time", [1], ["time"], [0], { units: "days since 2000-01-01" });
  await put(s, "lat", [ny, nx], ["y", "x"], lats, {
    standard_name: "latitude",
    units: "degrees_north",
  });
  await put(s, "lon", [ny, nx], ["y", "x"], lons, {
    standard_name: "longitude",
    units: "degrees_east",
  });
  await put(
    s,
    "area",
    [ny, nx],
    ["y", "x"],
    Array.from({ length: ny * nx }, (_, q) =>
      (missing === "area-copies" && q % nx >= n) ||
      (missing === "area-originals" && q % nx < 5)
        ? NaN
        : 1
    ),
    {
      standard_name: "cell_area",
      units: "m2",
    }
  );
  await put(s, "v", [1, ny, nx], ["time", "y", "x"], temps, {
    units: "K",
    coordinates: "lat lon",
    cell_measures: "area: area",
  });
  const latShards = source === "coordinate",
    name = latShards ? "lat" : "v";
  const metaKey = "/" + name + "/zarr.json";
  const meta = JSON.parse(new TextDecoder().decode(s.get(metaKey)));
  const original = latShards ? lats : temps;
  const entries = latShards ? 2 ** 20 : 2 ** 21;
  const inner = latShards ? [1, nx] : [1, ny, 12];
  const outer = latShards ? [1, nx * entries] : [entries, ny, 12];
  const bytes = inner.reduce((a, v) => a * v, 8);
  meta.chunk_grid.configuration.chunk_shape = outer;
  meta.codecs = [
    {
      name: "sharding_indexed",
      configuration: {
        chunk_shape: inner,
        codecs: [{ name: "bytes", configuration: { endian: "little" } }],
        index_codecs: [{ name: "bytes", configuration: { endian: "little" } }],
        index_location: "end",
      },
    },
  ];
  s.set(metaKey, new TextEncoder().encode(JSON.stringify(meta)));
  const shared = new Uint8Array(entries * 16).fill(255),
    table = new BigUint64Array(shared.buffer);
  table[0] = 0n;
  table[1] = BigInt(bytes);
  let stage = "description";
  const fetches: {
    stage: string;
    kind: string;
    path: string;
    bytes: number;
  }[] = [];
  const upstream = {
    get: async (k: string) => s.get(k),
    getRange: async (
      k: string,
      r: { suffixLength?: number; offset?: number; length?: number }
    ) => {
      if (!k.startsWith("/" + name + "/c/")) {
        const all = s.get(k);
        return r.suffixLength !== undefined
          ? all?.slice(-r.suffixLength)
          : all?.slice(r.offset, r.offset! + r.length!);
      }
      const pos = k.split("/").slice(3).map(Number);
      const block = latShards
        ? original.slice(pos[0] * nx, (pos[0] + 1) * nx)
        : Array.from({ length: ny * 12 }, (_, q) => {
            const j = Math.floor(q / 12),
              i = pos[2] * 12 + (q % 12);
            return i < nx ? original[j * nx + i] : NaN;
          });
      const data =
        r.suffixLength !== undefined
          ? shared
          : new Uint8Array(Float64Array.from(block).buffer).subarray(
              r.offset!,
              r.offset! + r.length!
            );
      fetches.push({
        stage,
        kind: r.suffixLength !== undefined ? "index" : "payload",
        path: k,
        bytes: data.byteLength,
      });
      return data;
    },
  };
  const c = (await resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      upstream as never,
      "",
      ZARR_FORMAT.V3,
      `copies-${missing}-${Math.random()}`
    ),
    "v",
    new ByteLru(2 ** 20)
  )) as TVariableContext;
  const query = {
    kind: "region-series",
    version: 1,
    variable: "v",
    fixed: {},
    time: { start: 0, stop: 1 },
    geometry: { kind: "box", west: -180, east: 180, south: -85, north: 85 },
    source: { ref: "local", versionStatus: "best-effort" },
  } as TAnalysisQuery;
  return {
    c,
    query,
    fetches,
    mark: (v: string) => {
      stage = v;
    },
  };
}

it("prices cold coordinate and copy shard indexes before reading them", async () => {
  const point = { kind: "point", lat: -5, lon: -164.4 };
  for (const source of ["coordinate", "field"] as const) {
    const { c, query, fetches, mark } = await make("copies", source);
    const q = {
      ...query,
      kind: "point-series",
      geometry: point,
    } as TAnalysisQuery;
    mark("plan");
    const plan = await planAnalysis(c, q, new ReadContext());
    const planned = fetches.filter((f) => f.stage === "plan");
    mark("execute");
    const out = await plan.execute();
    expect(out.values).toEqual([120]);
    const read = fetches
      .filter((f) => f.stage === "execute")
      .reduce((n, f) => n + f.bytes, 0);
    expect(planned, source).toEqual([]);
    // Everything read is quoted first.
    expect(plan.estimate.decodedBytes, source).toBeGreaterThanOrEqual(read);
    if (source === "coordinate") {
      expect(plan.estimate.needsConfirmation).toBe(true);
    }
  }
});
