/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS, type TAnalysisQuery } from "@/lib/analysis/types.ts";
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

const URL = "https://example.org/CMIP6/MIP/model/exp/r1/Amon/tas/gr/v20180101/";
// eslint-disable-next-line max-lines-per-function -- one fixture, built inline.
async function setup(
  n: number,
  irrelevantBounds: boolean,
  publishedBounds = true
) {
  const main = new Map(),
    fx = new Map(),
    lon = Array.from({ length: n }, (_, i) => i * 0.01),
    controller = new AbortController();
  for (const target of [main, fx]) {
    await zarr.create(zarr.root(target), {
      attributes: target === main ? { external_variables: "areacella" } : {},
    });
    await write(target, "lat", [0, 1], [2], ["lat"], {
      units: "degrees_north",
    });
  }
  await write(main, "lon", lon, [n], ["lon"], { units: "degrees_east" });
  await zarr.create(zarr.root(fx).resolve("lon"), {
    shape: [n],
    chunkShape: [irrelevantBounds ? n : 1],
    dimensionNames: ["lon"],
    dtype: "float64",
    attributes: {
      units: "degrees_east",
      ...(irrelevantBounds && publishedBounds ? { bounds: "lon_b" } : {}),
    },
  });
  if (irrelevantBounds) {
    await zarr.create(zarr.root(fx).resolve("lon_b"), {
      shape: [n, 2],
      chunkShape: [1, 1],
      dimensionNames: ["lon", "nv"],
      dtype: "float64",
    });
  }
  await write(main, "time", [0], [1], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(
    main,
    "tas",
    Array(2 * n).fill(7),
    [1, 2, n],
    ["time", "lat", "lon"],
    { cell_measures: "area: areacella" }
  );
  await zarr.create(zarr.root(fx).resolve("areacella"), {
    shape: [2, n],
    chunkShape: [2, 1],
    dimensionNames: ["lat", "lon"],
    dtype: "float64",
    attributes: { units: "m2" },
    fillValue: 1,
  });
  let reads = 0,
    area = 0,
    latitude = 0,
    bounds = 0;
  const fxStore = {
    get(key: string) {
      const match = key.match(/^\/lon\/c\/(\d+)$/);
      if (match) {
        reads++;
        return new Uint8Array(
          (irrelevantBounds
            ? Float64Array.from(lon)
            : Float64Array.of(lon[Number(match[1])])
          ).buffer
        );
      }
      if (key.startsWith("/lat/c/")) {
        latitude++;
      }
      if (key.startsWith("/lon_b/c/")) {
        bounds++;
      }
      if (key.startsWith("/areacella/c/")) {
        area++;
      }
      return fx.get(key);
    },
  };
  const sib = zarrAnalysisDatasetFromStore(
    fxStore,
    "",
    ZARR_FORMAT.V3,
    "fx-" + Math.random()
  );
  const ds = {
    ...zarrAnalysisDatasetFromStore(
      main,
      "",
      ZARR_FORMAT.V3,
      "main-" + Math.random()
    ),
    location: URL,
    openStore: async () => sib,
  };
  const c = await resolveVariableContext(ds, "tas", new ByteLru(1e6));
  const q: TAnalysisQuery = {
    version: 1,
    kind: ANALYSIS_KINDS.REGION_SERIES,
    geometry: {
      kind: "box",
      south: -0.1,
      north: 0.1,
      west: -0.001,
      east: irrelevantBounds ? 0.001 : 99,
    },
    fixed: {},
    source: { ref: "x", versionStatus: "best-effort" },
    variable: "tas",
    time: { start: 0, stop: 1 },
  };
  const estimate = () =>
    planAnalysis(c, q, new ReadContext(), controller.signal)
      .then((p) => p.estimate)
      .catch(String);
  const phase1 = await estimate();
  const phase2 = await planAnalysis(
    c,
    q,
    new ReadContext(),
    controller.signal,
    true
  )
    .then(async (p) => ({
      estimate: p.estimate,
      value: (await p.execute()).values,
    }))
    .catch(String);
  return {
    n,
    phase1,
    phase2,
    reads,
    area,
    latitude,
    bounds,
  };
}
it("enforces the total geometry-read budget across sibling verification and weighing", async () => {
  // 6,001 checking reads and 6,000 area reads: refused together, before
  // any is made (12,001 were read).
  const r = await setup(6000, false);
  expect(r.reads + r.area + r.latitude).toBe(0);
  expect(String(r.phase2)).toMatch(/12,001 stored chunks/);
});
it("does not refuse an irrelevant sibling bounds variable when the primary has no published bounds", async () => {
  // The check reads no bounds when this grid publishes none: the same
  // mean, 7, as without the unused reference; no bounds chunk read.
  const r = await setup(4096, true);
  const control = await setup(4096, true, false);
  expect(r.phase2).toMatchObject({ value: [7] });
  expect(control.phase2).toMatchObject({ value: [7] });
  expect(r.bounds).toBe(0);
});
