/**
 * A point series over a store laid out one date per chunk (a "spatial"
 * layout) is refused for its chunk count. The refusal says what one chunk
 * decodes to, so the first dates fill the preview budget, not one chunk.
 */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { sizeRefusal } from "@/lib/analysis/preview.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS, type TAnalysisQuery } from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

// eslint-disable-next-line max-lines-per-function
it("states the size of the stored chunks it refuses", async () => {
  const store = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(store), { attributes: {} });
  const nt = 250_000;
  const axes = [
    ["lat", Float64Array.from({ length: 16 }, (_, i) => -75 + i * 10)],
    ["lon", Float64Array.from({ length: 32 }, (_, j) => -175 + j * 11.25)],
    ["time", Float64Array.from({ length: nt }, (_, t) => t)],
  ] as const;
  const units = {
    lat: "degrees_north",
    lon: "degrees_east",
    time: "hours since 1940-01-01",
  };
  for (const [name, values] of axes) {
    const node = await zarr.create(zarr.root(store).resolve(name), {
      shape: [values.length],
      chunkShape: [values.length],
      dtype: "float64",
      dimensionNames: [name],
      attributes: { units: units[name] },
    });
    await zarr.set(node as never, null, {
      data: values,
      shape: [values.length],
      stride: [1],
    } as never);
  }
  // One whole map per chunk: 16 × 32 float32 = 2 KiB.
  await zarr.create(zarr.root(store).resolve("pv"), {
    shape: [nt, 16, 32],
    chunkShape: [1, 16, 32],
    dtype: "float32",
    dimensionNames: ["time", "lat", "lon"],
    attributes: { units: "K m2 kg-1 s-1" },
  });
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `spatial-${Math.random()}`
  );
  const context = await resolveVariableContext(
    dataset,
    "pv",
    new ByteLru(8 * 2 ** 20)
  );
  const query = {
    version: 1,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    source: { ref: "memory", versionStatus: "session" },
    variable: "pv",
    geometry: { kind: "point", lat: 26.6, lon: -64.4 },
    fixed: {},
  } as unknown as TAnalysisQuery;
  const error = await planAnalysis(context, query, new ReadContext()).then(
    () => undefined,
    (e: Error) => e
  );

  expect(error?.message).toMatch(/250,000 stored chunks \(about 2 KiB each\)/);
  expect(sizeRefusal(error!.message)?.decodedBytes).toBe(250_000 * 2048);
});
