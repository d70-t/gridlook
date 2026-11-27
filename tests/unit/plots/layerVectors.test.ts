import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { jointAlignment } from "@/lib/analysis/jointComponents.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS } from "@/lib/analysis/types.ts";
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

async function component(name: string, layer: [number, number], n = 1) {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(
    store,
    "time",
    Array.from({ length: n }, (_, k) => k),
    [n],
    ["time"],
    {
      units: "days since 2000-01-01",
    }
  );
  await write(store, "depth", [5], [1], ["depth"], {
    units: "m",
    positive: "down",
    bounds: "depth_bnds",
  });
  await write(store, "depth_bnds", layer, [1, 2], ["depth", "nv"]);
  await write(store, "lat", [0, 1], [2], ["lat"], { units: "degrees_north" });
  await write(store, "lon", [0, 1], [2], ["lon"], { units: "degrees_east" });
  await write(
    store,
    name,
    new Array(4 * n).fill(1),
    [n, 1, 2, 2],
    ["time", "depth", "lat", "lon"],
    {
      units: "m s-1",
    }
  );
  return resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `d-${Math.random()}`
    ),
    name,
    new ByteLru<BigInt64Array>(2 ** 20)
  );
}

it("interim48: components of one depth centre but other layers make no vector", async () => {
  const u = await component("uo", [0, 10]);
  const unlike = await jointAlignment(u, await component("vo", [4, 6]), 0);
  const alike = await jointAlignment(u, await component("vo", [0, 10]), 0);
  expect(unlike).toEqual({ reason: "their levels differ" });
  expect("reason" in alike).toBe(false);
});

// eslint-disable-next-line max-lines-per-function
it("interim48: a sparse vector quotes the partner tile of every date it reads", async () => {
  const n = 64;
  const gets = { uo: 0, vo: 0 };
  const open = async (name: "uo" | "vo", chunk: number) => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    await write(
      store,
      "time",
      Array.from({ length: n }, (_, k) => k),
      [n],
      ["time"],
      {
        units: "days since 2000-01-01",
      }
    );
    await write(store, "lat", [0, 1], [2], ["lat"], { units: "degrees_north" });
    await write(store, "lon", [0, 1], [2], ["lon"], { units: "degrees_east" });
    await write(
      store,
      name,
      new Array(n * 4).fill(1),
      [n, 2, 2],
      ["time", "lat", "lon"],
      { units: "m s-1" },
      [chunk, 2, 2]
    );
    const counted = {
      get(key: string) {
        if (key.startsWith(`/${name}/c`)) {
          gets[name]++;
        }
        return store.get(key);
      },
    };
    return resolveVariableContext(
      zarrAnalysisDatasetFromStore(
        counted as never,
        "",
        ZARR_FORMAT.V3,
        `s-${name}-${Math.random()}`
      ),
      name,
      new ByteLru<BigInt64Array>(2 ** 20)
    );
  };
  const [u, v] = await Promise.all([open("uo", n), open("vo", 1)]);
  const runs = Array.from(
    { length: 32 },
    (_, k) => [2 * k, 2 * k + 1] as [number, number]
  );
  const plan = await planAnalysis(
    u,
    {
      version: 1,
      kind: ANALYSIS_KINDS.REGION_SERIES,
      geometry: { kind: "box", south: -1, north: 2, west: -1, east: 2 },
      fixed: {},
      source: { ref: "x", versionStatus: "best-effort" },
      variable: "uo",
      time: { start: 0, stop: 63, runs },
      jointWith: "vo",
    },
    new ReadContext(),
    undefined,
    false,
    v
  );
  await plan.execute();
  expect(gets.uo + gets.vo).toBeLessThanOrEqual(plan.estimate.chunks);
  expect(plan.estimate.chunks).toBeLessThanOrEqual(34);
});

it("interim48: a cold long time pair is matched by number, and units changes are seen", async () => {
  const n = 200_000;
  const [u, v] = await Promise.all([
    component("uo", [0, 10], n),
    component("vo", [0, 10], n),
  ]);
  const started = performance.now();
  const joint = await jointAlignment(u, v, 0);
  const ms = performance.now() - started;
  if ("reason" in joint) {
    throw new Error(joint.reason);
  }
  expect([joint.rows[0], joint.rows[n - 1]]).toEqual([0, n - 1]);
  if (process.env.GRIDLOOK_TIMING === "1") {
    expect(ms).toBeLessThan(1000);
  }
  // The same raw arrays, another origin: no common instant.
  v.time!.units = "days since 3000-01-01";
  expect(await jointAlignment(u, v, 0)).toEqual({
    reason: "their dates differ",
  });
}, 60_000);
