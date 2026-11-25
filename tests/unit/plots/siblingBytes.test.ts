/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS, type TPlanEstimate } from "@/lib/analysis/types.ts";
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

// eslint-disable-next-line max-lines-per-function
async function run(chunk: number, temporaryPricingOutage = false) {
  const main: TStore = new Map(),
    fixed: TStore = new Map();
  for (const st of [main, fixed]) {
    await zarr.create(zarr.root(st), {
      attributes: st === main ? { external_variables: "areacella" } : {},
    });
  }
  for (const axis of ["lat", "lon"]) {
    const units = axis === "lat" ? "degrees_north" : "degrees_east";
    await write(main, axis, [0, 1], [2], [axis], { units });
    const a = await zarr.create(zarr.root(fixed).resolve(axis), {
      shape: [2],
      chunkShape: [chunk],
      dimensionNames: [axis],
      dtype: "float64",
      attributes: { units },
      fillValue: NaN as never,
    });
    if (chunk < 1e6) {
      await zarr.set(a as never, null, {
        data: Float64Array.from([0, 1]),
        shape: [2],
        stride: [1],
      } as never);
    }
  }
  await write(main, "time", [0], [1], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(main, "tas", [7, 7, 7, 7], [1, 2, 2], ["time", "lat", "lon"], {
    cell_measures: "area: areacella",
  });
  await write(fixed, "areacella", [1, 1, 1, 1], [2, 2], ["lat", "lon"], {
    units: "m2",
  });
  const reads: string[] = [];
  let coordBytes = 0;
  const metadataAttempts = new Map<string, number>();
  const sibling = zarrAnalysisDatasetFromStore(
    {
      get(key: string) {
        if (temporaryPricingOutage && /^\/(lat|lon)\/zarr\.json$/.test(key)) {
          const n = metadataAttempts.get(key) ?? 0;
          metadataAttempts.set(key, n + 1);
          if (n < 2) {
            throw new Error("503 Service Unavailable");
          }
        }
        if (/^\/(lat|lon)\/c\//.test(key)) {
          reads.push(key);
          if (chunk >= 1e6) {
            throw new Error("instrumented stop before large sibling chunk");
          }
          coordBytes += fixed.get(key)?.length ?? 0;
        }
        return fixed.get(key);
      },
    } as never,
    "",
    ZARR_FORMAT.V3,
    "fx" + chunk
  );
  const ds = {
    ...zarrAnalysisDatasetFromStore(
      main as never,
      "",
      ZARR_FORMAT.V3,
      "data" + chunk
    ),
    location: URL,
    openStore: async () => sibling,
  };
  const ctx = await resolveVariableContext(ds, "tas", new ByteLru(1e6));
  const q = {
    version: 1,
    kind: ANALYSIS_KINDS.REGION_SERIES,
    geometry: { kind: "box", south: -1, north: 2, west: -1, east: 2 },
    fixed: {},
    source: { ref: "x", versionStatus: "best-effort" },
    variable: "tas",
  };
  const estimate = (await planAnalysis(ctx, q as never, new ReadContext())
    .then((p) => p.estimate)
    .catch(String)) as TPlanEstimate;
  return { chunk, coordBytes, reads, estimate, metadataAttempts };
}
it("prices verification by bytes as well as request count", async () => {
  const small = await run(32768),
    large = await run(5 * 2 ** 20);
  // Two padded chunks of 32,768 values: 512 KiB decoded, priced (it was
  // 64 bytes); and two of 40 MiB are asked about before any is read.
  expect(small.estimate.decodedBytes).toBeGreaterThanOrEqual(small.coordBytes);
  expect(large.reads.length).toBe(0);
  expect(large.estimate.needsConfirmation).toBe(true);
});

it("keeps unpriced sibling payloads behind the confirmation if their metadata recovers", async () => {
  const result = await run(5 * 2 ** 20, true);
  expect(result.metadataAttempts.get("/lat/zarr.json")).toBeGreaterThan(0);
  expect(result.reads).toEqual([]);
});

it("independent review of interim45: a sibling chunk past the per-chunk limit is refused before confirmation", async () => {
  // 576 MiB a chunk: 72 Mi float64 values.
  const result = await run(72 * 2 ** 20);
  expect(result.reads).toEqual([]);
  expect(String(result.estimate)).toMatch(
    /576 MiB; plots read at most 256 MiB per chunk/
  );
});
