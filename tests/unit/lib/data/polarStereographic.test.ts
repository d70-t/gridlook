import proj4 from "proj4";
import { expect, it } from "vitest";

import { getCRSFromAttrs } from "@/lib/data/coordinateVariables.ts";

// Grid mapping of iris-test-data polar/toa_brightness_temperature.nc
// (MSG SEVIRI on the Meteosat sphere).
const mapping = {
  ["grid_mapping_name"]: "polar_stereographic",
  ["longitude_of_prime_meridian"]: 0,
  ["earth_radius"]: 6378169,
  ["latitude_of_projection_origin"]: 90,
  ["straight_vertical_longitude_from_pole"]: -35,
  ["false_easting"]: 0,
  ["false_northing"]: 0,
  ["scale_factor_at_projection_origin"]: 1,
};

// Corners and centre of the file's x/y axes. Reference: pyproj
// CRS.from_cf(mapping) -> EPSG:4326.
const REFERENCE = [
  [-2281878.0, -981693.3125, -101.722002, 67.960996],
  [6766404.0, -981693.3125, 46.744929, 33.618432],
  [-2281878.0, -6626247.0, -54.00215, 32.432494],
  [6766404.0, -6626247.0, 10.599591, 16.818181],
  [2260004.5, -3821720.5, -4.401718, 51.618232],
];

it("matches pyproj for the polar stereographic grid mapping", () => {
  const transform = proj4(getCRSFromAttrs(mapping)!, "EPSG:4326");
  for (const [x, y, lon, lat] of REFERENCE) {
    const [actualLon, actualLat] = transform.forward([x, y]);
    expect(actualLon).toBeCloseTo(lon, 5);
    expect(actualLat).toBeCloseTo(lat, 5);
  }
});

it("uses the earth radius instead of WGS84", () => {
  const withoutRadius = { ...mapping, ["earth_radius"]: undefined };
  const transform = proj4(getCRSFromAttrs(withoutRadius)!, "EPSG:4326");
  const [x, y, , lat] = REFERENCE[4];
  // WGS84 moves the grid centre by about 0.07 degrees (7 km, a few pixels).
  expect(Math.abs(transform.forward([x, y])[1] - lat)).toBeGreaterThan(0.05);
});

it("returns null for a projection origin that is not a pole", () => {
  expect(
    getCRSFromAttrs({ ...mapping, ["latitude_of_projection_origin"]: 60 })
  ).toBeNull();
});
