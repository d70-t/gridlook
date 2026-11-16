import { expect, it, vi } from "vitest";
import type * as zarr from "zarrita";

import { findCoordinateTimeDimensions } from "@/lib/data/coordinateVariables.ts";
import {
  reconcileCoordinateArrays,
  selectChunkIndices,
} from "@/lib/data/irregularGridHelpers.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";

vi.mock("@/lib/data/ZarrDataManager.ts", () => ({
  ZarrDataManager: {
    getVariableInfo: vi.fn(),
    resolveVariablePath: vi.fn((_variable: string, name: string) => name),
  },
}));

const AttributeName = {
  STANDARD_NAME: "standard_name",
  ZARR_FORMAT: "zarr_format",
} as const;

function chunk(values: number[], shape: number[]): zarr.Chunk<"float32"> {
  const stride = shape.map((_, i) =>
    shape.slice(i + 1).reduce((product, length) => product * length, 1)
  );
  return { data: new Float32Array(values), shape, stride };
}

it("slices lat(time, ny) and lon(time, nx) to one time step's meshgrid", () => {
  // Two time steps of a 2 x 3 box that moves by 10 degrees.
  const latitudes = chunk([0, 1, 10, 11], [2, 2]);
  const longitudes = chunk([0, 1, 2, 10, 11, 12], [2, 3]);
  const step = { time: 1 };

  const lat = selectChunkIndices(latitudes, ["time", "ny"], step);
  const lon = selectChunkIndices(longitudes, ["time", "nx"], step);

  expect(lat.shape).toEqual([2]);
  expect(lon.shape).toEqual([3]);
  expect(
    reconcileCoordinateArrays(
      lat.data as Float32Array,
      lon.data as Float32Array,
      lat.shape,
      lon.shape,
      6
    )
  ).toEqual({
    latitudes: new Float32Array([10, 10, 10, 11, 11, 11]),
    longitudes: new Float32Array([10, 11, 12, 10, 11, 12]),
  });
});

it("slices a time dimension that is not the leading one", () => {
  const values = chunk([0, 1, 2, 3, 4, 5], [2, 3]);

  const selected = selectChunkIndices(values, ["ny", "time"], { time: 2 });

  expect(selected.shape).toEqual([2]);
  expect(selected.data).toEqual(new Float32Array([2, 5]));
});

it("finds only the time dimensions shared by coordinates and data", async () => {
  vi.mocked(ZarrDataManager.getVariableInfo).mockImplementation(
    async (_source, name) =>
      ({
        attrs: name === "t" ? { [AttributeName.STANDARD_NAME]: "time" } : {},
      }) as unknown as Awaited<
        ReturnType<typeof ZarrDataManager.getVariableInfo>
      >
  );
  const sources: TSources = {
    [AttributeName.ZARR_FORMAT]: ZARR_FORMAT.NETCDF,
    levels: [
      {
        grid: { store: "grid-store", dataset: "" },
        time: { store: "time-store", dataset: "" },
        datasources: {},
      },
    ],
  };

  await expect(
    findCoordinateTimeDimensions(
      sources,
      "rectilinear/sst",
      ["t", "level", "ny", "nx"],
      ["t", "ny", "t", "nx"]
    )
  ).resolves.toEqual(["t"]);
});
