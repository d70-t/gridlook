/* eslint-disable max-lines-per-function, camelcase -- fixture-heavy cases with CF metadata. */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { createPartialAssembler } from "@/lib/analysis/partialUpdates.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import {
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  type TAnalysisResult,
} from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";
import { datesRead } from "@/ui/analysis/readStatus.ts";

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

it("interim49: a cross-section fills in with a count of its chunks", async () => {
  const s = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(s), { attributes: {} });
  const [nt, nk, ny, nx] = [2, 3, 4, 32];
  await put(s, "time", [0, 1], [nt], ["time"], {
    units: "days since 2000-01-01",
  });
  await put(s, "depth", [5, 15, 25], [nk], ["depth"], {
    units: "m",
    positive: "down",
    standard_name: "depth",
  });
  await put(s, "lat", [0, 1, 2, 3], [ny], ["lat"], {
    units: "degrees_north",
  });
  const lons = Array.from({ length: nx }, (_, i) => i);
  await put(s, "lon", lons, [nx], ["lon"], { units: "degrees_east" });
  const data = Array.from({ length: nt * nk * ny * nx }, (_, i) => i % 97);
  await put(
    s,
    "salt",
    data,
    [nt, nk, ny, nx],
    ["time", "depth", "lat", "lon"],
    { units: "1e-3" },
    [1, nk, ny, 1]
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
          { lat: 1, lon: 0 },
          { lat: 1, lon: 31 },
        ],
      },
      fixed: {},
      time: { start: 1, stop: 2 },
      sectionSamples: 64,
    },
    new ReadContext()
  );
  const seen: TAnalysisResult[] = [];
  const assemble = createPartialAssembler((r) => seen.push(structuredClone(r)));
  const result = await planned.execute(undefined, {
    onPartial: assemble,
    publishEveryMs: 1e-9,
  });
  expect(seen.length).toBeGreaterThan(2);
  const counts = seen.map((r) => r.partial!.done);
  expect(counts).toEqual([...counts].sort((a, b) => a - b));
  expect(new Set(seen.map((r) => r.partial!.total))).toEqual(new Set([nx]));
  expect(seen.every((r) => r.partial!.chunks)).toBe(true);
  // Counted as chunks of one date, not as dates read.
  expect(datesRead(seen[0])).toBeUndefined();
  // Filling in: more finite values with each update, then all of them.
  const finite = (r: TAnalysisResult) =>
    r.values.filter(Number.isFinite).length;
  expect(finite(seen.at(-1)!)).toBeGreaterThan(finite(seen[0]));
  expect(result.partial).toBeUndefined();
  expect(finite(result)).toBe(result.values.length);
});
