import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as zarr from "zarrita";

import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { getGridVariableData } from "@/lib/grids/gridDataWorkerClient.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";
import { loadVectorComponents } from "@/ui/grids/composables/streamlineData.ts";

vi.mock("@/lib/grids/gridDataWorkerClient.ts", () => ({
  getGridVariableData: vi.fn(),
}));

type TDataVar = zarr.Array<zarr.DataType, zarr.AsyncReadable>;

function dataVariable(shape: number[], attrs: zarr.Attributes = {}) {
  return { attrs, shape } as unknown as TDataVar;
}

function pressureLevelVariable() {
  return {
    attrs: {
      axis: "Z",
      long_name: "Pressure level", // eslint-disable-line camelcase
      units: "hPa",
    },
    shape: [2],
  } as unknown as TDataVar;
}

function sources(): TSources {
  return {
    zarr_format: ZARR_FORMAT.V3, // eslint-disable-line camelcase
    levels: [
      {
        grid: { store: "grid", dataset: "" },
        time: { store: "time", dataset: "" },
        datasources: {
          u: { store: "vectors", dataset: "run" },
          v: { store: "vectors", dataset: "run" },
        },
      },
    ],
  };
}

beforeEach(() => {
  vi.mocked(getGridVariableData).mockReset();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// eslint-disable-next-line max-lines-per-function
it("loads both streamline components through the data worker", async () => {
  const datasource = sources();
  const uVariable = dataVariable([10, 2], {
    standard_name: "eastward_wind", // eslint-disable-line camelcase
    units: "m s-1",
  });
  const vVariable = dataVariable([10, 2], {
    standard_name: "northward_wind", // eslint-disable-line camelcase
    units: "m s-1",
  });
  vi.spyOn(ZarrDataManager, "getDimensionNames").mockResolvedValue([
    "time",
    "cell",
  ]);
  vi.spyOn(ZarrDataManager, "getDatasetSource").mockImplementation(
    (allSources, variable) => allSources.levels[0].datasources[variable]
  );
  vi.mocked(getGridVariableData).mockImplementation(async ({ variable }) =>
    variable === "u" ? new Float64Array([1, 2]) : new Float64Array([3, 4])
  );

  const components = await loadVectorComponents({
    pair: { u: "u", v: "v", kind: "u/v" },
    datasources: datasource,
    getDataVar: vi.fn(async (variable) =>
      variable === "u" ? uVariable : vVariable
    ),
    currentDimensionNames: ["time", "cell"],
    currentIndices: [7, null],
    spatialDimensionNames: ["cell"],
    expectedDataLength: 2,
  });

  expect(components).toEqual({
    uData: new Float32Array([1, 2]),
    vData: new Float32Array([3, 4]),
    levelInfo: undefined,
    magnitudeInfo: {
      standardName: "wind_speed",
      longName: "Wind speed",
      units: "m s-1",
    },
    canDeriveMagnitude: true,
  });
  expect(getGridVariableData).toHaveBeenCalledTimes(2);
  expect(getGridVariableData).toHaveBeenCalledWith({
    source: datasource.levels[0].datasources.u,
    variable: "u",
    format: ZARR_FORMAT.V3,
    selection: [7, null],
  });
  expect(getGridVariableData).toHaveBeenCalledWith({
    source: datasource.levels[0].datasources.v,
    variable: "v",
    format: ZARR_FORMAT.V3,
    selection: [7, null],
  });

  datasource.levels[0].datasources["wind_speed"] = {
    store: "vectors",
    dataset: "run",
    attrs: { ["standard_name"]: "wind_speed" },
  };
  const existingMagnitude = await loadVectorComponents({
    pair: { u: "u", v: "v", kind: "u/v" },
    datasources: datasource,
    getDataVar: vi.fn(async (variable) =>
      variable === "u" ? uVariable : vVariable
    ),
    currentDimensionNames: ["time", "cell"],
    currentIndices: [7, null],
    spatialDimensionNames: ["cell"],
    expectedDataLength: 2,
  });
  expect(existingMagnitude?.magnitudeInfo?.standardName).toBe("wind_speed");
  expect(existingMagnitude?.canDeriveMagnitude).toBe(false);
});

it("selects a vertical slice and exposes its coordinate values", async () => {
  const datasource = sources();
  const uVariable = dataVariable([10, 2, 2]);
  const vVariable = dataVariable([10, 2, 2]);
  vi.spyOn(ZarrDataManager, "getDimensionNames").mockResolvedValue([
    "time",
    "level",
    "cell",
  ]);
  vi.spyOn(ZarrDataManager, "getDatasetSource").mockImplementation(
    (allSources, variable) => allSources.levels[0].datasources[variable]
  );
  vi.spyOn(ZarrDataManager, "getVariableInfo").mockResolvedValue(
    pressureLevelVariable()
  );
  vi.spyOn(ZarrDataManager, "getVariableDataFromArray").mockResolvedValue({
    data: new Float32Array([1000, 850]),
    shape: [2],
    stride: [1],
  });
  vi.mocked(getGridVariableData).mockImplementation(async ({ variable }) =>
    variable === "u" ? new Float64Array([1, 2]) : new Float64Array([3, 4])
  );

  const components = await loadVectorComponents({
    pair: { u: "u", v: "v", kind: "u/v" },
    datasources: datasource,
    getDataVar: vi.fn(async (variable) =>
      variable === "u" ? uVariable : vVariable
    ),
    currentDimensionNames: ["time", "cell"],
    currentIndices: [7, null],
    spatialDimensionNames: ["cell"],
    expectedDataLength: 2,
    selectedLevelIndex: 1,
  });

  expect(components?.levelInfo).toEqual({
    dimensionName: "level",
    values: [1000, 850],
    units: "hPa",
    longName: "Pressure level",
  });
  expect(getGridVariableData).toHaveBeenCalledWith(
    expect.objectContaining({ variable: "u", selection: [7, 1, null] })
  );
  expect(getGridVariableData).toHaveBeenCalledWith(
    expect.objectContaining({ variable: "v", selection: [7, 1, null] })
  );
});

it("does not start worker reads for incompatible components", async () => {
  const datasource = sources();
  vi.spyOn(ZarrDataManager, "getDimensionNames")
    .mockResolvedValueOnce(["time", "cell"])
    .mockResolvedValueOnce(["time", "edge"]);

  const components = await loadVectorComponents({
    pair: { u: "u", v: "v", kind: "u/v" },
    datasources: datasource,
    getDataVar: vi.fn().mockResolvedValue(dataVariable([10, 2])),
    currentDimensionNames: ["time", "cell"],
    currentIndices: [7, null],
    spatialDimensionNames: ["cell"],
    expectedDataLength: 2,
  });

  expect(components).toBeUndefined();
  expect(getGridVariableData).not.toHaveBeenCalled();
});
