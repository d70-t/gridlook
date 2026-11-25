import { expect, it } from "vitest";

import {
  checkLocalZarrSelection,
  LocalZarrSelection,
  localZarrDirName,
} from "@/lib/data/localZarr.ts";

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
  for (const files of [
    localFiles("ds.zarr/tas/0.0", "ds.zarr/.zmetadata"),
    localFiles("ds.zarr/.zgroup"),
    localFiles("ds.zarr/tas/c/0/0", "ds.zarr/zarr.json"),
  ]) {
    expect(checkLocalZarrSelection(files)).toBe(LocalZarrSelection.OK);
  }
});

it("reports a selection without any hidden files", () => {
  // A Zarr v2 store whose dot-files are missing, or any non-Zarr directory.
  expect(
    checkLocalZarrSelection(localFiles("ds.zarr/tas/0.0", "ds.zarr/tas/1.0"))
  ).toBe(LocalZarrSelection.NO_HIDDEN_FILES);
});

it("reports hidden files without root metadata", () => {
  // E.g. the directory containing the store.
  expect(
    checkLocalZarrSelection(
      localFiles("data/ds.zarr/.zmetadata", "data/ds.zarr/tas/0.0")
    )
  ).toBe(LocalZarrSelection.NO_ROOT_METADATA);
});

it("names the selected directory", () => {
  expect(localZarrDirName(localFiles("ds.zarr/tas/0.0"))).toBe("ds.zarr");
});
