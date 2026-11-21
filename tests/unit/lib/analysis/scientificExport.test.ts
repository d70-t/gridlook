/* eslint-disable max-lines-per-function -- fixtures and readers per format. */
/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { unzipSync } from "fflate";
import { beforeAll, describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import {
  decodeQueriesFromUrl,
  encodeQueriesForUrl,
  publicSourceRef,
  resultProvenance,
  resultTable,
  validateRestoredQuery,
} from "@/lib/analysis/analysisExport.ts";
import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { timeCellMethod } from "@/lib/analysis/cellMethods.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import {
  COUNTRY_ATLAS_VERSION,
  getCountryRings,
} from "@/lib/analysis/countryAtlas.ts";
import {
  loadNetCDFModule,
  writeNetCDF,
  type TNetCDFModule,
} from "@/lib/analysis/netcdfWriter.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import {
  chunkShapeOf,
  exportModel,
  STATUS_FLAGS,
  selectionGeoJSON,
  toGeoJSON,
  toZarrZip,
} from "@/lib/analysis/scientificExport.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import {
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  GEOMETRY_KINDS,
  type TAnalysisQuery,
  type TAnalysisResult,
  type TGeometry,
} from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;
const LATS = [-10, 0, 10];
const LONS = [170, 180, 190];
const NT = 4;

async function write(
  store: TStore,
  name: string,
  data: number[],
  shape: number[],
  dims: string[],
  attrs: Record<string, unknown> = {}
) {
  const array = await zarr.create(zarr.root(store).resolve(name), {
    shape,
    chunkShape: shape,
    dtype: "float64",
    dimensionNames: dims,
    attributes: attrs,
    fillValue: Number.NaN as never,
  });
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((p, n) => p * n, 1)
  );
  await zarr.set(array as never, null, {
    data: Float64Array.from(data),
    shape,
    stride,
  } as never);
}

async function fixture(
  formula = false,
  withLayerBounds = false,
  options: { levelName?: string; surfacePressure?: number } = {}
) {
  const levelName = options.levelName ?? "depth";
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "time", [0, 31, 59, 90], [NT], ["time"], {
    units: "days since 2001-01-01",
    calendar: "noleap",
  });
  await write(store, "lat", LATS, [3], ["lat"], {
    units: "degrees_north",
    bounds: "lat_bnds",
  });
  await write(
    store,
    "lat_bnds",
    LATS.flatMap((v) => [v - 5, v + 5]),
    [3, 2],
    ["lat", "nv"]
  );
  await write(store, "lon", LONS, [3], ["lon"], {
    units: "degrees_east",
    bounds: "lon_bnds",
  });
  await write(
    store,
    "lon_bnds",
    LONS.flatMap((v) => [v - 5, v + 5]),
    [3, 2],
    ["lon", "nv"]
  );
  if (formula) {
    await write(store, levelName, [0.2, 0.9], [2], [levelName], {
      standard_name: "atmosphere_hybrid_sigma_pressure_coordinate",
      formula_terms: "ap: ap b: b ps: ps",
      positive: "down",
    });
    await write(store, "ap", [100, 500], [2], [levelName], { units: "Pa" });
    await write(store, "b", [0.2, 0.9], [2], [levelName], { units: "1" });
    const pressure = options.surfacePressure ?? 1e5;
    await write(store, "ps", Array(NT).fill(pressure), [NT], ["time"], {
      units: "Pa",
    });
  } else {
    await write(store, levelName, [5, 50], [2], [levelName], {
      units: "m",
      positive: "down",
      standard_name: "depth",
      ...(withLayerBounds ? { bounds: "depth_bounds" } : {}),
    });
    if (withLayerBounds) {
      await write(
        store,
        "depth_bounds",
        [0, 12, 35, 65],
        [2, 2],
        [levelName, "nv"]
      );
    }
  }
  const data: number[] = [];
  for (let t = 0; t < NT; t++) {
    for (let k = 0; k < 2; k++) {
      for (let i = 0; i < 3; i++) {
        for (let j = 0; j < 3; j++) {
          data.push(
            t === 1 && i === 1 && j === 1
              ? Number.NaN
              : 100 * t + 10 * k + 3 * i + j
          );
        }
      }
    }
  }
  await write(
    store,
    "thetao",
    data,
    [NT, 2, 3, 3],
    ["time", levelName, "lat", "lon"],
    {
      units: "degC",
      long_name: "Sea water temperature",
    }
  );
  return resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `x-${Math.random()}`
    ),
    "thetao",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
}

function q(
  kind: TAnalysisQuery["kind"],
  geometry: TGeometry,
  extra: Partial<TAnalysisQuery> = {}
): TAnalysisQuery {
  return {
    version: ALGORITHM_VERSION,
    kind,
    source: {
      ref: "https://example.org/ocean.zarr",
      versionStatus: "best-effort",
    },
    variable: "thetao",
    geometry,
    fixed: {},
    ...extra,
  };
}

const point: TGeometry = { kind: "point", lat: 0, lon: 180 };
const seamBox: TGeometry = {
  kind: "box",
  west: 172,
  east: -172,
  south: -12,
  north: 12,
};
const seamPath: TGeometry = {
  kind: "polyline",
  vertices: [
    { lat: -8, lon: 172 },
    { lat: 8, lon: -172 },
  ],
};

let results: Record<string, TAnalysisResult>;
let netcdf: TNetCDFModule;

beforeAll(async () => {
  const ctx = await fixture();
  const run = async (query: TAnalysisQuery) =>
    (await planAnalysis(ctx, query, new ReadContext())).execute();
  results = {
    series: await run(q(ANALYSIS_KINDS.POINT_SERIES, point, { level: 0 })),
    area: await run(q(ANALYSIS_KINDS.REGION_SERIES, seamBox, { level: 1 })),
    profile: await run(
      q(ANALYSIS_KINDS.PROFILE, point, { time: { start: 2, stop: 3 } })
    ),
    curtain: await run(
      q(ANALYSIS_KINDS.SECTION, seamPath, {
        time: { start: 1, stop: 2 },
        sectionSamples: 5,
      })
    ),
    depth: await run(q(ANALYSIS_KINDS.TIME_DEPTH, point)),
    hovmoller: await run(
      q(ANALYSIS_KINDS.HOVMOLLER_LON, seamBox, { level: 0 })
    ),
    latSection: await run(
      q(ANALYSIS_KINDS.LAT_VERTICAL, seamBox, { time: { start: 0, stop: 1 } })
    ),
    distance: await run(
      q(ANALYSIS_KINDS.HOVMOLLER_PATH, seamPath, {
        level: 0,
        sectionSamples: 5,
      })
    ),
    distribution: await run(
      q(ANALYSIS_KINDS.DISTRIBUTION, seamBox, {
        level: 0,
        time: { start: 0, stop: 1 },
        valueBins: 4,
      })
    ),
  };
  const dist = path.resolve("node_modules/@earthyscience/netcdf4-wasm/dist");
  // The production loader, given the bytes the page would fetch.
  netcdf = await loadNetCDFModule({
    wasmBinary: fs.readFileSync(path.join(dist, "netcdf4-wasm.wasm")),
  });
}, 60_000);

/** Reads back through the C library: attributes and values as stored. */
function reader(m: TNetCDFModule, bytes: Uint8Array) {
  const call = (name: string, ...args: number[]) => {
    const status = (m[`_${name}_wrapper`] as (...a: number[]) => number)(
      ...args
    );
    if (status !== 0) {
      throw new Error(`${name}: ${status}`);
    }
  };
  const file = `/readback-${Math.random()}.nc`;
  (m.FS as unknown as { writeFile(p: string, d: Uint8Array): void }).writeFile(
    file,
    bytes
  );
  const text = (s: string) => {
    const n = m.lengthBytesUTF8(s) + 1;
    const p = m._malloc(n);
    m.stringToUTF8(s, p, n);
    return p;
  };
  const out = m._malloc(8);
  const pathPointer = text(file);
  call("nc_open", pathPointer, 0, out);
  const ncid = m.getValue(out, "i32");
  const varid = (name: string) => {
    if (name === "") {
      return -1;
    }
    const p = text(name);
    call("nc_inq_varid", ncid, p, out);
    m._free(p);
    return m.getValue(out, "i32");
  };
  return {
    hasAtt(variable: string, name: string) {
      const p = text(name);
      const status = (m._nc_inq_attid_wrapper as (...a: number[]) => number)(
        ncid,
        varid(variable),
        p,
        out
      );
      m._free(p);
      return status === 0;
    },
    attText(variable: string, name: string) {
      const id = varid(variable);
      const p = text(name);
      call("nc_inq_attlen", ncid, id, p, out);
      const length = m.getValue(out, "i32");
      const buffer = m._malloc(length + 1);
      call("nc_get_att_text", ncid, id, p, buffer);
      const value = new TextDecoder().decode(
        m.HEAPU8.slice(buffer, buffer + length)
      );
      m._free(p);
      m._free(buffer);
      return value;
    },
    doubles(variable: string, length: number) {
      const buffer = m._malloc(8 * length);
      call("nc_get_var_double", ncid, varid(variable), buffer);
      const values = Array.from(
        new Float64Array(m.HEAPU8.slice(buffer, buffer + 8 * length).buffer)
      );
      m._free(buffer);
      return values;
    },
    int64(variable: string, length: number) {
      const buffer = m._malloc(8 * length);
      call("nc_get_var_longlong", ncid, varid(variable), buffer);
      const values = Array.from(
        new BigInt64Array(m.HEAPU8.slice(buffer, buffer + 8 * length).buffer)
      );
      m._free(buffer);
      return values;
    },
    uint64(variable: string, length: number) {
      const buffer = m._malloc(8 * length);
      call("nc_get_var_ulonglong", ncid, varid(variable), buffer);
      const values = Array.from(
        new BigUint64Array(m.HEAPU8.slice(buffer, buffer + 8 * length).buffer)
      );
      m._free(buffer);
      return values;
    },
    close() {
      call("nc_close", ncid);
      m._free(out);
      m._free(pathPointer);
    },
  };
}

function same(a: number[], b: ArrayLike<number>) {
  expect(a.map((v) => (Number.isNaN(v) ? null : v))).toEqual(
    Array.from(b, (v) => (Number.isNaN(v) ? null : v))
  );
}

/**
 * Whether Python can run the generated scripts: without it those checks are
 * reported skipped, never passed unexercised.
 */
const HAS_PYTHON = (() => {
  try {
    execFileSync("python3", ["-c", "import pandas, matplotlib, numpy"]);
    return true;
  } catch {
    return false;
  }
})();

// Independent readers (netCDF4-python, xarray, zarr-python) check these
// when GRIDLOOK_EXPORT_DIR is set.
const OUT = process.env.GRIDLOOK_EXPORT_DIR;

describe("scientific downloads", () => {
  it("keeps the statistic attached to a renamed time coordinate in both downloads", async () => {
    const store: TStore = new Map();
    await zarr.create(zarr.root(store), { attributes: {} });
    await write(store, "t", [0.5, 1.5], [2], ["t"], {
      standard_name: "time",
      units: "days since 2000-01-01",
      bounds: "tb",
    });
    await write(store, "tb", [0, 1, 1, 2], [2, 2], ["t", "nv"]);
    await write(store, "lat", LATS, [3], ["lat"], { units: "degrees_north" });
    await write(store, "lon", LONS, [3], ["lon"], { units: "degrees_east" });
    await write(
      store,
      "thetao",
      Array(18).fill(10),
      [2, 3, 3],
      ["t", "lat", "lon"],
      {
        units: "degC",
        cell_methods: "t: maximum (interval: 1 hour)",
      }
    );
    const ds = zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      "t-source"
    );
    const ctx = await resolveVariableContext(
      ds,
      "thetao",
      new ByteLru<BigInt64Array>(2 ** 20)
    );
    const plan = await planAnalysis(
      ctx,
      q(ANALYSIS_KINDS.POINT_SERIES, point),
      new ReadContext()
    );
    const result = await plan.execute();
    expect(timeCellMethod(result.cellMethods, result.time?.dimension)).toBe(
      "maximum"
    );
    const model = exportModel(result);
    const nc = reader(netcdf, writeNetCDF(netcdf, model));
    const archive = unzipSync(await toZarrZip(model));
    const field = JSON.parse(
      new TextDecoder().decode(archive["thetao/zarr.json"])
    );
    try {
      expect(field.dimension_names).toEqual(["time"]);
      expect
        .soft(nc.attText("thetao", "cell_methods"))
        .toBe("time: maximum (interval: 1 hour)");
      expect(
        timeCellMethod(field.attributes.cell_methods, field.dimension_names[0])
      ).toBe("maximum");
    } finally {
      nc.close();
    }
  });

  it("review of interim45: an unsigned source's members are all uint64", async () => {
    for (const id of ["101", "9223372036854775809"]) {
      const model = exportModel({
        ...results.series,
        selections: [
          {
            dimension: "member",
            index: 0,
            id,
            idType: "uint64",
            ensemble: true,
          },
        ],
      });
      const archive = unzipSync(await toZarrZip(model));
      const metadata = JSON.parse(
        new TextDecoder().decode(archive["member/zarr.json"])
      );
      expect(metadata.data_type, id).toBe("uint64");
    }
  });

  it("review of interim45: a member equal to netCDF's default fill stays a value", () => {
    for (const [id, idType] of [
      ["-9223372036854775806", "int64"],
      ["18446744073709551614", "uint64"],
    ]) {
      const model = exportModel({
        ...results.series,
        selections: [
          { dimension: "member", index: 0, id, idType, ensemble: true },
        ],
      });
      const r = reader(netcdf, writeNetCDF(netcdf, model));
      try {
        expect(r.hasAtt("member", "_FillValue"), id).toBe(false);
        expect(r.hasAtt("member", "gridlook_identifier"), id).toBe(true);
        expect(
          idType === "int64" ? r.int64("member", 1) : r.uint64("member", 1),
          id
        ).toEqual([BigInt(id)]);
      } finally {
        r.close();
      }
    }
  });

  it("keeps leading zeroes of text ensemble labels when exporting selections", async () => {
    for (const id of ["001", "01"]) {
      const result = {
        ...results.series,
        selections: [{ dimension: "member", index: 0, id, ensemble: true }],
      };
      const archive = unzipSync(await toZarrZip(exportModel(result)));
      const meta = JSON.parse(
        new TextDecoder().decode(archive["member/zarr.json"])
      );
      const bytes = archive["member/c"];
      // Written as text (vlen-utf8: a count, then each length and bytes).
      expect(meta.data_type).toBe("string");
      const view = new DataView(bytes.buffer, bytes.byteOffset);
      const length = view.getUint32(4, true);
      const recovered = new TextDecoder().decode(bytes.subarray(8, 8 + length));
      expect.soft(recovered).toBe(id);
    }
  });

  it("interim48: wide unsigned members stay apart under xarray concatenation", ({
    skip,
  }) => {
    try {
      execFileSync("python3", ["-c", "import xarray, netCDF4"]);
    } catch {
      skip();
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "members48-"));
    const ids = [
      "18446744073709551613",
      "18446744073709551614",
      "18446744073709551615",
    ];
    ids.forEach((id, at) => {
      const model = exportModel({
        ...results.series,
        selections: [
          {
            dimension: "member",
            index: at,
            id,
            idType: "uint64",
            ensemble: true,
          },
        ],
      });
      fs.writeFileSync(path.join(dir, `${at}.nc`), writeNetCDF(netcdf, model));
    });
    const out = execFileSync(
      "python3",
      [
        "-I",
        "-c",
        String.raw`
import sys, glob, xarray as xr
files = sorted(glob.glob(sys.argv[1] + "/*.nc"))
merged = xr.concat([xr.open_dataset(f) for f in files], dim="member")
print(merged.member.dtype, " ".join(str(int(v)) for v in merged.member.values), flush=True)
`,
        dir,
      ],
      { encoding: "utf8" }
    );
    expect(out.trim()).toBe(`uint64 ${ids.join(" ")}`);
  });

  it("interim48: text identifiers that read as one number stay apart", () => {
    const ids = ["1", "1.0", "1e0", "001"];
    const written = ids.map((id, index) => {
      const model = exportModel({
        ...results.series,
        selections: [
          {
            dimension: "member",
            index,
            id,
            ensemble: true,
            idEncoding: "text",
          },
        ],
      });
      const member = model.arrays.find((a) => a.name === "member")!;
      return [member.type, member.data[0]];
    });
    // Written as the text itself: distinct, and the same
    // label in two files aligns whatever its position.
    expect(written).toEqual(ids.map((id) => ["str", id]));
  });

  it("links the selected physical level when its source name is status", async () => {
    const ctx = await fixture(false, true, { levelName: "status" });
    const plan = await planAnalysis(
      ctx,
      q(ANALYSIS_KINDS.POINT_SERIES, point, { level: 1 }),
      new ReadContext()
    );
    const series = await plan.execute();
    expect(series.fixedLevel?.value).toBe(50);
    const model = exportModel(series);
    const scalar = model.arrays.find((a) => a.attrs.axis === "Z")!;
    const archive = unzipSync(await toZarrZip(model));
    const { attributes } = JSON.parse(
      new TextDecoder().decode(archive["thetao/zarr.json"])
    );
    const nc = reader(netcdf, writeNetCDF(netcdf, model));
    try {
      for (const refs of [
        nc.attText("thetao", "coordinates"),
        attributes.coordinates,
      ]) {
        expect.soft(refs.split(/\s+/)).toContain(scalar.name);
      }
    } finally {
      nc.close();
    }
  });

  it("records the member, the standard name and a fill-free time coordinate (review of interim37)", async () => {
    const result = {
      ...results.series,
      standardName: "sea_water_potential_temperature",
      selections: [
        { dimension: "realization", index: 1, id: "23", ensemble: true },
      ],
    };
    const model = exportModel(result);
    const nc = reader(netcdf, writeNetCDF(netcdf, model));
    try {
      expect(nc.attText("thetao", "standard_name")).toBe(
        "sea_water_potential_temperature"
      );
      expect(nc.attText("thetao", "coordinates").split(" ")).toContain(
        "realization"
      );
      expect(nc.attText("realization", "standard_name")).toBe("realization");
      expect(nc.doubles("realization", 1)).toEqual([23]);
      expect(nc.hasAtt("time", "_FillValue")).toBe(false);
      expect(nc.hasAtt("thetao", "_FillValue")).toBe(true);
    } finally {
      nc.close();
    }
  });

  it("keeps a missing observation time off a CF dimension coordinate", async () => {
    const base = results.series;
    const raw = [0, NaN, 2, 3];
    const model = exportModel({
      ...base,
      time: { ...base.time!, raw, bounds: undefined },
    });
    const archive = unzipSync(await toZarrZip(model));
    const time = JSON.parse(
      new TextDecoder().decode(archive["time/zarr.json"])
    );
    const field = JSON.parse(
      new TextDecoder().decode(archive["thetao/zarr.json"])
    );
    expect(time.dimension_names).toEqual(["obs"]);
    expect(field.attributes.coordinates.split(/\s+/)).toContain("time");
  });

  it("keeps adjacent wide integer ensemble identifiers distinct in a download", async () => {
    const ids = ["9007199254740992", "9007199254740993"];
    const decoded = [];
    for (const id of ids) {
      const model = exportModel({
        ...results.series,
        selections: [{ dimension: "member", index: 0, id, ensemble: true }],
      });
      const archive = unzipSync(await toZarrZip(model));
      const metadata = JSON.parse(
        new TextDecoder().decode(archive["member/zarr.json"])
      );
      const bytes = archive["member/c"];
      const view = new DataView(
        bytes.buffer,
        bytes.byteOffset,
        bytes.byteLength
      );
      const actual =
        metadata.attributes.gridlook_identifier ??
        (metadata.data_type === "float64"
          ? view.getFloat64(0, true)
          : view.getBigInt64(0, true));
      decoded.push(String(actual));
    }
    expect(decoded).toEqual(ids);
  });

  it("independent review of interim43: an integral member ID is the coordinate itself, exactly", async () => {
    for (const id of [
      "9007199254740992",
      "9007199254740993",
      "1000000000000000100",
    ]) {
      const model = exportModel({
        ...results.series,
        selections: [{ dimension: "member", index: 0, id, ensemble: true }],
      });
      // NetCDF: an int64 realization.
      const r = reader(netcdf, writeNetCDF(netcdf, model));
      expect(r.int64("member", 1), id).toEqual([BigInt(id)]);
      r.close();
      // Zarr: the same.
      const archive = unzipSync(await toZarrZip(model));
      const metadata = JSON.parse(
        new TextDecoder().decode(archive["member/zarr.json"])
      );
      expect(metadata.data_type, id).toBe("int64");
      expect(metadata.attributes.standard_name).toBe("realization");
      const bytes = archive["member/c"];
      expect(
        new DataView(bytes.buffer, bytes.byteOffset, 8).getBigInt64(0, true),
        id
      ).toBe(BigInt(id));
    }
  });

  it("review of interim44: a member ID past int64 is an exact uint64 coordinate", async () => {
    for (const id of [
      "9223372036854775808",
      "10000000000000002000",
      "18446744073709551615",
    ]) {
      const model = exportModel({
        ...results.series,
        selections: [{ dimension: "member", index: 0, id, ensemble: true }],
      });
      const r = reader(netcdf, writeNetCDF(netcdf, model));
      expect(r.uint64("member", 1), id).toEqual([BigInt(id)]);
      expect(r.hasAtt("member", "gridlook_identifier"), id).toBe(false);
      r.close();
      const archive = unzipSync(await toZarrZip(model));
      const metadata = JSON.parse(
        new TextDecoder().decode(archive["member/zarr.json"])
      );
      expect(metadata.data_type, id).toBe("uint64");
      expect(metadata.attributes.standard_name).toBe("realization");
      const bytes = archive["member/c"];
      expect(
        new DataView(bytes.buffer, bytes.byteOffset, 8).getBigUint64(0, true),
        id
      ).toBe(BigInt(id));
    }
  });

  it("puts times stored out of order on an observation dimension (review of interim37)", async () => {
    const base = results.series;
    const raw = [2.5, 0.5, 1.5, 3.5].slice(0, base.values.length);
    const result = {
      ...base,
      time: { ...base.time!, raw, bounds: undefined },
      values: base.values.slice(0, raw.length),
    };
    const model = exportModel(result);
    const time = model.arrays.find((a) => a.name === "time")!;
    const field = model.arrays.find((a) => a.name === "thetao")!;
    expect(time.dims).toEqual(["obs"]);
    expect(field.dims).toEqual(["obs"]);
    expect(String(field.attrs.coordinates).split(" ")).toContain("time");
    const nc = reader(netcdf, writeNetCDF(netcdf, model));
    try {
      expect(nc.doubles("time", raw.length)).toEqual(raw);
    } finally {
      nc.close();
    }
    // In order: time stays the coordinate variable.
    expect(
      exportModel(results.series).arrays.find((a) => a.name === "time")!.dims
    ).toEqual(["time"]);
  });

  it("selects the level read in the xarray example (review of interim37)", async () => {
    const { pythonScript } = await import("@/lib/analysis/pythonExport.ts");
    const series = results.series;
    expect(series.fixedLevel).toBeDefined();
    const script = pythonScript(series, "s", "Series");
    expect(script).toContain(
      `# da = da.isel({${JSON.stringify(series.fixedLevel!.dimension)}: ${series.fixedLevel!.index}})`
    );
  });

  it("final review of interim41: opens a nested group and keeps metadata in its comments", async () => {
    const { pythonScript } = await import("@/lib/analysis/pythonExport.ts");
    const series = results.series;
    const nested = {
      ...series,
      query: { ...series.query, variable: "1/physics/thetao" },
      fixedLevel: { ...series.fixedLevel!, units: "m\nimport os" },
    };
    const script = pythonScript(nested, "s", "Series");
    expect(script).toMatch(/xr\.open_dataset\([^)]*group="1\/physics"/);
    expect(script).toContain('# da = ds["thetao"]');
    // The units stay in the comment: no line starts with them.
    expect(
      script.split("\n").some((line) => line.startsWith("import os"))
    ).toBe(false);
    expect(script).toContain("m import os");
  });

  it("keeps a selected ocean layer's published bounds in a point series", async () => {
    const ctx = await fixture(false, true);
    expect(ctx.vertical!.bounds).toEqual([0, 12, 35, 65]);
    const plan = await planAnalysis(
      ctx,
      q(ANALYSIS_KINDS.POINT_SERIES, point, { level: 1 }),
      new ReadContext()
    );
    const series = await plan.execute();
    expect(series.fixedLevel!.value).toBe(50);
    const archive = unzipSync(await toZarrZip(exportModel(series)));
    const depth = JSON.parse(
      new TextDecoder().decode(archive["depth/zarr.json"])
    );
    expect(depth.attributes.bounds).toEqual(expect.any(String));
    const chunk = archive[depth.attributes.bounds + "/c/0"];
    const data = new DataView(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    expect([data.getFloat64(0, true), data.getFloat64(8, true)]).toEqual([
      35, 65,
    ]);
  });

  it("records the band mean after the source time method in both Hovmöller exports", async () => {
    const result = { ...results.hovmoller, cellMethods: "time: maximum" };
    const model = exportModel(result);
    const archive = unzipSync(await toZarrZip(model));
    const metadata = JSON.parse(
      new TextDecoder().decode(archive["thetao/zarr.json"])
    );
    const nc = reader(netcdf, writeNetCDF(netcdf, model));
    try {
      const methods = [
        nc.attText("thetao", "cell_methods"),
        metadata.attributes.cell_methods,
      ];
      expect(methods).toEqual([
        expect.stringMatching(/^time: maximum .*latitude: mean/),
        expect.stringMatching(/^time: maximum .*latitude: mean/),
      ]);
    } finally {
      nc.close();
    }
  });

  it("keeps temperature differences on distribution bins across scientific formats", async () => {
    const result = {
      ...results.distribution,
      units: "K",
      unitsMetadata: "temperature: difference",
    };
    const model = exportModel(result);
    const archive = unzipSync(await toZarrZip(model));
    const { attributes } = JSON.parse(
      new TextDecoder().decode(archive["value_bin/zarr.json"])
    );
    const nc = reader(netcdf, writeNetCDF(netcdf, model));
    try {
      expect.soft(attributes.units_metadata).toBe("temperature: difference");
      expect(nc.attText("value_bin", "units_metadata")).toBe(
        "temperature: difference"
      );
    } finally {
      nc.close();
    }
  });

  it("writes a formula profile's model levels and resolved pressures in both formats", async () => {
    const ctx = await fixture(true);
    const query = q(ANALYSIS_KINDS.PROFILE, point, {
      time: { start: 0, stop: 1 },
    });
    const result = await (
      await planAnalysis(ctx, query, new ReadContext())
    ).execute();
    const model = exportModel(result);
    const nc = reader(netcdf, writeNetCDF(netcdf, model));
    const files = unzipSync(await toZarrZip(model));
    const root = zarr.root(
      new Map(Object.entries(files).map(([key, bytes]) => [`/${key}`, bytes]))
    );
    for (const [name, expected] of [
      ["depth", [0.2, 0.9]],
      ["depth_position", [20100, 90500]],
    ] as const) {
      expect(nc.doubles(name, 2)).toEqual([...expected]);
      const axis = await zarr.open(root.resolve(name), { kind: "array" });
      const values = (await zarr.get(axis as never)) as { data: Float64Array };
      expect(Array.from(values.data)).toEqual([...expected]);
      expect(axis.attrs.units).toBe(
        name === "depth_position" ? "Pa" : undefined
      );
    }
    expect(nc.attText("depth_position", "units")).toBe("Pa");
    expect(nc.attText("thetao", "coordinates").split(" ")).toContain(
      "depth_position"
    );
    const data = await zarr.open(root.resolve("thetao"), { kind: "array" });
    expect(String(data.attrs.coordinates).split(" ")).toContain(
      "depth_position"
    );
    nc.close();
  });

  it("publishes only safe source address components in every provenance copy", async () => {
    const raw =
      "zarr3+https://demo:PRIVATE@example.test/store?private_token=PRIVATE#PRIVATE";
    const clean = "zarr3+https://example.test/store";
    const query = {
      ...results.series.query,
      source: { ...results.series.query.source, ref: raw, name: raw },
    };
    const result = { ...results.series, query };
    expect(publicSourceRef(raw)).toEqual({ ref: clean, shareable: true });
    expect(
      publicSourceRef(
        "reference+https://example.test/file.json/foo?session=PRIVATE"
      ).ref
    ).toBe("reference+https://example.test/file.json/foo");
    const provenance = resultProvenance(result);
    expect(JSON.stringify(provenance)).not.toContain("PRIVATE");
    expect(provenance.source.ref).toBe(clean);
    const model = exportModel(result);
    const nc = reader(netcdf, writeNetCDF(netcdf, model));
    const files = unzipSync(await toZarrZip(model));
    const attrs = JSON.parse(
      new TextDecoder().decode(files["zarr.json"])
    ).attributes;
    for (const key of ["source", "gridlook_query", "gridlook_provenance"]) {
      expect(nc.attText("", key)).toBe(attrs[key]);
      expect(attrs[key]).not.toContain("PRIVATE");
      expect(attrs[key]).toContain(clean);
    }
    expect(result.query.source.ref).toBe(raw);
    nc.close();
  });

  it("exports the requested point and distinguishes no stored cell from an unread date", async () => {
    const ctx = await fixture();
    const requested = { kind: "point", lat: 80, lon: 45 } as const;
    for (const kind of [
      ANALYSIS_KINDS.POINT_SERIES,
      ANALYSIS_KINDS.PROFILE,
      ANALYSIS_KINDS.TIME_DEPTH,
    ]) {
      const result = await (
        await planAnalysis(ctx, q(kind, requested), new ReadContext())
      ).execute();
      const model = exportModel(result);
      const field = model.arrays.find((a) => a.attrs.gridlook_source_variable)!;
      const coords = String(field.attrs.coordinates).split(" ");
      expect(coords).toEqual(expect.arrayContaining(["lat", "lon"]));
      for (const coord of coords) {
        expect(model.arrays.some((a) => a.name === coord)).toBe(true);
      }
      expect(model.arrays.find((a) => a.name === "lat")!.data[0]).toBe(
        requested.lat
      );
      expect(model.arrays.find((a) => a.name === "lon")!.data[0]).toBe(
        requested.lon
      );
      expect(model.arrays.find((a) => a.name === "status")!.data).toEqual(
        new Int32Array(result.values.length).fill(STATUS_FLAGS.NO_STORED_CELL)
      );
      expect(resultTable(result).row(0)).toContain("no stored cell");
      if (kind === ANALYSIS_KINDS.POINT_SERIES) {
        const partial = {
          ...result,
          partial: { done: 1, total: 2, readUntil: 1 },
        };
        expect(
          exportModel(partial).arrays.find((a) => a.name === "status")!.data[1]
        ).toBe(STATUS_FLAGS.NOT_READ);
        expect(resultTable(partial).row(1)).toContain("not read");
      }
    }
  });

  it("restores country selections by ID and resolution and exports the selected boundary", async () => {
    const geometry = { kind: "country", id: "710", resolution: "50m" } as const;
    const expected = await getCountryRings(geometry.id, geometry.resolution);
    expect(expected.some((part) => part.length > 1)).toBe(true); // Lesotho is a hole in South Africa.
    for (const result of [results.area, results.distribution]) {
      const query = { ...result.query, geometry };
      const restored = decodeQueriesFromUrl(encodeQueriesForUrl([query])!);
      expect(restored[0].geometry).toEqual(geometry);
      expect(
        validateRestoredQuery({
          ...query,
          geometry: { ...geometry, id: "unknown" },
        })
      ).toBe(false);
      expect(
        validateRestoredQuery({
          ...query,
          geometry: { ...geometry, resolution: "1m" },
        })
      ).toBe(false);
      expect(
        validateRestoredQuery({ ...query, kind: ANALYSIS_KINDS.POINT_SERIES })
      ).toBe(false);
      const country = { ...result, query };
      const geo = await selectionGeoJSON(country, "South Africa");
      expect(geo.features[0]).toMatchObject({
        geometry: { type: "MultiPolygon", coordinates: expected },
        properties: {
          country_id: "710",
          country_name: "South Africa",
          boundary_resolution: "50m",
          boundary_atlas: COUNTRY_ATLAS_VERSION,
        },
      });
      expect(resultProvenance(country).countryBoundary).toMatchObject({
        id: "710",
        resolution: "50m",
        atlas: COUNTRY_ATLAS_VERSION,
      });
    }
    expect(await selectionGeoJSON(results.area, "A1")).toEqual(
      toGeoJSON(results.area, "A1")
    );
  });

  it("keeps what the values are: units_metadata and cell_methods", () => {
    // A temperature difference and a maximum over time: without them 2 K read
    // back as −271.15 °C.
    const model = exportModel({
      ...results.series,
      unitsMetadata: "temperature: difference",
      cellMethods: "time: maximum",
    });
    const values = model.arrays.find(
      (a) => a.attrs.gridlook_source_variable !== undefined
    )!;
    expect(values.attrs).toMatchObject({
      units_metadata: "temperature: difference",
      cell_methods: "time: maximum",
    });
  });

  it("composes cell methods and marks a temperature spread as a difference (reviews of interim26)", () => {
    const region = results.area;
    const model = exportModel({
      ...region,
      units: "K",
      cellMethods: "time: maximum",
      unitsMetadata: "temperature: on_scale",
      region: {
        ...region.region,
        spread: {
          std: region.values.map(() => 2),
          min: region.values.map(() => 280),
          max: region.values.map(() => 290),
        },
      },
    } as typeof region);
    const byName = (suffix: string) =>
      model.arrays.find((a) => a.name.endsWith(suffix))!;
    const main = model.arrays.find(
      (a) => a.attrs.gridlook_source_variable !== undefined
    )!;
    expect(main.attrs.cell_methods).toBe("time: maximum area: mean (weighted)");
    expect(byName("_std").attrs).toMatchObject({
      units_metadata: "temperature: difference",
      cell_methods: "time: maximum area: standard_deviation (weighted)",
    });
    expect(byName("_max").attrs).toMatchObject({
      units_metadata: "temperature: on_scale",
      cell_methods: "time: maximum area: maximum",
    });
  });

  it("review of interim43: a field named like a native index component stays the field", () => {
    const model = exportModel({
      ...results.depth,
      query: { ...results.depth.query, variable: "lat_index" },
    } as TAnalysisResult);
    const field = model.arrays.find((a) => a.attrs.gridlook_source_variable)!;
    expect(field.name).toBe("lat_index");
    const coordinates = String(field.attrs.coordinates).split(" ");
    expect(coordinates).not.toContain("lat_index");
    expect(coordinates).toEqual(["lat", "lon", "lat_index_1", "lon_index"]);
    const native = model.arrays.find((a) => a.name === "lat_index_1")!;
    expect(native.type).toBe("i8");
    expect(native.attrs.long_name).toMatch(/native lat index/);
  });

  it("review of interim44: native dimension names with spaces stay whole", () => {
    const section = results.curtain;
    const samples = section.samples!;
    expect(samples.index?.dims).toHaveLength(2);
    const model = exportModel({
      ...section,
      samples: {
        ...samples,
        index: { ...samples.index!, dims: ["grid row", "grid column"] },
      },
    } as TAnalysisResult);
    const field = model.arrays.find((a) => a.attrs.gridlook_source_variable)!;
    expect(String(field.attrs.coordinates).split(" ")).toEqual(
      expect.arrayContaining(["grid_row_index", "grid_column_index"])
    );
    const parts = ["grid_row_index", "grid_column_index"].map((name) =>
      model.arrays.find((a) => a.name === name)!
    );
    const combined = model.arrays.find((a) => a.name === "cell_index")!;
    const rows = combined.data.length / 2;
    parts.forEach((part, k) =>
      expect(Array.from(part.data as BigInt64Array)).toEqual(
        Array.from({ length: rows }, (_, at) => combined.data[at * 2 + k])
      )
    );
  });

  it("review of interim43: unordered or missing depths are an auxiliary coordinate on observations", async ({
    skip,
  }) => {
    // Four levels, an observed value at each, the unknown depth included.
    const profile = {
      ...results.profile,
      values: [5, 6, 7, 8],
      shape: [...results.profile.shape.slice(0, -1), 4],
    };
    for (const depths of [
      [0, 20, 10, 30],
      [0, Number.NaN, 10, 30],
    ]) {
      const result = {
        ...profile,
        vertical: { ...profile.vertical!, values: depths, bounds: undefined },
      } as TAnalysisResult;
      const model = exportModel(result);
      const z = model.arrays.find((a) => a.dims[0] === `${a.name}_obs`)!;
      const field = model.arrays.find((a) => a.attrs.gridlook_source_variable)!;
      // The depths under their own name, in stored order, on observations;
      // an auxiliary coordinate has no axis (CF 1.12).
      expect(z.dims).toEqual([`${z.name}_obs`]);
      expect(z.attrs.axis).toBeUndefined();
      expect(Array.from(z.data as Float64Array)).toEqual(depths);
      expect(field.dims).toContain(`${z.name}_obs`);
      expect(String(field.attrs.coordinates).split(" ")).toContain(z.name);
      expect(Array.from(field.data as Float64Array)).toEqual(profile.values);
      if (!HAS_PYTHON) {
        continue;
      }
      // xarray opens the Zarr, the depth a coordinate of the field, and
      // selects by it.
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gridlook-z-"));
      try {
        const archive = unzipSync(await toZarrZip(model));
        for (const [name, bytes] of Object.entries(archive)) {
          fs.mkdirSync(path.dirname(path.join(dir, "p.zarr", name)), {
            recursive: true,
          });
          fs.writeFileSync(path.join(dir, "p.zarr", name), bytes);
        }
        const out = execFileSync("python3", [
          "-c",
          `import xarray as xr, json; ds = xr.open_dataset("${path.join(dir, "p.zarr")}", engine="zarr", decode_times=False); da = ds["${field.name}"]; print(json.dumps(["${z.name}" in da.coords, list(da.dims), [None if v != v else v for v in da["${z.name}"].values.tolist()]]))`,
        ]).toString();
        expect(JSON.parse(out)).toEqual([
          true,
          field.dims,
          depths.map((d) => (Number.isNaN(d) ? null : d)),
        ]);
      } catch (error) {
        if (/No module named/.test(String(error))) {
          skip();
        }
        throw error;
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("describes every result shape with CF coordinates and status flags", () => {
    const series = exportModel(results.series);
    expect(series.dims).toEqual([
      ["time", NT],
      ["cell_rank", 2],
    ]);
    expect(series.arrays.find((a) => a.name === "time")!.attrs).toMatchObject({
      units: "days since 2001-01-01",
      calendar: "noleap",
    });
    const status = series.arrays.find((a) => a.name === "status")!;
    expect(Array.from(status.data as Int32Array)).toEqual([
      0,
      STATUS_FLAGS.MISSING,
      0,
      0,
    ]);
    expect(exportModel(results.curtain).dims).toEqual([
      ["sample", 5],
      ["depth", 2],
      ["cell_rank", 2],
    ]);
    // The column's own place and native cell come with it.
    expect(exportModel(results.depth).dims).toEqual([
      ["time", NT],
      ["depth", 2],
      ["cell_rank", 2],
    ]);
    const depth = exportModel(results.depth);
    const field = depth.arrays.find((a) => a.attrs.gridlook_source_variable)!;
    // One coordinate per native index component (xarray attaches these).
    expect(field.attrs.coordinates).toBe("lat lon lat_index lon_index");
    const profile = exportModel(results.profile);
    expect(
      profile.arrays.find((a) => a.attrs.gridlook_source_variable)!.attrs
        .coordinates
    ).toMatch(/\btime\b/);
    expect(exportModel(results.hovmoller).dims[1][0]).toBe("lon");
    expect(exportModel(results.distance).dims[1][0]).toBe("distance");
    const histogram = exportModel(results.distribution);
    expect(
      histogram.arrays.find((a) => a.name === "value_bin_bounds")!.dims
    ).toEqual(["bin", "nv"]);
  });

  it("writes NetCDF-4 with its attributes and values stored in the file", () => {
    for (const [name, result] of Object.entries(results)) {
      const model = exportModel(result);
      const bytes = writeNetCDF(netcdf, model);
      // HDF5 signature: a NetCDF-4 file, not classic.
      expect(Array.from(bytes.slice(1, 4))).toEqual([72, 68, 70]);
      const r = reader(netcdf, bytes);
      expect(r.attText("", "Conventions")).toBe("CF-1.12");
      expect(JSON.parse(r.attText("", "gridlook_query")).kind).toBe(
        result.kind
      );
      const data = model.arrays.find(
        (a) => a.name === "thetao" || a.name === "area_fraction"
      )!;
      same(r.doubles(data.name, data.data.length), data.data as Float64Array);
      if (data.name === "thetao") {
        expect(r.attText("thetao", "units")).toBe("degC");
      }
      r.close();
      if (OUT) {
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, `${name}.nc`), bytes);
      }
    }
  });

  it("writes small, then large (memory grows), then small again", () => {
    const model = (n: number) => ({
      dims: [["x", n]] as [string, number][],
      arrays: [
        {
          name: "v",
          dims: ["x"],
          type: "f8" as const,
          data: Float64Array.from({ length: n }, (_, i) => i),
          attrs: { units: "1" },
        },
      ],
      attrs: { Conventions: "CF-1.12" },
    });
    for (const n of [3, 2_097_152, 3]) {
      const bytes = writeNetCDF(netcdf, model(n));
      const r = reader(netcdf, bytes);
      const values = r.doubles("v", n);
      expect(values[n - 1]).toBe(n - 1);
      expect(r.attText("v", "units")).toBe("1");
      r.close();
    }
  });

  it("keeps 64-bit cell identifiers exact", () => {
    const result = {
      ...results.series,
      cell: {
        id: "9007199254740993",
        lat: 0,
        lon: 180,
        selection: "containing HEALPix cell",
      },
    } as TAnalysisResult;
    const model = exportModel(result);
    const bytes = writeNetCDF(netcdf, model);
    const r = reader(netcdf, bytes);
    expect(r.int64("cell_index", 1)).toEqual([9007199254740993n]);
    r.close();
  });

  it("writes cell positions from the locator, not from the label", () => {
    const model = exportModel(results.series);
    const index = model.arrays.find((a) => a.name === "cell_index")!;
    expect(index.attrs.gridlook_index_dimensions).toBe("lat lon");
    expect(index.attrs._FillValue).toBeUndefined();
    // An older label with digits in a dimension name: n2d=7 is one index.
    const legacy = exportModel({
      ...results.series,
      cell: { id: "n2d=7", lat: 0, lon: 0, selection: "nearest site" },
    } as TAnalysisResult);
    const one = legacy.arrays.find((a) => a.name === "cell_index")!;
    expect(Array.from(one.data as BigInt64Array)).toEqual([7n]);
    expect(one.dims).toEqual([]);
  });

  it("renames a source variable that collides with an auxiliary name", () => {
    for (const variable of ["status", "time", "lat"]) {
      const model = exportModel({
        ...results.series,
        query: { ...results.series.query, variable },
      } as TAnalysisResult);
      const names = model.arrays.map((a) => a.name);
      expect(new Set(names).size).toBe(names.length);
      const main = model.arrays.find(
        (a) => a.attrs.gridlook_source_variable === variable
      )!;
      expect(main.name).toBe(`${variable}_value`);
      expect(names).toContain("status");
      writeNetCDF(netcdf, model);
    }
  });

  it("exports an area series' spread with CF cell methods", () => {
    const area = results.area;
    const n = area.values.length;
    const spread = {
      std: Array.from({ length: n }, (_, t) => 0.5 + t),
      min: area.values.map((v) => v - 1),
      max: area.values.map((v) => v + 1),
    };
    const model = exportModel({
      ...area,
      region: { ...area.region!, spread },
    } as TAnalysisResult);
    const named = (suffix: string) =>
      model.arrays.find((a) => a.name.endsWith(suffix))!;
    expect(Array.from(named("_std").data as Float64Array)).toEqual(spread.std);
    expect(named("_std").attrs.cell_methods).toBe(
      "area: standard_deviation (weighted)"
    );
    expect(named("_min").attrs.cell_methods).toBe("area: minimum");
    expect(Array.from(named("_max").data as Float64Array)).toEqual(spread.max);
    writeNetCDF(netcdf, model);
  });

  it("exports a stopped area series: unread counts are −1, flagged not read", () => {
    const area = results.area;
    const stopped = {
      ...area,
      partial: { done: 1, total: 2, readUntil: 2 },
      values: area.values.map((v, t) => (t < 2 ? v : Number.NaN)),
      region: {
        ...area.region!,
        coverage: area.region!.coverage.map((c, t) => (t < 2 ? c : Number.NaN)),
        validCells: area.region!.validCells.map((n, t) =>
          t < 2 ? n : Number.NaN
        ),
      },
    } as TAnalysisResult;
    const model = exportModel(stopped);
    const counts = model.arrays.find((a) => a.name === "valid_cells")!;
    expect(Array.from(counts.data as BigInt64Array).slice(2)).toEqual([
      -1n,
      -1n,
    ]);
    const status = model.arrays.find((a) => a.name === "status")!;
    expect(Array.from(status.data as Int32Array).slice(2)).toEqual([
      STATUS_FLAGS.NOT_READ,
      STATUS_FLAGS.NOT_READ,
    ]);
    expect(model.attrs.gridlook_completeness).toBe("partial");
    writeNetCDF(netcdf, model);
  });

  it("writes one giant row in tiles, exactly", () => {
    // 1 × 1,200,000 Float64 (9.2 MiB): larger than one 4 MiB tile.
    const n = 1_200_000;
    const values = Float64Array.from({ length: n }, (_, at) => at * 0.5);
    const bytes = writeNetCDF(netcdf, {
      dims: [
        ["row", 1],
        ["x", n],
      ],
      arrays: [
        { name: "v", dims: ["row", "x"], type: "f8", data: values, attrs: {} },
      ],
      attrs: {},
    });
    const r = reader(netcdf, bytes);
    const back = r.doubles("v", n);
    expect(back[0]).toBe(0);
    expect(back[n - 1]).toBe((n - 1) * 0.5);
    expect(back[524_288]).toBe(524_288 * 0.5);
    r.close();
  });

  it("chunks a large Zarr array by bytes and reads it back whole", async () => {
    expect(chunkShapeOf([1024, 1024])).toEqual([128, 1024]);
    expect(chunkShapeOf([4, 300_000])).toEqual([1, 131_072]);
    expect(chunkShapeOf([10])).toEqual([10]);
    const n = 512 * 1024;
    const values = Float64Array.from({ length: n }, (_, at) => Math.sin(at));
    const model = {
      dims: [
        ["y", 512],
        ["x", 1024],
      ] as [string, number][],
      arrays: [
        {
          name: "big",
          dims: ["y", "x"],
          type: "f8" as const,
          data: values,
          attrs: {},
        },
      ],
      attrs: {},
    };
    let ticks = 0;
    const timer = setInterval(() => ticks++, 0);
    const bytes = await toZarrZip(model);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(0);
    const files = unzipSync(bytes);
    const store = new Map(
      Object.entries(files).map(([key, data]) => [`/${key}`, data])
    );
    const array = await zarr.open(zarr.root(store).resolve("big"), {
      kind: "array",
    });
    expect(array.chunks).toEqual([128, 1024]);
    const back = await zarr.get(array);
    expect((back.data as Float64Array)[n - 1]).toBe(values[n - 1]);
  });

  it("zips Zarr v3 with zarr.json at the root and dimension names", async () => {
    for (const [name, result] of Object.entries(results)) {
      const model = exportModel(result);
      const zip = await toZarrZip(model);
      const files = unzipSync(zip);
      expect(Object.keys(files)).toContain("zarr.json");
      const store = new Map(
        Object.entries(files).map(([key, bytes]) => [`/${key}`, bytes])
      );
      const group = await zarr.open(zarr.root(store), { kind: "group" });
      expect(group.attrs.Conventions).toBe("CF-1.12");
      const data = model.arrays.find(
        (a) => a.name === "thetao" || a.name === "area_fraction"
      )!;
      const array = await zarr.open(zarr.root(store).resolve(data.name), {
        kind: "array",
      });
      expect(array.dimensionNames).toEqual(data.dims);
      const chunk = await zarr.get(array as never);
      same(
        Array.from((chunk as { data: Float64Array }).data),
        data.data as Float64Array
      );
      if (OUT) {
        fs.writeFileSync(path.join(OUT, `${name}.zarr.zip`), zip);
      }
    }
  });

  it("writes a box drawn round the South Pole as GeoJSON others read alike", () => {
    // Its outline at 60°S, continuous across 180°, closed along the pole.
    const ring = [
      [0, -60],
      [90, -60],
      [180, -60],
      [-90, -60],
      [0, -60],
      [0, -90],
      [-90, -90],
      [180, -90],
      [90, -90],
      [0, -90],
      [0, -60],
    ];
    const drawn = {
      ...results.area,
      query: {
        ...results.area.query,
        geometry: {
          kind: GEOMETRY_KINDS.SHAPE,
          name: "as drawn, 60°S–90°S | round the South Pole",
          polygons: [[ring]],
          digest: "test",
          drawn: true as const,
        },
      },
    };
    const geo = toGeoJSON(drawn, "A1") as {
      features: { geometry: { type: string; coordinates: unknown } }[];
    };
    const { type, coordinates } = geo.features[0].geometry;
    const parts = (
      type === "Polygon" ? [coordinates] : coordinates
    ) as number[][][][];
    // RFC 7946 rings: longitudes within ±180°, read as plain lon/lat.
    const lons = parts.flat(2).map((p) => p[0]);
    expect(Math.max(...lons)).toBeLessThanOrEqual(180);
    expect(Math.min(...lons)).toBeGreaterThanOrEqual(-180);
    const inside = (lon: number, lat: number) =>
      parts.some(([outer]) => {
        let odd = false;
        for (let i = 0, j = outer.length - 1; i < outer.length; j = i++) {
          const [xi, yi] = outer[i];
          const [xj, yj] = outer[j];
          const crossing = xi + ((xj - xi) * (lat - yi)) / (yj - yi);
          if (yi > lat !== yj > lat && crossing > lon) {
            odd = !odd;
          }
        }
        return odd;
      });
    for (const lon of [-170, -10, 10, 100, 179]) {
      expect(inside(lon, -75)).toBe(true);
      expect(inside(lon, -50)).toBe(false);
    }
  });

  it("writes the selection as GeoJSON, split at 180°", () => {
    const box = toGeoJSON(results.area, "A1") as {
      features: {
        geometry: { type: string; coordinates: number[][][][] };
        properties: { role: string };
      }[];
    };
    const selection = box.features[0].geometry;
    expect(selection.type).toBe("MultiPolygon");
    const lons = selection.coordinates.flat(2).map((p) => p[0]);
    expect(Math.max(...lons)).toBeLessThanOrEqual(180);
    expect(Math.min(...lons)).toBeGreaterThanOrEqual(-180);
    const line = toGeoJSON(results.curtain, "S1") as {
      features: {
        geometry: { type: string; coordinates: number[][][] };
        properties: Record<string, unknown>;
      }[];
    };
    expect(line.features[0].geometry.type).toBe("MultiLineString");
    const [west, east] = line.features[0].geometry.coordinates;
    expect(west[west.length - 1][0]).toBe(180);
    expect(east[0][0]).toBe(-180);
    expect(west[west.length - 1][1]).toBeCloseTo(east[0][1], 9);
    expect(line.features[1].properties.role).toBe("waypoints");
    expect(
      line.features.filter((f) => f.properties.role === "sample")
    ).toHaveLength(5);
    if (OUT) {
      fs.writeFileSync(path.join(OUT, "area.geojson"), JSON.stringify(box));
      fs.writeFileSync(path.join(OUT, "curtain.geojson"), JSON.stringify(line));
    }
  });
});

describe("GeoJSON selections keep their spherical area", () => {
  type TRing = [number, number][];
  const ringContains = (ring: TRing, x: number, y: number) => {
    let inside = false;
    for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
      const [xa, ya] = ring[a];
      const [xb, yb] = ring[b];
      if (ya > y !== yb > y && x < ((xb - xa) * (y - ya)) / (yb - ya) + xa) {
        inside = !inside;
      }
    }
    return inside;
  };
  const shapes = (geometry: { type: string; coordinates: unknown }) =>
    (geometry.type === "Polygon"
      ? [geometry.coordinates]
      : geometry.coordinates) as TRing[][];
  const signed = (ring: TRing) =>
    ring.reduce(
      (sum, [x0, y0], at) =>
        sum +
        x0 * ring[(at + 1) % ring.length][1] -
        ring[(at + 1) % ring.length][0] * y0,
      0
    );

  const cases: Record<string, { lat: number; lon: number }[]> = {
    northCap: [0, 60, 120, 180, 240, 300].map((lon) => ({ lat: 70, lon })),
    southCap: [300, 240, 180, 120, 60, 0].map((lon) => ({ lat: -65, lon })),
    concaveSeam: [
      [-10, 170],
      [-10, -170],
      [-5, -170],
      [-5, 175],
      [5, 175],
      [5, -170],
      [10, -170],
      [10, 170],
    ].map(([lat, lon]) => ({ lat, lon })),
    clockwise: [
      [0, 0],
      [10, 0],
      [10, 10],
      [0, 10],
    ].map(([lat, lon]) => ({ lat, lon })),
  };

  for (const [name, vertices] of Object.entries(cases)) {
    it(`${name}: valid rings, counterclockwise, same membership as the sphere`, async () => {
      const geometry = { kind: "polygon", vertices } as TGeometry;
      const json = toGeoJSON(
        {
          ...results.area,
          query: { ...results.area.query, geometry },
        } as TAnalysisResult,
        "A1"
      ) as { features: { geometry: { type: string; coordinates: unknown } }[] };
      const selection = json.features[0].geometry;
      const polygons = shapes(selection);
      for (const polygon of polygons) {
        const ring = polygon[0];
        expect(ring[0]).toEqual(ring[ring.length - 1]);
        expect(signed(ring.slice(0, -1))).toBeGreaterThan(0);
        for (const [lon, lat] of ring) {
          expect(Math.abs(lon)).toBeLessThanOrEqual(180 + 1e-9);
          expect(Math.abs(lat)).toBeLessThanOrEqual(90);
        }
      }
      const { polygonContains, preparePolygon } =
        await import("@/lib/analysis/sphere.ts");
      const sphere = preparePolygon(vertices);
      let inside = 0;
      let wrong = 0;
      for (let lat = -89.75; lat < 90; lat += 0.5) {
        for (let lon = -179.75; lon < 180; lon += 0.5) {
          const expected = polygonContains(sphere, lat, lon);
          const got = polygons.some((polygon) =>
            ringContains(polygon[0], lon, lat)
          );
          inside += Number(expected);
          wrong += Number(expected !== got);
        }
      }
      expect(inside).toBeGreaterThan(0);
      // Great-circle edges vs densified chords: a thin boundary band only.
      expect(wrong / inside).toBeLessThan(0.02);
      if (OUT) {
        fs.writeFileSync(
          path.join(OUT, `selection-${name}.geojson`),
          JSON.stringify(json)
        );
      }
    });
  }
});

describe("GeoJSON at the seam (v7 review)", () => {
  const geo = (geometry: TGeometry) =>
    (
      toGeoJSON(
        {
          ...results.area,
          query: { ...results.area.query, geometry },
        } as TAnalysisResult,
        "A1"
      ) as { features: { geometry: { type: string; coordinates: unknown } }[] }
    ).features[0].geometry;

  it("uses the analysis span when a narrow box includes an extra turn", () => {
    const expected = geo({
      kind: "box",
      west: -170,
      east: -160,
      south: -5,
      north: 5,
    });
    for (const [west, east] of [
      [-170, 200],
      [550, -520],
    ]) {
      expect(geo({ kind: "box", west, east, south: -5, north: 5 })).toEqual(
        expected
      );
    }
  });

  it("a full-longitude band is one polygon, however its ends are written", () => {
    for (const [west, east] of [
      [0, 360],
      [-90, 270],
      [180, -180],
      [-180, 180],
    ]) {
      const g = geo({ kind: "box", west, east, south: -10, north: 10 });
      expect(g.type).toBe("Polygon");
      expect((g.coordinates as number[][][])[0].map((p) => p[0])).toEqual([
        -180, 180, 180, -180, -180,
      ]);
    }
  });

  it("a route ending exactly on 180° has no seam-only fragment", () => {
    const g = geo({
      kind: "polyline",
      vertices: [
        { lat: 0, lon: 170 },
        { lat: 0, lon: 180 },
      ],
    });
    const lines =
      g.type === "LineString"
        ? [g.coordinates as number[][]]
        : (g.coordinates as number[][][]);
    for (const line of lines) {
      expect(new Set(line.map((p) => p.join())).size).toBeGreaterThan(1);
    }
  });
});

describe("export semantics (v8 review)", () => {
  const find = (model: ReturnType<typeof exportModel>, name: string) =>
    model.arrays.find((a) => a.name === name);
  const field = (model: ReturnType<typeof exportModel>) =>
    model.arrays.find((a) => a.attrs.gridlook_source_variable !== undefined)!;

  it("a series at a fixed physical level carries it as a scalar coordinate", () => {
    const series = results.series;
    expect(series.fixedLevel?.index).toBe(0);
    const model = exportModel(series);
    const level = find(model, safeDepth(series))!;
    expect(level.dims).toEqual([]);
    expect(Array.from(level.data as Float64Array)).toEqual([
      series.fixedLevel!.value,
    ]);
    expect(level.attrs.units).toBe(series.fixedLevel!.units);
    expect(String(field(model).attrs.coordinates)).toContain(level.name);
  });

  it("source time bounds become CF time bounds", () => {
    const nt = results.series.time!.raw.length;
    const bounds = results.series.time!.raw.flatMap((t) => [t - 0.5, t + 0.5]);
    const model = exportModel({
      ...results.series,
      time: { ...results.series.time!, bounds },
    });
    expect(find(model, "time")!.attrs.bounds).toBe("time_bnds");
    const tb = find(model, "time_bnds")!;
    expect(tb.dims).toEqual(["time", "nv"]);
    expect(tb.data.length).toBe(2 * nt);
  });

  it("an outside sample is 'no stored cell' at every read time, not missing", () => {
    const r = results.distance;
    const n = r.axis!.values.length;
    const values = r.values.map((v, at) => (at % n === 0 ? Number.NaN : v));
    const status = r.samples!.status.map((s, k) =>
      k === 0 ? ("no stored cell" as const) : s
    );
    const model = exportModel({
      ...r,
      values,
      samples: { ...r.samples!, status },
    });
    const codes = Array.from(find(model, "status")!.data as Int32Array);
    for (let at = 0; at < codes.length; at += n) {
      expect(codes[at]).toBe(STATUS_FLAGS.NO_STORED_CELL);
    }
    expect(
      Array.from(find(model, "sample_status")!.data as Int32Array)[0]
    ).toBe(STATUS_FLAGS.NO_STORED_CELL);
  });

  it("a computed altitude keeps its published datum; an unknown one has none", () => {
    const curtain = results.curtain;
    const ns = curtain.samples!.distances.length;
    const nk = curtain.shape[1];
    const withFormula = (standardName?: string) =>
      exportModel({
        ...curtain,
        columnVertical: Array.from({ length: ns * nk }, (_, at) => -at),
        vertical: { ...curtain.vertical!, units: "m", standardName },
      });
    const level = `${curtain.vertical!.dimension}_position`;
    expect(find(withFormula("altitude"), level)!.attrs.standard_name).toBe(
      "altitude"
    );
    expect(
      find(withFormula(undefined), level)!.attrs.standard_name
    ).toBeUndefined();
  });

  it("a source level dimension named status does not collide with the flags", () => {
    const curtain = results.curtain;
    const model = exportModel({
      ...curtain,
      vertical: { ...curtain.vertical!, dimension: "status" },
    });
    const names = model.arrays.map((a) => a.name);
    expect(new Set(names).size).toBe(names.length);
    const flags = model.arrays.find(
      (a) =>
        a.attrs.flag_meanings &&
        a.dims.includes("sample") &&
        a.dims.length === 2
    )!;
    expect(flags.name).not.toBe("status");
    expect(find(model, "status")!.dims).toEqual(["status"]);
  });

  it("a source level dimension named sample stays its own axis in both writers (v9 review)", async () => {
    const curtain = results.curtain;
    const ns = curtain.samples!.distances.length;
    const nk = curtain.shape[1];
    const result = {
      ...curtain,
      vertical: { ...curtain.vertical!, dimension: "sample" },
    };
    const model = exportModel(result);
    const field = model.arrays.find((a) => a.name === "thetao")!;
    expect(field.dims).toEqual(["sample", "sample_level"]);
    expect(new Map(model.dims).get("sample")).toBe(ns);
    expect(new Map(model.dims).get("sample_level")).toBe(nk);
    const bytes = writeNetCDF(netcdf, model);
    const r = reader(netcdf, bytes);
    expect(r.doubles("thetao", ns * nk)).toHaveLength(ns * nk);
    expect(r.doubles("distance", ns)).toHaveLength(ns);
    r.close();
    const files = unzipSync(await toZarrZip(model));
    const store = new Map(
      Object.entries(files).map(([key, b]) => [`/${key}`, b])
    );
    const array = await zarr.open(zarr.root(store).resolve("thetao"), {
      kind: "array",
    });
    expect(array.shape).toEqual([ns, nk]);
    const distance = await zarr.open(zarr.root(store).resolve("distance"), {
      kind: "array",
    });
    expect(distance.shape).toEqual([ns]);
  });

  it("refuses a model whose values do not fit its dimensions", () => {
    const series = results.series;
    expect(() =>
      exportModel({ ...series, values: series.values.slice(1) })
    ).toThrow(/holds .* values, not/);
  });

  it("a distribution's scalar time and level are attached to area_fraction", () => {
    const model = exportModel(results.distribution);
    const fraction = model.arrays.find((a) => a.name === "area_fraction")!;
    const coords = String(fraction.attrs.coordinates).split(" ");
    expect(coords).toContain("time");
    expect(coords).toContain(
      results.distribution.fixedLevel!.dimension.replace(/[^A-Za-z0-9_]/g, "_")
    );
    // The area-weighted summary travels with it.
    const summary = results.distribution.histogram!.summary!;
    const provenance = resultProvenance(results.distribution).distribution!;
    expect(provenance.percentiles?.values).toEqual(summary.percentiles);
    expect(provenance.curve?.bandwidth).toBe(summary.density!.bandwidth);
    expect(fraction.attrs.gridlook_area_percentile_values).toEqual(
      summary.percentiles
    );
    expect(fraction.attrs.gridlook_area_std).toBe(summary.std);
  });

  it("GeoJSON waypoints are numbered as on the map", () => {
    const line = toGeoJSON(results.curtain, "S1") as {
      features: { properties: { role?: string; labels?: string[] } }[];
    };
    const waypoints = line.features.find(
      (f) => f.properties.role === "waypoints"
    )!;
    expect(waypoints.properties.labels).toEqual(["1", "2"]);
  });
});

function safeDepth(result: TAnalysisResult) {
  return result.fixedLevel!.dimension.replace(/[^A-Za-z0-9_]/g, "_");
}

describe("collision-free names before references (v20 review)", () => {
  it("time bounds point at the bounds, beside a fixed level named time_bnds", () => {
    const series = results.series;
    const raw = series.time!.raw;
    const model = exportModel({
      ...series,
      fixedLevel: {
        dimension: "time_bnds",
        index: 0,
        value: 85000,
        units: "Pa",
      },
      time: { ...series.time!, bounds: raw.flatMap((t) => [t - 0.5, t + 0.5]) },
    });
    const time = model.arrays.find((a) => a.name === "time")!;
    const bounds = model.arrays.find((a) => a.name === time.attrs.bounds)!;
    expect(bounds.dims).toEqual(["time", "nv"]);
    expect(bounds.data.length).toBe(2 * raw.length);
    // The level keeps its own scalar, under its own name.
    const level = model.arrays.find(
      (a) => a.dims.length === 0 && a.data[0] === 85000
    );
    expect(level).toBeDefined();
    expect(level!.name).not.toBe(time.attrs.bounds);
  });
});

describe("Python script", () => {
  it("independent review of interim43: model-calendar ticks name their own observations", async ({
    skip,
  }) => {
    const { pythonScript } = await import("@/lib/analysis/pythonExport.ts");
    if (!HAS_PYTHON) {
      skip();
    }
    const base = results.series;
    const ticks = (raw: number[], units: string) => {
      const result = {
        ...base,
        values: raw.map((_, k) => k + 1),
        shape: [raw.length],
        time: {
          ...base.time!,
          raw,
          bounds: undefined,
          units,
          calendar: "360_day",
        },
        query: { ...base.query, time: { start: 0, stop: raw.length } },
      } as TAnalysisResult;
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gridlook-ticks-"));
      try {
        fs.writeFileSync(
          path.join(dir, "t.py"),
          pythonScript(result, "t", "T")
        );
        const out = execFileSync(
          "python3",
          [
            "-c",
            `exec(open("t.py").read().replace("Path(__file__)", "Path('t.py')").replace("plt.show()", "")); fig.canvas.draw(); import json; print(json.dumps([l.get_text() for l in ax.get_xticklabels()]))`,
          ],
          { cwd: dir, env: { ...process.env, MPLBACKEND: "Agg" } }
        ).toString();
        return JSON.parse(out.trim().split("\n").pop()!) as string[];
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    };
    expect(ticks([0, 10, 20, 30], "seconds since 2001-01-01")).toEqual([
      "2001-01-01 00:00:00",
      "2001-01-01 00:00:10",
      "2001-01-01 00:00:20",
      "2001-01-01 00:00:30",
    ]);
    // Days at midnight: the dates alone, and none in the gap.
    expect(ticks([0, 1, 29, 30], "days since 2001-01-01")).toEqual([
      "2001-01-01",
      "2001-01-02",
      "2001-01-30",
      "2001-02-01",
    ]);
  });

  it("review of interim43: a variable named like an index column is drawn as itself", async ({
    skip,
  }) => {
    const { pythonScript } = await import("@/lib/analysis/pythonExport.ts");
    if (!HAS_PYTHON) {
      skip();
    }
    const depth = results.depth;
    const cases = [
      {
        name: "depth",
        result: {
          ...depth,
          units: undefined,
          query: {
            ...depth.query,
            variable: `${depth.axis?.dimension ?? depth.vertical!.dimension}_index`,
          },
        },
        drawn: "Z",
      },
      {
        name: "profile",
        result: {
          ...results.profile,
          units: undefined,
          query: { ...results.profile.query, variable: "level_index" },
        },
        drawn: "val",
      },
    ];
    for (const { name, result, drawn } of cases) {
      const script = pythonScript(result as TAnalysisResult, name, name);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gridlook-index-"));
      try {
        fs.writeFileSync(path.join(dir, `${name}.py`), script);
        const out = execFileSync(
          "python3",
          [
            "-c",
            `exec(open("${name}.py").read().replace("Path(__file__)", "Path('${name}.py')").replace("plt.show()", "")); import json; v = np.asarray(${drawn}, dtype=float).ravel(); print(json.dumps(sorted(float(x) for x in v[np.isfinite(v)])))`,
          ],
          { cwd: dir, env: { ...process.env, MPLBACKEND: "Agg" } }
        ).toString();
        const values = result.values
          .filter(Number.isFinite)
          .sort((a, b) => a - b);
        expect(JSON.parse(out.trim().split("\n").pop()!), name).toEqual(values);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    }
  });

  it("redraws every kind of plot from its embedded values", async () => {
    const { pythonScript } = await import("@/lib/analysis/pythonExport.ts");
    const expected: Record<string, RegExp> = {
      series:
        /ax\.plot\(x, df\["thetao \(degC\)"\]\.to_numpy\(dtype=float\)\[order\], lw=1\.2, marker="\.", ms=3\)/,
      area: /ax\.plot\(x, /,
      profile: /ax\.invert_yaxis\(\)/,
      curtain: /PolyCollection\(verts/,
      depth: /PolyCollection\(verts[\s\S]*ax\.invert_yaxis\(\)/,
      hovmoller: /PolyCollection\(verts/,
      distance: /PolyCollection\(verts/,
      distribution: /ax\.bar\(low, df\["share_of_valid_area"\] \* 100/,
    };
    for (const [name, result] of Object.entries(results)) {
      const script = pythonScript(result, `P_${name}`, `Plot ${name}`);
      expect(script).toMatch(/^#!\/usr\/bin\/env python3\n"""Plot /);
      expect(script).toContain("df = pd.read_csv(io.StringIO(CSV))");
      expect(script).toContain(`fig.savefig("P_${name}.png", dpi=200)`);
      expect(script).toContain(`# da = ds["${result.query.variable}"]`);
      if (expected[name]) {
        expect(script, name).toMatch(expected[name]);
      }
      if (OUT) {
        fs.mkdirSync(OUT, { recursive: true });
        fs.writeFileSync(path.join(OUT, `P_${name}.py`), script);
      }
    }
  });

  it("opens a reference file through fsspec and a catalog by its level's store (review of interim33)", async () => {
    const { pythonScript } = await import("@/lib/analysis/pythonExport.ts");
    const withSource = (source: Record<string, string>) =>
      pythonScript(
        {
          ...results.series,
          query: {
            ...results.series.query,
            source: { versionStatus: "best-effort", ...source },
          },
        } as TAnalysisResult,
        "p",
        "P"
      );
    const reference = withSource({ ref: "reference+https://x.org/refs.json" });
    expect(reference).toContain(
      '# fs = fsspec.filesystem("reference", fo="https://x.org/refs.json")'
    );
    expect(reference).not.toMatch(/open_dataset\("reference\+/);
    const catalog = withSource({
      ref: "https://x.org/catalog.json",
      level: "1 of 2: https://x.org/l0.zarr",
    });
    expect(catalog).toContain(
      '# ds = xr.open_dataset("https://x.org/l0.zarr", engine="zarr", chunks={})'
    );
    const unnamed = withSource({ ref: "https://x.org/catalog.json" });
    expect(unnamed).not.toMatch(/# ds = xr\.open/);
    expect(unnamed).toMatch(/Gridlook catalog/);
  });

  it("review of interim44: a variable called time_low is not read as the cells' lower ends", async () => {
    const { pythonScript, MAX_EMBEDDED_ROWS } =
      await import("@/lib/analysis/pythonExport.ts");
    const depth = results.depth;
    const nz = depth.shape[1];
    const nt = Math.ceil((MAX_EMBEDDED_ROWS + 1) / nz);
    const raw = Array.from({ length: nt }, (_, k) => k);
    const big = {
      ...depth,
      units: undefined,
      shape: [nt, nz],
      values: new Array(nt * nz).fill(-0.75),
      time: {
        ...depth.time!,
        raw,
        bounds: raw.flatMap((t) => [t - 0.2, t + 0.2]),
        units: "days since 2000-01-01",
        calendar: "standard",
      },
      query: {
        ...depth.query,
        variable: "time_low",
        time: { start: 0, stop: nt },
      },
    } as TAnalysisResult;
    const script = pythonScript(big, "big", "Big");
    expect(script).toContain(
      'df.groupby("time_index")[["time_low (value)", "time_high"]]'
    );
  });

  it("reads a large time–depth plot's time cells from its CSV, not a literal (review of interim33)", async ({
    skip,
  }) => {
    const { pythonScript, MAX_EMBEDDED_ROWS } =
      await import("@/lib/analysis/pythonExport.ts");
    const { resultToCsv } = await import("@/lib/analysis/analysisExport.ts");
    const depth = results.depth;
    const nz = depth.shape[1];
    const nt = Math.ceil((MAX_EMBEDDED_ROWS + 1) / nz);
    const raw = Array.from({ length: nt }, (_, k) => 2 * k);
    const big = {
      ...depth,
      shape: [nt, nz],
      values: Array.from({ length: nt * nz }, (_, at) => at % 7),
      time: {
        ...depth.time!,
        raw,
        bounds: raw.flatMap((t) => [t - 0.25, t + 0.25]),
        units: "days since 2000-01-01",
        calendar: "standard",
      },
      query: { ...depth.query, time: { start: 0, stop: nt } },
    } as TAnalysisResult;
    const script = pythonScript(big, "big_depth", "Big depth");
    // No 2 × nt literal of bounds: the script stays small.
    expect(script.length).toBeLessThan(40_000);
    expect(script).toContain(
      'df.groupby("time_index")[["time_low", "time_high"]]'
    );
    if (!HAS_PYTHON) {
      skip();
    }
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gridlook-big-"));
    try {
      fs.writeFileSync(path.join(dir, "big_depth.csv"), resultToCsv(big));
      fs.writeFileSync(path.join(dir, "big_depth.py"), script);
      const probe = execFileSync(
        "python3",
        [
          "-c",
          `exec(open("big_depth.py").read().replace("Path(__file__)", "Path('big_depth.py')").replace("plt.show()", "")); print("W", float(np.nanmedian((XH - XL)[0])))`,
        ],
        { cwd: dir, env: { ...process.env, MPLBACKEND: "Agg" } }
      ).toString();
      // Each declared cell is half a day wide, gaps between them empty.
      expect(Number(/W (\S+)/.exec(probe)![1])).toBeCloseTo(0.5, 6);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  }, 60_000);

  it("runs the Python time-depth export with a missing date and finite declared bounds", async ({
    skip,
  }) => {
    const { pythonScript } = await import("@/lib/analysis/pythonExport.ts");
    const depth = results.depth;
    const time = {
      ...depth.time!,
      raw: depth.time!.raw.map((_, k) => (k === 1 ? NaN : 7 * k)),
      bounds: depth.time!.raw.flatMap((_, k) => [7 * k - 0.5, 7 * k + 0.5]),
      units: "days since 2000-01-01",
      calendar: "standard",
    };
    if (!HAS_PYTHON) {
      skip();
    }
    const script = pythonScript(
      { ...depth, time },
      "bounded_gap",
      "Bounded gap"
    );
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gridlook-bounded-gap-"));
    try {
      execFileSync("python3", ["-c", script], {
        cwd: dir,
        env: { ...process.env, MPLBACKEND: "Agg" },
      });
      expect(
        fs.statSync(path.join(dir, "bounded_gap.png")).size
      ).toBeGreaterThan(0);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.skipIf(!HAS_PYTHON)(
    "draws what was computed, gaps and all (v20 reviews: run in Python)",
    async () => {
      const { pythonScript } = await import("@/lib/analysis/pythonExport.ts");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gridlook-py-"));
      const PROBE = `
import json
out = {"texts": [t.get_text() for a in fig.axes for t in a.texts]}
if "Z" in globals():
    out["Z"] = list(Z.shape); out["nan"] = int(np.isnan(Z).sum())
    out["Y"] = [[None if np.isnan(v) else float(v) for v in row] for row in Y]
out["lines"] = [[None if np.isnan(v) else float(v) for v in np.asarray(l.get_ydata(), dtype=float)] for a in fig.axes for l in a.lines]
out["x"] = [[str(v) for v in np.asarray(l.get_xdata())] for a in fig.axes for l in a.lines]
fig.canvas.draw()
out["xlabel"] = fig.axes[0].get_xlabel(); out["ylabel"] = fig.axes[0].get_ylabel()
out["xticks"] = [t.get_text() for t in fig.axes[0].get_xticklabels()]
out["yinverted"] = bool(fig.axes[0].yaxis_inverted())
if "X" in globals():
    out["X"] = [[None if np.isnan(v) else float(v) for v in row] for row in X]
for name in ("XL", "XH", "YL", "YH"):
    if name in globals():
        out[name] = [[None if np.isnan(v) else float(v) for v in row] for row in globals()[name]]
print("PROBE" + json.dumps(out))
`;
      const run = (result: TAnalysisResult, name: string, shownAs?: string) => {
        const script = pythonScript(result, name, name, shownAs);
        const output = execFileSync("python3", ["-c", script + PROBE], {
          cwd: dir,
          env: { ...process.env, MPLBACKEND: "Agg" },
        }).toString();
        return {
          script,
          probe: JSON.parse(output.split("PROBE")[1]) as {
            Z?: number[];
            nan?: number;
            Y?: (number | null)[][];
            lines: (number | null)[][];
            x: string[][];
            texts: string[];
            xlabel: string;
            ylabel: string;
            xticks: string[];
            yinverted: boolean;
            X?: (number | null)[][];
            XL?: (number | null)[][];
            XH?: (number | null)[][];
            YL?: (number | null)[][];
            YH?: (number | null)[][];
          },
        };
      };
      {
        const section = results.latSection;
        const nb = section.axis!.values.length;
        const nl = section.vertical!.values.length;
        const edges = Array.from({ length: nb + 1 }, (_, k) => k * k * 2);
        const layers = Array.from({ length: nl }, (_, k) => [
          10 * k,
          10 * k + 2,
        ]).flat();
        const drawn = run(
          {
            ...section,
            axis: { ...section.axis!, bounds: edges },
            vertical: { ...section.vertical!, bounds: layers },
          },
          "section_cells"
        ).probe;
        expect(drawn.XL?.[0].slice(0, 2)).toEqual([edges[0], edges[1]]);
        expect(drawn.XH?.[0].slice(0, 2)).toEqual([edges[1], edges[2]]);
        expect(drawn.YL?.map((row) => row[0])).toEqual(
          layers.filter((_, k) => k % 2 === 0)
        );
        expect(drawn.YH?.map((row) => row[0])).toEqual(
          layers.filter((_, k) => k % 2 === 1)
        );
      }
      {
        const curtain = results.curtain;
        const nk = curtain.vertical!.values.length;
        const layers = Array.from({ length: nk }, (_, k) => [
          10 * k,
          10 * k + 2,
        ]).flat();
        const drawn = run(
          {
            ...curtain,
            vertical: { ...curtain.vertical!, physical: true, bounds: layers },
          },
          "curtain_cells"
        ).probe;
        const km = curtain.samples!.distances.map((m) => m / 1000);
        const firstRow = drawn.XL![0];
        expect(firstRow[0]).toBeCloseTo(km[0], 9);
        expect(drawn.XH![0][km.length - 1]).toBeCloseTo(km[km.length - 1], 9);
        expect(drawn.YL?.map((row) => row[0])).toEqual(
          layers.filter((_, k) => k % 2 === 0)
        );
        expect(drawn.YH?.map((row) => row[0])).toEqual(
          layers.filter((_, k) => k % 2 === 1)
        );
      }
      {
        const depth = results.depth;
        const dated = (raw: number[]) => ({
          ...depth,
          time: {
            ...depth.time!,
            raw,
            bounds: undefined,
            units: "days since 2000-01-01",
            calendar: "standard",
          },
        });
        const gap = run(dated([0, Number.NaN, 2, 3]), "time_gap").probe;
        const width = (at: number) => gap.XH![0][at]! - gap.XL![0][at]!;
        expect(width(0)).toBeCloseTo(width(2), 9);
        // Day 0's cell ends half a day on, before day 1 (the missing one).
        expect(gap.XH![0][0]! - gap.X![0][0]!).toBeCloseTo(width(3) / 2, 9);
        const none = run(
          dated(depth.time!.raw.map(() => Number.NaN)),
          "no_dates"
        ).probe;
        expect(none.texts.join(" ")).toMatch(/No values at a known position/);
      }
      {
        const depth = results.depth;
        const nt = depth.time!.raw.length;
        const centres = [100, 400, 800, 1200].slice(0, nt);
        const micro = run(
          {
            ...depth,
            time: {
              ...depth.time!,
              raw: centres,
              bounds: centres.flatMap((c) => [c - 50, c + 50]),
              units: "microseconds since 2001-01-01",
              calendar: "standard",
            },
          },
          "micro_cells"
        );
        const day0 = Date.UTC(2001, 0, 1) / 86_400_000;
        const lows = (micro.probe.XL?.[0] ?? micro.probe.YL?.map((r) => r[0]))!;
        const us = lows.map((v) =>
          Math.round(((v as number) - day0) * 86_400e6)
        );
        expect(us).toEqual(centres.map((c) => c - 50));
      }
      // A curtain with an all-missing interior sample keeps all its columns.
      const curtain = results.curtain;
      const [ns, nk] = curtain.shape;
      const gap = curtain.values.map((v, at) =>
        Math.floor(at / nk) === 2 ? NaN : v
      );
      const c = run({ ...curtain, values: gap }, "curtain_gap");
      expect(c.probe.Z).toEqual([nk, ns]);
      expect(c.probe.nan).toBe(gap.filter(Number.isNaN).length);
      // Levels that vary by column are drawn where they are (no extra slots).
      const columnVertical = gap.map(
        (_, at) => 1000 - 100 * (at % nk) - Math.floor(at / nk)
      );
      const hybrid = run(
        { ...curtain, values: gap, columnVertical },
        "curtain_hybrid"
      );
      expect(hybrid.probe.Z).toEqual([nk, ns]);
      expect(hybrid.probe.Y![0].slice(0, 2)).toEqual([1000, 999]);
      // A time–depth diagram with a date all missing keeps that date.
      const depth = results.depth;
      const [nt, levels] = depth.shape;
      const lost = depth.values.map((v, at) =>
        Math.floor(at / levels) === 1 ? NaN : v
      );
      expect(run({ ...depth, values: lost }, "depth_gap").probe.Z).toEqual([
        levels,
        nt,
      ]);
      // Nothing at all: a note, not an error.
      const empty = run(
        { ...curtain, values: curtain.values.map(() => NaN) },
        "empty"
      );
      expect(empty.probe.texts).toContain("No values in this selection");
      // A mean below the coverage threshold is hidden, as in the plot.
      const area = results.area;
      const coverage = area.region!.coverage.map((v, at) =>
        at === 1 ? 0.5 : v
      );
      const masked = run(
        {
          ...area,
          query: { ...area.query, minCoverage: 0.9 },
          region: { ...area.region!, coverage },
        },
        "area_threshold"
      );
      expect(masked.probe.lines[0][1]).toBeNull();
      // An all_leap series is placed by its raw time, evenly.
      const series = results.series;
      const leap = run(
        { ...series, time: { ...series.time!, calendar: "all_leap" } },
        "leap"
      );
      expect(leap.probe.x[0].map(Number)).toEqual(series.time!.raw);
      expect(leap.script).toContain("all_leap calendar");
      const old = run(
        {
          ...series,
          time: {
            ...series.time!,
            raw: [0, 6, 12, 36],
            units: "hours since 1500-01-01",
            calendar: "proleptic_gregorian",
          },
        },
        "year1500"
      );
      const days = old.probe.x[0].map(Number);
      expect(days[1] - days[0]).toBeCloseTo(0.25, 9);
      expect(days[3] - days[0]).toBeCloseTo(1.5, 9);
      expect(old.probe.xlabel).toMatch(/^time/);
      // Matplotlib date numbers count days from 1970 (proleptic Gregorian).
      const epoch = new Date(0);
      epoch.setUTCFullYear(1500, 0, 1);
      expect(days[0]).toBeCloseTo(epoch.getTime() / 86_400_000, 6);
      const steps = run(
        {
          ...series,
          time: { ...series.time!, units: undefined, calendar: undefined },
        },
        "steps"
      );
      expect(steps.probe.x[0].map(Number)).toEqual(series.time!.raw);
      const uneven = results.depth;
      const unevenTime = {
        ...uneven.time!,
        raw: uneven.time!.raw.map(
          (_, k) => [0, 1, 100, 101, 102][k] ?? 200 + k
        ),
        units: "days since 2000-01-01",
        calendar: "standard",
      };
      const placed = run({ ...uneven, time: unevenTime }, "depth_uneven");
      const columns = placed.probe.X![0];
      expect(columns[1]! - columns[0]!).toBeCloseTo(1, 6);
      expect(columns[2]! - columns[1]!).toBeCloseTo(99, 6);
      // Oriented as in the app: longitude × time and distance × time with
      // time up the side, latitude × time with time across.
      for (const [kind, timeAcross] of [
        [ANALYSIS_KINDS.HOVMOLLER_LON, false],
        [ANALYSIS_KINDS.HOVMOLLER_LAT, true],
        [ANALYSIS_KINDS.HOVMOLLER_PATH, false],
      ] as const) {
        const h = run({ ...results.hovmoller, kind }, `hov_${kind}`);
        expect(h.probe.yinverted, kind).toBe(false);
        expect(
          (timeAcross ? h.probe.xlabel : h.probe.ylabel).startsWith("time"),
          kind
        ).toBe(true);
      }
      const weekly = {
        ...unevenTime,
        raw: uneven.time!.raw.map((_, k) => 7 * k + 0.5),
        bounds: uneven.time!.raw.flatMap((_, k) => [7 * k, 7 * k + 1]),
      };
      const layered = {
        ...uneven.vertical!,
        bounds: uneven.vertical!.values.flatMap((_, k) => [
          [0, 2, 18, 50, 100, 200][k] ?? 300 + k,
          [2, 18, 50, 100, 200, 300][k] ?? 301 + k,
        ]),
      };
      const cells = run(
        { ...uneven, time: weekly, vertical: layered },
        "depth_cells"
      );
      const [xl, xh] = [cells.probe.XL![0], cells.probe.XH![0]];
      expect(xh[0]! - xl[0]!).toBeCloseTo(1, 6);
      expect(xl[1]! - xh[0]!).toBeCloseTo(6, 6);
      const [yl, yh] = [
        cells.probe.YL!.map((r) => r[0]),
        cells.probe.YH!.map((r) => r[0]),
      ];
      expect([yl[0], yh[0], yl[1], yh[1]]).toEqual([0, 2, 2, 18]);
      // A missing date does not stop the script; the row has no place on the
      // axis, as in Gridlook's chart.
      const missing = run(
        {
          ...series,
          time: {
            ...series.time!,
            raw: series.time!.raw.map((v, k) => (k === 1 ? NaN : v)),
          },
        },
        "missing_date"
      );
      expect(missing.probe.lines[0].length).toBe(series.time!.raw.length - 1);
      // A dimension name cannot become code: the script parses to the same
      // statements whatever the names hold.
      const hostile = "time\nPWNED = 1  # \u2028PWNED2 = 2";
      const script = pythonScript(
        {
          ...series,
          time: { ...series.time!, dimension: hostile },
          query: { ...series.query, fixed: { [`m\rPWNED3 = 3`]: 0 } },
        },
        "hostile",
        'Title ending in a quote"'
      );
      const parsed = execFileSync(
        "python3",
        [
          "-c",
          "import ast,sys; t=ast.parse(sys.stdin.read()); print(sorted({n.id for n in ast.walk(t) if isinstance(n, ast.Name) and n.id.startswith('PWNED')}))",
        ],
        { input: script }
      )
        .toString()
        .trim();
      expect(parsed).toBe("[]");
      // A view of the values is named, and the title says what is drawn.
      const anomaly = run(series, "named", "the anomaly view");
      expect(anomaly.script).toContain("The window shows the anomaly view");
      expect(anomaly.script).toContain("(values as computed)");
    },
    120_000
  );

  it("reads the CSV beside it when the values are too many to embed", async () => {
    const { pythonScript, MAX_EMBEDDED_ROWS } =
      await import("@/lib/analysis/pythonExport.ts");
    const many = {
      ...results.series,
      values: new Array(MAX_EMBEDDED_ROWS + 1).fill(1),
      time: {
        ...results.series.time!,
        raw: new Array(MAX_EMBEDDED_ROWS + 1).fill(0),
      },
    };
    const script = pythonScript(many, "big", "Big");
    expect(script).toContain(
      'df = pd.read_csv(Path(__file__).with_name("big.csv"))'
    );
    expect(script).not.toContain("CSV = ");
  });
});

describe("Python script: scientific axes (v27 review §5)", () => {
  const python = (() => {
    try {
      execFileSync("python3", ["-c", "import pandas, matplotlib, numpy"]);
      return true;
    } catch {
      return false;
    }
  })();
  const plotted = async (result: TAnalysisResult, probe: string) => {
    const { pythonScript } = await import("@/lib/analysis/pythonExport.ts");
    const script = pythonScript(result, "test", "Test");
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gridlook-axis-"));
    try {
      return execFileSync("python3", ["-c", script + "\n" + probe], {
        cwd: dir,
        env: { ...process.env, MPLBACKEND: "Agg" },
      })
        .toString()
        .trim();
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  };

  it.runIf(python)(
    "compacts separated stored dates and preserves their declared cells in a Python grid",
    async () => {
      const base = results.depth;
      const raw = [0, 1, 2, 3];
      const result: TAnalysisResult = {
        ...base,
        query: {
          ...base.query,
          time: {
            start: 0,
            stop: 4097,
            runs: [
              [0, 2],
              [4095, 4097],
            ],
          },
        },
        time: {
          ...base.time!,
          raw,
          bounds: raw.flatMap((v) => [v - 0.125, v + 0.125]),
        },
        values: base.values.map(() => 1),
      };
      const report = await plotted(
        result,
        'print("GRID", Z.shape[1], round(float((XH - XL)[keep][0]), 3))'
      );
      expect(report.split("GRID ")[1]).toBe("4 0.25");
    },
    60_000
  );

  it.runIf(python)(
    "keeps the known layer when another layer's bounds are missing (review of interim37)",
    async () => {
      const base = results.depth;
      const levels = base.vertical!.values.length;
      const bounds = base.vertical!.values.flatMap((v, k) =>
        k === 0 ? [v - 0.5, v + 0.5] : [NaN, NaN]
      );
      const result = {
        ...base,
        vertical: { ...base.vertical!, bounds },
      };
      const output = await plotted(
        result,
        'print("CELLS", sum(len(c.get_paths()) for c in ax.collections))'
      );
      const cells = Number(output.split("CELLS ")[1]);
      expect(levels).toBeGreaterThan(1);
      expect(cells).toBeGreaterThan(0);
    },
    60_000
  );

  it.runIf(python)(
    "masks by the coverage column, not a variable named coverage (review of interim37)",
    async () => {
      const base = results.area;
      const n = base.values.length;
      const result = {
        ...base,
        units: undefined,
        query: { ...base.query, variable: "coverage", minCoverage: 0.5 },
        values: base.values.map((_, at) => (at === 0 ? 0.2 : 0.9)),
        region: {
          ...base.region!,
          coverage: base.values.map((_, at) => (at === 0 ? 1 : 0.1)),
        },
      };
      const output = await plotted(
        result,
        'print("SHOWN", *ax.lines[0].get_ydata())'
      );
      const shown = output.split("SHOWN ")[1].split(/\s+/).map(Number);
      expect(n).toBeGreaterThan(1);
      expect(shown[0]).toBeCloseTo(0.2);
      expect(shown.slice(1).every(Number.isNaN)).toBe(true);
    },
    60_000
  );

  it.runIf(python)(
    "draws irregular depths and dates with the app's cell edges (review of interim37)",
    async () => {
      const base = results.depth;
      const [nt, nk] = [3, 4];
      const result = {
        ...base,
        time: {
          ...base.time!,
          raw: [0, 1, 9],
          bounds: undefined,
          units: "days since 2001-01-01",
        },
        vertical: {
          ...base.vertical!,
          values: [0, 2, 6, 200],
          bounds: undefined,
        },
        axis: { ...base.axis!, values: [0, 2, 6, 200], bounds: undefined },
        values: Array.from({ length: nt * nk }, (_, at) => at),
        shape: [nt, nk],
      };
      const output = await plotted(
        result,
        [
          'print("Y", *sorted(set(np.round(np.concatenate([YL[np.isfinite(YL)], YH[np.isfinite(YH)]]), 6))))',
          'print("X", *sorted(set(np.round(np.concatenate([XL[np.isfinite(XL)], XH[np.isfinite(XH)]]) - XL[np.isfinite(XL)].min(), 6))))',
        ].join("\n")
      );
      const edges = (tag: string) =>
        output
          .split("\n")
          .find((line) => line.startsWith(`${tag} `))!
          .slice(2)
          .split(/\s+/)
          .map(Number);
      // Depth: halfway between levels, no gap between 6 and 200 m.
      expect(edges("Y")).toEqual([-1, 1, 4, 103, 297]);
      // Time: half the (upper) median step at most, no gap from 1 to 9.
      expect(edges("X")).toEqual([0, 1, 5.5, 13.5]);
    },
    60_000
  );

  it.runIf(python)(
    "draws accumulations since one start around their times, as the app (review of interim37)",
    async () => {
      const base = results.depth;
      const nt = 16;
      const levels = base.axis!.values.length;
      const raw = Array.from({ length: nt }, (_, d) => d + 0.5);
      const result = {
        ...base,
        time: {
          ...base.time!,
          raw,
          bounds: raw.flatMap((_, d) => [0, d + 1]),
          units: "days since 2001-01-01",
        },
        values: Array.from({ length: nt * levels }, (_, at) => at),
        shape: [nt, levels],
      };
      const output = await plotted(
        result,
        'print("STARTS", len(set(np.round(XL[np.isfinite(XL)], 6))))'
      );
      expect(Number(output.split("STARTS ")[1])).toBe(nt);
    },
    60_000
  );

  it.runIf(python)(
    "omits a curtain whose formula supplies no vertical positions",
    async () => {
      const ctx = await fixture(true, false, { surfacePressure: NaN });
      const plan = await planAnalysis(
        ctx,
        q(ANALYSIS_KINDS.SECTION, seamPath, {
          time: { start: 0, stop: 1 },
          sectionSamples: 5,
        }),
        new ReadContext()
      );
      const curtain = await plan.execute();
      expect(curtain.columnVertical?.every(Number.isNaN)).toBe(true);
      expect(curtain.values.every(Number.isFinite)).toBe(true);
      const output = await plotted(
        curtain,
        'print("CELLS", sum(len(c.get_paths()) for c in ax.collections))'
      );
      expect(output).toContain("CELLS 0");
    },
    60_000
  );

  it.runIf(python)(
    "connects an interleaved profile in the same physical level order as the chart",
    async () => {
      const { axisRows } = await import("@/ui/analysis/seriesDates.ts");
      const base = results.profile;
      const levels = [0, 20, 10, 30];
      const values = [12, 80, 25, 40];
      const result = {
        ...base,
        shape: [4],
        vertical: { ...base.vertical!, values: levels, bounds: undefined },
        values,
      };
      const output = await plotted(
        result,
        'print("VALUES", *ax.lines[0].get_xdata())'
      );
      const showing = output.split("VALUES ")[1].split(/\s+/).map(Number);
      expect(showing).toEqual(axisRows(levels)!.map((i) => values[i]));
    },
    60_000
  );

  it.runIf(python)(
    "leaves an unlocated pressure column out of the generated curtain",
    async () => {
      const { pythonScript } = await import("@/lib/analysis/pythonExport.ts");
      const base = results.curtain;
      const [columns, levels] = base.shape;
      const columnVertical = base.values.map((_, at) =>
        Math.floor(at / levels) === 1 ? NaN : 90_000 - 10_000 * (at % levels)
      );
      const result = {
        ...base,
        vertical: {
          ...base.vertical!,
          physical: true,
          label: "pressure (Pa)",
          units: "Pa",
          positive: "down" as const,
        },
        columnVertical,
        values: base.values.map(() => 1),
      };
      const script = pythonScript(result, "pressure", "Pressure curtain");
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), "gridlook-missing-pressure-")
      );
      try {
        const probe =
          '\nprint("PRESSURE", len(mesh.get_paths()), float(np.nanmin(YL[keep])))';
        const output = execFileSync("python3", ["-c", script + probe], {
          cwd: dir,
          env: { ...process.env, MPLBACKEND: "Agg" },
        }).toString();
        const [painted, minimumPa] = output
          .split("PRESSURE ")[1]
          .trim()
          .split(/\s+/)
          .map(Number);
        expect({ painted, minimumPa }).toEqual({
          painted: (columns - 1) * levels,
          minimumPa: 90_000 - 10_000 * (levels - 1) - 5_000,
        });
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000
  );

  it.runIf(python)(
    "draws a mixed-order time series in the same date order as Gridlook",
    async () => {
      const { pythonScript } = await import("@/lib/analysis/pythonExport.ts");
      const { orderedPoints } = await import("@/ui/analysis/seriesDates.ts");
      const base = results.series;
      const raw = [0, 2, 1, 3];
      const values = [12, 80, 25, 40];
      const result = { ...base, time: { ...base.time!, raw }, values };
      const chartValues = orderedPoints(raw, values, 800).map((p) => p.y);
      expect(chartValues).toEqual([12, 25, 80, 40]);
      const script = pythonScript(result, "interleaved", "Interleaved dates");
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), "gridlook-python-order-")
      );
      try {
        const output = execFileSync(
          "python3",
          ["-c", script + '\nprint("LINE", *ax.lines[0].get_ydata())'],
          { cwd: dir, env: { ...process.env, MPLBACKEND: "Agg" } }
        ).toString();
        const plotted = output
          .split("LINE ")[1]
          .trim()
          .split(/\s+/)
          .map(Number);
        expect(plotted).toEqual(chartValues);
      } finally {
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    60_000
  );

  const PROBE = `
import json
def floats(a):
    return [[None if not np.isfinite(v) else float(v) for v in row] for row in np.atleast_2d(a)]
out = {"x": [[float(v) for v in np.asarray(l.get_xdata(), dtype=float)] for a in fig.axes for l in a.lines]}
for name in ("XL", "XH", "YL", "YH"):
    if name in globals():
        out[name] = floats(globals()[name])
fig.canvas.draw()
out["xticks"] = [t.get_text() for t in fig.axes[0].get_xticklabels()]
print("PROBE" + json.dumps(out))
`;
  it.runIf(python)(
    "keeps bins, gaps, calendars and metadata",
    async () => {
      const { pythonScript } = await import("@/lib/analysis/pythonExport.ts");
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gridlook-py-axes-"));
      const run = (result: TAnalysisResult, name: string) => {
        const script = pythonScript(result, name, name);
        const output = execFileSync("python3", ["-c", script + PROBE], {
          cwd: dir,
          env: { ...process.env, MPLBACKEND: "Agg" },
        }).toString();
        return {
          script,
          probe: JSON.parse(output.split("PROBE")[1]) as Record<
            string,
            (number | null)[][]
          > & { xticks: string[] },
        };
      };
      // One longitude bin, 175–185°: drawn 10° wide, not as a line.
      const hov = results.hovmoller;
      const [nt] = hov.shape;
      const bin = run(
        {
          ...hov,
          shape: [nt, 1],
          values: Array.from({ length: nt }, (_, k) => k),
          axis: { ...hov.axis!, values: [180], bounds: [175, 185] },
        },
        "single_bin"
      );
      expect(bin.probe.XL[0][0]).toBe(175);
      expect(bin.probe.XH[0][0]).toBe(185);
      // A sparse time–depth record: nothing is painted over the 98 days
      // nobody observed (days 2.5 to 99.5 stay empty).
      const depth = results.depth;
      const raw = depth.time!.raw.map(
        (_, k) => [0, 1, 2, 100, 101][k] ?? 200 + k
      );
      const sparse = run(
        {
          ...depth,
          time: { ...depth.time!, raw, units: "days since 2000-01-01" },
        },
        "sparse_depth"
      );
      const [lo, hi] = [sparse.probe.XL[0], sparse.probe.XH[0]];
      expect(hi[2]! - lo[2]!).toBeCloseTo(1, 6);
      expect(lo[3]! - hi[2]!).toBeCloseTo(97, 6);
      // Three CF standard-calendar days across October 1582 (Julian, then
      // Gregorian): one day apart as stored, labelled in their own calendar.
      const series = results.series;
      const reform = run(
        {
          ...series,
          values: [1, 2, 3],
          time: {
            ...series.time!,
            raw: [2, 3, 4],
            units: "days since 1582-10-01",
            calendar: "standard",
          },
        },
        "october_1582"
      );
      expect(reform.probe.x[0]).toEqual([2, 3, 4]);
      expect(reform.probe.xticks.join(" ")).toMatch(/1582-10-0[34]|1582-10-15/);
      // Proleptic years Matplotlib cannot hold: placed by their coordinate.
      const far = run(
        {
          ...series,
          values: [1, 2],
          time: {
            ...series.time!,
            raw: [0, 365],
            units: "days since 12000-01-01",
            calendar: "proleptic_gregorian",
          },
        },
        "year_12000"
      );
      expect(far.probe.x[0]).toEqual([0, 365]);
      // Units and calendar with line breaks still make a script that runs.
      const multiline = run(
        {
          ...series,
          time: {
            ...series.time!,
            units: "days since\n2000-01-01",
            calendar: "360_day\nnote",
          },
        },
        "multiline"
      );
      // Every comment stays on its line: no line starts with a bare date.
      const lines = multiline.script.split("\n");
      expect(lines.filter((line) => /^2000-01-01/.test(line))).toEqual([]);
    },
    120_000
  );

  it("never embeds the time axis: a 360-day grid reads raw time from its CSV", async () => {
    const { pythonScript } = await import("@/lib/analysis/pythonExport.ts");
    const hov = results.hovmoller;
    const script = pythonScript(
      { ...hov, time: { ...hov.time!, calendar: "360_day" } },
      "h360",
      "H360"
    );
    expect(script).not.toContain("RAW = ");
    expect(script).toMatch(
      /t = df\["time \([^"]*\)"\]\.to_numpy\(dtype=float\)/
    );
  });
});

it("review of interim30 #39: the xarray example opens a source by Gridlook's own prefix", async () => {
  const { pythonScript } = await import("@/lib/analysis/pythonExport.ts");
  const at = (ref: string) =>
    pythonScript(
      {
        ...results.series,
        query: {
          ...results.series.query,
          source: { ...results.series.query.source, ref },
        },
      },
      "s",
      "S"
    );
  const netcdf = at("netcdf+https://example.org/data");
  // By byte ranges, not as OPeNDAP.
  expect(netcdf).toContain('# url = "https://example.org/data"');
  expect(netcdf).toContain(
    "xr.open_dataset(io.BufferedReader(Ranges(url), 1 << 20), chunks={})"
  );
  // The address as written stays in the provenance; the open call has none.
  const open = netcdf
    .split("\n")
    .find((line) => line.includes("open_dataset"))!;
  expect(open).not.toContain("netcdf+");
  expect(open).not.toMatch(/engine="zarr"/);
  expect(at("zarr3+https://example.org/x.nc")).toMatch(
    /open_dataset\("https:\/\/example\.org\/x\.nc", engine="zarr"/
  );
});

it("independent review of interim45: an auxiliary depth keeps its layers and the observations' IDs", async () => {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "time", [0], [1], ["time"], {
    units: "days since 2001-01-01",
  });
  await write(store, "lat", [0], [1], ["lat"], {
    units: "degrees_north",
    bounds: "lat_bnds",
  });
  await write(store, "lat_bnds", [-1, 1], [1, 2], ["lat", "nv"]);
  await write(store, "lon", [180], [1], ["lon"], {
    units: "degrees_east",
    bounds: "lon_bnds",
  });
  await write(store, "lon_bnds", [179, 181], [1, 2], ["lon", "nv"]);
  await write(store, "obs", [101, 103, 107, 109], [4], ["obs"], {
    long_name: "observation",
  });
  await write(store, "depth", [30, 10, 20, Number.NaN], [4], ["obs"], {
    units: "m",
    positive: "down",
    standard_name: "depth",
    bounds: "depth_bounds",
  });
  await write(
    store,
    "depth_bounds",
    [29, 31, 9, 11, 19, 21, Number.NaN, Number.NaN],
    [4, 2],
    ["obs", "nv"]
  );
  await write(
    store,
    "thetao",
    [0, 4, 8, 12],
    [1, 4, 1, 1],
    ["time", "obs", "lat", "lon"],
    {
      units: "degC",
      coordinates: "depth",
      cell_methods: "depth: mean",
    }
  );
  const ctx = await resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `aux-depth-${Math.random()}`
    ),
    "thetao",
    new ByteLru(2 ** 20)
  );
  expect(ctx.vertical?.bounds).toEqual([
    29,
    31,
    9,
    11,
    19,
    21,
    Number.NaN,
    Number.NaN,
  ]);
  const result = await (
    await planAnalysis(
      ctx,
      q(ANALYSIS_KINDS.PROFILE, point, { fixed: { time: 0 } }),
      new ReadContext()
    )
  ).execute();
  const model = exportModel(result);
  const byName = (name: string) => model.arrays.find((a) => a.name === name)!;
  // The observations by their own IDs, on their own dimension.
  expect(Array.from(byName("obs").data as Float64Array)).toEqual([
    101, 103, 107, 109,
  ]);
  expect(byName("obs").dims).toEqual(["obs"]);
  // The depths under their name, an auxiliary coordinate with its layers.
  const depth = byName("depth");
  expect(depth.dims).toEqual(["obs"]);
  expect(Array.from(depth.data as Float64Array)).toEqual([
    30,
    10,
    20,
    Number.NaN,
  ]);
  expect(depth.attrs.axis).toBeUndefined();
  const bounds = byName(String(depth.attrs.bounds));
  expect(Array.from(bounds.data as Float64Array)).toEqual([
    29,
    31,
    9,
    11,
    19,
    21,
    Number.NaN,
    Number.NaN,
  ]);
  const field = model.arrays.find((a) => a.attrs.gridlook_source_variable)!;
  expect(String(field.attrs.coordinates).split(" ")).toContain("depth");
  // Observation 103: 4 at 10 m over [9, 11]; the unknown depth keeps 12.
  expect(Array.from(field.data as Float64Array)).toEqual([0, 4, 8, 12]);
  if (!HAS_PYTHON) {
    return;
  }
  // Both files, by two readers: the NetCDF by netCDF4, the Zarr by xarray.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gridlook-aux-"));
  try {
    fs.writeFileSync(path.join(dir, "p.nc"), writeNetCDF(netcdf, model));
    for (const [name, bytes] of Object.entries(
      unzipSync(await toZarrZip(model))
    )) {
      fs.mkdirSync(path.dirname(path.join(dir, "p.zarr", name)), {
        recursive: true,
      });
      fs.writeFileSync(path.join(dir, "p.zarr", name), bytes);
    }
    const script = [
      "import json, os, netCDF4, xarray as xr",
      `nc = netCDF4.Dataset("${path.join(dir, "p.nc")}")`,
      `v = nc["${field.name}"]`,
      "obs = list(nc['obs'][:]); k = obs.index(103)",
      "b = nc[nc['depth'].bounds][:]",
      "a = [float(v[:].ravel()[k]), float(nc['depth'][k]), [float(x) for x in b[k]], float(v[:].ravel()[3]), bool(nc['depth'][:].mask[3]) if hasattr(nc['depth'][:], 'mask') else nc['depth'][3] != nc['depth'][3]]",
      "nc.close()",
      `ds = xr.open_dataset("${path.join(dir, "p.zarr")}", engine="zarr", decode_times=False)`,
      `da = ds["${field.name}"].sel(obs=103)`,
      "z = [float(da.values.ravel()[0]), float(da['depth']), [float(x) for x in ds['depth_bnds'].sel(obs=103).values]]",
      "print(json.dumps([a, z]), flush=True)",
      "os._exit(0)",
    ].join("\n");
    const [a, z] = JSON.parse(
      execFileSync("python3", ["-c", script]).toString()
    );
    expect(a).toEqual([4, 10, [9, 11], 12, true]);
    expect(z).toEqual([4, 10, [9, 11]]);
  } catch (error) {
    if (/No module named/.test(String(error))) {
      return;
    }
    throw error;
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

it("interim48: 64-bit observation IDs of an auxiliary depth are exported exactly", async () => {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "time", [0], [1], ["time"], {
    units: "days since 2001-01-01",
  });
  await write(store, "lat", [0], [1], ["lat"], { units: "degrees_north" });
  await write(store, "lon", [180], [1], ["lon"], { units: "degrees_east" });
  const base = 2n ** 53n;
  const obs = await zarr.create(zarr.root(store).resolve("obs"), {
    shape: [4],
    chunkShape: [4],
    dtype: "uint64",
    dimensionNames: ["obs"],
    attributes: { long_name: "observation" },
  });
  await zarr.set(obs as never, null, {
    data: BigUint64Array.of(base, base + 1n, base + 2n, base + 3n),
    shape: [4],
    stride: [1],
  } as never);
  await write(store, "depth", [30, 10, 20, 40], [4], ["obs"], {
    units: "m",
    positive: "down",
    standard_name: "depth",
  });
  await write(
    store,
    "thetao",
    [0, 4, 8, 12],
    [1, 4, 1, 1],
    ["time", "obs", "lat", "lon"],
    {
      units: "degC",
      coordinates: "depth",
    }
  );
  const ctx = await resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `aux-ids-${Math.random()}`
    ),
    "thetao",
    new ByteLru(2 ** 20)
  );
  const result = await (
    await planAnalysis(
      ctx,
      q(ANALYSIS_KINDS.PROFILE, point, { fixed: { time: 0 } }),
      new ReadContext()
    )
  ).execute();
  const model = exportModel(result);
  const ids = model.arrays.find((a) => a.name === "obs")!;
  expect(ids.type).toBe("u8");
  expect(Array.from(ids.data as BigUint64Array)).toEqual([
    base,
    base + 1n,
    base + 2n,
    base + 3n,
  ]);
  const nc = reader(netcdf, writeNetCDF(netcdf, model));
  try {
    expect(nc.uint64("obs", 4)).toEqual([
      base,
      base + 1n,
      base + 2n,
      base + 3n,
    ]);
  } finally {
    nc.close();
  }
});
