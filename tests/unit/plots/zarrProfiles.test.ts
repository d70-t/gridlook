/* eslint-disable camelcase, max-lines-per-function -- fixtures with CF and Zarr attribute names. */
import { it, expect } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { alignTo } from "@/lib/analysis/companionAlign.ts";
import { convertResult } from "@/lib/analysis/displayUnits.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ALGORITHM_VERSION, ANALYSIS_KINDS } from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";
async function write(
  store: Map<string, Uint8Array>,
  path: string,
  data: number[],
  shape: number[],
  dimensionNames: string[],
  attributes: Record<string, unknown> = {}
) {
  const arr = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape: shape,
    dtype: "float64",
    dimensionNames,
    attributes,
    fillValue: NaN,
  });
  await zarr.set(arr, null, {
    data: Float64Array.from(data),
    shape,
    stride: shape.map((_, d) => shape.slice(d + 1).reduce((x, v) => x * v, 1)),
  });
}
async function fixture() {
  const store = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(store), { attributes: {} });
  await zarr.create(zarr.root(store).resolve("anomaly_analysis"), {
    attributes: {},
  });
  await write(store, "lat", [0, 1], [2], ["lat"], { units: "degrees_north" });
  await write(store, "lon", [0, 1], [2], ["lon"], { units: "degrees_east" });
  await write(store, "depth", [0, NaN, 1, 2, 3], [5], ["depth"], {
    units: "m",
    positive: "down",
    standard_name: "depth",
  });
  for (const [name, seq] of [
    ["left", [0, 100, 1, 2, 3]],
    ["right", [0, -100, 1, 2, 3]],
  ] as const) {
    await write(
      store,
      name,
      seq.flatMap((v) => Array(4).fill(v)),
      [5, 2, 2],
      ["depth", "lat", "lon"],
      { units: "1" }
    );
  }
  for (const name of ["anomaly_analysis/tas", "tas"]) {
    await write(
      store,
      name,
      Array(20).fill(280),
      [5, 2, 2],
      ["depth", "lat", "lon"],
      {
        units: "K",
        standard_name: "air_temperature",
        long_name: "Air temperature",
        coordinates: "/depth /lat /lon",
      }
    );
  }
  const dataset = zarrAnalysisDatasetFromStore(
    { get: async (key: string) => store.get(key) },
    "",
    ZARR_FORMAT.V3,
    "chart37"
  );
  const profile = async (variable: string) => {
    const c = await resolveVariableContext(
      dataset,
      variable,
      new ByteLru<BigInt64Array>(2 ** 20)
    );
    const p = await planAnalysis(
      c,
      {
        version: ALGORITHM_VERSION,
        kind: ANALYSIS_KINDS.PROFILE,
        source: { ref: "memory", versionStatus: "session" },
        variable,
        geometry: { kind: "point", lat: 0, lon: 0 },
        fixed: {},
      },
      new ReadContext()
    );
    return p.execute();
  };
  return profile;
}

it("pairs only the four known depths in two actual Zarr profiles", async () => {
  const read = await fixture();
  const x = await read("left"),
    y = await read("right");
  expect(x.vertical?.physical).toBe(true);
  expect(x.vertical?.values).toEqual([0, NaN, 1, 2, 3]);
  const matched = alignTo(x, y);
  if ("reason" in matched) {
    throw new Error(matched.reason);
  }
  expect(matched.matched).toBe(4);
  expect(matched.values[1]).toBeNaN();
});
it("displays the same air temperature from either Zarr group", async () => {
  const read = await fixture();
  for (const field of ["tas", "anomaly_analysis/tas"]) {
    const x = await read(field);
    expect(x.values[0]).toBe(280);
    const converted = convertResult(x, "degC", "air_temperature");
    expect(converted.values[0]).toBeCloseTo(6.85);
  }
});
