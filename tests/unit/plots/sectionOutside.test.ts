/* eslint-disable max-lines-per-function, camelcase -- fixture-heavy cases with CF metadata. */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { resultTable } from "@/lib/analysis/analysisExport.ts";
import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext, ReadLimiter } from "@/lib/analysis/chunkVisitor.ts";
import { createPartialAssembler } from "@/lib/analysis/partialUpdates.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { exportModel } from "@/lib/analysis/scientificExport.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import {
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  type TAnalysisResult,
  type TPartialUpdate,
} from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

async function put(
  s: Map<string, Uint8Array>,
  name: string,
  data: number[],
  shape: number[],
  dims: string[],
  attrs: Record<string, unknown>,
  chunks = shape
) {
  const a = await zarr.create(zarr.root(s).resolve(name), {
    shape,
    chunkShape: chunks,
    dtype: "float64",
    dimensionNames: dims,
    attributes: attrs,
    fillValue: Number.NaN,
  });
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((p, n) => p * n, 1)
  );
  await zarr.set(a, null, { data: Float64Array.from(data), shape, stride });
}

it("a stopped section flags stations outside the grid as no stored cell", async () => {
  const s = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(s), { attributes: {} });
  const [nt, nk, ny, nx] = [2, 12, 4, 5];
  await put(s, "time", [0, 1], [nt], ["time"], {
    units: "days since 2000-01-01",
  });
  await put(
    s,
    "depth",
    Array.from({ length: nk }, (_, i) => i * 5),
    [nk],
    ["depth"],
    {
      units: "m",
      positive: "down",
      standard_name: "depth",
    }
  );
  await put(s, "lat", [0, 1, 2, 3], [ny], ["lat"], {
    units: "degrees_north",
  });
  const lons = Array.from({ length: nx }, (_, i) => i);
  await put(s, "lon", lons, [nx], ["lon"], { units: "degrees_east" });
  const data = Array.from({ length: nt * nk * ny * nx }, (_, i) =>
    Math.floor(i / (ny * nx)) % nk === 0 && i % nx === 2 ? NaN : i % 97
  );
  await put(
    s,
    "salt",
    data,
    [nt, nk, ny, nx],
    ["time", "depth", "lat", "lon"],
    { units: "1e-3" },
    [1, 1, ny, nx]
  );
  const ctx = await resolveVariableContext(
    zarrAnalysisDatasetFromStore(s as never, "", ZARR_FORMAT.V3, "sect49"),
    "salt",
    new ByteLru(2 ** 20)
  );
  const planned = await planAnalysis(
    ctx,
    {
      version: ALGORITHM_VERSION,
      kind: ANALYSIS_KINDS.SECTION,
      source: { ref: "memory", versionStatus: "session" },
      variable: "salt",
      geometry: {
        kind: "polyline",
        vertices: [
          { lat: 1, lon: -4 },
          { lat: 1, lon: 4 },
        ],
      },
      fixed: {},
      time: { start: 1, stop: 2 },
      sectionSamples: 9,
    },
    new ReadContext(new ReadLimiter(1))
  );
  const updates: TPartialUpdate[] = [];
  const seen: TAnalysisResult[] = [];
  const assemble = createPartialAssembler((r) => seen.push(structuredClone(r)));
  const result = await planned.execute(undefined, {
    onPartial: (update) => {
      updates.push(update);
      assemble(update);
    },
    publishEveryMs: 1e-9,
  });
  const partial = seen[0];
  function row(r: TAnalysisResult) {
    const model = exportModel(r),
      z = resultTable(r);
    const k = r.samples!.status.findIndex((s) => s === "no stored cell");
    expect(k).toBeGreaterThanOrEqual(0);
    const i = k * r.shape[1];
    const status = model.arrays.find((a) => a.name === "status")!
      .data as Int32Array;
    const station = model.arrays.find((a) => a.name === "sample_status")!
      .data as Int32Array;
    return {
      pathIndex: k,
      zarrCell: status[i],
      zarrStation: station[k],
      csv: z.row(i)[z.header.indexOf("status")],
      geo: r.samples!.status[k],
    };
  }
  const paused = row(partial),
    done = row(result);
  // Paused and finished alike, in Zarr cell and station flags and CSV.
  expect(paused).toEqual(done);
});
