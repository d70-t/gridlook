import { expect, it } from "vitest";

import { isRemoteNetCDFSource } from "@/lib/data/localNetCDF.ts";
import { splitSourceType, withSourceType } from "@/lib/data/sourceType.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

it("splits a type prefix off the URL", () => {
  expect(splitSourceType("zarr3+https://example.org/a.zarr")).toEqual({
    format: ZARR_FORMAT.V3,
    url: "https://example.org/a.zarr",
  });
  expect(splitSourceType("https://example.org/a.zarr")).toEqual({
    format: undefined,
    url: "https://example.org/a.zarr",
  });
});

it("replaces or removes the type prefix", () => {
  const url = "https://example.org/a";
  expect(withSourceType(url, ZARR_FORMAT.NETCDF)).toBe(`netcdf+${url}`);
  expect(withSourceType(`netcdf+${url}`, ZARR_FORMAT.V2)).toBe(`zarr2+${url}`);
  expect(withSourceType(`icechunk+${url}`, undefined)).toBe(url);
});

it("lets a type prefix win over the NetCDF file extension", () => {
  expect(isRemoteNetCDFSource("https://example.org/a.nc")).toBe(true);
  expect(isRemoteNetCDFSource("https://example.org/a")).toBe(false);
  expect(isRemoteNetCDFSource("netcdf+https://example.org/a")).toBe(true);
  expect(isRemoteNetCDFSource("zarr3+https://example.org/a.nc")).toBe(false);
});
