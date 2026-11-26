/* eslint-disable max-lines-per-function, camelcase -- inline fixtures with CF keys. */
/**
 * 135,000 tiles under one primary chunk overflowed the stack and were all
 * queued at once; a one-cell selection under a 256 × 256 primary tile was
 * refused at 1,025 MiB for partner tiles it never visits.
 */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import {
  ReadContext,
  type TAnalysisArray,
  type TStoredChunk,
} from "@/lib/analysis/chunkVisitor.ts";
import { jointArray } from "@/lib/analysis/jointComponents.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS } from "@/lib/analysis/types.ts";
import { buildValueCodec } from "@/lib/analysis/valueDecoding.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

function fake(
  key: string,
  shape: number[],
  chunks: number[],
  onRead: () => void
): TAnalysisArray {
  return {
    key,
    shape,
    chunks,
    dtype: "float64",
    attrs: {},
    dimensionNames: ["time", "lat", "lon"],
    fillValue: Number.NaN,
    async readChunk(): Promise<TStoredChunk> {
      onRead();
      await Promise.resolve();
      const n = chunks.reduce((p, c) => p * c, 1);
      return {
        absent: false,
        data: new Float64Array(n).fill(1),
        shape: chunks,
        stride: chunks.map((_, d) =>
          chunks.slice(d + 1).reduce((p, c) => p * c, 1)
        ),
      };
    },
  } as TAnalysisArray;
}

it("reads 135,424 partner tiles of one chunk a few at a time, without a stack overflow", async () => {
  const n = 368;
  let [open, most] = [0, 0];
  const u = fake("u", [1, n, n], [1, n, n], () => {});
  const v = fake("v", [1, n, n], [1, 1, 1], () => {
    open++;
    most = Math.max(most, open);
    void Promise.resolve().then(() => open--);
  });
  const codec = buildValueCodec({}, Number.NaN, "float64", ZARR_FORMAT.V3);
  const joined = jointArray(
    u,
    v,
    codec,
    new ReadContext(undefined, 2 ** 20),
    { chunkReads: 0 } as never,
    {
      runs: [[[0, 1]], [[0, n]], [[0, n]]],
      timeAxis: 0,
      rows: Int32Array.of(0),
    }
  );
  const chunk = await joined.readChunk([0, 0, 0]);
  expect(chunk.missingAt?.([0, 5, 7])).toBe(false);
  expect(most).toBeLessThanOrEqual(8);
}, 60_000);

it("plans one cell under a 256 × 256 tile with a partner chunked along time", async () => {
  const store = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(store), { attributes: {} });
  const axis = async (
    name: string,
    length: number,
    attrs: Record<string, unknown>
  ) => {
    const a = await zarr.create(zarr.root(store).resolve(name), {
      shape: [length],
      chunkShape: [length],
      dtype: "float64",
      dimensionNames: [name],
      attributes: attrs,
    });
    await zarr.set(a as never, null, {
      data: Float64Array.from({ length }, (_, k) =>
        name === "time" ? k : -60 + k * 0.25
      ),
      shape: [length],
      stride: [1],
    } as never);
  };
  await axis("time", 2048, { units: "days since 2000-01-01" });
  await axis("lat", 256, { units: "degrees_north" });
  await axis("lon", 256, { units: "degrees_east" });
  for (const [name, chunkShape] of [
    ["uo", [1, 256, 256]],
    ["vo", [2048, 1, 1]],
  ] as const) {
    await zarr.create(zarr.root(store).resolve(name), {
      shape: [2048, 256, 256],
      chunkShape: [...chunkShape],
      dtype: "float64",
      dimensionNames: ["time", "lat", "lon"],
      attributes: {
        units: "m s-1",
        standard_name:
          name === "uo"
            ? "eastward_sea_water_velocity"
            : "northward_sea_water_velocity",
      },
      fillValue: Number.NaN as never,
    });
  }
  const ds = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    "one-cell-partner"
  );
  const describe = (name: string) =>
    resolveVariableContext(ds, name, new ByteLru<BigInt64Array>(2 ** 20));
  const [u, v] = await Promise.all([describe("uo"), describe("vo")]);
  const planned = await planAnalysis(
    u,
    {
      version: 1,
      kind: ANALYSIS_KINDS.REGION_SERIES,
      geometry: { kind: "box", south: 0, north: 0.1, west: 0, east: 0.1 },
      fixed: {},
      source: { ref: "x", versionStatus: "best-effort" },
      variable: "uo",
      time: { start: 0, stop: 1 },
      jointWith: "vo",
    },
    new ReadContext(),
    undefined,
    false,
    v
  );
  expect(planned.estimate.chunks).toBe(2);
  expect(planned.estimate.workingBytes).toBeLessThan(64 * 2 ** 20);
});

it("review of interim45: a stopped joint read keeps its reservation until its own read settles", async () => {
  // The primary's read ignores the stop and ends when released.
  let releaseOwn!: () => void;
  const ownDone = new Promise<void>((resolve) => {
    releaseOwn = resolve;
  });
  const u = {
    ...fake("u2", [1, 2, 2], [1, 2, 2], () => {}),
    async readChunk(): Promise<TStoredChunk> {
      await ownDone;
      return {
        absent: false,
        data: new Float64Array(4).fill(1),
        shape: [1, 2, 2],
        stride: [4, 2, 1],
      };
    },
  } as TAnalysisArray;
  const v = fake("v2", [1, 2, 2], [1, 2, 2], () => {});
  const codec = buildValueCodec({}, Number.NaN, "float64", ZARR_FORMAT.V3);
  const read = new ReadContext(undefined, 2 ** 20);
  const joined = jointArray(u, v, codec, read, { chunkReads: 0 } as never, {
    runs: [[[0, 1]], [[0, 2]], [[0, 2]]],
    timeAxis: 0,
    rows: Int32Array.of(0),
  });
  const stop = new AbortController();
  let backend: Promise<unknown> | undefined;
  const reading = read.read(
    joined,
    [0, 0, 0],
    { chunkReads: 0 } as never,
    stop.signal,
    (s) => {
      backend = s;
    }
  );
  await new Promise((resolve) => setTimeout(resolve, 0));
  stop.abort(new Error("stopped"));
  await expect(reading).rejects.toThrow();
  // Told of its backend, which has not settled while the own read runs.
  expect(backend).toBeDefined();
  let settled = false;
  void backend!.then(() => (settled = true));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(false);
  releaseOwn();
  await new Promise((resolve) => setTimeout(resolve, 0));
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(settled).toBe(true);
});

it("interim48: a failed own tile ends the partner reads, and backends hold no tile", async () => {
  const n = 64;
  let partnerReads = 0;
  const u = {
    ...fake("u3", [1, 1, n], [1, 1, n], () => {}),
    async readChunk(): Promise<TStoredChunk> {
      throw new Error("HTTP 503");
    },
  } as TAnalysisArray;
  const v = fake("v3", [1, 1, n], [1, 1, 1], () => partnerReads++);
  const codec = buildValueCodec({}, Number.NaN, "float64", ZARR_FORMAT.V3);
  const read = new ReadContext(undefined, 1);
  const joined = jointArray(u, v, codec, read, { chunkReads: 0 } as never, {
    runs: [[[0, 1]], [[0, 1]], [[0, n]]],
    timeAxis: 0,
    rows: Int32Array.of(0),
  });
  await expect(joined.readChunk([0, 0, 0])).rejects.toThrow("503");
  expect(partnerReads).toBeLessThanOrEqual(8);
  // What a reader is told to wait for settles to nothing, not the chunk.
  const told: Promise<unknown>[] = [];
  await read.read(v, [0, 0, 5], { chunkReads: 0 } as never, undefined, (s) =>
    told.push(s)
  );
  expect(await Promise.all(told)).toEqual([undefined]);
});
