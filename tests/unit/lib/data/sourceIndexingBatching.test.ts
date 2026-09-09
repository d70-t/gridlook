/* eslint-disable camelcase -- Zarr metadata uses snake_case keys. */
import { expect, it, vi } from "vitest";
import * as zarr from "zarrita";

import { indexFromZarr } from "@/lib/data/sourceIndexing.ts";

function metadataResponse(names: string[]) {
  const metadata: Record<string, unknown> = {
    ".zgroup": { zarr_format: 2 },
    ".zattrs": {},
  };
  for (const name of names) {
    metadata[`${name}/.zarray`] = {
      zarr_format: 2,
      shape: [1],
      chunks: [1],
      dtype: "<f4",
      compressor: null,
      filters: null,
      fill_value: 0,
      order: "C",
    };
    metadata[`${name}/.zattrs`] = {
      _ARRAY_DIMENSIONS: ["cell"],
      ...(name === names.at(-1) ? { coordinates: "coordinate" } : {}),
    };
  }
  return new Response(
    JSON.stringify({ zarr_consolidated_format: 1, metadata })
  );
}

it("yields during indexing and resolves coordinates referenced by later batches", async () => {
  const names = [
    "group/coordinate",
    ...Array.from({ length: 400 }, (_, index) => `group/variable${index}`),
  ];
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(metadataResponse(names));
  const openSpy = vi.spyOn(zarr.open, "v2");
  try {
    const openedAtYield = new Promise<number>((resolve) => {
      setTimeout(() => {
        resolve(
          openSpy.mock.calls.filter(([, options]) => options?.kind === "array")
            .length
        );
      }, 0);
    });
    const loading = indexFromZarr("https://example.test/data.zarr");
    const opened = await openedAtYield;
    const index = await loading;

    expect(opened).toBeGreaterThan(0);
    expect(opened).toBeLessThan(names.length);
    const sources = index.levels[0].datasources;
    expect(Object.keys(sources)).toEqual(names);
    expect(sources["group/coordinate"].hidden).toBe(true);
    expect(sources["group/variable399"].hidden).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    openSpy.mockRestore();
    fetchMock.mockRestore();
  }
});
