import { expect, it } from "vitest";

import { hasRootZarrMetadata } from "@/lib/data/localZarr.ts";

function localFiles(...paths: string[]) {
  return paths.map(
    (path) =>
      Object.assign(new Blob([""]), {
        name: path.split("/").at(-1),
        webkitRelativePath: path,
      }) as File
  );
}

it("accepts Zarr v2 and v3 stores with root metadata", () => {
  expect(
    hasRootZarrMetadata(localFiles("ds.zarr/tas/0.0", "ds.zarr/.zmetadata"))
  ).toBe(true);
  expect(hasRootZarrMetadata(localFiles("ds.zarr/.zgroup"))).toBe(true);
  expect(
    hasRootZarrMetadata(localFiles("ds.zarr/tas/c/0/0", "ds.zarr/zarr.json"))
  ).toBe(true);
});

it("rejects a Zarr v2 store whose hidden files were dropped (Safari)", () => {
  expect(
    hasRootZarrMetadata(localFiles("ds.zarr/tas/0.0", "ds.zarr/tas/1.0"))
  ).toBe(false);
});

it("ignores metadata that is not at the store root", () => {
  expect(
    hasRootZarrMetadata(localFiles("ds.zarr/tas/.zarray", "ds.zarr/tas/0.0"))
  ).toBe(false);
});
