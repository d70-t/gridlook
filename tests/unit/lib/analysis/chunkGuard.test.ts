/**
 * A stored chunk too large to decode is refused before it is fetched, whatever
 * reads it: here a seven-latitude coordinate whose declared chunk pads to
 * 320,000,000 bytes.
 */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

it("refuses an oversized stored chunk before fetching it", async () => {
  const store = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(store), { attributes: {} });
  await zarr.create(zarr.root(store).resolve("lat"), {
    shape: [7],
    chunkShape: [40_000_000],
    dtype: "float64",
    dimensionNames: ["lat"],
    attributes: { units: "degrees_north" },
  });
  const fetched: string[] = [];
  const watched = {
    get(key: string) {
      fetched.push(key);
      return Promise.resolve(store.get(key));
    },
  };
  const dataset = zarrAnalysisDatasetFromStore(
    watched as never,
    "",
    ZARR_FORMAT.V3,
    `guard-${Math.random()}`
  );
  const lat = await dataset.openArray("lat");
  await expect(lat.readChunk([0])).rejects.toThrow(
    /decodes to 305 MiB.*at most 256 MiB per chunk/
  );
  expect(fetched.filter((key) => key.includes("/c/"))).toEqual([]);
});
