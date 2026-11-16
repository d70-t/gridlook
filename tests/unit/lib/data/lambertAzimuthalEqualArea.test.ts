import proj4 from "proj4";
import { expect, it } from "vitest";

import { getCRSFromAttrs } from "@/lib/data/coordinateVariables.ts";

// Grid mapping of iris-test-data euro_air_temp.nc; netCDF int64 attributes
// arrive as BigInt.
const mapping = {
  ["grid_mapping_name"]: "lambert_azimuthal_equal_area",
  ["longitude_of_projection_origin"]: 10n,
  ["latitude_of_projection_origin"]: 52n,
  ["false_easting"]: 4321000n,
  ["false_northing"]: 3210000n,
};

it("matches EPSG:3035 for the euro_air_temp.nc grid", () => {
  const transform = proj4(getCRSFromAttrs(mapping)!, "EPSG:4326");
  // Reference pairs from pyproj (EPSG:3035 -> EPSG:4326).
  for (const [x, y, lon, lat] of [
    [650000, 3200000, -36.89917340180391, 41.06647229242462],
    [6800000, 5800000, 70.33267937672188, 64.66143931129756],
    [4321000, 3210000, 10, 52],
    [
      2846428.57142857, 4685714.28571429, -19.436462125333392,
      62.43438355326728,
    ],
  ]) {
    const [actualLon, actualLat] = transform.forward([x, y]);
    expect(actualLon).toBeCloseTo(lon, 6);
    expect(actualLat).toBeCloseTo(lat, 6);
  }
});

it("returns null without a projection origin", () => {
  expect(
    getCRSFromAttrs({
      ...mapping,
      ["latitude_of_projection_origin"]: undefined,
    })
  ).toBeNull();
});
