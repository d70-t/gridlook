import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type * as zarr from "zarrita";

import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { getGridVariableData } from "@/lib/grids/gridDataWorkerClient.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";
import {
  inspectVolumeSources,
  loadProjectedVolumeGrid,
  loadVolumeData,
} from "@/lib/volume/volumeData.ts";
import { getVolumeVariablesForGroup } from "@/lib/volume/volumeVariables.ts";

vi.mock("@/lib/grids/gridDataWorkerClient.ts", () => ({
  getGridVariableData: vi.fn(),
}));

const group = "multiscales/zoom_1";
const names = ["clw", "cli", "zg"].map((name) => `${group}/${name}`);
const context = {
  dimensionNames: ["time", "level_full", "cell"],
  indices: [4, 1, null],
};

function sources(): TSources {
  const source = { store: "volume.zarr", dataset: "" };
  return {
    ["zarr_format"]: ZARR_FORMAT.V3,
    levels: [
      {
        grid: source,
        time: source,
        datasources: Object.fromEntries(names.map((name) => [name, source])),
      },
    ],
  };
}

beforeEach(() => {
  vi.mocked(getGridVariableData).mockReset();
  vi.spyOn(ZarrDataManager, "getVariableInfo").mockRejectedValue(
    new Error("No coordinate")
  );
  vi.spyOn(ZarrDataManager, "getDimensionNames").mockResolvedValue(
    context.dimensionNames
  );
  vi.spyOn(
    ZarrDataManager,
    "getVariableInfoByDatasetSources"
  ).mockImplementation(
    async (_, name) =>
      ({
        shape: [10, 2, 2],
        attrs: name.endsWith("/zg")
          ? { ["standard_name"]: "height", units: "m" }
          : { coordinates: "zg", ["scale_factor"]: 0.5 },
      }) as unknown as zarr.Array<zarr.DataType, zarr.AsyncReadable>
  );
});

afterEach(() => vi.restoreAllMocks());

it("loads all levels at the scalar timestep through the shared data worker", async () => {
  const datasource = sources();
  vi.mocked(getGridVariableData).mockImplementation(
    async ({ variable, onProgress }) => {
      onProgress?.(1, 2);
      onProgress?.(2, 2);
      return variable.endsWith("/zg")
        ? new Float64Array([1000, 1000, 0, 0])
        : new Int16Array([2, 4, 6, 8]);
    }
  );
  const inspected = await inspectVolumeSources(
    datasource,
    names.slice(0, 2),
    context
  );
  const progress = vi.fn();
  const result = await loadVolumeData(datasource, inspected, context, progress);

  expect(getGridVariableData).toHaveBeenCalledTimes(3);
  for (const variable of names) {
    expect(getGridVariableData).toHaveBeenCalledWith({
      source: datasource.levels[0].datasources[variable],
      variable,
      format: ZARR_FORMAT.V3,
      selection: [4, null, null],
      onProgress: expect.any(Function),
    });
  }
  expect(result.values).toEqual([
    new Float32Array([1, 2, 3, 4]),
    new Float32Array([1, 2, 3, 4]),
  ]);
  expect(result.heights).toEqual(new Float32Array([1000, 1000, 0, 0]));
  expect(context.indices).toEqual([4, 1, null]);
  expect(progress).toHaveBeenLastCalledWith(1);
});

it("rejects mismatched vertical grids before downloading their values", async () => {
  vi.mocked(
    ZarrDataManager.getVariableInfoByDatasetSources
  ).mockResolvedValueOnce({
    shape: [10, 3, 2],
    attrs: {},
  } as unknown as zarr.Array<zarr.DataType, zarr.AsyncReadable>);
  await expect(
    inspectVolumeSources(sources(), names.slice(0, 2), context)
  ).rejects.toThrow("incompatible grids");
  expect(getGridVariableData).not.toHaveBeenCalled();
});

it.each([
  [
    "pres",
    {
      axis: "Z",
      ["standard_name"]: "sea_water_pressure",
      positive: "down",
      units: "dbar",
    },
  ],
  ["deptht", {}],
])(
  "loads %s downward at the selected forecast time",
  // eslint-disable-next-line max-lines-per-function
  async (verticalDimension, pressureAttrs) => {
    const datasource = sources();
    const dimensions = [
      "validity",
      "lead_time",
      verticalDimension,
      "latitude",
      "longitude",
    ];
    const variable = {
      shape: [10, 49, 3, 2, 2],
      attrs: { dimensionNames: dimensions },
    };
    const vars = {
      [`${group}/oxy`]: { ...datasource.levels[0].grid, ...variable },
      ...Object.fromEntries(
        Object.entries({
          validity: { axis: "T" },
          ["lead_time"]: {
            ["standard_name"]: "forecast_period",
            units: "hours",
          },
          [verticalDimension]: pressureAttrs,
        }).map(([name, attrs]) => [
          `${group}/${name}`,
          { ...datasource.levels[0].grid, attrs, hidden: true },
        ])
      ),
    };
    datasource.levels[0].datasources = vars;
    expect(
      getVolumeVariablesForGroup(
        { vars, title: "Ocean", defaultVar: `${group}/oxy`, colormaps: [] },
        `${group}/oxy`
      )
    ).toEqual([`${group}/oxy`]);
    vi.mocked(ZarrDataManager.getDimensionNames).mockResolvedValue(dimensions);
    vi.mocked(
      ZarrDataManager.getVariableInfoByDatasetSources
    ).mockResolvedValue(
      variable as unknown as zarr.Array<zarr.DataType, zarr.AsyncReadable>
    );
    vi.mocked(ZarrDataManager.getVariableInfo).mockResolvedValue({
      shape: [3],
      attrs: pressureAttrs,
    } as unknown as zarr.Array<zarr.DataType, zarr.AsyncReadable>);
    vi.mocked(getGridVariableData).mockImplementation(async ({ variable }) =>
      variable === `${group}/${verticalDimension}`
        ? new Float32Array([1000, 500, 100])
        : new Float32Array(12).fill(1)
    );
    const selection = {
      dimensionNames: ["validity", "lead_time", "latitude", "longitude"],
      indices: [7, 12, null, null],
    };
    const inspected = await inspectVolumeSources(
      datasource,
      [`${group}/oxy`],
      selection
    );
    const loaded = await loadVolumeData(
      datasource,
      inspected,
      selection,
      vi.fn()
    );
    expect(getGridVariableData).toHaveBeenCalledWith(
      expect.objectContaining({
        variable: `${group}/oxy`,
        selection: [7, 12, null, null, null],
      })
    );
    expect(inspected[0].spatialShape).toEqual([2, 2]);
    expect(loaded.values[0]).toHaveLength(12);
    expect(loaded.levels).toEqual(new Float32Array([-1000, -500, -100]));
  }
);

it("loads decoded native x/y coordinates using the declared projection", async () => {
  const datasource = sources();
  datasource.levels[0].datasources = Object.fromEntries(
    Object.entries({
      field: {
        shape: [2, 2, 2],
        attrs: {
          dimensionNames: ["level", "y", "x"],
          ["grid_mapping"]: "projection",
        },
      },
      x: { shape: [2], attrs: { ["scale_factor"]: 1000 } },
      y: { shape: [2], attrs: { ["scale_factor"]: 1000 } },
      projection: { shape: [], attrs: { ["crs_wkt"]: "EPSG:3857" } },
    }).map(([name, metadata]) => [
      `${group}/${name}`,
      { ...datasource.levels[0].grid, ...metadata },
    ])
  );
  vi.mocked(ZarrDataManager.getVariableInfoByDatasetSources).mockImplementation(
    async (_, name) =>
      datasource.levels[0].datasources[name] as unknown as zarr.Array<
        zarr.DataType,
        zarr.AsyncReadable
      >
  );
  vi.spyOn(ZarrDataManager, "getVariableDataFromArray").mockResolvedValue({
    data: new Int16Array([-2, 3]),
    shape: [2],
    stride: [1],
  });
  expect(
    await loadProjectedVolumeGrid(datasource, `${group}/field`, [
      "level",
      "y",
      "x",
    ])
  ).toEqual({
    kind: "projected",
    crs: "EPSG:3857",
    x: new Float32Array([-2000, 3000]),
    y: new Float32Array([-2000, 3000]),
  });
});

it.each([
  ["level", { axis: "T" }],
  ["lead_time", { ["standard_name"]: "forecast_period", units: "hours" }],
  ["member", {}],
])(
  "does not treat %s as a vertical axis in the menu or loader",
  async (name, attrs) => {
    const datasource = sources();
    const dimensionNames = [name, "latitude", "longitude"];
    const variable = { shape: [3, 2, 2], attrs: { dimensionNames } };
    const vars = {
      field: { ...datasource.levels[0].grid, ...variable },
      [name]: { ...datasource.levels[0].grid, attrs, hidden: true },
    };
    datasource.levels[0].datasources = vars;
    expect(
      getVolumeVariablesForGroup(
        { vars, title: "Surface", defaultVar: "field", colormaps: [] },
        "field"
      )
    ).toEqual([]);
    vi.mocked(ZarrDataManager.getDimensionNames).mockResolvedValue(
      dimensionNames
    );
    vi.mocked(
      ZarrDataManager.getVariableInfoByDatasetSources
    ).mockResolvedValue(
      variable as unknown as zarr.Array<zarr.DataType, zarr.AsyncReadable>
    );
    await expect(
      inspectVolumeSources(datasource, ["field"], {
        dimensionNames,
        indices: [0, null, null],
      })
    ).rejects.toThrow("not a supported volume");
    expect(getGridVariableData).not.toHaveBeenCalled();
  }
);
