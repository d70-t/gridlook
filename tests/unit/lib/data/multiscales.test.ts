/* eslint-disable camelcase -- Zarr metadata uses snake_case keys. */
import { describe, expect, it, vi } from "vitest";

import { EARTH_RADIUS_METERS } from "@/lib/camera/cameraSettings.ts";
import {
  groupArrayAssets,
  levelGeometryFromGrid,
  parseMultiscales,
} from "@/lib/data/multiscales.ts";
import type { TDataSource } from "@/lib/types/GlobeTypes.ts";

const METERS_PER_DEGREE = (Math.PI / 180) * EARTH_RADIUS_METERS;

function omeAttrs(
  units: [string, string],
  scales: [number, number][],
  axisType = "space"
) {
  return {
    multiscales: [
      {
        axes: [
          { name: "time", type: "time" },
          { name: "lat", type: axisType, unit: units[0] },
          { name: "lon", type: axisType, unit: units[1] },
        ],
        datasets: scales.map((scale, index) => ({
          path: String(index),
          coordinateTransformations: [{ type: "scale", scale: [1, ...scale] }],
        })),
      },
    ],
  };
}

describe("parseMultiscales", () => {
  it("lists OME-NGFF datasets as declared with their ground resolution", () => {
    const levels = parseMultiscales(
      omeAttrs(
        ["degree", "degrees_east"],
        [
          [0.25, 0.25],
          [0.5, 0.5],
        ]
      )
    );
    expect(levels.map((level) => level.path)).toEqual(["0", "1"]);
    expect(levels[0].resolution).toBeCloseTo(0.25 * METERS_PER_DEGREE, 6);
    expect(levels[1].resolution).toBeCloseTo(0.5 * METERS_PER_DEGREE, 6);
  });

  it("averages the spatial axes in metres and converts kilometres", () => {
    const [level] = parseMultiscales(omeAttrs(["km", "metre"], [[1, 1000]]));
    expect(level.resolution).toBe(1000);
  });

  it("leaves the resolution out for units it cannot convert", () => {
    const [level] = parseMultiscales(omeAttrs(["pixel", "pixel"], [[1, 1]]));
    expect(level.path).toBe("0");
    expect(level.resolution).toBeUndefined();
  });

  it("leaves the resolution out without spatial axes or a scale", () => {
    expect(
      parseMultiscales(omeAttrs(["degree", "degree"], [[1, 1]], "channel"))[0]
        .resolution
    ).toBeUndefined();
    expect(
      parseMultiscales({
        multiscales: [{ datasets: [{ path: "0" }, { path: "1" }] }],
      })
    ).toEqual([{ path: "0" }, { path: "1" }]);
  });
});

describe("parseMultiscales for ndpyramid", () => {
  it("reads web-mercator resolutions from the zoom and tile size", () => {
    // 2πR at the equator of Web Mercator's sphere
    const equator = 2 * Math.PI * 6378137;
    const entries = parseMultiscales({
      multiscales: [
        {
          datasets: [
            { path: "0", crs: "EPSG:3857", pixels_per_tile: 128 },
            { path: "1", level: 1, crs: "EPSG:3857", pixels_per_tile: 128 },
            { path: "a", crs: "EPSG:3857", pixels_per_tile: 128 },
            { path: "b", level: "3", crs: "EPSG:3857", pixels_per_tile: 128 },
            { path: "4", level: "x", crs: "EPSG:3857", pixels_per_tile: 128 },
          ],
        },
      ],
    });
    expect(entries[0].resolution).toBeCloseTo(equator / 128, 6);
    expect(entries[1].resolution).toBeCloseTo(equator / 256, 6);
    expect(entries[2].resolution).toBeUndefined();
    expect(entries[3].resolution).toBeCloseTo(equator / 1024, 6);
    expect(entries[4].resolution).toBeCloseTo(equator / 2048, 6);
  });
});

describe("parseMultiscales for OME-NGFF 0.5", () => {
  it("reads the multiscales nested under `ome`", () => {
    const levels = parseMultiscales({
      ome: {
        version: "0.5",
        ...omeAttrs(
          ["degree", "degree"],
          [
            [0.25, 0.25],
            [0.5, 0.5],
          ]
        ),
      },
    });
    expect(levels.map((level) => level.path)).toEqual(["0", "1"]);
    expect(levels[1].resolution).toBeCloseTo(0.5 * METERS_PER_DEGREE, 6);
  });
});

describe("parseMultiscales for GeoZarr", () => {
  it("orders GeoZarr tile matrices finest first with WebMercatorQuad resolutions", () => {
    const levels = parseMultiscales({
      multiscales: [
        {
          tile_matrix_set: "WebMercatorQuad",
          tile_matrix_limits: { "0": {}, "1": {}, "2": {} },
        },
      ],
    });
    expect(levels.map((level) => level.path)).toEqual(["2", "1", "0"]);
    expect(levels[0].resolution).toBeCloseTo(156543.03392804097 / 4, 6);
    expect(levels[2].resolution).toBeCloseTo(156543.03392804097, 6);
  });

  it("keeps named tile matrices as declared without a known resolution", () => {
    const levels = parseMultiscales({
      multiscales: [
        {
          tile_matrix_set: { id: "CustomGrid" },
          tile_matrix_limits: { coarse: {}, fine: {} },
        },
      ],
    });
    expect(levels).toEqual([{ path: "coarse" }, { path: "fine" }]);
  });
});

describe("parseMultiscales for a zarr-conventions layout", () => {
  it("lists the layout's assets as declared, without a resolution", () => {
    const levels = parseMultiscales({
      multiscales: {
        layout: [
          { asset: "0" },
          { asset: "1", derived_from: "0", transform: { scale: [2, 2] } },
          { derived_from: "1" },
        ],
        resampling_method: "mean",
      },
    });
    expect(levels).toEqual([{ path: "0" }, { path: "1" }]);
  });
});

describe("groupArrayAssets", () => {
  const isArray = (path: string) => path.includes("/");

  it("folds the arrays of a per-array layout into their parent groups", () => {
    const levels = groupArrayAssets(
      [
        { path: "3/a" },
        { path: "2/b" },
        { path: "1/a" },
        { path: "1/b" },
        { path: "0/a" },
        { path: "0/b" },
      ],
      isArray
    );
    expect(levels).toEqual([
      { path: "3" },
      { path: "2" },
      { path: "1" },
      { path: "0" },
    ]);
  });

  it("keeps level groups as declared and merges a group with its arrays", () => {
    const levels = groupArrayAssets(
      [
        { path: "1/", resolution: 2 },
        { path: "1/a" },
        { path: "0/a", resolution: 4 },
        { path: "0/b", resolution: 8 },
      ],
      isArray
    );
    expect(levels).toEqual([
      { path: "1", resolution: 2 },
      { path: "0", resolution: 4 },
    ]);
  });

  it("takes an array at the multiscales group itself as its level", () => {
    expect(groupArrayAssets([{ path: "a" }], () => true)).toEqual([
      { path: "" },
    ]);
  });
});

describe("parseMultiscales for inline GeoZarr tile matrix sets", () => {
  it("reads the cell size of an inline tile matrix set", () => {
    const tileMatrixSet = (crs: string) => ({
      id: "Regional",
      crs,
      tileMatrices: [
        { id: "coarse", cellSize: 2 },
        { id: "fine", cellSize: 0.5 },
      ],
    });
    const projected = parseMultiscales({
      multiscales: { tile_matrix_set: tileMatrixSet("EPSG:32633") },
    });
    expect(projected).toEqual([
      { path: "fine", resolution: 0.5 },
      { path: "coarse", resolution: 2 },
    ]);
    const geographic = parseMultiscales({
      multiscales: {
        tile_matrix_set: tileMatrixSet(
          "http://www.opengis.net/def/crs/OGC/1.3/CRS84"
        ),
        tile_matrix_limits: { coarse: {}, fine: {} },
      },
    });
    expect(geographic.map(({ path }) => path)).toEqual(["fine", "coarse"]);
    expect(geographic[0].resolution).toBeCloseTo(0.5 * METERS_PER_DEGREE, 6);
  });

  it("declares no levels without a usable multiscales attribute", () => {
    expect(parseMultiscales({})).toEqual([]);
    expect(parseMultiscales({ multiscales: "0.4" })).toEqual([]);
    expect(parseMultiscales({ multiscales: [] })).toEqual([]);
    expect(parseMultiscales({ multiscales: [{ version: "0.4" }] })).toEqual([]);
  });
});

function source(overrides: Partial<TDataSource> = {}): TDataSource {
  return { store: "store", dataset: "0", ...overrides };
}

describe("levelGeometryFromGrid", () => {
  const readAxis = vi.fn(async () => [0, 0.25]);

  it("takes the HEALPix nside from the CRS variable", async () => {
    const geometry = await levelGeometryFromGrid(
      {
        crs: source({
          attrs: { grid_mapping_name: "healpix", healpix_nside: 1024 },
        }),
        tas: source({ shape: [10, 12 * 1024 * 1024] }),
      },
      readAxis
    );
    expect(geometry.cellCount).toBe(12 * 1024 * 1024);
    expect(geometry.resolution).toBeCloseTo(
      (EARTH_RADIUS_METERS * Math.sqrt(Math.PI / 3)) / 1024,
      6
    );
    expect(readAxis).not.toHaveBeenCalled();
  });
});

describe("levelGeometryFromGrid on sparse HEALPix", () => {
  const readAxis = vi.fn(async () => [0, 0.25]);

  it("counts only the cells a sparse HEALPix level stores", async () => {
    const geometry = await levelGeometryFromGrid(
      {
        crs: source({
          attrs: { grid_mapping_name: "healpix", healpix_nside: 2 ** 16 },
        }),
        cell: source({
          shape: [5000],
          hidden: true,
          attrs: { dimensionNames: ["cell"] },
        }),
        tas: source({
          shape: [10, 5000],
          attrs: { dimensionNames: ["time", "cell"] },
        }),
      },
      readAxis
    );
    expect(geometry.cellCount).toBe(5000);
    expect(geometry.resolution).toBeCloseTo(
      (EARTH_RADIUS_METERS * Math.sqrt(Math.PI / 3)) / 2 ** 16,
      6
    );
  });
});

describe("levelGeometryFromGrid for the DGGS convention", () => {
  it("takes the HEALPix nside from the DGGS convention", async () => {
    const geometry = await levelGeometryFromGrid(
      {
        cell_ids: source({
          shape: [300],
          hidden: true,
          attrs: { dimensionNames: ["zone"] },
        }),
        tas: source({
          shape: [10, 300],
          attrs: { dimensionNames: ["time", "zone"] },
        }),
      },
      undefined,
      {
        dggs: {
          name: "healpix",
          refinement_level: 14,
          indexing_scheme: "nested",
          coordinate: "cell_ids",
        },
      }
    );
    expect(geometry).toEqual({
      resolution: (EARTH_RADIUS_METERS * Math.sqrt(Math.PI / 3)) / 2 ** 14,
      cellCount: 300,
    });
  });

  it("infers the HEALPix nside from a global cell dimension", async () => {
    const geometry = await levelGeometryFromGrid({
      tas: source({
        shape: [10, 12 * 16],
        attrs: { dimensionNames: ["time", "cell"] },
      }),
    });
    expect(geometry).toEqual({
      resolution: (EARTH_RADIUS_METERS * Math.sqrt(Math.PI / 3)) / 4,
      cellCount: 12 * 16,
    });
  });
});

describe("levelGeometryFromGrid on regular grids", () => {
  const readAxis = vi.fn(async () => [0, 0.25]);

  it("reads the spacing of a regular longitude coordinate", async () => {
    const geometry = await levelGeometryFromGrid(
      {
        lat: source({ shape: [720], hidden: true }),
        lon: source({ shape: [1440], hidden: true }),
        tas: source({
          shape: [10, 720, 1440],
          attrs: { dimensionNames: ["time", "lat", "lon"] },
        }),
      },
      readAxis
    );
    expect(readAxis).toHaveBeenCalledWith("lon");
    expect(geometry.resolution).toBeCloseTo(0.25 * METERS_PER_DEGREE, 6);
    expect(geometry.cellCount).toBe(720 * 1440);
  });

  it("counts the cells of a projected grid without a resolution", async () => {
    readAxis.mockClear();
    const geometry = await levelGeometryFromGrid(
      {
        x: source({ shape: [500] }),
        tas: source({
          shape: [500, 500],
          attrs: { dimensionNames: ["y", "x"] },
        }),
      },
      readAxis
    );
    expect(geometry).toEqual({ cellCount: 500 * 500 });
    expect(readAxis).not.toHaveBeenCalled();
  });
  it("knows nothing about grids without spatial dimensions", async () => {
    const geometry = await levelGeometryFromGrid(
      {
        tas: source({
          shape: [10, 7],
          attrs: { dimensionNames: ["time", "ncells"] },
        }),
      },
      readAxis
    );
    expect(geometry).toEqual({});
  });
});

describe("levelGeometryFromGrid on projected grids", () => {
  it("reads the spacing of a projected x coordinate in metres", async () => {
    const geometry = await levelGeometryFromGrid(
      {
        x: source({ shape: [128], attrs: { units: "metre" } }),
        tas: source({
          shape: [128, 128],
          attrs: { dimensionNames: ["y", "x"] },
        }),
      },
      async () => [0, 312.5]
    );
    expect(geometry).toEqual({ resolution: 312.5, cellCount: 128 * 128 });
  });
});
