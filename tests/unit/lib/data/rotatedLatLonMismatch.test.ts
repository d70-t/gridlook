import proj4 from "proj4";
import { beforeEach, expect, it, vi } from "vitest";

import {
  getCRSFromAttrs,
  hasRotatedLatLonMismatch,
} from "@/lib/data/coordinateVariables.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";

vi.mock("@/lib/data/ZarrDataManager.ts", () => ({
  ZarrDataManager: {
    getVariableDataFromArray: vi.fn(),
    getVariableInfo: vi.fn(),
    getVariableInfoByDatasetSources: vi.fn(),
    resolveVariablePath: vi.fn((_variable: string, name: string) => name),
  },
}));

const AttributeName = {
  GRID_MAPPING_NAME: "grid_mapping_name",
  GRID_NORTH_POLE_LATITUDE: "grid_north_pole_latitude",
  GRID_NORTH_POLE_LONGITUDE: "grid_north_pole_longitude",
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

function rotatedPoleCRS(latitude: number, longitude: number) {
  return getCRSFromAttrs({
    [AttributeName.GRID_MAPPING_NAME]: "rotated_latitude_longitude",
    [AttributeName.GRID_NORTH_POLE_LATITUDE]: latitude,
    [AttributeName.GRID_NORTH_POLE_LONGITUDE]: longitude,
  })!;
}

// iris small_rotPole_precipitation.nc: its lat/lon were computed with the
// EUR pole (39.25, -162), its rotated_pole attributes say (18, -140.75).
const LAT_LON_CRS = rotatedPoleCRS(39.25, -162);
const DECLARED_CRS = rotatedPoleCRS(18, -140.75);
const RLAT = new Float32Array([-0.22, 0, 0.22]);
const RLON = new Float32Array([-3.24, -3.02, -2.8]);

beforeEach(() => {
  const transform = proj4(LAT_LON_CRS, "EPSG:4326");
  const latitudes: number[] = [];
  const longitudes: number[] = [];
  for (const rlat of RLAT) {
    for (const rlon of RLON) {
      const [lon, lat] = transform.forward([rlon, rlat]);
      longitudes.push(lon);
      latitudes.push(lat);
    }
  }
  const arrays: Record<string, { values: number[] }> = {
    lat: { values: latitudes },
    lon: { values: longitudes },
  };
  vi.mocked(ZarrDataManager.getVariableInfoByDatasetSources).mockResolvedValue({
    attrs: { coordinates: "lon lat" },
    dimensionNames: ["time", "rlat", "rlon"],
  } as unknown as Awaited<
    ReturnType<typeof ZarrDataManager.getVariableInfoByDatasetSources>
  >);
  vi.mocked(ZarrDataManager.getVariableInfo).mockImplementation(
    async (_source, name) =>
      ({
        ...arrays[name],
        attrs: {},
        dimensionNames: ["rlat", "rlon"],
      }) as unknown as Awaited<
        ReturnType<typeof ZarrDataManager.getVariableInfo>
      >
  );
  vi.mocked(ZarrDataManager.getVariableDataFromArray).mockImplementation(
    async (array) =>
      ({
        data: new Float32Array(
          (array as unknown as { values: number[] }).values
        ),
        shape: [RLAT.length, RLON.length],
        stride: [RLON.length, 1],
      }) as Awaited<ReturnType<typeof ZarrDataManager.getVariableDataFromArray>>
  );
});

it("flags a rotated pole that disagrees with the grid's own lat/lon", async () => {
  await expect(
    hasRotatedLatLonMismatch(SOURCES, "pr", RLON, RLAT, DECLARED_CRS)
  ).resolves.toBe(true);
});

it("accepts a rotated pole that matches the grid's own lat/lon", async () => {
  await expect(
    hasRotatedLatLonMismatch(SOURCES, "pr", RLON, RLAT, LAT_LON_CRS)
  ).resolves.toBe(false);
});
