/* eslint-disable camelcase -- the catalog's own keys. */
import { expect, it } from "vitest";

import { pythonScript } from "@/lib/analysis/pythonExport.ts";
import { ANALYSIS_KINDS, type TAnalysisResult } from "@/lib/analysis/types.ts";
import { levelText } from "@/store/analysisStore.ts";
import { levelRead } from "@/ui/analysis/levelRead.ts";
import { levelReadText } from "@/ui/analysis/methodFacts.ts";

const sources = {
  zarr_format: 2,
  levels: [
    {
      datasources: {
        tas: { store: "https://x.org/tas.zarr", dataset: "" },
        pr: { store: "https://x.org/pr.zarr", dataset: "" },
      },
    },
  ],
} as never;

const series = (source: Record<string, string>) =>
  ({
    kind: ANALYSIS_KINDS.POINT_SERIES,
    query: {
      version: 1,
      kind: ANALYSIS_KINDS.POINT_SERIES,
      variable: "pr",
      fixed: {},
      geometry: { kind: "point", lat: 0, lon: 0 },
      source: { versionStatus: "best-effort", ...source },
    },
    values: [1, 2],
    dims: ["time"],
    shape: [2],
    notes: [],
    time: { dimension: "time", raw: [0, 1], units: "days since 2001-01-01" },
  }) as unknown as TAnalysisResult;

it("a single-level catalog's script opens the variable's own store", () => {
  const catalog = "https://x.org/catalog.json";
  const read = levelRead(sources, "https://x.org/tas.zarr", "", catalog);
  const level = levelText(
    { store: "https://x.org/pr.zarr", dataset: "", ...read } as never,
    "pr"
  );
  expect(level).toBe("1 of 1: https://x.org/pr.zarr");
  const script = pythonScript(
    series({ ref: catalog, level: level! }),
    "p",
    "P"
  );
  expect(script).toContain(
    '# ds = xr.open_dataset("https://x.org/pr.zarr", engine="zarr", chunks={})'
  );
  // Nothing to explain in the window: it is the only level.
  expect(levelReadText(level)).toBeUndefined();
  // A plain store is no catalog: no level.
  expect(
    levelRead(sources, "https://x.org/tas.zarr", "", "https://x.org/tas.zarr")
  ).toEqual({});
});

it("a remote NetCDF file is opened by byte ranges, a local one directly", () => {
  const remote = pythonScript(
    series({ ref: "https://x.org/data/file.nc" }),
    "p",
    "P"
  );
  expect(remote).toContain('# url = "https://x.org/data/file.nc"');
  expect(remote).toContain(
    "#     ds = xr.open_dataset(io.BufferedReader(Ranges(url), 1 << 20), chunks={})"
  );
  const local = pythonScript(series({ ref: "data/file.nc" }), "p", "P");
  expect(local).toContain('# ds = xr.open_dataset("data/file.nc", chunks={})');
});

it("review of interim45: a catalog store ending in a slash joins its dataset with one", () => {
  const slashed = {
    zarr_format: 2,
    levels: [
      {
        datasources: {
          pr: { store: "https://x.org/cat/", dataset: "/pr.zarr" },
        },
      },
    ],
  } as never;
  const read = levelRead(
    slashed,
    "https://x.org/cat/",
    "/pr.zarr",
    "https://x.org/catalog.json"
  );
  expect(read.level?.label).toBe("https://x.org/cat/pr.zarr");
  const level = levelText(
    { store: "https://x.org/cat/", dataset: "pr.zarr", ...read } as never,
    "pr"
  );
  expect(level).toBe("1 of 1: https://x.org/cat/pr.zarr");
  const script = pythonScript(
    series({ ref: "https://x.org/catalog.json", level: level! }),
    "p",
    "P"
  );
  expect(script).toContain(
    '# ds = xr.open_dataset("https://x.org/cat/pr.zarr", engine="zarr", chunks={})'
  );
});

it("review of interim45: a remote NetCDF recipe reads the whole file when the server ignores ranges", () => {
  const script = pythonScript(
    series({ ref: "netcdf+https://x.org/data/file" }),
    "p",
    "P"
  );
  expect(script).toContain("# except (OSError, ValueError):");
  expect(script).toContain(
    "#     with urllib.request.urlopen(url) as response:"
  );
  expect(script).toContain("#     ds = xr.open_dataset(whole)");
  expect(script).toContain("#     limit, total = 4 * 1024**3, 0");
  expect(script).toContain("# class Ranges(io.RawIOBase):");
  expect(script).toContain("#         self.size = self.get(0, 0)[1]");
  expect(script).toContain("tempfile.SpooledTemporaryFile");
  expect(script).not.toContain('b"".join');
});
