import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import {
  explainMetadataJsonError,
  MetadataJsonError,
  withMetadataJsonCheck,
} from "@/lib/data/metadataJson.ts";
import { flattenErrorMessage } from "@/utils/errorHandling.ts";

const encode = (text: string) => new TextEncoder().encode(text);

function store(files: Record<string, string>) {
  return withMetadataJsonCheck({
    get: async (key: string) => (key in files ? encode(files[key]) : undefined),
  });
}

const ZARRAY = (fill: string) =>
  `{\n  "shape": [4],\n  "chunks": [4],\n  "fill_value": ${fill},\n  "order": "C",\n  "filters": null,\n  "compressor": null,\n  "zarr_format": 2,\n  "dtype": "<f4"\n}`;

describe("withMetadataJsonCheck", () => {
  it("names the file and line of a bare NaN", async () => {
    const s = store({ "/a/.zarray": ZARRAY("NaN") });
    const error = await s.get("/a/.zarray").catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MetadataJsonError);
    expect((error as Error).message).toBe(
      'Invalid Zarr metadata in "/a/.zarray": line 4 has a bare NaN, which ' +
        'is not valid JSON. Zarr writes it as a string, e.g. "fill_value": "NaN".'
    );
  });

  it("reports other JSON errors with the parser's reason", async () => {
    const s = store({ "/.zmetadata": "{" });
    await expect(s.get("/.zmetadata")).rejects.toThrow(
      /^Invalid Zarr metadata in "\/\.zmetadata": not valid JSON \(/
    );
  });

  it("passes valid metadata and chunks through", async () => {
    const s = store({ "/a/.zarray": ZARRAY('"NaN"'), "/a/0": "NaN" });
    expect(await s.get("/a/.zarray")).toBeDefined();
    expect(await s.get("/a/0")).toEqual(encode("NaN"));
  });

  it("surfaces the error through zarr.withConsolidatedMetadata", async () => {
    const s = store({
      "/.zmetadata": `{"zarr_consolidated_format": 1, "metadata": {"a/.zarray": ${ZARRAY("NaN")}}}`,
    });
    await expect(zarr.withConsolidatedMetadata(s)).rejects.toBeInstanceOf(
      MetadataJsonError
    );
  });
});

describe("explainMetadataJsonError", () => {
  it("recognises the error after the worker flattens it", async () => {
    const error = await store({ "/.zgroup": "NaN" })
      .get("/.zgroup")
      .catch((e: unknown) => e);
    const flattened = new Error(flattenErrorMessage(error));
    expect(explainMetadataJsonError(flattened)?.heading).toBe(
      "Invalid Zarr metadata"
    );
    expect(explainMetadataJsonError(new Error("other"))).toBeUndefined();
  });
});
