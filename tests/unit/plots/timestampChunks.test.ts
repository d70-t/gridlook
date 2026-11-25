/* eslint-disable max-lines-per-function -- one fixture, built in place. */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

it("reads 8,192 one-stamp time chunks several at a time, in order", async () => {
  const n = 8192;
  const files = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(files));
  const time = await zarr.create(zarr.root(files).resolve("time"), {
    shape: [n],
    chunkShape: [1],
    dtype: "float64",
    dimensionNames: ["time"],
    attributes: { units: "days since 2000-01-01" },
  });
  await zarr.set(time as never, null, {
    data: Float64Array.from({ length: n }, (_, k) => k),
    shape: [n],
    stride: [1],
  } as never);
  for (const [name, shape, dims] of [
    ["lat", [2], ["lat"]],
    ["lon", [2], ["lon"]],
  ] as const) {
    const axis = await zarr.create(zarr.root(files).resolve(name), {
      shape: [...shape],
      chunkShape: [...shape],
      dtype: "float64",
      dimensionNames: [...dims],
      attributes: {
        units: name === "lat" ? "degrees_north" : "degrees_east",
      },
    });
    await zarr.set(axis as never, null, {
      data: Float64Array.of(0, 1),
      shape: [2],
      stride: [1],
    } as never);
  }
  await zarr.create(zarr.root(files).resolve("tas"), {
    shape: [n, 2, 2],
    chunkShape: [n, 2, 2],
    dtype: "float32",
    dimensionNames: ["time", "lat", "lon"],
  });
  let [open, most, reads] = [0, 0, 0];
  const store = {
    async get(key: string) {
      if (/^\/time\/c\/\d+$/.test(key)) {
        reads++;
        open++;
        most = Math.max(most, open);
        await new Promise((resolve) => setTimeout(resolve, 0));
        open--;
      }
      return files.get(key);
    },
  };
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    "stamps43"
  );
  const context = await resolveVariableContext(
    dataset,
    "tas",
    new ByteLru(1e7)
  );
  expect(reads).toBe(n);
  expect(most).toBeGreaterThan(1);
  expect(most).toBeLessThanOrEqual(16);
  const raw = context.time!.raw;
  expect(raw.length).toBe(n);
  expect(raw.every((value, k) => value === k)).toBe(true);
  // Said apart from opening the source: 8,192 chunks of 8 B.
  expect(context.timeArrays?.map((a) => [a.reads, a.bytes])).toEqual([
    [8192, 65536],
  ]);
});
