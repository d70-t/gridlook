import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { slice } from "zarrita";

import {
  getNetCDFArray,
  invalidateNetCDFCache,
  listNetCDFArrays,
  openNetCDFArray,
  openNetCDFGroup,
  resolveNetCDFGroup,
} from "@/lib/data/netCDF.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

const netCDFMocks = vi.hoisted(() => ({
  fromBlob: vi.fn(),
}));

vi.mock("@earthyscience/netcdf4-wasm", async (importOriginal) => ({
  ...(await importOriginal()),
  NetCDF4: { fromBlob: netCDFMocks.fromBlob },
}));

const NetCDFAttribute = {
  FILL_VALUE: "_FillValue",
  SCALE_FACTOR: "scale_factor",
} as const;

const metadata = {
  temperature: {
    name: "temperature",
    dtype: "f4",
    shape: [2, 3],
    dimensions: ["time", "lat"],
    attributes: {
      [NetCDFAttribute.SCALE_FACTOR]: new Float32Array([0.5]),
      [NetCDFAttribute.FILL_VALUE]: new Float32Array([-999]),
    },
    chunks: [1, 3],
  },
  lat: {
    name: "lat",
    dtype: "f8",
    shape: [3],
    dimensions: ["lat"],
    attributes: { units: "degrees_north" },
    chunks: [3],
  },
  wind: {
    name: "wind",
    dtype: "i2",
    shape: [2],
    dimensions: ["time"],
    attributes: {},
    chunks: [2],
  },
};

function createDataset() {
  return {
    close: vi.fn(),
    get: vi.fn().mockResolvedValue(new Float32Array([4, 6])),
    getFullMetadata: vi.fn(async (groupPath: string) =>
      groupPath === "/subgroup"
        ? [metadata.wind]
        : [metadata.temperature, metadata.lat]
    ),
    getGlobalAttributes: vi.fn(async (groupPath: string) =>
      groupPath === "/" ? { title: "Local data" } : { label: "Subgroup" }
    ),
    getGroupsRecursive: vi
      .fn()
      .mockResolvedValue({ subgroup: { ncid: 2, subgroups: {} } }),
    getVariableInfo: vi.fn(async (variable: keyof typeof metadata) =>
      Promise.resolve(metadata[variable])
    ),
  };
}

const file = new Blob(["netcdf"]) as File;

beforeEach(() => {
  netCDFMocks.fromBlob.mockResolvedValue(createDataset());
  ZarrDataManager.registerNetCDFBackend({
    getArray: getNetCDFArray,
    invalidateCache: invalidateNetCDFCache,
    openArray: openNetCDFArray,
    openGroup: openNetCDFGroup,
    resolveGroup: resolveNetCDFGroup,
  });
});

afterEach(async () => {
  await invalidateNetCDFCache();
  vi.clearAllMocks();
});

it("exposes NetCDF metadata and sliced reads like a Zarrita array", async () => {
  const group = await openNetCDFGroup(file, "local-file");
  const array = await openNetCDFArray(group, "temperature");
  const result = await getNetCDFArray(array, [1, slice(0, 3, 2)]);

  expect(group.attrs).toEqual({ title: "Local data" });
  expect(array).toMatchObject({
    attrs: {
      [NetCDFAttribute.SCALE_FACTOR]: 0.5,
      [NetCDFAttribute.FILL_VALUE]: -999,
    },
    chunks: [1, 3],
    dimensionNames: ["time", "lat"],
    dtype: "float32",
    fillValue: -999,
    format: ZARR_FORMAT.NETCDF,
    shape: [2, 3],
  });
  expect(result).toEqual({
    data: new Float32Array([4, 6]),
    shape: [2],
    stride: [1],
  });
  expect(group.context.dataset.get).toHaveBeenCalledWith(
    "temperature",
    [1, { start: 0, stop: 3, step: 2 }],
    "/"
  );
});

it("dispatches reads through ZarrDataManager without falling through to Zarrita", async () => {
  const result = await ZarrDataManager.getVariableData(
    { file, store: "local-file", dataset: "" },
    "temperature",
    [1, slice(0, 3, 2)]
  );

  expect(result).toEqual({
    data: new Float32Array([4, 6]),
    shape: [2],
    stride: [1],
  });
});

it("indexes coordinate variables and variables in nested groups", async () => {
  const arrays = await listNetCDFArrays(file, "local-file");

  expect(arrays.map((array) => array.path)).toEqual([
    "/temperature",
    "/lat",
    "/subgroup/wind",
  ]);
});

it("rejects missing grid markers before netcdf4-wasm returns false metadata", async () => {
  const group = await openNetCDFGroup(file, "local-file");

  await expect(openNetCDFArray(group, "vertex_of_cell")).rejects.toThrow(
    "NetCDF variable not found: /vertex_of_cell"
  );
  expect(group.context.dataset.getVariableInfo).not.toHaveBeenCalled();
});
