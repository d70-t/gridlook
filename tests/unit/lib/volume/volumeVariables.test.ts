import { describe, expect, it } from "vitest";

import type { TDataSource, TModelInfo } from "@/lib/types/GlobeTypes.ts";
import {
  getHealpixVolumeVariables,
  getHealpixVolumeVariablesForGroup,
  isHealpixVolumeVariable,
  preferredVolumeVariable,
  volumeVariableColor,
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
      isHealpixVolumeVariable(
        source(["time", "level_full", "cell"], [2, 90, 48])
      )
    ).toBe(true);
    expect(isHealpixVolumeVariable(source(["time", "cell"], [2, 48]))).toBe(
      false
    );
    expect(
      isHealpixVolumeVariable(
        source(["time", "level", "lat", "lon"], [2, 3, 4, 8])
      )
    ).toBe(false);
    expect(
      isHealpixVolumeVariable(
        source(
          ["valid_time", "pressure", "latitude", "longitude"],
          [2, 3, 4, 8]
        )
      )
    ).toBe(false);
  });

  it("filters hidden variables and prefers cloud water over cloud ice", () => {
    const modelInfo = {
      vars: {
        cli: source(["time", "level_full", "cell"], [2, 90, 48]),
        clw: source(["time", "level_full", "cell"], [2, 90, 48]),
        surface: source(["time", "cell"], [2, 48]),
      },
    } as unknown as TModelInfo;
    const variables = getHealpixVolumeVariables(modelInfo);
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
      getHealpixVolumeVariablesForGroup(modelInfo, "multiscales/zoom_6/clivi")
    ).toEqual(["multiscales/zoom_6/clw"]);
  });

  it("provides cloud defaults and checks grid compatibility", () => {
    const cloud = source(["time", "level_full", "cell"], [2, 90, 48]);
    const otherCloud = source(["time", "level_full", "cell"], [2, 90, 48]);
    const ocean = source(["time", "depth_full", "cell"], [2, 128, 48]);
    expect(volumeVariableColor("clw")).toBe("#ffffff");
    expect(volumeVariableColor("cli")).toBe("#72b7ff");
    expect(volumeVariableOpacity()).toBe(0.75);
    expect(volumeVariablesAreCompatible(cloud, otherCloud)).toBe(true);
    expect(volumeVariablesAreCompatible(cloud, ocean)).toBe(false);
  });
});
