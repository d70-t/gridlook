/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
/**
 * A publication of the partner's dates makes the old plan stale, and releasing
 * the partner stops the run before it is freed.
 */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { AnalysisRunner } from "@/lib/analysis/analysisRunner.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS, type TAnalysisQuery } from "@/lib/analysis/types.ts";
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
const source = (key: string) => ({
  key,
  store: `memory://${key}`,
  dataset: "",
  format: ZARR_FORMAT.V3,
});

/** U and V in two stores; V's data reads can be held until `go`. */
async function livePair(held = false) {
  const u = await grid();
  const v = await grid();
  await field(u, "uo", { data: new Float64Array([1, 2, 3, 4]) });
  await field(v, "vo", { data: new Float64Array([NaN, 3, NaN, NaN]) });
  const runner = new AnalysisRunner();
  const us = source(`us-${Math.random()}`);
  const vs = source(`vs-${Math.random()}`);
  let go = () => {};
  let entered = () => {};
  const gate = new Promise<void>((resolve) => (go = resolve));
  const started = new Promise<void>((resolve) => (entered = resolve));
  const guarded = {
    async get(key: string) {
      if (held && key.startsWith("/vo/c/")) {
        entered();
        await gate;
      }
      return v.get(key);
    },
  };
  const datasets = (runner as unknown as { datasets: Map<string, unknown> })
    .datasets;
  datasets.set(
    us.key,
    Promise.resolve(
      zarrAnalysisDatasetFromStore(u as never, "", ZARR_FORMAT.V3, us.key)
    )
  );
  datasets.set(
    vs.key,
    Promise.resolve(
      zarrAnalysisDatasetFromStore(guarded as never, "", ZARR_FORMAT.V3, vs.key)
    )
  );
  const query = {
    version: 1,
    kind: ANALYSIS_KINDS.REGION_SERIES,
    geometry: BOX,
    fixed: {},
    source: { ref: "x", versionStatus: "best-effort" },
    variable: "uo",
    jointWith: "vo",
    jointSource: vs,
    time: { start: 0, stop: 1 },
  } as unknown as TAnalysisQuery;
  return { v, runner, us, vs, query, go, started };
}

it("replans a vector whose partner published other dates", async () => {
  const { v, runner, us, vs, query } = await livePair();
  await runner.plan("old", us, query);
  v.set("/time/c/0", new Uint8Array(Float64Array.of(1).buffer));
  await runner.forgetPublished(vs.key, 0, 0);
  await expect(runner.execute("old")).rejects.toThrow(/plan it again/);
  await expect(runner.plan("fresh", us, query)).rejects.toThrow(/dates differ/);
});

it("releasing the partner stops the vector before it frees it", async () => {
  const { runner, us, vs, query, go, started } = await livePair(true);
  await runner.plan("held", us, query);
  const result = runner.execute("held").then(
    (r) => r.region?.joint,
    (error: Error) => error.name
  );
  await started;
  let released = false;
  const releasing = runner.release(vs.key).then(() => (released = true));
  await new Promise((resolve) => setTimeout(resolve, 50));
  const beforeRead = released;
  go();
  await releasing;
  // Either the release waited for the read, or the run was cancelled.
  expect(!beforeRead || (await result) === "AbortError").toBe(true);
  expect(await result).toBe("AbortError");
});
