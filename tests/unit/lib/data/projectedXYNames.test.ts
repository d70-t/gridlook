import proj4 from "proj4";
import { beforeEach, expect, it, vi } from "vitest";

import {
  DEFAULT_ANCHOR_CRS,
  findProjectedXYNames,
  hasLengthUnitCoordinates,
} from "@/lib/data/coordinateVariables.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";

vi.mock("@/lib/data/ZarrDataManager.ts", () => ({
  ZarrDataManager: {
    getVariableInfo: vi.fn(),
    resolveVariablePath: vi.fn((_variable: string, name: string) => name),
  },
}));

const AttributeName = {
  AXIS: "axis",
  STANDARD_NAME: "standard_name",
  UNITS: "units",
  ZARR_FORMAT: "zarr_format",
} as const;

const ProjectionStandardName = {
  X: "projection_x_coordinate",
  Y: "projection_y_coordinate",
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

function mockCoordinateAttrs(attrs: Record<string, Record<string, unknown>>) {
  vi.mocked(ZarrDataManager.getVariableInfo).mockImplementation(
    async (_source, name) => {
      if (!(name in attrs)) {
        throw new Error(`No coordinate variable ${name}`);
      }
      return { attrs: attrs[name] } as unknown as Awaited<
        ReturnType<typeof ZarrDataManager.getVariableInfo>
      >;
    }
  );
}

beforeEach(() => {
  vi.mocked(ZarrDataManager.getVariableInfo).mockReset();
});

it("recognizes x/y by the standard_name of their coordinate variables", async () => {
  mockCoordinateAttrs({
    northing: { [AttributeName.STANDARD_NAME]: ProjectionStandardName.Y },
    easting: { [AttributeName.STANDARD_NAME]: ProjectionStandardName.X },
  });

  await expect(
    findProjectedXYNames(SOURCES, "air_temperature", [
      "time",
      "northing",
      "easting",
    ])
  ).resolves.toEqual({ xName: "easting", yName: "northing" });
});

it("does not match a dimension named like the standard_name without the attribute", async () => {
  mockCoordinateAttrs({
    [ProjectionStandardName.Y]: {},
    [ProjectionStandardName.X]: {},
  });

  await expect(
    findProjectedXYNames(SOURCES, "air_temperature", [
      ProjectionStandardName.Y,
      ProjectionStandardName.X,
    ])
  ).resolves.toBeNull();
});

it("recognizes x/y by axis with a length unit (MESO-NH ni/nj)", async () => {
  mockCoordinateAttrs({
    nj: { [AttributeName.AXIS]: "Y", [AttributeName.UNITS]: "m" },
    ni: { [AttributeName.AXIS]: "X", [AttributeName.UNITS]: "m" },
  });

  await expect(
    findProjectedXYNames(SOURCES, "TEMP", ["time", "level", "nj", "ni"])
  ).resolves.toEqual({ xName: "ni", yName: "nj" });
});

it("does not take geographic axes for projected x/y", async () => {
  mockCoordinateAttrs({
    lat: { [AttributeName.AXIS]: "Y", [AttributeName.UNITS]: "degrees_north" },
    lon: { [AttributeName.AXIS]: "X", [AttributeName.UNITS]: "degrees_east" },
  });

  await expect(
    findProjectedXYNames(SOURCES, "TEMP", ["lat", "lon"])
  ).resolves.toBeNull();
});

it("anchors only x/y in metres, not x/y in degrees", async () => {
  mockCoordinateAttrs({
    nj: { [AttributeName.UNITS]: "m" },
    ni: { [AttributeName.UNITS]: "m" },
    y: { [AttributeName.UNITS]: "degrees_north" },
    x: { [AttributeName.UNITS]: "degrees_east" },
  });

  await expect(
    hasLengthUnitCoordinates(SOURCES, "TEMP", ["nj", "ni"])
  ).resolves.toBe(true);
  await expect(
    hasLengthUnitCoordinates(SOURCES, "TEMP", ["y", "x"])
  ).resolves.toBe(false);
});

it("draws the default anchor true to scale from 0°N 0°E", () => {
  const transform = proj4(DEFAULT_ANCHOR_CRS, "EPSG:4326");

  expect(transform.forward([0, 0])).toEqual([0, 0]);
  // 300 km along the equator / a meridian is about 2.7 degrees.
  const [lon] = transform.forward([300000, 0]);
  const [, lat] = transform.forward([0, 300000]);
  expect(lon).toBeCloseTo(2.695, 3);
  expect(lat).toBeCloseTo(2.713, 3);
});

it("still recognizes x/y by name without coordinate variables", async () => {
  mockCoordinateAttrs({});

  await expect(
    findProjectedXYNames(SOURCES, "air_temperature", ["y", "x"])
  ).resolves.toEqual({ xName: "x", yName: "y" });
});
