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

async function read(kind: string, dimension: unknown, index = "i") {
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
      {
        key: "t/c/{{i}}",
        url: `${data}{{ ${index} }}`,
        dimensions: { i: dimension },
      },
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

it("expands arithmetic in generated fields in either direction", async () => {
  for (const index of ["i + 0", "(i * 3) // 3", "2 * i - i"]) {
    expect(
      await read("math", { start: 1, stop: -1, step: -1 }, index),
      index
    ).toEqual([45, 68]);
  }
});

it("refuses a generator with a step of zero", async () => {
  await expect(read("zero", { start: 1, stop: -1, step: 0 })).rejects.toThrow(
    /step of 0/
  );
});

// eslint-disable-next-line max-lines-per-function
it("names generated objects and offsets as Python evaluates their templates", async () => {
  const root = "https://example.test/";
  const objects: Record<string, number[]> = {
    "run0.0": [45, 68],
    "run1.0": [45, 68],
    run0: [97, 98],
    run1: [97, 98],
    run00: [45, 68],
    run01: [45, 68],
    file: [45, 68],
  };
  for (const [name, dimension, url, offset] of [
    ["division", { start: 0, stop: 2, step: 1 }, "run{{ i / 1 }}", "{{i}}"],
    [
      "format",
      { start: 1, stop: -1, step: -1 },
      'run{{ "%02d" | format(i) }}',
      "{{i}}",
    ],
    [
      "large",
      { start: 0, stop: 2, step: 1 },
      "file",
      "{{ (1700000000000000000 + i) - 1700000000000000000 }}",
    ],
  ] as const) {
    const manifest = `${root}${name}.json`;
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const request = new Request(input);
      if (request.url === manifest) {
        return Response.json({
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
            {
              key: "t/c/{{i}}",
              url: root + url,
              dimensions: { i: dimension },
              offset,
              length: "1",
            },
          ],
        });
      }
      const row = objects[request.url.slice(root.length)];
      const [, a] = /^bytes=(\d+)-/.exec(request.headers.get("Range")!)!;
      return new Response(Uint8Array.of(row[Number(a)]), {
        status: 206,
        headers: { "Content-Range": `bytes ${a}-${a}/2` },
      });
    });
    const store = await createReferenceStore(`reference+${manifest}`, {
      fresh: true,
    });
    const array = await zarr.open(zarr.root(store).resolve("t"), {
      kind: "array",
    });
    expect(
      Array.from((await zarr.get(array)).data as Uint8Array),
      name
    ).toEqual([45, 68]);
  }
});
