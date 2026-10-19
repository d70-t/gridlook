import { afterEach, describe, expect, it, vi } from "vitest";
import * as zarr from "zarrita";

import {
  createReferenceStore,
  expandTemplates,
  isReferenceStorePath,
  referenceContents,
  splitReferenceStoreAndGroup,
} from "@/lib/data/referenceStore.ts";

const GROUP = JSON.stringify({
  zarr_format: 3, // eslint-disable-line camelcase
  node_type: "group", // eslint-disable-line camelcase
  attributes: { title: "refs" },
});
const ARRAY = JSON.stringify({
  zarr_format: 3, // eslint-disable-line camelcase
  node_type: "array", // eslint-disable-line camelcase
  shape: [4],
  data_type: "uint8", // eslint-disable-line camelcase
  chunk_grid: { name: "regular", configuration: { chunk_shape: [2] } }, // eslint-disable-line camelcase
  chunk_key_encoding: { name: "default" }, // eslint-disable-line camelcase
  codecs: [{ name: "bytes" }],
  fill_value: 0, // eslint-disable-line camelcase
  dimension_names: ["cells"], // eslint-disable-line camelcase
});

function spec() {
  return {
    version: 1,
    templates: { a: "https://example.org/cell_1.zarr" },
    refs: {
      "zarr.json": GROUP,
      "g/zarr.json": GROUP,
      "g/x/zarr.json": ARRAY,
      "g/x/c/0": "base64:AQI=",
      "g/x/c/1": ["{{a}}/x/c/0", 10, 2],
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("reference store paths", () => {
  it("recognizes the reference+ prefix", () => {
    expect(isReferenceStorePath("reference+https://h/r.json")).toBe(true);
    expect(isReferenceStorePath("https://h/r.json")).toBe(false);
  });

  it("splits the reference file from the group", () => {
    expect(
      splitReferenceStoreAndGroup("reference+https://h/r.json/a/b/")
    ).toEqual({ storePath: "reference+https://h/r.json", groupPath: "a/b" });
    expect(splitReferenceStoreAndGroup("reference+https://h/r.json")).toEqual({
      storePath: "reference+https://h/r.json",
      groupPath: "",
    });
  });
});

describe("expandTemplates", () => {
  it("substitutes plain templates and drops them", () => {
    const out = expandTemplates(spec());
    expect(out.templates).toBeUndefined();
    expect(out.refs?.["g/x/c/1"]).toEqual([
      "https://example.org/cell_1.zarr/x/c/0",
      10,
      2,
    ]);
    expect(out.refs?.["g/x/c/0"]).toBe("base64:AQI=");
  });

  it("leaves specs with gen entries or unknown templates to the library", () => {
    const withGen = {
      ...spec(),
      gen: [{ key: "k", url: "u", dimensions: {} }],
    };
    expect(expandTemplates(withGen)).toBe(withGen);
    const unknown = spec();
    unknown.refs["g/x/c/1"] = ["{{b}}/x", 0, 1];
    expect(expandTemplates(unknown)).toBe(unknown);
  });
});

describe("referenceContents", () => {
  it("lists the v3 nodes", () => {
    const { contents, zarrFormat } = referenceContents(spec());
    expect(zarrFormat).toBe(3);
    expect(contents).toEqual([
      { path: "/", kind: "group" },
      { path: "/g", kind: "group" },
      { path: "/g/x", kind: "array" },
    ]);
  });

  it("lists the v2 nodes of a version 0 file", () => {
    const { contents, zarrFormat } = referenceContents({
      ".zgroup": '{"zarr_format":2}',
      "x/.zarray": "{}",
      "x/0": ["https://h/f", 0, 4],
    });
    expect(zarrFormat).toBe(2);
    expect(contents).toEqual([
      { path: "/", kind: "group" },
      { path: "/x", kind: "array" },
    ]);
  });
});

describe("createReferenceStore", () => {
  it("reads inline and referenced chunks through zarrita", async () => {
    const requests: { url: string; range: string | null }[] = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input: RequestInfo | URL) => {
        const request = input instanceof Request ? input : new Request(input);
        if (request.url === "https://h/refs.json") {
          return new Response(JSON.stringify(spec()));
        }
        requests.push({
          url: request.url,
          range: request.headers.get("Range"),
        });
        return new Response(new Uint8Array([3, 4]), { status: 206 });
      })
    );
    const store = await createReferenceStore("reference+https://h/refs.json");
    expect(store.contents().map((n) => n.path)).toEqual(["/", "/g", "/g/x"]);
    const array = await zarr.open.v3(zarr.root(store).resolve("g/x"), {
      kind: "array",
    });
    const chunk = await zarr.get(array);
    expect(Array.from(chunk.data as Uint8Array)).toEqual([1, 2, 3, 4]);
    expect(requests).toEqual([
      { url: "https://example.org/cell_1.zarr/x/c/0", range: "bytes=10-11" },
    ]);
  });
});
