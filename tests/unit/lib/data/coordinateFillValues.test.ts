import { expect, it, vi } from "vitest";
import type * as zarr from "zarrita";

import { getLatLonData } from "@/lib/data/coordinateVariables.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { buildSerializedGeoSampleIndexData } from "@/lib/grids/gridWorkerCalculations.ts";
import { buildIrregularDelaunayGrid } from "@/lib/grids/irregularDelaunayCalculations.ts";
import { createSerializedGeoSampleIndex } from "@/lib/grids/serializedGeoSampleIndex.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";

vi.mock("@/lib/data/ZarrDataManager.ts", () => ({
  ZarrDataManager: {
    getDimensionNames: vi.fn(),
    getVariableDataFromArray: vi.fn(),
    getVariableInfo: vi.fn(),
    resolveVariablePath: vi.fn((_variable: string, name: string) => name),
  },
}));

const AttributeName = {
  FILL_VALUE: "_FillValue",
  MISSING_VALUE: "missing_value",
  ZARR_FORMAT: "zarr_format",
} as const;

// CLM output on the ne120np4 grid: ocean columns have lat = lon = 1e36.
const FILL = 1e36;

// A 10 x 10 degree patch of land points, followed by as many fill columns.
function landAndOceanColumns() {
  const latitudes: number[] = [];
  const longitudes: number[] = [];
  for (let lat = 0; lat < 10; lat++) {
    for (let lon = 0; lon < 10; lon++) {
      latitudes.push(lat);
      longitudes.push(lon);
    }
  }
  const land = latitudes.length;
  for (let i = 0; i < land; i++) {
    latitudes.push(FILL);
    longitudes.push(FILL);
  }
  return {
    latitudes: new Float32Array(latitudes),
    longitudes: new Float32Array(longitudes),
    land,
  };
}

function mockLatLonVariables(
  latitudes: Float32Array,
  longitudes: Float32Array
) {
  const arrays: Record<string, Float32Array> = {
    lat: latitudes,
    lon: longitudes,
  };
  vi.mocked(ZarrDataManager.getVariableInfo).mockImplementation(
    async (_source, name) =>
      ({
        name,
        attrs: {
          [AttributeName.FILL_VALUE]: FILL,
          [AttributeName.MISSING_VALUE]: FILL,
        },
        dimensionNames: ["lndgrid"],
      }) as unknown as Awaited<
        ReturnType<typeof ZarrDataManager.getVariableInfo>
      >
  );
  vi.mocked(ZarrDataManager.getVariableDataFromArray).mockImplementation(
    async (array) => {
      const values = arrays[(array as unknown as { name: string }).name];
      return {
        data: new Float32Array(values),
        shape: [values.length],
        stride: [1],
      } as Awaited<ReturnType<typeof ZarrDataManager.getVariableDataFromArray>>;
    }
  );
}

it("masks coordinate fill values as NaN", async () => {
  const { latitudes, longitudes } = landAndOceanColumns();
  mockLatLonVariables(latitudes, longitudes);
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
  const datavar = {
    attrs: {},
    dimensionNames: ["time", "lndgrid"],
  } as unknown as zarr.Array<zarr.DataType, zarr.AsyncReadable>;

  const result = await getLatLonData("FCOV", datavar, sources);

  const lat = result.latitudes.data as Float32Array;
  const lon = result.longitudes!.data as Float32Array;
  expect(lat[0]).toBe(0);
  expect(lon[0]).toBe(0);
  // A 0 is a coordinate, not a fill value.
  expect(lat[1]).toBe(0);
  expect(Number.isNaN(lat[lat.length - 1])).toBe(true);
  expect(Number.isNaN(lon[lon.length - 1])).toBe(true);
});

it("triangulates the cells that have a position", () => {
  const { latitudes, longitudes } = landAndOceanColumns();
  latitudes.fill(NaN, 100);
  longitudes.fill(NaN, 100);

  const grid = buildIrregularDelaunayGrid(
    latitudes,
    longitudes,
    [latitudes.length],
    [longitudes.length],
    latitudes.length
  );

  // A 10 x 10 point grid has 9 x 9 squares of two triangles each.
  expect(grid.triangleIndices.length / 3).toBe(162);
  expect(Math.max(...grid.triangleIndices)).toBeLessThan(100);
});

it("finds the nearest sample past samples without a position", () => {
  const { latitudes, longitudes, land } = landAndOceanColumns();
  const values = new Float32Array(latitudes.length);
  for (let i = 0; i < values.length; i++) {
    values[i] = i < land ? i : NaN;
  }
  latitudes.fill(NaN, land);
  longitudes.fill(NaN, land);

  const index = createSerializedGeoSampleIndex(
    buildSerializedGeoSampleIndexData(
      Float64Array.from(latitudes),
      Float64Array.from(longitudes),
      values
    )
  );

  for (let lat = 0; lat < 10; lat++) {
    for (let lon = 0; lon < 10; lon++) {
      expect(index.findNearest(lat + 0.1, lon + 0.1)?.value).toBe(
        lat * 10 + lon
      );
    }
  }
});
