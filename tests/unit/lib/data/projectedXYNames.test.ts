import { beforeEach, expect, it, vi } from "vitest";

import { findProjectedXYNames } from "@/lib/data/coordinateVariables.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { ZARR_FORMAT, type TSources } from "@/lib/types/GlobeTypes.ts";

vi.mock("@/lib/data/ZarrDataManager.ts", () => ({
  ZarrDataManager: {
    getVariableInfo: vi.fn(),
    resolveVariablePath: vi.fn((_variable: string, name: string) => name),
  },
}));

const AttributeName = {
  STANDARD_NAME: "standard_name",
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

it("still recognizes x/y by name without coordinate variables", async () => {
  mockCoordinateAttrs({});

  await expect(
    findProjectedXYNames(SOURCES, "air_temperature", ["y", "x"])
  ).resolves.toEqual({ xName: "x", yName: "y" });
});
