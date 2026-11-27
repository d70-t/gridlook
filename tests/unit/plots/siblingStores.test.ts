import { afterEach, expect, it, vi } from "vitest";

import {
  openZarrAnalysisDataset,
  releaseStoresOf,
} from "@/lib/analysis/sourceAdapter.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

afterEach(() => {
  vi.restoreAllMocks();
});

it("independent review of interim45: a fixed-field store goes with the last source using it", async () => {
  vi.spyOn(ZarrDataManager, "createNewStore").mockImplementation(
    async () => new Map() as never
  );
  const open = (name: string) =>
    openZarrAnalysisDataset(
      { store: `https://example.org/${name}.zarr`, dataset: "" },
      ZARR_FORMAT.V3
    );
  const [a, b] = [await open("a"), await open("b")];
  const fixed = "https://example.org/fx-shared.zarr";
  const sibling = await a.openStore!(fixed);
  expect(await b.openStore!(fixed)).toBe(sibling);
  // The first released: the second still uses it.
  expect(await releaseStoresOf(a.key)).toEqual([]);
  expect(await b.openStore!(fixed)).toBe(sibling);
  // The last released: it is let go, and opened afresh after.
  expect(await releaseStoresOf(b.key)).toEqual([sibling]);
  const c = await open("c");
  expect(await c.openStore!(fixed)).not.toBe(sibling);
});
