/* eslint-disable max-lines-per-function -- one reproducer per finding. */
/* eslint-disable camelcase -- CF and Zarr metadata use snake_case keys. */
import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import {
  publicSourceRef,
  reduceForDisplay,
} from "@/lib/analysis/analysisExport.ts";
import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { createValidatedIndex } from "@/lib/analysis/cellIndex.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import {
  exportModel,
  STATUS_FLAGS,
  toGeoJSON,
} from "@/lib/analysis/scientificExport.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import {
  ANALYSIS_KINDS,
  type TAnalysisKind,
  type TGeometry,
} from "@/lib/analysis/types.ts";
import {
  buildValueCodec,
  decodeStoredValue,
} from "@/lib/analysis/valueDecoding.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { locateOnAxis, pyramidRelativePath } from "@/lib/grids/analysisGrid.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";
import {
  rasterize,
  timeCells,
  axisCells,
} from "@/ui/analysis/heatmapRaster.ts";

type TStore = Map<string, Uint8Array>;

async function write(
  store: TStore,
  path: string,
  data: number[],
  shape: number[],
  dims: string[],
  attrs: Record<string, unknown> = {},
  dtype: "float64" | "float32" | "int8" = "float64"
) {
  const array = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape: shape,
    dtype,
    dimensionNames: dims,
    attributes: attrs,
    fillValue: (dtype === "int8" ? 0 : Number.NaN) as never,
  });
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((product, n) => product * n, 1)
  );
  const typed =
    dtype === "int8"
      ? Int8Array.from(data)
      : dtype === "float32"
        ? Float32Array.from(data)
        : Float64Array.from(data);
  await zarr.set(array as never, null, {
    data: typed,
    shape,
    stride,
  } as never);
}

function open(store: TStore, variable: string) {
  return resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `v11-${Math.random()}`
    ),
    variable,
    new ByteLru<BigInt64Array>(2 ** 20)
  );
}

function query(
  kind: TAnalysisKind,
  variable: string,
  geometry: TGeometry,
  extra: Record<string, unknown> = {}
) {
  return {
    version: 1 as const,
    kind,
    source: { ref: "memory", versionStatus: "session" as const },
    variable,
    fixed: {},
    geometry,
    ...extra,
  };
}

/** time × lat × lon on a 4 × 4 regional grid (−20..20, 0..40). */
async function regional(
  options: {
    latAttrs?: Record<string, unknown>;
    lonAttrs?: Record<string, unknown>;
    lats?: number[];
    lons?: number[];
    latBounds?: number[];
    values?: (t: number, i: number, j: number) => number;
    fieldAttrs?: Record<string, unknown>;
  } = {}
) {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  const lats = options.lats ?? [-15, -5, 5, 15];
  const lons = options.lons ?? [5, 15, 25, 35];
  const scale = options.latAttrs?.units ? Math.PI / 180 : 1;
  await write(store, "lat", lats, [4], ["lat"], {
    units: "degrees_north",
    bounds: "lat_bnds",
    ...options.latAttrs,
  });
  await write(
    store,
    "lat_bnds",
    (options.latBounds ?? [-20, -10, -10, 0, 0, 10, 10, 20]).map(
      (v) => v * scale
    ),
    [4, 2],
    ["lat", "nv"]
  );
  await write(store, "lon", lons, [4], ["lon"], {
    units: "degrees_east",
    bounds: "lon_bnds",
    ...options.lonAttrs,
  });
  await write(
    store,
    "lon_bnds",
    [0, 10, 10, 20, 20, 30, 30, 40].map((v) => v * scale),
    [4, 2],
    ["lon", "nv"]
  );
  await write(store, "time", [0, 1, 2], [3], ["time"], {
    units: "days since 2000-01-01",
  });
  const value = options.values ?? ((t, i, j) => 100 * t + 10 * i + j);
  const data: number[] = [];
  for (let t = 0; t < 3; t++) {
    for (let i = 0; i < 4; i++) {
      for (let j = 0; j < 4; j++) {
        data.push(value(t, i, j));
      }
    }
  }
  await write(store, "tas", data, [3, 4, 4], ["time", "lat", "lon"], {
    units: "K",
    ...options.fieldAttrs,
  });
  return store;
}

describe("findings of the parallel v11 review", () => {
  it("1 | a shared source address keeps no query parameter of any name", () => {
    expect(
      publicSourceRef(
        "https://user:pw@data.example.org/run/a.zarr?client_secret=abc&sas=x&jwt=y#part"
      )
    ).toEqual({ ref: "https://data.example.org/run/a.zarr", shareable: true });
    expect(
      publicSourceRef("reference+https://h.example/r.json?token=t").ref
    ).toBe("reference+https://h.example/r.json");
  });

  it("2 | xarray's base64 Zarr v3 _FillValue stays a missing marker", () => {
    // xarray 2026.9 writes _FillValue = -999.0 of a v3 array as this text.
    const codec = buildValueCodec(
      { _FillValue: "AAAAAAA4j8A=" },
      Number.NaN,
      "float32",
      3
    );
    expect(decodeStoredValue(codec, -999)).toBeNaN();
    expect(decodeStoredValue(codec, 12.5)).toBe(12.5);
    // Plain numbers and their text are unchanged.
    const plain = buildValueCodec({ _FillValue: "-1e20" }, null, "float64", 3);
    expect(decodeStoredValue(plain, -1e20)).toBeNaN();
  });

  it("2 | …through an area mean, a finite fill never counts as data", async () => {
    const store = await regional({
      values: (_, i, j) => (i === 0 && j === 0 ? -999 : 10),
      fieldAttrs: { _FillValue: "AAAAAAA4j8A=" },
    });
    const context = await open(store, "tas");
    const planned = await planAnalysis(
      context,
      query(
        ANALYSIS_KINDS.REGION_SERIES,
        "tas",
        { kind: "box", west: 0, east: 40, south: -20, north: 20 },
        { time: { start: 0, stop: 3 } }
      ),
      new ReadContext()
    );
    const result = await planned.execute();
    expect(result.values).toEqual([10, 10, 10]);
  });

  it("3 | CF _Unsigned=true reads signed storage as unsigned, markers too", () => {
    const codec = buildValueCodec(
      { _Unsigned: "true", _FillValue: -1, valid_max: -6 },
      null,
      "int8",
      3
    );
    expect(decodeStoredValue(codec, -56)).toBe(200);
    expect(decodeStoredValue(codec, 7)).toBe(7);
    expect(decodeStoredValue(codec, -1)).toBeNaN(); // 255, the fill
    expect(decodeStoredValue(codec, -3)).toBeNaN(); // 253 > valid_max 250
    expect(codec.rule).toMatch(/unsigned/);
  });

  it("13 | an inclusive Float32 endpoint (valid_max 0.1) is kept", () => {
    const codec = buildValueCodec({ valid_max: 0.1 }, null, "float32", 3);
    expect(decodeStoredValue(codec, Math.fround(0.1))).toBeCloseTo(0.1, 7);
    expect(decodeStoredValue(codec, Math.fround(0.2))).toBeNaN();
  });

  it("4 | a missing time neither hangs the heatmap nor erases its neighbours", () => {
    const rows = timeCells([0, Number.NaN, 2]);
    expect(Number.isFinite(rows.lo[0]) && Number.isFinite(rows.hi[0])).toBe(
      true
    );
    expect(Number.isNaN(rows.lo[1])).toBe(true);
    expect(Number.isFinite(rows.lo[2]) && Number.isFinite(rows.hi[2])).toBe(
      true
    );
    // Two pixels for three dates forces the shared-pixel sweep.
    const raster = rasterize({
      values: [1, 2, 3],
      rows,
      columns: axisCells([0]),
      timePixels: 2,
      axisPixels: 1,
      timeToPixel: (t) => ((t + 0.5) / 3) * 2,
      axisToPixel: (v) => v + 0.5,
    });
    const seen = [raster.value(0, 0), raster.value(1, 0)];
    expect(seen).toContain(1);
    expect(seen).toContain(3);
    expect(seen).not.toContain(2);
  });

  it("6 | a dimensionless auxiliary vertical coordinate is never metres", async () => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    await write(store, "lat", [-5, 5], [2], ["lat"], {
      units: "degrees_north",
    });
    await write(store, "lon", [5, 15], [2], ["lon"], { units: "degrees_east" });
    await write(
      store,
      "sigma",
      Array(8).fill(0.5),
      [2, 2, 2],
      ["k", "lat", "lon"],
      {
        units: "1",
        positive: "down",
      }
    );
    await write(store, "u", Array(8).fill(1), [2, 2, 2], ["k", "lat", "lon"], {
      coordinates: "sigma",
    });
    const context = await open(store, "u");
    expect(context.vertical?.label ?? "").not.toMatch(/\(m|metre|meter/);
    expect(context.vertical?.note).toMatch(/dimensionless/);
    expect(Array.from(context.vertical!.values)).toEqual([0, 1]);
  });

  it("7 | time(record) named in `coordinates` is the time axis", async () => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    await write(store, "lat", [-5, 5], [2], ["lat"], {
      units: "degrees_north",
    });
    await write(store, "lon", [5, 15], [2], ["lon"], { units: "degrees_east" });
    await write(store, "time", [0, 1, 2], [3], ["record"], {
      units: "days since 2000-01-01",
      standard_name: "time",
    });
    await write(
      store,
      "u",
      Array(12).fill(1),
      [3, 2, 2],
      ["record", "lat", "lon"],
      {
        coordinates: "time",
      }
    );
    const context = await open(store, "u");
    expect(context.time?.dimension).toBe("record");
    expect(Array.from(context.time!.raw)).toEqual([0, 1, 2]);
  });

  it("8 | latitude and longitude in radians are read as degrees", async () => {
    const rad = Math.PI / 180;
    const store = await regional({
      lats: [-15, -5, 5, 15].map((v) => v * rad),
      lons: [5, 15, 25, 35].map((v) => v * rad),
      latAttrs: { units: "radians" },
      lonAttrs: { units: "radian" },
    });
    const context = await open(store, "tas");
    const planned = await planAnalysis(
      context,
      query(
        ANALYSIS_KINDS.POINT_SERIES,
        "tas",
        { kind: "point", lat: 4, lon: 26 },
        { time: { start: 0, stop: 3 } }
      ),
      new ReadContext()
    );
    const result = await planned.execute();
    // Cell (lat 5°, lon 25°): i = 2, j = 2.
    expect(result.values).toEqual([22, 122, 222]);
  });

  it("10 | a zero-area cell neither counts nor stretches the histogram", async () => {
    const store = await regional({
      // The northern row is a zero-width cell (15°..15°) holding 1000.
      latBounds: [-20, -10, -10, 0, 0, 10, 15, 15],
      values: (_, i) => (i === 3 ? 1000 : i),
    });
    const context = await open(store, "tas");
    const planned = await planAnalysis(
      context,
      query(
        ANALYSIS_KINDS.DISTRIBUTION,
        "tas",
        { kind: "box", west: 0, east: 40, south: -20, north: 20 },
        { time: { start: 0, stop: 1 }, valueBins: 4 }
      ),
      new ReadContext()
    );
    const result = await planned.execute();
    expect(result.histogram!.validCells).toBe(12);
    expect(Math.max(...result.histogram!.edges)).toBeLessThan(1000);
  });

  it("11 | GeoJSON measures a box as the calculation does (10° → 370.5°)", async () => {
    const store = await regional({ lons: [5, 10.2, 25, 35] });
    const context = await open(store, "tas");
    const planned = await planAnalysis(
      context,
      query(
        ANALYSIS_KINDS.REGION_SERIES,
        "tas",
        { kind: "box", west: 10, east: 370.5, south: -20, north: 20 },
        { time: { start: 0, stop: 1 } }
      ),
      new ReadContext()
    );
    const result = await planned.execute();
    const feature = toGeoJSON(result, "A1").features[0] as {
      geometry: { type: string; coordinates: number[][][] };
    };
    expect(feature.geometry.type).toBe("Polygon");
    const xs = feature.geometry.coordinates[0].map(([x]) => x);
    expect(Math.max(...xs) - Math.min(...xs)).toBeCloseTo(0.5, 9);
  });

  it("12 | a point outside the grid exports its position and no_stored_cell", async () => {
    const store = await regional();
    const context = await open(store, "tas");
    const planned = await planAnalysis(
      context,
      query(
        ANALYSIS_KINDS.POINT_SERIES,
        "tas",
        { kind: "point", lat: 60, lon: 20 },
        { time: { start: 0, stop: 3 } }
      ),
      new ReadContext()
    );
    const result = await planned.execute();
    const model = exportModel(result);
    const names = model.arrays.map((a) => a.name);
    const field = model.arrays.find((a) => a.name === "tas")!;
    for (const name of String(field.attrs.coordinates).split(" ")) {
      expect(names).toContain(name);
    }
    expect(
      Array.from(
        model.arrays.find((a) => a.name === "lat")!.data as Float64Array
      )
    ).toEqual([60]);
    expect(
      Array.from(
        model.arrays.find((a) => a.name === "status")!.data as Int32Array
      )
    ).toEqual([3, 3, 3].map(() => STATUS_FLAGS.NO_STORED_CELL));
  });

  it("14 | the outer edge of a bounded axis and a full-circle seam are inside", () => {
    const lat = {
      values: Float64Array.from([-45, 45]),
      bounds: Float64Array.from([-90, 0, 0, 90]),
      periodic: false,
    };
    expect(locateOnAxis(lat, 90).index).toBe(1);
    expect(locateOnAxis(lat, -90).index).toBe(0);
    expect(locateOnAxis(lat, 0).index).toBe(1); // shared edge: cell above
    expect(locateOnAxis(lat, 90.5).index).toBe(-1);
    const descending = {
      values: Float64Array.from([45, -45]),
      bounds: Float64Array.from([90, 0, 0, -90]),
      periodic: false,
    };
    expect(locateOnAxis(descending, 90).index).toBe(0);
    const ring = {
      values: Float64Array.from([180]),
      bounds: Float64Array.from([0, 360]),
      periodic: true,
      longitude: true,
    };
    for (const lon of [0, 360, -180, 180, 359.999]) {
      expect(locateOnAxis(ring, lon).index).toBe(0);
    }
  });

  it("16 | a resident sorted index is searched in place, never re-read", async () => {
    const ids = BigInt64Array.from([2n, 5n, 9n, 40n]);
    const index = createValidatedIndex(ids);
    for (let k = 0; k < 3; k++) {
      expect(await index.positionsOf([9n, 3n, 40n])).toEqual([2, -1, 3]);
    }
    expect(await index.spansOf([[4n, 10n]])).toEqual({
      spans: [[1, 3]],
      stored: 2,
    });
    expect(index.counters.chunkReads).toBe(0);
  });

  it("22 | overviews keep the subgroup below the published level", () => {
    const levels = ["level0", "level1", "levels", "levels/17"];
    expect(pyramidRelativePath("level0/ocean/thetao", levels)).toBe(
      "ocean/thetao"
    );
    expect(pyramidRelativePath("level0/thetao", levels)).toBe("thetao");
    expect(pyramidRelativePath("levels/17/atmos/t", levels)).toBe("atmos/t");
    expect(pyramidRelativePath("thetao", levels)).toBeUndefined();
  });

  it("v11 | display buckets always reach the last sample (402 into 100)", () => {
    const y = Array.from({ length: 402 }, (_, at) =>
      at === 401 ? 5 : Number.NaN
    );
    const x = y.map((_, at) => at);
    const reduced = reduceForDisplay(x, y, 100);
    expect(reduced.index).toContain(401);
    expect(reduced.y.filter((v) => !Number.isNaN(v))).toEqual([5]);
  });
});

describe("independent review of interim45: one undated observation", () => {
  it("leaves the ten dated observations plottable, the undated one counted and given no date", async () => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    await write(store, "lat", [0, 1], [2], ["lat"], { units: "degrees_north" });
    await write(store, "lon", [0, 1], [2], ["lon"], { units: "degrees_east" });
    // time(obs): an auxiliary coordinate, its middle row missing.
    const days = Array.from({ length: 11 }, (_, k) =>
      k === 5 ? Number.NaN : k
    );
    await write(store, "time", days, [11], ["obs"], {
      units: "days since 2001-01-01",
      _FillValue: Number.NaN,
    });
    const field = Array.from({ length: 11 * 4 }, (_, at) =>
      Math.floor(at / 4) === 5 ? Number.NaN : 10 + Math.floor(at / 4)
    );
    await write(store, "tas", field, [11, 2, 2], ["obs", "lat", "lon"], {
      units: "K",
      coordinates: "time",
    });
    const context = await open(store, "tas");
    expect(context.capabilities[ANALYSIS_KINDS.POINT_SERIES].available).toBe(
      true
    );
    const result = await (
      await planAnalysis(
        context,
        query(
          ANALYSIS_KINDS.POINT_SERIES,
          "tas",
          { kind: "point", lat: 0, lon: 0 },
          {
            time: { start: 0, stop: 11 },
          }
        ) as never,
        new ReadContext()
      )
    ).execute();
    // Ten dated values in place, the undated row missing and undated.
    expect(result.values.filter(Number.isFinite)).toHaveLength(10);
    expect(Number.isNaN(result.time!.raw[5])).toBe(true);
    expect(result.time!.raw.filter(Number.isFinite)).toEqual([
      0, 1, 2, 3, 4, 6, 7, 8, 9, 10,
    ]);
    expect(result.notes.join(" ")).toMatch(/1 observation has no time/);
    // A coordinate variable of the dimension itself may not be missing.
    const own: TStore = new Map();
    await zarr.create(zarr.root(own), { attributes: {} });
    await write(own, "lat", [0, 1], [2], ["lat"], { units: "degrees_north" });
    await write(own, "lon", [0, 1], [2], ["lon"], { units: "degrees_east" });
    await write(own, "time", days, [11], ["time"], {
      units: "days since 2001-01-01",
    });
    await write(own, "tas", field, [11, 2, 2], ["time", "lat", "lon"], {
      units: "K",
    });
    const refused = await open(own, "tas");
    expect(refused.capabilities[ANALYSIS_KINDS.POINT_SERIES].available).toBe(
      false
    );
  });
});

describe("interim48: an undated last observation", () => {
  it("keeps the ten dated observations and the undated last one in its written chunk", async () => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    await write(store, "lat", [0, 1], [2], ["lat"], { units: "degrees_north" });
    await write(store, "lon", [0, 1], [2], ["lon"], { units: "degrees_east" });
    const days = Array.from({ length: 11 }, (_, k) =>
      k === 10 ? Number.NaN : k
    );
    await write(store, "time", days, [11], ["obs"], {
      units: "days since 2001-01-01",
      _FillValue: Number.NaN,
    });
    const field = Array.from({ length: 11 * 4 }, (_, at) =>
      Math.floor(at / 4) === 10 ? Number.NaN : 10 + Math.floor(at / 4)
    );
    await write(store, "tas", field, [11, 2, 2], ["obs", "lat", "lon"], {
      units: "K",
      coordinates: "time",
    });
    const context = await open(store, "tas");
    const result = await (
      await planAnalysis(
        context,
        query(
          ANALYSIS_KINDS.POINT_SERIES,
          "tas",
          { kind: "point", lat: 0, lon: 0 },
          { time: { start: 0, stop: 11 } }
        ) as never,
        new ReadContext()
      )
    ).execute();
    expect(result.values.filter(Number.isFinite)).toHaveLength(10);
    expect(result.time!.raw).toHaveLength(11);
    expect(result.notes.join(" ")).toMatch(/1 observation has no time/);
  });
});
