import { beforeEach, expect, it, vi } from "vitest";

import {
  getCRSWkt,
  getLatLonData,
  isLatitudeName,
  isLongitudeName,
  isProjectedXName,
  isProjectedYName,
  isWebMercatorCRS,
} from "@/lib/data/coordinateVariables.ts";
import { getGridType, GRID_TYPES } from "@/lib/data/gridTypeDetector.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";

vi.mock("@/lib/data/coordinateVariables.ts", () => ({
  getCRSWkt: vi.fn(),
  getLatLonData: vi.fn(),
  isLatitudeName: vi.fn(),
  isLongitudeName: vi.fn(),
  isProjectedXName: vi.fn(),
  isProjectedYName: vi.fn(),
  isWebMercatorCRS: vi.fn(),
}));

vi.mock("@/lib/data/ZarrDataManager.ts", () => ({
  ZarrDataManager: {
    getCRSInfo: vi.fn(),
    getDatasetSource: vi.fn(),
    getDimensionNames: vi.fn(),
    getParentGroup: vi.fn(),
    getVariableInfo: vi.fn(),
    resolveVariablePath: vi.fn(),
  },
}));

const TEST_VARIABLE = "temperature";
const SourceAttributeName = {
  DIMENSION_NAMES: "dimensionNames",
  ZARR_FORMAT: "zarr_format",
} as const;
const ZarrMetadataAttributeName = {
  DGGS: "dggs",
  GRID_MAPPING_NAME: "grid_mapping_name",
  REFINEMENT_LEVEL: "refinement_level",
  ZARR_CONVENTIONS: "zarr_conventions",
} as const;

function getLocalName(name: string) {
  const separatorIndex = name.lastIndexOf("/");
  return separatorIndex === -1 ? name : name.slice(separatorIndex + 1);
}

function createSources(dimensionNames: string[] = []): TSources {
  return {
    [SourceAttributeName.ZARR_FORMAT]: ZARR_FORMAT.V3,
    levels: [
      {
        grid: { store: "grid-store", dataset: "grid-dataset" },
        time: { store: "time-store", dataset: "time-dataset" },
        datasources: {
          [TEST_VARIABLE]: {
            store: "data-store",
            dataset: "data-dataset",
            attrs: { [SourceAttributeName.DIMENSION_NAMES]: dimensionNames },
          },
        },
      },
    ],
  };
}

function createArray(attrs: Record<string, unknown> = {}) {
  return {
    attrs,
    dimensionNames: [],
  } as unknown as Awaited<ReturnType<typeof ZarrDataManager.getVariableInfo>>;
}

function createGroup(attrs: Record<string, unknown>) {
  return {
    attrs,
  } as Awaited<ReturnType<typeof ZarrDataManager.getParentGroup>>;
}

function createChunk(data: Float64Array, shape: number[]) {
  return {
    data,
    shape,
    stride: [],
  };
}

function createLatLonData(
  latitudesData: number[],
  longitudesData: number[],
  shape: number[]
) {
  return {
    latitudesAttrs: { dimensionNames: undefined },
    latitudes: createChunk(new Float64Array(latitudesData), shape),
    longitudesAttrs: { dimensionNames: undefined },
    longitudes: createChunk(new Float64Array(longitudesData), shape),
  } as Awaited<ReturnType<typeof getLatLonData>>;
}

function mockDataVariable() {
  vi.mocked(ZarrDataManager.getVariableInfo).mockImplementation(
    async (_source, variable) => {
      if (variable === "vertex_of_cell") {
        throw new Error("No triangular grid metadata");
      }
      return createArray();
    }
  );
}

async function detectGridType(sources: TSources) {
  return await getGridType(true, TEST_VARIABLE, sources, vi.fn());
}

beforeEach(() => {
  vi.clearAllMocks();

  vi.mocked(ZarrDataManager.getCRSInfo).mockRejectedValue(new Error("No CRS"));
  vi.mocked(ZarrDataManager.getDatasetSource).mockImplementation(
    (sources, variable) => sources.levels[0].datasources[variable]
  );
  vi.mocked(ZarrDataManager.getDimensionNames).mockImplementation(
    async (sources, variable) =>
      (sources.levels[0].datasources[variable].attrs?.[
        SourceAttributeName.DIMENSION_NAMES
      ] ?? []) as string[]
  );
  vi.mocked(ZarrDataManager.getParentGroup).mockResolvedValue(createGroup({}));
  vi.mocked(ZarrDataManager.getVariableInfo).mockRejectedValue(
    new Error("No variable")
  );
  vi.mocked(ZarrDataManager.resolveVariablePath).mockImplementation(
    (contextVariable, variable) => {
      if (variable.includes("/") || !contextVariable.includes("/")) {
        return variable;
      }
      return `${contextVariable.split("/").slice(0, -1).join("/")}/${variable}`;
    }
  );

  vi.mocked(getCRSWkt).mockResolvedValue(null);
  vi.mocked(getLatLonData).mockRejectedValue(new Error("No lat/lon data"));
  vi.mocked(isLatitudeName).mockImplementation((name) =>
    ["lat", "latitude", "rlat"].includes(getLocalName(name))
  );
  vi.mocked(isLongitudeName).mockImplementation((name) =>
    ["lon", "longitude", "rlon"].includes(getLocalName(name))
  );
  vi.mocked(isProjectedXName).mockImplementation(
    (name) => getLocalName(name) === "x"
  );
  vi.mocked(isProjectedYName).mockImplementation(
    (name) => getLocalName(name) === "y"
  );
  vi.mocked(isWebMercatorCRS).mockImplementation(
    (crsWkt) =>
      crsWkt.includes('AUTHORITY["EPSG","3857"]') ||
      crsWkt.toLowerCase().includes("pseudo-mercator")
  );
});

it("returns error without inspecting data when the source is invalid", async () => {
  const logError = vi.fn();

  const gridType = await getGridType(false, TEST_VARIABLE, undefined, logError);

  expect(gridType).toBe(GRID_TYPES.ERROR);
  expect(logError).not.toHaveBeenCalled();
  expect(ZarrDataManager.getVariableInfo).not.toHaveBeenCalled();
});

it("returns triangular when vertex_of_cell metadata exists", async () => {
  const sources = createSources();
  vi.mocked(ZarrDataManager.getVariableInfo).mockResolvedValue(createArray());

  const gridType = await detectGridType(sources);

  expect(gridType).toBe(GRID_TYPES.TRIANGULAR);
  expect(ZarrDataManager.getVariableInfo).toHaveBeenCalledWith(
    sources.levels[0].grid,
    "vertex_of_cell",
    sources[SourceAttributeName.ZARR_FORMAT]
  );
});

it.each([
  ["healpix", GRID_TYPES.HEALPIX],
  ["rotated_latitude_longitude", GRID_TYPES.REGULAR_ROTATED],
  ["polar_stereographic", GRID_TYPES.CURVILINEAR],
])(
  "returns %s from CRS metadata",
  async (gridMappingName, expectedGridType) => {
    const sources = createSources();
    vi.mocked(ZarrDataManager.getCRSInfo).mockResolvedValue(
      createArray({
        [ZarrMetadataAttributeName.GRID_MAPPING_NAME]: gridMappingName,
      })
    );

    await expect(detectGridType(sources)).resolves.toBe(expectedGridType);
  }
);

it("returns healpix from DGGS zarr convention metadata", async () => {
  const sources = createSources();
  vi.mocked(ZarrDataManager.getParentGroup).mockResolvedValue(
    createGroup({
      [ZarrMetadataAttributeName.ZARR_CONVENTIONS]: ["dggs"],
      [ZarrMetadataAttributeName.DGGS]: {
        name: "healpix",
        [ZarrMetadataAttributeName.REFINEMENT_LEVEL]: 1,
        coordinate: null,
      },
    })
  );

  await expect(detectGridType(sources)).resolves.toBe(GRID_TYPES.HEALPIX);
});

it.each([[["time", "lat", "lon"]], [["time", "lat"]]])(
  "returns regular from dimension names %j",
  async (dimensionNames) => {
    const sources = createSources(dimensionNames);

    await expect(detectGridType(sources)).resolves.toBe(GRID_TYPES.REGULAR);
    expect(getLatLonData).not.toHaveBeenCalled();
  }
);

it.each([
  {
    expectedGridType: GRID_TYPES.CURVILINEAR,
    latitudesData: [0, 0, 1, 1],
    longitudesData: [10, 11, 10, 11],
    name: "curvilinear",
    shape: [2, 2],
  },
  {
    expectedGridType: GRID_TYPES.GAUSSIAN_REDUCED,
    latitudesData: [45, 45, 0, 0],
    longitudesData: [0, 90, 0, 180],
    name: "gaussian reduced",
    shape: [4],
  },
  {
    expectedGridType: GRID_TYPES.IRREGULAR,
    latitudesData: [45, 0, -45],
    longitudesData: [0, 90, 180],
    name: "irregular",
    shape: [3],
  },
])(
  "returns $name from latitude and longitude data",
  async ({ expectedGridType, latitudesData, longitudesData, shape }) => {
    const sources = createSources(["cell"]);
    mockDataVariable();
    vi.mocked(getLatLonData).mockResolvedValue(
      createLatLonData(latitudesData, longitudesData, shape)
    );

    await expect(detectGridType(sources)).resolves.toBe(expectedGridType);
  }
);

it.each([
  ["PROJCS[Polar Stereographic]", GRID_TYPES.CURVILINEAR],
  [
    'PROJCS[WGS 84 / Pseudo-Mercator, AUTHORITY["EPSG","3857"]]',
    GRID_TYPES.REGULAR,
  ],
])("returns %s projected x/y fallback", async (crsWkt, expectedGridType) => {
  const sources = createSources(["y", "x"]);
  mockDataVariable();
  vi.mocked(getCRSWkt).mockResolvedValue(crsWkt);

  await expect(detectGridType(sources)).resolves.toBe(expectedGridType);
  expect(getCRSWkt).toHaveBeenCalledWith(sources, TEST_VARIABLE);
});
