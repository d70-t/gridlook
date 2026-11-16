/* eslint-disable camelcase */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

it("a failed group metadata read is not taken for no attributes (review of interim37)", async () => {
  const store = new Map<string, Uint8Array>();
  await zarr.create(zarr.root(store), {
    attributes: { dggs: { name: "healpix", refinement_level: 0 } },
  });
  let failures = 1;
  const flaky = {
    get(key: string) {
      if (key.endsWith("zarr.json") && failures > 0) {
        failures--;
        return Promise.reject(new Error("HTTP 503 Service Unavailable"));
      }
      return Promise.resolve(store.get(key));
    },
  };
  const dataset = zarrAnalysisDatasetFromStore(
    flaky as never,
    "",
    ZARR_FORMAT.V3,
    `flaky-${Math.random()}`
  );
  await expect(dataset.groupAttrs("")).rejects.toThrow(/503/);
  // Recovered: the attributes are there.
  expect(await dataset.groupAttrs("")).toMatchObject({
    dggs: { refinement_level: 0 },
  });
  // A group that is not there still has none.
  expect(await dataset.groupAttrs("absent")).toBe(null);
});
