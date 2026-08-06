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

function dataVariable(shape: number[]) {
  return { attrs: {}, shape } as unknown as TDataVar;
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

it("loads both streamline components through the data worker", async () => {
  const datasource = sources();
  const uVariable = dataVariable([10, 2]);
  const vVariable = dataVariable([10, 2]);
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
