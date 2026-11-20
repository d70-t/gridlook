/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
/* eslint-disable max-lines-per-function -- fixtures build small stores inline. */
import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import { resultToCsv } from "@/lib/analysis/analysisExport.ts";
import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import {
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  type TAnalysisQuery,
} from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;
const DEGREE_M = 111195.08;

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
    chunkShape: shape.map((n) => Math.min(n, 64)),
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

/** A bounded 1° grid over the given longitudes, two rows about the equator. */
async function surface(
  lons: number[],
  value: (j: number, k: number) => number,
  levels = 0
) {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  const lats = [-0.5, 0.5];
  await write(store, "lat", lats, [2], ["lat"], {
    units: "degrees_north",
    bounds: "lat_bnds",
  });
  await write(
    store,
    "lat_bnds",
    lats.flatMap((v) => [v - 0.5, v + 0.5]),
    [2, 2],
    ["lat", "nv"]
  );
  await write(store, "lon", lons, [lons.length], ["lon"], {
    units: "degrees_east",
    bounds: "lon_bnds",
  });
  await write(
    store,
    "lon_bnds",
    lons.flatMap((v) => [v - 0.5, v + 0.5]),
    [lons.length, 2],
    ["lon", "nv"]
  );
  if (levels) {
    await write(
      store,
      "depth",
      Array.from({ length: levels }, (_, k) => 10 * (k + 1)),
      [levels],
      ["depth"],
      { units: "m", positive: "down", standard_name: "depth" }
    );
  }
  const nk = Math.max(1, levels);
  const data: number[] = [];
  for (let k = 0; k < nk; k++) {
    for (let i = 0; i < 2; i++) {
      lons.forEach((_, j) => data.push(value(j, k)));
    }
  }
  await write(
    store,
    "sst",
    data,
    levels ? [levels, 2, lons.length] : [2, lons.length],
    levels ? ["depth", "lat", "lon"] : ["lat", "lon"],
    { units: "degC" }
  );
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `surface-${lons.length}-${levels}-${Math.random()}`
  );
  return resolveVariableContext(dataset, "sst", new ByteLru(2 ** 20));
}

function section(
  vertices: { lat: number; lon: number }[],
  samples: number
): TAnalysisQuery {
  return {
    version: ALGORITHM_VERSION,
    kind: ANALYSIS_KINDS.SECTION,
    source: { ref: "memory", versionStatus: "session" },
    variable: "sst",
    geometry: { kind: "polyline", vertices },
    fixed: {},
    sectionSamples: samples,
  };
}

async function run(
  context: Awaited<ReturnType<typeof surface>>,
  q: TAnalysisQuery
) {
  const planned = await planAnalysis(context, q, new ReadContext());
  return planned.execute();
}

const transect = [
  { lat: 0, lon: 0 },
  { lat: 0, lon: 1 },
  { lat: 0, lon: 2 },
];

describe("cross-sections without levels", () => {
  it("an equatorial surface transect gives one value per sample", async () => {
    const context = await surface([0, 1, 2, 3], (j) => [2, 5, 9, 11][j]);
    expect(context.capabilities[ANALYSIS_KINDS.SECTION].available).toBe(true);
    expect(context.capabilities[ANALYSIS_KINDS.PROFILE]).toMatchObject({
      available: false,
      reason: expect.stringMatching(/vertical/),
    });
    const result = await run(context, section(transect, 3));
    expect(result.sectionMode).toBe("path");
    expect(result.shape).toEqual([3]);
    expect(result.dims).toEqual(["sample"]);
    expect(result.vertical).toBeUndefined();
    expect(result.values).toEqual([2, 5, 9]);
    const distances = result.samples!.distances;
    expect(distances[0]).toBe(0);
    expect(distances[1]).toBeCloseTo(DEGREE_M, 1);
    expect(distances[2]).toBeCloseTo(2 * DEGREE_M, 1);
    expect(result.samples!.status).toEqual(["ok", "ok", "ok"]);
    const lines = resultToCsv(result).trim().split("\n");
    expect(lines).toHaveLength(4);
    expect(lines[0]).toBe("sample,distance_m,lat,lon,cell,sst (degC),status");
    expect(lines[2].endsWith(",5,ok")).toBe(true);
    // The quoted cell id stays one field.
    expect(lines[2]).toContain('"1,1"');
  });

  it("a masked midpoint is a gap in values, status and CSV", async () => {
    const context = await surface([0, 1, 2, 3], (j) =>
      j === 1 ? Number.NaN : [2, 5, 9, 11][j]
    );
    const result = await run(context, section(transect, 3));
    expect(result.values[0]).toBe(2);
    expect(result.values[1]).toBeNaN();
    expect(result.values[2]).toBe(9);
    expect(result.samples!.status).toEqual(["ok", "missing", "ok"]);
    const row = resultToCsv(result).trim().split("\n")[2];
    expect(row.endsWith(",,missing")).toBe(true);
  });

  it("works across ±180°, on a revisit and outside the grid", async () => {
    const lons = Array.from({ length: 360 }, (_, j) => j + 0.5);
    const context = await surface(lons, (j) => j);
    const across = await run(
      context,
      section(
        [
          { lat: 0, lon: 179.2 },
          { lat: 0, lon: -179.8 },
        ],
        3
      )
    );
    expect(across.values).toEqual([179, 179, 180]);
    expect(across.samples!.distances[2]).toBeCloseTo(DEGREE_M, 1);
    const revisit = await run(
      context,
      section(
        [
          { lat: 0, lon: 10.2 },
          { lat: 0, lon: 11.2 },
          { lat: 0, lon: 10.2 },
        ],
        3
      )
    );
    expect(revisit.values).toEqual([10, 11, 10]);
    // Two rows about the equator: a path to 5°N leaves the grid.
    const leaving = await run(
      context,
      section(
        [
          { lat: 0, lon: 20.2 },
          { lat: 5, lon: 20.2 },
        ],
        3
      )
    );
    expect(leaving.values[0]).toBe(20);
    expect(leaving.samples!.status.slice(1)).toEqual([
      "no stored cell",
      "no stored cell",
    ]);
  });

  it("rejects paths without a direction and collapses repeated points", async () => {
    const context = await surface([0, 1, 2, 3], (j) => j);
    await expect(
      run(
        context,
        section(
          [
            { lat: 0, lon: 1 },
            { lat: 0, lon: 1 },
          ],
          3
        )
      )
    ).rejects.toThrow(/two distinct points/);
    await expect(
      run(
        context,
        section(
          [
            { lat: 0, lon: 0 },
            { lat: 0, lon: 180 },
          ],
          3
        )
      )
    ).rejects.toThrow(/opposite/);
    const repeated = await run(
      context,
      section([transect[0], transect[0], transect[1], transect[2]], 3)
    );
    expect(repeated.samples!.vertices).toHaveLength(3);
    expect(repeated.values).toEqual([0, 1, 2]);
  });

  it("the same path on a two-level field is a [3, 2] curtain", async () => {
    const context = await surface(
      [0, 1, 2, 3],
      (j, k) => 100 * k + [2, 5, 9, 11][j],
      2
    );
    const result = await run(context, section(transect, 3));
    expect(result.sectionMode).toBe("curtain");
    expect(result.shape).toEqual([3, 2]);
    expect(result.values).toEqual([2, 102, 5, 105, 9, 109]);
    const lines = resultToCsv(result).trim().split("\n");
    expect(lines).toHaveLength(7);
    expect(lines[0]).toContain("level_index");
  });
});
