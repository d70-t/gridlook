import { expect, it } from "vitest";

import {
  getLocalNetCDF,
  isLocalNetCDFSource,
  isNetCDFFile,
  registerLocalNetCDF,
} from "@/lib/data/localNetCDF.ts";

function localFile(name: string) {
  return Object.assign(new Blob(["netcdf"]), { name }) as File;
}

it("recognizes supported NetCDF file extensions", () => {
  expect(isNetCDFFile(localFile("weather.nc"))).toBe(true);
  expect(isNetCDFFile(localFile("weather.NC4"))).toBe(true);
  expect(isNetCDFFile(localFile("weather.cdf"))).toBe(true);
  expect(isNetCDFFile(localFile("weather.zarr"))).toBe(false);
});

it("registers a local file under a synthetic source", () => {
  const file = localFile("weather data.nc");
  const source = registerLocalNetCDF(file);

  expect(isLocalNetCDFSource(source)).toBe(true);
  expect(source).toContain("weather%20data.nc");
  expect(getLocalNetCDF(source)).toBe(file);
});
