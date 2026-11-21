/* eslint-disable camelcase, max-lines-per-function -- CF metadata uses snake_case keys. */
import { expect, it, vi } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
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
    stride: shape.map((_, d) => shape.slice(d + 1).reduce((a, n) => a * n, 1)),
  } as never);
}

/** Three equal cells on the equator, each component valid on two. */
async function components() {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "lat", [0], [1], ["lat"], {
    units: "degrees_north",
    bounds: "lat_bnds",
  });
  await write(store, "lat_bnds", [-1, 1], [1, 2], ["lat", "nv"]);
  await write(store, "lon", [0, 10, 20], [3], ["lon"], {
    units: "degrees_east",
    bounds: "lon_bnds",
  });
  await write(store, "lon_bnds", [-5, 5, 5, 15, 15, 25], [3, 2], ["lon", "nv"]);
  await write(store, "time", [0], [1], ["time"], {
    units: "days since 2000-01-01",
  });
  const units = { units: "m s-1" };
  await write(store, "uo", [6, 0, NaN], [1, 1, 3], ["time", "lat", "lon"], {
    ...units,
    standard_name: "eastward_sea_water_velocity",
  });
  await write(store, "vo", [NaN, 0, 8], [1, 1, 3], ["time", "lat", "lon"], {
    ...units,
    standard_name: "northward_sea_water_velocity",
  });
  return zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `joint-${Math.random()}`
  );
}

it("independent review of interim41: vector components over an area are averaged on their common cells", async () => {
  const dataset = await components();
  const series = async (variable: string, jointWith?: string) => {
    const describe = (name: string) =>
      resolveVariableContext(
        dataset,
        name,
        new ByteLru<BigInt64Array>(2 ** 20)
      );
    const context = await describe(variable);
    const partner = jointWith ? await describe(jointWith) : undefined;
    const plan = await planAnalysis(
      context,
      {
        version: 1,
        kind: ANALYSIS_KINDS.REGION_SERIES,
        geometry: { kind: "box", west: -5, east: 25, south: -1, north: 1 },
        fixed: {},
        source: { ref: "x", versionStatus: "best-effort" },
        variable,
        time: { start: 0, stop: 1 },
        ...(jointWith ? { jointWith } : {}),
      },
      new ReadContext(),
      undefined,
      false,
      partner
    );
    return plan.execute();
  };
  // Apart, each over its own two cells: 3 and 4, a 5 m/s vector.
  expect((await series("uo")).values).toEqual([3]);
  expect((await series("vo")).values).toEqual([4]);
  // Together, over the one cell both hold: calm, on a third of the area.
  const [u, v] = [await series("uo", "vo"), await series("vo", "uo")];
  expect([u.values[0], v.values[0]]).toEqual([0, 0]);
  expect(u.region?.joint).toBe(true);
  expect(u.region?.coverage[0]).toBeCloseTo(1 / 3, 6);
  expect(v.region?.coverage[0]).toBeCloseTo(1 / 3, 6);
});

it("interim49: two equal long time axes map row to row without a map per instant", async () => {
  const { jointAlignment } = await import("@/lib/analysis/jointComponents.ts");
  const n = 400_000;
  const open = async (name: string) => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    await write(store, "lat", [0], [1], ["lat"], { units: "degrees_north" });
    await write(store, "lon", [0], [1], ["lon"], { units: "degrees_east" });
    await write(
      store,
      "time",
      Array.from({ length: n }, (_, k) => k),
      [n],
      ["time"],
      { units: "hours since 2000-01-01" }
    );
    const array = await zarr.create(zarr.root(store).resolve(name), {
      shape: [n, 1, 1],
      chunkShape: [4096, 1, 1],
      dtype: "float64",
      dimensionNames: ["time", "lat", "lon"],
      attributes: { units: "m s-1" },
      fillValue: Number.NaN as never,
    });
    void array;
    return resolveVariableContext(
      zarrAnalysisDatasetFromStore(
        store as never,
        "",
        ZARR_FORMAT.V3,
        `long-${name}-${Math.random()}`
      ),
      name,
      new ByteLru(2 ** 20)
    );
  };
  const [u, v] = [await open("uo"), await open("vo")];
  const set = vi.spyOn(Map.prototype, "set");
  const aligned = await jointAlignment(u, v, undefined);
  const sets = set.mock.calls.length;
  set.mockRestore();
  if ("reason" in aligned) {
    throw new Error(aligned.reason);
  }
  expect([aligned.rows[0], aligned.rows[n - 1], aligned.rows.length]).toEqual([
    0,
    n - 1,
    n,
  ]);
  expect(sets).toBeLessThan(100);
}, 120_000);

it("interim49: a model level index is no physical depth for a vector", async () => {
  const { jointAlignment } = await import("@/lib/analysis/jointComponents.ts");
  const open = async (name: string, levelAttrs: Record<string, unknown>) => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    await write(store, "lat", [0], [1], ["lat"], { units: "degrees_north" });
    await write(store, "lon", [0], [1], ["lon"], { units: "degrees_east" });
    await write(store, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(store, "lev", [5, 15], [2], ["lev"], levelAttrs);
    await write(
      store,
      name,
      [1, 2],
      [1, 2, 1, 1],
      ["time", "lev", "lat", "lon"],
      {
        units: "m s-1",
      }
    );
    return resolveVariableContext(
      zarrAnalysisDatasetFromStore(
        store as never,
        "",
        ZARR_FORMAT.V3,
        `lev-${name}-${Math.random()}`
      ),
      name,
      new ByteLru(2 ** 20)
    );
  };
  const u = await open("uo", {
    units: "m",
    positive: "down",
    standard_name: "depth",
  });
  const v = await open("vo", { long_name: "model level" });
  expect(u.vertical?.kind).not.toBe(v.vertical?.kind);
  const aligned = await jointAlignment(u, v, 0);
  expect("reason" in aligned && aligned.reason).toMatch(/levels differ/);
});

it("interim49: vector cell methods compare in order and with their sampling intervals", async () => {
  const { vectorMethodProblem } = await import("@/lib/analysis/cellMethods.ts");
  const at = (cellMethods: string) => ({ cellMethods, timeDimension: "time" });
  expect(
    vectorMethodProblem(
      at("time: mean (interval: 1 hour)"),
      at("time: mean (interval: 24 hours)")
    )
  ).toMatch(/differ/);
  expect(
    vectorMethodProblem(
      at("area: mean time: mean"),
      at("time: mean area: mean")
    )
  ).toMatch(/differ/);
  expect(
    vectorMethodProblem(
      at("time: mean (interval: 1 hour)"),
      at("time: mean (interval: 1 hour)")
    )
  ).toBeUndefined();
});
