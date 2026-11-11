/* eslint-disable camelcase -- Zarr metadata uses snake_case keys. */
import { expect, it, vi } from "vitest";

import { indexFromIndex } from "@/lib/data/sourceIndexing.ts";

const urlOf = (input: RequestInfo | URL) =>
  input instanceof Request ? input.url : String(input);

const store = "https://hub.example.org/user/x/files/s.zarr";
const index = {
  levels: [
    {
      grid: { store, dataset: "grp" },
      time: { store, dataset: "grp" },
      // a dataset path is joined onto the store URL, where the token must
      // stay the query
      datasources: { tas: { store, dataset: "grp" } },
    },
  ],
};
const zmetadata = {
  zarr_consolidated_format: 1,
  metadata: {
    ".zgroup": { zarr_format: 2 },
    "tas/.zarray": {
      zarr_format: 2,
      shape: [1],
      chunks: [1],
      dtype: "<f4",
      compressor: null,
      filters: null,
      fill_value: 0,
      order: "C",
    },
    "tas/.zattrs": { _ARRAY_DIMENSIONS: ["cell"] },
  },
};

it("tokenizes every store a JSON index names and keeps the token last", async () => {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation((input) => {
      const url = urlOf(input);
      if (url.endsWith("index.json")) {
        return Promise.resolve(new Response(JSON.stringify(index)));
      }
      if (url.includes("/.zmetadata?")) {
        return Promise.resolve(new Response(JSON.stringify(zmetadata)));
      }
      return Promise.resolve(new Response("", { status: 404 }));
    });
  try {
    const sources = await indexFromIndex(
      "https://hub.example.org/user/x/files/index.json",
      (s) => `${s}?_xsrf=T`
    );
    const level = sources.levels[0];
    expect(level.grid.store).toBe(`${store}?_xsrf=T`);
    expect(level.time.store).toBe(`${store}?_xsrf=T`);
    expect(level.datasources.tas.store).toBe(`${store}?_xsrf=T`);
    const storeRequests = fetchMock.mock.calls
      .map((call) => urlOf(call[0]))
      .filter((url) => !url.endsWith("index.json"));
    expect(storeRequests.length).toBeGreaterThan(0);
    for (const url of storeRequests) {
      expect(url).toMatch(
        /^https:\/\/hub\.example\.org\/user\/x\/files\/s\.zarr\/grp\/[^?]+\?_xsrf=T$/
      );
    }
  } finally {
    fetchMock.mockRestore();
  }
});
