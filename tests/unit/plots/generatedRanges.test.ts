/* eslint-disable camelcase -- Zarr metadata uses snake_case keys. */
import { afterEach, expect, it, vi } from "vitest";
import * as zarr from "zarrita";

import { createReferenceStore } from "@/lib/data/referenceStore.ts";

const meta = JSON.stringify({
  zarr_format: 3,
  node_type: "array",
  shape: [2],
  data_type: "uint8",
  chunk_grid: { name: "regular", configuration: { chunk_shape: [1] } },
  chunk_key_encoding: { name: "default" },
  codecs: [{ name: "bytes" }],
  fill_value: 0,
  dimension_names: ["time"],
});

afterEach(() => vi.unstubAllGlobals());

async function read(kind: string, dimension: unknown) {
  const manifest = `https://example.test/temperature-${kind}.json`;
  const data = "https://example.test/data/";
  const spec = {
    version: 1,
    refs: {
      "zarr.json": JSON.stringify({
        zarr_format: 3,
        node_type: "group",
        attributes: {},
      }),
      "t/zarr.json": meta,
    },
    gen: [
      { key: "t/c/{{i}}", url: `${data}{{i}}`, dimensions: { i: dimension } },
    ],
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = new Request(input).url;
    if (url === manifest) {
      return Response.json(spec);
    }
    const k = Number(url.replace(data, ""));
    return new Response(Uint8Array.of([45, 68][k]));
  });
  const store = await createReferenceStore(`reference+${manifest}`, {
    fresh: true,
  });
  const array = await zarr.open(zarr.root(store).resolve("t"), {
    kind: "array",
  });
  return Array.from((await zarr.get(array)).data as Uint8Array);
}

it("expands generated ranges in either direction, as Python's range", async () => {
  expect(await read("ascending", { start: 0, stop: 2, step: 1 })).toEqual([
    45, 68,
  ]);
  expect(await read("descending", { start: 1, stop: -1, step: -1 })).toEqual([
    45, 68,
  ]);
  expect(await read("explicit", [1, 0])).toEqual([45, 68]);
});
