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
async function setup(n: number, stop: boolean, appears = false) {
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
    chunkShape: [1],
    dimensionNames: ["lon"],
    dtype: "float64",
    attributes: { units: "degrees_east" },
  });
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
  await write(fx, "areacella", Array(2 * n).fill(1), [2, n], ["lat", "lon"], {
    units: "m2",
  });
  let reads = 0,
    area = 0;
  let metadataReads = 0;
  const fxStore = {
    get(key: string) {
      // Absent when priced, published by the time it is checked.
      if (appears && key === "/lon/zarr.json" && ++metadataReads <= 2) {
        return undefined;
      }
      const match = key.match(/^\/lon\/c\/(\d+)$/);
      if (match) {
        reads++;
        if (stop && reads === 1) {
          controller.abort("test stopped");
        }
        return new Uint8Array(Float64Array.of(lon[Number(match[1])]).buffer);
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
      east: 0.001,
    },
    fixed: {},
    source: { ref: "x", versionStatus: "best-effort" },
    variable: "tas",
    time: { start: 0, stop: 1 },
  };
  const out = await planAnalysis(c, q, new ReadContext(), controller.signal)
    .then((p) => p.estimate)
    .catch((e) => String(e));
  return { n, reads, area, out };
}
it("prices fixed-field equivalence before crossing its coordinate-read ceiling", async () => {
  const r = await setup(8193, false);
  expect(r.reads).toBeLessThanOrEqual(8192);
});
it("stops comparing coordinates when its sole plot cancels", async () => {
  const r = await setup(128, true);
  expect(r.reads).toBeLessThan(128);
});
it("interim48: a sibling coordinate published between its price and its check is not read unpriced", async () => {
  const r = await setup(8193, false, true);
  expect(r.reads).toBe(0);
});
