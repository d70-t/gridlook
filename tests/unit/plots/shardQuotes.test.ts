/* eslint-disable camelcase -- Zarr v3 metadata uses snake_case keys. */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS } from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;

async function axis(store: TStore, name: string, n: number, units: string) {
  const array = await zarr.create(zarr.root(store).resolve(name), {
    shape: [n],
    chunkShape: [n],
    dtype: "float64",
    dimensionNames: [name],
    attributes: { units },
  });
  await zarr.set(array, null, {
    data: Float64Array.from({ length: n }, (_, k) => k * 0.01),
    shape: [n],
    stride: [1],
  });
}

// eslint-disable-next-line max-lines-per-function
async function shardedContext(
  dates: number,
  shard: [number, number],
  name = "t",
  sharding = true
) {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await axis(store, "time", dates, "days since 2000-01-01");
  await axis(store, "lat", shard[0], "degrees_north");
  await axis(store, "lon", shard[1], "degrees_east");
  store.set(
    `/${name}/zarr.json`,
    new TextEncoder().encode(
      JSON.stringify({
        zarr_format: 3,
        node_type: "array",
        shape: [dates, ...shard],
        data_type: "float64",
        dimension_names: ["time", "lat", "lon"],
        chunk_grid: {
          name: "regular",
          configuration: { chunk_shape: [1, ...shard] },
        },
        chunk_key_encoding: {
          name: "default",
          configuration: { separator: "/" },
        },
        fill_value: "NaN",
        attributes: { units: "m s-1" },
        codecs: [
          !sharding
            ? { name: "bytes", configuration: { endian: "little" } }
            : {
                name: "sharding_indexed",
                configuration: {
                  chunk_shape: [1, 1, 1],
                  codecs: [
                    { name: "bytes", configuration: { endian: "little" } },
                  ],
                  index_codecs: [
                    { name: "bytes", configuration: { endian: "little" } },
                  ],
                },
              },
        ],
      })
    )
  );
  return resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      {
        get: async (key: string) => store.get(key),
        getRange: async () => {
          throw new Error("no field or index read while planning");
        },
      } as never,
      "",
      ZARR_FORMAT.V3,
      `shard48-${name}-${Math.random()}`
    ),
    name,
    new ByteLru<BigInt64Array>(2 ** 20)
  );
}

async function sharded(dates: number, shard: [number, number]) {
  const context = await shardedContext(dates, shard);
  return planAnalysis(
    context,
    {
      version: 1,
      kind: ANALYSIS_KINDS.POINT_SERIES,
      geometry: { kind: "point", lat: 0, lon: 0 },
      fixed: {},
      source: { ref: "x", versionStatus: "best-effort" },
      variable: "t",
      time: { start: 0, stop: dates },
    },
    new ReadContext()
  );
}

it("interim48: every touched shard index is quoted, past what the page keeps", async () => {
  // 256 × 256 slots: a 1 MiB index per date.
  const plan = await sharded(512, [256, 256]);
  expect(plan.estimate.decodedBytes).toBeGreaterThanOrEqual(512 * 2 ** 20);
  expect(plan.estimate.modest).toBe(false);
});

it("interim48: one shard index larger than the index budget is refused before any read", async () => {
  // 2048 × 4096 slots: a 128 MiB index.
  await expect(sharded(1, [2048, 4096])).rejects.toThrow(/index of 128 MiB/);
});

it("interim48: a vector partner's shard indexes are quoted with the plot's", async () => {
  const [u, v] = await Promise.all([
    shardedContext(1, [256, 256], "uo", false),
    shardedContext(1, [256, 256], "vo"),
  ]);
  const plan = await planAnalysis(
    u,
    {
      version: 1,
      kind: ANALYSIS_KINDS.REGION_SERIES,
      geometry: { kind: "box", south: 0, north: 0.05, west: 0, east: 0.05 },
      fixed: {},
      source: { ref: "x", versionStatus: "best-effort" },
      variable: "uo",
      time: { start: 0, stop: 1 },
      jointWith: "vo",
    },
    new ReadContext(),
    undefined,
    false,
    v
  );
  expect(plan.estimate.decodedBytes).toBeGreaterThanOrEqual(2 ** 20);
});
