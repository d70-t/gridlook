import { describe, expect, it } from "vitest";

import { GRID_TYPES } from "@/lib/data/gridTypeDetector.ts";
import type { TDataSource, TModelInfo } from "@/lib/types/GlobeTypes.ts";
import {
  getVolumeVariables,
  getVolumeVariablesForGroup,
  getVolumeUnavailableReason,
  isVolumeVariable,
  preferredVolumeVariable,
  volumeVariableOpacity,
  volumeVariablesAreCompatible,
} from "@/lib/volume/volumeVariables.ts";

function source(dimensions: string[], shape: number[]): TDataSource {
  return {
    store: "dataset.zarr",
    dataset: "",
    shape,
    attrs: { dimensionNames: dimensions },
  };
}

// eslint-disable-next-line max-lines-per-function
describe("volume variables", () => {
  it("requires one recognizable vertical and at least one spatial dimension", () => {
    expect(
      isVolumeVariable(source(["time", "level_full", "cell"], [2, 90, 48]))
    ).toBe(true);
    for (const level of ["sigma", "hybrid"]) {
      expect(isVolumeVariable(source([level, "cell"], [3, 48]))).toBe(true);
    }
    expect(isVolumeVariable(source(["time", "cell"], [2, 48]))).toBe(false);
    expect(
      isVolumeVariable(source(["time", "level", "lat", "lon"], [2, 3, 4, 8]))
    ).toBe(true);
    expect(
      isVolumeVariable(
        source(
          ["valid_time", "pressure", "latitude", "longitude"],
          [2, 3, 4, 8]
        )
      )
    ).toBe(true);
  });

  it("filters hidden variables and prefers cloud water over cloud ice", () => {
    const modelInfo = {
      vars: {
        cli: source(["time", "level_full", "cell"], [2, 90, 48]),
        clw: source(["time", "level_full", "cell"], [2, 90, 48]),
        surface: source(["time", "cell"], [2, 48]),
      },
    } as unknown as TModelInfo;
    const variables = getVolumeVariables(modelInfo);
    expect(variables).toEqual(["cli", "clw"]);
    expect(preferredVolumeVariable(variables)).toBe("clw");
  });

  it("keeps multiscale volume choices in the selected grid group", () => {
    const modelInfo = {
      vars: {
        "multiscales/zoom_0/clw": source(
          ["time", "level_full", "cell"],
          [2, 3, 12]
        ),
        "multiscales/zoom_6/clivi": source(["time", "cell"], [2, 49_152]),
        "multiscales/zoom_6/clw": source(
          ["time", "level_full", "cell"],
          [2, 3, 49_152]
        ),
      },
    } as unknown as TModelInfo;

    expect(
      getVolumeVariablesForGroup(modelInfo, "multiscales/zoom_6/clivi")
    ).toEqual(["multiscales/zoom_6/clw"]);
  });

  it("provides default opacity and checks grid compatibility", () => {
    const cloud = source(["time", "level_full", "cell"], [2, 90, 48]);
    const otherCloud = source(["time", "level_full", "cell"], [2, 90, 48]);
    const ocean = source(["time", "depth_full", "cell"], [2, 128, 48]);
    expect(volumeVariableOpacity()).toBe(0.75);
    expect(volumeVariablesAreCompatible(cloud, otherCloud)).toBe(true);
    expect(volumeVariablesAreCompatible(cloud, ocean)).toBe(false);
  });
});

it.each([GRID_TYPES.CURVILINEAR, GRID_TYPES.TRIANGULAR, GRID_TYPES.IRREGULAR])(
  "explains why the %s grid cannot render volumes even with vertical data",
  (gridType) => {
    const modelInfo: TModelInfo = {
      vars: {
        temperature: source(["time", "level", "lat", "lon"], [2, 3, 4, 8]),
      },
      defaultVar: "temperature",
      title: "Temperature",
      colormaps: [],
    };
    expect(
      getVolumeUnavailableReason(modelInfo, "temperature", gridType, true)
    ).toBe(`Volume rendering is not supported for ${gridType} grids.`);
  }
);

it.each([
  [GRID_TYPES.REGULAR, "EPSG:3857"],
  [
    GRID_TYPES.CURVILINEAR,
    "+proj=lcc +lat_1=56.7 +lat_0=56.7 +lon_0=25 +datum=WGS84",
  ],
])("accepts projected x/y volumes displayed as %s grids", (gridType, crs) => {
  const modelInfo: TModelInfo = {
    vars: {
      "0/so_abs": source(["deptht", "time", "y", "x"], [75, 5, 128, 128]),
      "0/x": source(["x"], [128]),
      "0/y": source(["y"], [128]),
      "0/spatial_ref": { ...source([], []), attrs: { ["crs_wkt"]: crs } },
    },
    defaultVar: "0/so_abs",
    title: "Salinity",
    colormaps: [],
  };
  modelInfo.vars["0/so_abs"].attrs!["grid_mapping"] = "spatial_ref";
  expect(
    getVolumeUnavailableReason(modelInfo, "0/so_abs", gridType, true)
  ).toBeUndefined();
  expect(getVolumeVariablesForGroup(modelInfo, "0/so_abs")).toEqual([
    "0/so_abs",
  ]);
  modelInfo.vars["0/x"].shape = [128, 128];
  expect(
    getVolumeUnavailableReason(modelInfo, "0/so_abs", gridType, true)
  ).toContain("one-dimensional x/y axes");
  modelInfo.vars["0/x"].shape = [128];
  modelInfo.vars["0/spatial_ref"].attrs = {};
  expect(getVolumeVariablesForGroup(modelInfo, "0/so_abs")).toEqual([]);
});

it("distinguishes missing volume data from a ready or initializing renderer", () => {
  const modelInfo: TModelInfo = {
    vars: { surface: source(["time", "lat", "lon"], [2, 4, 8]) },
    defaultVar: "surface",
    title: "Temperature",
    colormaps: [],
  };
  expect(
    getVolumeUnavailableReason(modelInfo, "surface", GRID_TYPES.REGULAR, true)
  ).toContain("recognized vertical axis");
  modelInfo.vars.temperature = source(
    ["time", "level", "lat", "lon"],
    [2, 3, 4, 8]
  );
  expect(
    getVolumeUnavailableReason(modelInfo, "surface", GRID_TYPES.REGULAR, true)
  ).toBeUndefined();
  expect(
    getVolumeUnavailableReason(modelInfo, "surface", GRID_TYPES.REGULAR, false)
  ).toBe("Volume rendering is not ready for this grid yet.");
  expect(
    getVolumeUnavailableReason(undefined, "surface", undefined, false)
  ).toBe("Load a dataset to add a volume layer.");
});
