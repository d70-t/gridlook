import { beforeEach, expect, it, vi } from "vitest";
import type * as zarr from "zarrita";

import { getIrregularLatLonData } from "@/lib/data/coordinateVariables.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";

vi.mock("@/lib/data/ZarrDataManager.ts", () => ({
  ZarrDataManager: {
    getCRSInfo: vi.fn(),
    getDatasetGroup: vi.fn(),
    getDatasetSource: vi.fn(),
    getDimensionNames: vi.fn(),
    getVariableDataFromArray: vi.fn(),
    getVariableInfo: vi.fn(),
    resolveVariablePath: vi.fn((_variable: string, name: string) => name),
  },
}));

const AttributeName = {
  AXIS: "axis",
  GRID_MAPPING_NAME: "grid_mapping_name",
  GRID_NORTH_POLE_LATITUDE: "grid_north_pole_latitude",
  GRID_NORTH_POLE_LONGITUDE: "grid_north_pole_longitude",
  STANDARD_NAME: "standard_name",
  UNITS: "units",
  ZARR_FORMAT: "zarr_format",
} as const;

const SOURCES: TSources = {
  [AttributeName.ZARR_FORMAT]: ZARR_FORMAT.NETCDF,
  levels: [
    {
      grid: { store: "grid-store", dataset: "" },
      time: { store: "time-store", dataset: "" },
      datasources: {},
    },
  ],
};

type TMockArray = {
  attrs: Record<string, unknown>;
  dimensionNames?: string[];
  shape: number[];
  values: number[];
};

const COLPEX_POLE = { latitude: 37.5, longitude: 177.5 };
const EUR11_POLE = { latitude: 39.25, longitude: -162 };

// Corners of iris-test-data small_theta_colpex.nc.
const ARRAYS: Record<string, TMockArray> = {
  ["grid_latitude"]: {
    attrs: { [AttributeName.AXIS]: "Y", [AttributeName.UNITS]: "degrees" },
    shape: [2],
    values: [-0.5274, 0.3582],
  },
  ["grid_longitude"]: {
    attrs: { [AttributeName.AXIS]: "X", [AttributeName.UNITS]: "degrees" },
    shape: [2],
    values: [359.18, 360.0656],
  },
  // Corners of the EUR-11 grid (reg_rot_CLM_C20_3_D2_3h_IWATER_1.nc layout).
  rlat: {
    attrs: {
      [AttributeName.STANDARD_NAME]: "grid_latitude",
      [AttributeName.UNITS]: "degrees",
    },
    dimensionNames: ["rlat"],
    shape: [2],
    values: [-23.375, 21.835],
  },
  rlon: {
    attrs: {
      [AttributeName.STANDARD_NAME]: "grid_longitude",
      [AttributeName.UNITS]: "degrees",
    },
    dimensionNames: ["rlon"],
    shape: [2],
    values: [-28.375, 18.155],
  },
  time: {
    attrs: { [AttributeName.STANDARD_NAME]: "time" },
    shape: [6],
    values: [],
  },
};

function mockDataset(dimensions: string[], pole = COLPEX_POLE) {
  vi.mocked(ZarrDataManager.getDimensionNames).mockResolvedValue(dimensions);
  vi.mocked(ZarrDataManager.getCRSInfo).mockResolvedValue({
    attrs: {
      [AttributeName.GRID_MAPPING_NAME]: "rotated_latitude_longitude",
      [AttributeName.GRID_NORTH_POLE_LATITUDE]: pole.latitude,
      [AttributeName.GRID_NORTH_POLE_LONGITUDE]: pole.longitude,
    },
  } as unknown as Awaited<ReturnType<typeof ZarrDataManager.getCRSInfo>>);
  vi.mocked(ZarrDataManager.getVariableInfo).mockImplementation(
    async (_source, name) => {
      if (!(name in ARRAYS)) {
        throw new Error(`No variable ${name}`);
      }
      return ARRAYS[name] as unknown as Awaited<
        ReturnType<typeof ZarrDataManager.getVariableInfo>
      >;
    }
  );
  vi.mocked(ZarrDataManager.getVariableDataFromArray).mockImplementation(
    async (array) => {
      const { values, shape } = array as unknown as TMockArray;
      return { data: new Float32Array(values), shape, stride: [1] } as Awaited<
        ReturnType<typeof ZarrDataManager.getVariableDataFromArray>
      >;
    }
  );
}

const DATAVAR = {
  attrs: {},
  dimensionNames: [],
} as unknown as zarr.Array<zarr.DataType, zarr.AsyncReadable>;

beforeEach(() => {
  vi.clearAllMocks();
});

it("reprojects rotated-pole axes to one lat/lon pair per cell", async () => {
  mockDataset([
    "time",
    "model_level_number",
    "grid_latitude",
    "grid_longitude",
  ]);

  const result = await getIrregularLatLonData(
    "air_potential_temperature",
    DATAVAR,
    SOURCES
  );

  expect(result.latitudes.shape).toEqual([2, 2]);
  expect(result.latitudesAttrs.dimensionNames).toEqual([
    "grid_latitude",
    "grid_longitude",
  ]);
  expect(result.timeDimensions).toEqual([]);
  // Reference: proj4 ob_tran with the file's pole (Welsh border/Shropshire).
  const expected = [
    [-3.831, 51.965],
    [-2.394, 51.973],
    [-3.858, 52.85],
    [-2.391, 52.858],
  ];
  const longitudes = result.longitudes!.data as Float32Array;
  const latitudes = result.latitudes.data as Float32Array;
  expected.forEach(([lon, lat], index) => {
    expect(longitudes[index]).toBeCloseTo(lon, 2);
    expect(latitudes[index]).toBeCloseTo(lat, 2);
  });
});

it("rejects axes in (x, y) order instead of drawing them transposed", async () => {
  mockDataset(["grid_longitude", "grid_latitude"]);

  await expect(
    getIrregularLatLonData("surface_altitude", DATAVAR, SOURCES)
  ).rejects.toThrow();
});

it("reprojects rlat/rlon found via the dimension names (no coordinates attribute)", async () => {
  mockDataset(["time", "rlat", "rlon"], EUR11_POLE);
  const datavar = {
    attrs: {},
    dimensionNames: ["time", "rlat", "rlon"],
  } as unknown as zarr.Array<zarr.DataType, zarr.AsyncReadable>;

  const result = await getIrregularLatLonData("IWATER", datavar, SOURCES);

  expect(result.latitudes.shape).toEqual([2, 2]);
  // Reference pairs from the PIK-STARS3 EUR-11 file's lon/lat arrays (same
  // pole), see rotatedVolume.test.ts.
  const expected = [
    [-10.063879662216031, 21.98782875683831],
    [36.41382968450823, 25.1142623886123],
    [-44.59386389190011, 60.203763369090005],
    [64.96437666717895, 66.68983654206978],
  ];
  const longitudes = result.longitudes!.data as Float32Array;
  const latitudes = result.latitudes.data as Float32Array;
  expected.forEach(([lon, lat], index) => {
    expect(longitudes[index]).toBeCloseTo(lon, 3);
    expect(latitudes[index]).toBeCloseTo(lat, 3);
  });
});
