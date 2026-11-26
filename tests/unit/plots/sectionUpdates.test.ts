/* eslint-disable max-lines-per-function, camelcase -- fixture-heavy cases with CF metadata. */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { resultTable } from "@/lib/analysis/analysisExport.ts";
import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import {
  freezeResult,
  createPartialAssembler,
} from "@/lib/analysis/partialUpdates.ts";
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
import { partialText } from "@/ui/analysis/plotFigure.ts";

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

it("a cross-section's updates carry only newly read cells", async () => {
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
  expect(updates.length).toBeGreaterThan(2);
  // Every value sent at most once over all updates.
  const sent = updates.reduce(
    (sum, u) => sum + u.values.length + (u.cells?.at.length ?? 0),
    0
  );
  expect(sent).toBeLessThanOrEqual(result.values.length);
  // What was assembled agrees with the final values where it arrived.
  const last = seen.at(-1)!;
  last.values.forEach((v, at) => {
    if (last.cellRead![at]) {
      expect(v).toBe(result.values[at]);
    } else {
      expect(Number.isNaN(v)).toBe(true);
    }
  });
  // Stopped early: chunks counted, and unread cells marked so.
  const early = seen[0];
  expect(early.cellRead!.some((r) => !r)).toBe(true);
  expect(partialText(early)).toMatch(/^Partial: \d+ of 32 chunks read/);
  const table = resultTable(early);
  const status = table.header.indexOf("status");
  const unread = early.cellRead!.findIndex((r) => !r);
  expect(table.row(unread)[status]).toBe("not read");
  // The scientific download says the same, cell by cell and per station.
  const model = exportModel(early);
  const cells = model.arrays.find((a) => a.name === "status")!;
  const flags = Array.from(cells.data as Int32Array);
  const notRead = early.cellRead!.filter((r) => !r).length;
  expect(flags.filter((f) => f === flags[unread]).length).toBe(notRead);
  const stations = model.arrays.find((a) => a.name === "sample_status")!;
  const finiteAt = early.values.findIndex(Number.isFinite);
  const levels = early.shape[1];
  expect((stations.data as Int32Array)[Math.floor(finiteAt / levels)]).toBe(0);
  // A frozen copy keeps its arrival mask when the live one changes.
  const frozen = freezeResult(early);
  early.cellRead!.fill(1);
  expect(frozen.cellRead!.some((r) => !r)).toBe(true);
});
