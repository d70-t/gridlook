/* eslint-disable camelcase -- Zarr metadata uses snake_case keys. */
import { afterEach, describe, expect, it, vi } from "vitest";

import { EARTH_RADIUS_METERS } from "@/lib/camera/cameraSettings.ts";
import { coarsestLevelOf, hasLevels } from "@/lib/data/levels.ts";
import { indexFromIndex, indexFromZarr } from "@/lib/data/sourceIndexing.ts";

const REPO = "https://example.test/repo.icechunk";

// An in-memory Zarr v3 repository standing in for an Icechunk one at REPO.
const icechunk = vi.hoisted(() => ({
  files: new Map<string, unknown>(),
}));

vi.mock("icechunk-js", () => ({
  IcechunkStore: {
    open: async (url: string) => {
      if (url !== "https://example.test/repo.icechunk") {
        throw new Error("Not a valid icechunk repository");
      }
      return {
        get: async (key: string) => {
          const file = icechunk.files.get(key.replace(/^\//, ""));
          return file === undefined
            ? undefined
            : new TextEncoder().encode(JSON.stringify(file));
        },
        listNodes: () =>
          [...icechunk.files.entries()].map(([key, node]) => ({
            path: `/${key.replace(/\/?zarr\.json$/, "")}`,
            nodeData: { type: (node as { node_type: string }).node_type },
          })),
      };
    },
  },
}));

const SRC = "https://example.test/pyramid.zarr";

type TLevelSpec = { path: string; nlat: number; nlon: number };

function zarray(length: number[]) {
  return {
    zarr_format: 2,
    shape: length,
    chunks: length,
    dtype: "<f8",
    compressor: null,
    filters: null,
    fill_value: 0,
    order: "C",
  };
}

/** Consolidated v2 metadata of a lat/lon pyramid, one child group a level. */
function pyramidMetadata(
  levels: TLevelSpec[],
  rootAttrs: Record<string, unknown>
) {
  const metadata: Record<string, unknown> = {
    ".zgroup": { zarr_format: 2 },
    ".zattrs": rootAttrs,
  };
  for (const { path, nlat, nlon } of levels) {
    metadata[`${path}/.zgroup`] = { zarr_format: 2 };
    metadata[`${path}/lat/.zarray`] = zarray([nlat]);
    metadata[`${path}/lat/.zattrs`] = { _ARRAY_DIMENSIONS: ["lat"] };
    metadata[`${path}/lon/.zarray`] = zarray([nlon]);
    metadata[`${path}/lon/.zattrs`] = { _ARRAY_DIMENSIONS: ["lon"] };
    metadata[`${path}/tas/.zarray`] = zarray([nlat, nlon]);
    metadata[`${path}/tas/.zattrs`] = { _ARRAY_DIMENSIONS: ["lat", "lon"] };
  }
  return { zarr_consolidated_format: 1, metadata };
}

function omeAttrs(paths: string[]) {
  return { multiscales: [{ datasets: paths.map((path) => ({ path })) }] };
}

function longitudes(nlon: number) {
  const step = 360 / nlon;
  return Float64Array.from({ length: nlon }, (_, index) => index * step);
}

function requestUrl(input: RequestInfo | URL) {
  return input instanceof Request ? input.url : String(input);
}

/**
 * Serve `files` (JSON, typed arrays, or an Error to throw) by URL; anything
 * else is a 404. Returns the fetch mock so a test can inspect the requests.
 */
function serve(files: Record<string, unknown>) {
  return vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const file = files[requestUrl(input)];
    if (file instanceof Error) {
      throw file;
    }
    if (file instanceof Float64Array) {
      return new Response(file.buffer as ArrayBuffer);
    }
    if (file === undefined) {
      return new Response(null, { status: 404 });
    }
    return new Response(JSON.stringify(file));
  });
}

function pyramidFiles(
  levels: TLevelSpec[],
  rootAttrs: Record<string, unknown> = {}
) {
  const files: Record<string, unknown> = {
    [`${SRC}/.zmetadata`]: pyramidMetadata(levels, rootAttrs),
  };
  for (const { path, nlon } of levels) {
    files[`${SRC}/${path}/lon/0`] = longitudes(nlon);
  }
  return files;
}

const LEVELS: TLevelSpec[] = [
  { path: "0", nlat: 180, nlon: 360 },
  { path: "1", nlat: 90, nlon: 180 },
  { path: "2", nlat: 45, nlon: 90 },
];

afterEach(() => {
  vi.restoreAllMocks();
});

describe("indexing a pyramid whose levels fail to read", () => {
  it("leaves out a level whose grid cannot be read", async () => {
    const files = pyramidFiles(LEVELS, omeAttrs(["0", "1", "2"]));
    files[`${SRC}/1/lon/0`] = new TypeError("network error");
    serve(files);
    const index = await indexFromZarr(SRC);
    expect(index.levels.map((level) => level.name)).toEqual(["0", "2"]);
  });

  it("opens as a single level when fewer than two levels survive", async () => {
    const files = pyramidFiles(LEVELS.slice(0, 2), omeAttrs(["0", "1"]));
    files[`${SRC}/0/lon/0`] = new TypeError("network error");
    serve(files);
    const index = await indexFromZarr(SRC);
    expect(index.levels).toHaveLength(1);
    expect(Object.keys(index.levels[0].datasources)).toEqual(
      expect.arrayContaining(["0/tas", "1/tas"])
    );
  });

  it("does not read the grid when the attributes give the resolution", async () => {
    const attrs = {
      multiscales: [
        {
          axes: [
            { name: "lat", type: "space", unit: "degree" },
            { name: "lon", type: "space", unit: "degree" },
          ],
          datasets: ["0", "1"].map((path, index) => ({
            path,
            coordinateTransformations: [
              { type: "scale", scale: [2 ** index, 2 ** index] },
            ],
          })),
        },
      ],
    };
    const fetchMock = serve(pyramidFiles(LEVELS.slice(0, 2), attrs));
    const index = await indexFromZarr(SRC);
    expect(index.levels.map((level) => level.cellCount)).toEqual([
      180 * 360,
      90 * 180,
    ]);
    const urls = fetchMock.mock.calls.map(([input]) => requestUrl(input));
    expect(urls.some((url) => url.endsWith("/lon/0"))).toBe(false);
  });
});

describe("indexing a HEALPix pyramid under the DGGS convention", () => {
  it("reads each level's refinement level and stored cell count", async () => {
    const metadata: Record<string, unknown> = {
      ".zgroup": { zarr_format: 2 },
      ".zattrs": omeAttrs(["14", "13"]),
    };
    for (const [path, cells] of [
      ["14", 4000],
      ["13", 1000],
    ] as const) {
      metadata[`${path}/.zgroup`] = { zarr_format: 2 };
      metadata[`${path}/.zattrs`] = {
        dggs: { name: "healpix", refinement_level: Number(path) },
      };
      metadata[`${path}/cell_ids/.zarray`] = zarray([cells]);
      metadata[`${path}/cell_ids/.zattrs`] = { _ARRAY_DIMENSIONS: ["cells"] };
      metadata[`${path}/tas/.zarray`] = zarray([cells]);
      metadata[`${path}/tas/.zattrs`] = { _ARRAY_DIMENSIONS: ["cells"] };
    }
    serve({
      [`${SRC}/.zmetadata`]: { zarr_consolidated_format: 1, metadata },
    });
    const index = await indexFromZarr(SRC);
    const nsideResolution = (order: number) =>
      (EARTH_RADIUS_METERS * Math.sqrt(Math.PI / 3)) / 2 ** order;
    expect(index.levels.map(({ cellCount }) => cellCount)).toEqual([
      4000, 1000,
    ]);
    expect(index.levels[0].resolution).toBeCloseTo(nsideResolution(14), 6);
    expect(index.levels[1].resolution).toBeCloseTo(nsideResolution(13), 6);
  });
});

/**
 * Consolidated v2 metadata of a HEALPix pyramid whose `multiscales` layout
 * describes arrays, as healpix-convert writes it when the variables of a
 * derived level come from different native levels: "a" is converted at the
 * level 3, "b" at the level 2, both aggregated to the levels 1 and 0.
 */
function arrayLayoutMetadata() {
  const layout = [
    { asset: "3/a" },
    { asset: "2/b" },
    { asset: "1/a", derived_from: "3/a", transform: { scale: [4] } },
    { asset: "1/b", derived_from: "2/b", transform: { scale: [2] } },
    { asset: "0/a", derived_from: "3/a", transform: { scale: [8] } },
    { asset: "0/b", derived_from: "2/b", transform: { scale: [4] } },
  ];
  const metadata: Record<string, unknown> = {
    ".zgroup": { zarr_format: 2 },
    ".zattrs": { multiscales: { layout, resampling_method: "mean" } },
  };
  const variables: Record<string, string[]> = {
    "3": ["a"],
    "2": ["b"],
    "1": ["a", "b"],
    "0": ["a", "b"],
  };
  for (const [path, names] of Object.entries(variables)) {
    const cells = 12 * 4 ** Number(path);
    metadata[`${path}/.zgroup`] = { zarr_format: 2 };
    metadata[`${path}/.zattrs`] = {
      dggs: { name: "healpix", refinement_level: Number(path) },
    };
    metadata[`${path}/cell_ids/.zarray`] = zarray([cells]);
    metadata[`${path}/cell_ids/.zattrs`] = { _ARRAY_DIMENSIONS: ["cells"] };
    for (const name of names) {
      metadata[`${path}/${name}/.zarray`] = zarray([cells]);
      metadata[`${path}/${name}/.zattrs`] = { _ARRAY_DIMENSIONS: ["cells"] };
    }
  }
  return { zarr_consolidated_format: 1, metadata };
}

describe("indexing a pyramid whose layout describes arrays", () => {
  it("reads one level per parent group, with the level group's grid", async () => {
    serve({ [`${SRC}/.zmetadata`]: arrayLayoutMetadata() });
    const index = await indexFromZarr(SRC);
    expect(index.levels.map((level) => level.name)).toEqual([
      "3",
      "2",
      "1",
      "0",
    ]);
    expect(index.levels.map(({ path }) => path)).toEqual(["3", "2", "1", "0"]);
    expect(
      index.levels.map(({ datasources }) =>
        Object.keys(datasources)
          .filter((name) => !datasources[name].hidden)
          .sort()
      )
    ).toEqual([["3/a"], ["2/b"], ["1/a", "1/b"], ["0/a", "0/b"]]);
    expect(index.levels.map(({ cellCount }) => cellCount)).toEqual([
      12 * 4 ** 3,
      12 * 4 ** 2,
      12 * 4,
      12,
    ]);
    const nsideResolution = (order: number) =>
      (EARTH_RADIUS_METERS * Math.sqrt(Math.PI / 3)) / 2 ** order;
    expect(index.levels[0].resolution).toBeCloseTo(nsideResolution(3), 6);
    expect(index.levels[3].resolution).toBeCloseTo(nsideResolution(0), 6);
  });
});

function jsonIndex(stores: string[]) {
  return {
    zarr_format: 2,
    levels: stores.map((store) => ({
      grid: { store, dataset: "" },
      time: { store, dataset: "" },
      datasources: { tas: { store, dataset: "" } },
    })),
  };
}

function flatStore(nlat: number, nlon: number) {
  return {
    zarr_consolidated_format: 1,
    metadata: {
      ".zgroup": { zarr_format: 2 },
      ".zattrs": {},
      "tas/.zarray": zarray([nlat, nlon]),
      "tas/.zattrs": { _ARRAY_DIMENSIONS: ["lat", "lon"] },
    },
  };
}

describe("indexing a JSON index whose levels fail to read", () => {
  const INDEX = "https://example.test/index.json";
  const FINE = "https://example.test/fine.zarr";
  const COARSE = "https://example.test/coarse.zarr";

  it("leaves out a further level whose store cannot be read", async () => {
    serve({
      [INDEX]: jsonIndex([FINE, COARSE]),
      [`${FINE}/.zmetadata`]: flatStore(180, 360),
    });
    const index = await indexFromIndex(INDEX);
    expect(index.levels).toHaveLength(1);
    expect(index.levels[0].datasources.tas.shape).toEqual([180, 360]);
  });

  it("still fails when the first level's store cannot be read", async () => {
    serve({
      [INDEX]: jsonIndex([FINE, COARSE]),
      [`${COARSE}/.zmetadata`]: flatStore(90, 180),
    });
    await expect(indexFromIndex(INDEX)).rejects.toThrow();
  });
});

function v3Array(shape: number[], dimensions: string[]) {
  return {
    zarr_format: 3,
    node_type: "array",
    shape,
    data_type: "float32",
    chunk_grid: { name: "regular", configuration: { chunk_shape: shape } },
    chunk_key_encoding: { name: "default", configuration: { separator: "/" } },
    fill_value: 0,
    codecs: [{ name: "bytes", configuration: { endian: "little" } }],
    dimension_names: dimensions,
    attributes: {},
  };
}

function scaledOmeAttrs(paths: string[]) {
  return {
    multiscales: [
      {
        axes: [
          { name: "lat", type: "space", unit: "degree" },
          { name: "lon", type: "space", unit: "degree" },
        ],
        datasets: paths.map((path, index) => ({
          path,
          coordinateTransformations: [
            { type: "scale", scale: [2 ** index, 2 ** index] },
          ],
        })),
      },
    ],
  };
}

describe("indexing a multiscales pyramid", () => {
  it("indexes one level per declared group, finest first", async () => {
    serve(pyramidFiles(LEVELS, omeAttrs(["0", "1", "2"])));
    const index = await indexFromZarr(SRC);
    expect(index.levels).toHaveLength(3);
    index.levels.forEach((level, position) => {
      const path = String(position);
      expect(level.name).toBe(path);
      expect(level.path).toBe(path);
      expect(level.grid).toEqual({ store: SRC, dataset: "" });
      expect(level.time).toEqual({ store: SRC, dataset: "" });
      // keyed by the full path, as without levels
      expect(Object.keys(level.datasources).sort()).toEqual([
        `${path}/lat`,
        `${path}/lon`,
        `${path}/tas`,
      ]);
      expect(level.datasources[`${path}/tas`].hidden).toBe(false);
    });
    const degree = (Math.PI / 180) * EARTH_RADIUS_METERS;
    expect(index.levels[0].resolution).toBeCloseTo(degree, 6);
    expect(index.levels[2].resolution).toBeCloseTo(4 * degree, 6);
    expect(index.levels.map(({ cellCount }) => cellCount)).toEqual([
      180 * 360,
      90 * 180,
      45 * 90,
    ]);
  });

  it.each([
    ["without a multiscales attribute", {}],
    ["when the declared groups hold no arrays", omeAttrs(["a", "b"])],
    ["when only one declared group holds arrays", omeAttrs(["0", "b"])],
  ])("opens a single level %s", async (_, attrs) => {
    serve(pyramidFiles(LEVELS.slice(0, 2), attrs));
    const index = await indexFromZarr(SRC);
    expect(index.levels).toHaveLength(1);
    expect(index.levels[0].grid).toEqual({ store: SRC, dataset: "" });
    expect(Object.keys(index.levels[0].datasources)).toEqual(
      expect.arrayContaining(["0/tas", "1/tas"])
    );
  });
});

describe("indexing an ndpyramid pyramid", () => {
  it("orders the levels, listed coarsest first, finest first", async () => {
    const levels = [
      { path: "0", nlat: 45, nlon: 90 },
      { path: "1", nlat: 90, nlon: 180 },
    ];
    serve(
      pyramidFiles(levels, {
        multiscales: [
          {
            datasets: levels.map(({ path }) => ({
              path,
              crs: "EPSG:3857",
              pixels_per_tile: 128,
            })),
          },
        ],
      })
    );
    const index = await indexFromZarr(SRC);
    expect(index.levels.map(({ path }) => path)).toEqual(["1", "0"]);
    expect(index.levels[0].resolution).toBeCloseTo(
      (2 * Math.PI * 6378137) / 256,
      6
    );
  });
});

describe("indexing what a multiscales group holds besides its levels", () => {
  it("keeps root arrays and sibling groups as variables without levels", async () => {
    const files = pyramidFiles(LEVELS.slice(0, 2), omeAttrs(["0", "1"]));
    const { metadata } = files[`${SRC}/.zmetadata`] as {
      metadata: Record<string, unknown>;
    };
    metadata["root_only/.zarray"] = zarray([180, 360]);
    metadata["root_only/.zattrs"] = { _ARRAY_DIMENSIONS: ["lat", "lon"] };
    metadata["quality/.zgroup"] = { zarr_format: 2 };
    metadata["quality/mask/.zarray"] = zarray([180, 360]);
    metadata["quality/mask/.zattrs"] = { _ARRAY_DIMENSIONS: ["lat", "lon"] };
    serve(files);
    const index = await indexFromZarr(SRC);
    expect(index.levels.map(({ path }) => path)).toEqual(["0", "1"]);
    for (const [position, level] of index.levels.entries()) {
      const visible = Object.entries(level.datasources)
        .filter(([, source]) => !source.hidden)
        .map(([name]) => name)
        .sort();
      expect(visible).toEqual([`${position}/tas`, "quality/mask", "root_only"]);
    }
    const { levels } = index;
    expect(hasLevels(levels, "0/tas")).toBe(true);
    expect(hasLevels(levels, "root_only")).toBe(false);
    expect(coarsestLevelOf(levels, "root_only")).toBeUndefined();
  });
});

/**
 * The waterpark layout: zarr v2 whose root holds only the group
 * `multiscales/`, carrying a zarr-conventions layout of `zoom_9 … zoom_0`.
 */
function waterparkMetadata() {
  const layout = [9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((zoom) => ({
    asset: `zoom_${zoom}`,
    ...(zoom < 9
      ? { derived_from: `zoom_${zoom + 1}`, transform: { scale: [2.0] } }
      : {}),
  }));
  const metadata: Record<string, unknown> = {
    ".zgroup": { zarr_format: 2 },
    ".zattrs": { dataset_id: "eerie" },
    "multiscales/.zgroup": { zarr_format: 2 },
    "multiscales/.zattrs": { multiscales: { layout } },
  };
  for (let zoom = 0; zoom <= 9; zoom++) {
    const group = `multiscales/zoom_${zoom}`;
    metadata[`${group}/.zgroup`] = { zarr_format: 2 };
    metadata[`${group}/.zattrs`] = { healpix_nside: 2 ** zoom };
    metadata[`${group}/crs/.zarray`] = zarray([1]);
    metadata[`${group}/crs/.zattrs`] = {
      _ARRAY_DIMENSIONS: ["crs"],
      grid_mapping_name: "healpix",
      healpix_nside: 2 ** zoom,
    };
    metadata[`${group}/pr/.zarray`] = zarray([2, 12 * 4 ** zoom]);
    metadata[`${group}/pr/.zattrs`] = {
      _ARRAY_DIMENSIONS: ["time", "cell"],
      grid_mapping: "crs",
    };
  }
  return metadata;
}

/** Pyramids on `a/b` and on `c`, which is shallower. */
function twoPyramidsMetadata() {
  const metadata: Record<string, unknown> = {
    ".zgroup": { zarr_format: 2 },
    ".zattrs": {},
    "a/.zgroup": { zarr_format: 2 },
    "a/b/.zgroup": { zarr_format: 2 },
  };
  for (const [group, levels] of [
    ["a/b", LEVELS.slice(0, 2)],
    ["c", LEVELS.slice(1)],
  ] as const) {
    const pyramid = pyramidMetadata(
      levels.map((level) => ({ ...level, path: `${group}/${level.path}` })),
      {}
    ).metadata;
    delete pyramid[".zgroup"];
    delete pyramid[".zattrs"];
    Object.assign(metadata, pyramid);
    metadata[`${group}/.zgroup`] = { zarr_format: 2 };
    metadata[`${group}/.zattrs`] = omeAttrs(levels.map(({ path }) => path));
  }
  return metadata;
}

describe("indexing a pyramid declared on a group below the opened one", () => {
  it("reads the waterpark layout as ten levels", async () => {
    serve({
      [`${SRC}/.zmetadata`]: {
        zarr_consolidated_format: 1,
        metadata: waterparkMetadata(),
      },
    });
    const index = await indexFromZarr(SRC);
    expect(index.levels.map(({ name }) => name)).toEqual(
      [9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((zoom) => `zoom_${zoom}`)
    );
    expect(index.levels.map(({ path }) => path)).toEqual(
      [9, 8, 7, 6, 5, 4, 3, 2, 1, 0].map((zoom) => `multiscales/zoom_${zoom}`)
    );
    expect(Object.keys(index.levels[9].datasources)).toContain(
      "multiscales/zoom_0/pr"
    );
    index.levels.forEach((level, position) => {
      const nside = 2 ** (9 - position);
      expect(level.resolution).toBeCloseTo(
        (EARTH_RADIUS_METERS * Math.sqrt(Math.PI / 3)) / nside,
        6
      );
      expect(level.cellCount).toBe(12 * nside * nside);
    });
  });

  it("reads the shallowest of several pyramids and says so", async () => {
    const files: Record<string, unknown> = {
      [`${SRC}/.zmetadata`]: {
        zarr_consolidated_format: 1,
        metadata: twoPyramidsMetadata(),
      },
    };
    for (const { path, nlon } of LEVELS) {
      files[`${SRC}/c/${path}/lon/0`] = longitudes(nlon);
    }
    serve(files);
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const index = await indexFromZarr(SRC);
    expect(index.levels.map(({ path }) => path)).toEqual(["c/1", "c/2"]);
    expect(info).toHaveBeenCalledWith(expect.stringContaining('"c"'));
  });
});

function writeIcechunkPyramid() {
  icechunk.files.clear();
  icechunk.files.set("zarr.json", {
    zarr_format: 3,
    node_type: "group",
    attributes: {},
  });
  icechunk.files.set("pyramid/zarr.json", {
    zarr_format: 3,
    node_type: "group",
    attributes: { title: "Pyramid", ...scaledOmeAttrs(["0", "1"]) },
  });
  for (const [path, nlat, nlon] of [
    ["0", 180, 360],
    ["1", 90, 180],
  ] as const) {
    icechunk.files.set(`pyramid/${path}/zarr.json`, {
      zarr_format: 3,
      node_type: "group",
      attributes: {},
    });
    icechunk.files.set(
      `pyramid/${path}/tas/zarr.json`,
      v3Array([nlat, nlon], ["lat", "lon"])
    );
  }
}

describe("indexing levels from other sources", () => {
  it("joins the level paths to the group an Icechunk URL points at", async () => {
    writeIcechunkPyramid();
    const index = await indexFromZarr(`${REPO}/pyramid/`);
    expect(index.name).toBe("Pyramid");
    expect(index.levels.map(({ grid }) => grid)).toEqual([
      { store: `icechunk+${REPO}`, dataset: "pyramid" },
      { store: `icechunk+${REPO}`, dataset: "pyramid" },
    ]);
    expect(index.levels.map(({ path }) => path)).toEqual(["0", "1"]);
    expect(Object.keys(index.levels[1].datasources)).toEqual(["1/tas"]);
    expect(index.levels.map(({ cellCount }) => cellCount)).toEqual([
      180 * 360,
      90 * 180,
    ]);
  });

  it("enriches every level of a JSON index", async () => {
    const INDEX = "https://example.test/index.json";
    const FINE = "https://example.test/fine.zarr";
    const COARSE = "https://example.test/coarse.zarr";
    serve({
      [INDEX]: jsonIndex([FINE, COARSE]),
      [`${FINE}/.zmetadata`]: flatStore(180, 360),
      [`${COARSE}/.zmetadata`]: flatStore(90, 180),
    });
    const index = await indexFromIndex(INDEX);
    expect(
      index.levels.map(({ datasources }) => datasources.tas.shape)
    ).toEqual([
      [180, 360],
      [90, 180],
    ]);
    expect(index.levels[1].datasources.tas.attrs?.dimensionNames).toEqual([
      "lat",
      "lon",
    ]);
  });
});

describe("indexing a Kerchunk reference file", () => {
  it("reads the levels of a pyramid", async () => {
    const REFS = "https://example.test/refs.json";
    const levels = LEVELS.slice(0, 2);
    const { metadata } = pyramidMetadata(levels, omeAttrs(["0", "1"]));
    const refs: Record<string, string> = {};
    for (const [key, value] of Object.entries(metadata)) {
      refs[key] = JSON.stringify(value);
    }
    for (const { path, nlon } of levels) {
      refs[`${path}/lon/0`] =
        "base64:" + Buffer.from(longitudes(nlon).buffer).toString("base64");
    }
    serve({ [REFS]: { version: 1, refs } });
    const index = await indexFromZarr(`reference+${REFS}`);
    expect(index.levels.map(({ path }) => path)).toEqual(["0", "1"]);
    expect(index.levels.map(({ cellCount }) => cellCount)).toEqual([
      180 * 360,
      90 * 180,
    ]);
  });
});
