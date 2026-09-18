import proj4 from "proj4";
import { expect, it } from "vitest";

import { getRotatedPoleCRS } from "@/lib/data/coordinateVariables.ts";
import { GRID_TYPES } from "@/lib/data/gridTypeDetector.ts";
import type { TModelInfo } from "@/lib/types/GlobeTypes.ts";
import { getProjectedVolumeMapping } from "@/lib/volume/projectedVolumeMapping.ts";
import { VOLUME_GRID_TYPES } from "@/lib/volume/volumeGrid.ts";
import { buildVolumeTexture } from "@/lib/volume/volumeTexture.ts";
import {
  getVolumeUnavailableReason,
  projectedVolumeCRS,
} from "@/lib/volume/volumeVariables.ts";

const pole = {
  ["grid_mapping_name"]: "rotated_latitude_longitude",
  ["grid_north_pole_latitude"]: "39.25",
  ["grid_north_pole_longitude"]: "-162.0",
};

it("matches the stored geographic coordinates of the PIK-STARS3 EUR-11 grid", () => {
  const transform = proj4(getRotatedPoleCRS(pole)!, "EPSG:4326");
  // Independent reference pairs from the file's rlon/rlat and lon/lat arrays.
  for (const [rlon, rlat, lon, lat] of [
    [-28.375, -23.375, -10.063879662216031, 21.98782875683831],
    [18.155, -23.375, 36.41382968450823, 25.1142623886123],
    [-28.375, 21.835, -44.59386389190011, 60.203763369090005],
    [18.155, 21.835, 64.96437666717895, 66.68983654206978],
    [-5.055, -0.715, 10.159980150426628, 49.76709798897581],
  ]) {
    const geographic = transform.forward([rlon, rlat]);
    const native = transform.inverse([lon, lat]);
    expect(geographic[0]).toBeCloseTo(lon, 9);
    expect(geographic[1]).toBeCloseTo(lat, 9);
    expect(native[0]).toBeCloseTo(rlon, 9);
    expect(native[1]).toBeCloseTo(rlat, 9);
  }
});

it("samples wrapped rotated axes and preserves their source rows", () => {
  const grid = {
    kind: VOLUME_GRID_TYPES.PROJECTED,
    x: new Float32Array([359, 0, 1]),
    y: new Float32Array([1, 0, -1]),
    crs: getRotatedPoleCRS({
      ...pole,
      ["grid_north_pole_latitude"]: 90,
      ["grid_north_pole_longitude"]: -180,
    })!,
  };
  const { sourceCells } = getProjectedVolumeMapping(grid, 3, 3);
  expect(Array.from(sourceCells)).toEqual([6, 7, 8, 3, 4, 5, 0, 1, 2]);
  const result = buildVolumeTexture(
    {
      grid,
      sourceCellCount: 9,
      sourceLevelCount: 2,
      values: [new Float32Array(18).fill(1)],
      dimensions: { width: 3, height: 3, depth: 2, byteLength: 18 },
    },
    undefined
  );
  expect(result.data.every((value) => value > 0)).toBe(true);
});

it("requires valid pole metadata before enabling rotated volumes", () => {
  const source = { store: "local.nc", dataset: "" };
  const modelInfo: TModelInfo = {
    title: "Rotated",
    defaultVar: "ddp",
    colormaps: [],
    vars: {
      ddp: {
        ...source,
        shape: [1, 25, 412, 424],
        attrs: {
          dimensionNames: ["time", "bin", "rlat", "rlon"],
          ["grid_mapping"]: "rotated_pole",
        },
      },
      bin: { ...source, shape: [25], attrs: { axis: "Z", units: "level" } },
      rlat: { ...source, shape: [412] },
      rlon: { ...source, shape: [424] },
      ["rotated_pole"]: { ...source, shape: [], attrs: pole },
    },
  };
  expect(projectedVolumeCRS("ddp", modelInfo.vars)).toBe(
    getRotatedPoleCRS(pole)
  );
  expect(
    getVolumeUnavailableReason(
      modelInfo,
      "ddp",
      GRID_TYPES.REGULAR_ROTATED,
      true
    )
  ).toBeUndefined();
  modelInfo.vars.rotated_pole.attrs = {
    ...pole,
    ["grid_north_pole_latitude"]: "invalid",
  };
  expect(
    getVolumeUnavailableReason(
      modelInfo,
      "ddp",
      GRID_TYPES.REGULAR_ROTATED,
      true
    )
  ).toContain("valid pole coordinates");
});
