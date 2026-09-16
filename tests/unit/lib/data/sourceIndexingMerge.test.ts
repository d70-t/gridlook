/* eslint-disable camelcase -- Zarr metadata uses snake_case keys. */
import { expect, it, vi } from "vitest";

import { indexFromZarr } from "@/lib/data/sourceIndexing.ts";

it("preserves grouped variables, coordinates, and special keys when merging", async () => {
  const names = [
    "first/temperature",
    "second/temperature",
    "first/cell",
    "second/cell",
    "__proto__",
  ];
  const metadata: Record<string, unknown> = {
    ".zgroup": { zarr_format: 2 },
    ".zattrs": {},
    "first/.zgroup": { zarr_format: 2 },
    "second/.zgroup": { zarr_format: 2 },
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
    metadata[`${name}/.zattrs`] = { _ARRAY_DIMENSIONS: ["cell"] };
  }
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      new Response(JSON.stringify({ zarr_consolidated_format: 1, metadata }))
    );
  try {
    const index = await indexFromZarr("https://example.test/data.zarr");
    const sources = index.levels[0].datasources;
    expect(Object.keys(sources)).toEqual(names);
    expect(sources["first/temperature"].hidden).toBe(false);
    expect(sources["second/temperature"].hidden).toBe(false);
    expect(sources["first/cell"].hidden).toBe(true);
    expect(sources["second/cell"].hidden).toBe(true);
    expect(Object.hasOwn(sources, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(sources)).toBe(Object.prototype);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  } finally {
    fetchMock.mockRestore();
  }
});
