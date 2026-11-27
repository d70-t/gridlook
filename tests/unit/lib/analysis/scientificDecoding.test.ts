/* eslint-disable max-lines-per-function -- each case builds its own fixture. */
/* eslint-disable camelcase -- CF and Zarr metadata use snake_case keys. */
import v8 from "node:v8";
import vm from "node:vm";

import * as healpixGeo from "healpix-geo";
import { describe, expect, it } from "vitest";

import {
  decodeTimeValue,
  encodeTimeValue,
  formatCalendarDate,
  nearestTimeIndex,
  parseCalendarDate,
  parseTimeAxis,
  type TTimeAxis,
} from "@/lib/analysis/calendar.ts";
import { DRAWING_SPHERE_RADIUS_METERS } from "@/lib/analysis/sphere.ts";
import {
  buildValueCodec,
  decodeStoredBigInt,
  decodeStoredValue,
} from "@/lib/analysis/valueDecoding.ts";
import {
  evaluateFormula,
  FORMULA_FAMILIES,
  resolveVerticalAxis,
  VERTICAL_KINDS,
} from "@/lib/analysis/vertical.ts";
import {
  locateOnAxis,
  normalizeEllipsoid,
  resolveHealpixFrame,
} from "@/lib/grids/analysisGrid.ts";

/** A full garbage collection, to measure what stays held. */
const collect = (() => {
  v8.setFlagsFromString("--expose-gc");
  return vm.runInNewContext("gc") as () => void;
})();

function axis(units: string, calendar?: string) {
  const parsed = parseTimeAxis(units, calendar);
  if ("unsupported" in parsed) {
    throw new Error(parsed.unsupported);
  }
  return parsed as TTimeAxis;
}

function label(units: string, calendar: string | undefined, value: number) {
  return formatCalendarDate(decodeTimeValue(axis(units, calendar), value));
}

describe("CF calendars (expected dates worked out independently)", () => {
  it("noleap skips 29 February; 360_day has 30-day months", () => {
    expect(label("days since 2000-01-01", "noleap", 59)).toBe(
      "2000-03-01 00:00:00"
    );
    expect(label("days since 2000-01-01", "365_day", 365)).toBe(
      "2001-01-01 00:00:00"
    );
    expect(label("days since 2000-01-01", "360_day", 59)).toBe(
      "2000-02-30 00:00:00"
    );
    expect(label("days since 2000-01-01", "360_day", 360)).toBe(
      "2001-01-01 00:00:00"
    );
  });

  it("proleptic Gregorian and standard differ only before 1582-10-15", () => {
    expect(label("days since 2000-01-01", "proleptic_gregorian", 59)).toBe(
      "2000-02-29 00:00:00"
    );
    // 1500 is a Julian leap year but not a Gregorian one.
    expect(label("days since 1500-01-01", "standard", 59)).toBe(
      "1500-02-29 00:00:00"
    );
    expect(label("days since 1500-01-01", "proleptic_gregorian", 59)).toBe(
      "1500-03-01 00:00:00"
    );
    expect(label("days since 1582-10-04", "gregorian", 1)).toBe(
      "1582-10-15 00:00:00"
    );
    expect(label("days since 1582-10-15", "standard", -1)).toBe(
      "1582-10-04 00:00:00"
    );
  });

  it("decodes hours and seconds, and inverts for entered dates", () => {
    // 1950-2020: 70 years with 17 leap days = 25567 days.
    expect(label("hours since 1950-01-01 00:00:00", "standard", 613608)).toBe(
      "2020-01-01 00:00:00"
    );
    expect(
      label("seconds since 2000-01-01", "gregorian", 3600 * 36 + 1.5)
    ).toBe("2000-01-02 12:00:01.500");
    const noleap = axis("days since 2000-01-01", "noleap");
    const date = parseCalendarDate("2001-03-01")!;
    expect(encodeTimeValue(noleap, date)).toBe(365 + 59);
    expect(nearestTimeIndex([0, 10, 20], 15)).toBe(1); // tie goes to the earlier
  });

  it("refuses calendars and units without a tested decoder", () => {
    expect(parseTimeAxis("days since 2000-01-01", "julian")).toHaveProperty(
      "unsupported"
    );
    expect(parseTimeAxis("months since 2000-01-01", "standard")).toHaveProperty(
      "unsupported"
    );
    expect(parseTimeAxis("days since 2001-02-29", "noleap")).toHaveProperty(
      "unsupported",
      expect.stringMatching(/not a date/)
    );
    for (const units of [
      "hours since 2000-01-01 99:99:99",
      "hours since 2000-01-01 24:00",
      "seconds since 2000-01-01 12:60",
      "seconds since 2000-01-01 12:00:60",
    ]) {
      expect(parseTimeAxis(units, "standard")).toHaveProperty(
        "unsupported",
        expect.stringMatching(/clock time/)
      );
    }
  });
});

describe("CF value decoding in the stored domain", () => {
  it("decodes xarray Zarr v3 floating fill attributes for present and absent samples", () => {
    for (const dtype of ["float32", "float64"]) {
      const codec = buildValueCodec(
        { _FillValue: "AAAAAICHw8A=" },
        -9999,
        dtype,
        3
      );
      expect(decodeStoredValue(codec, -9999)).toBeNaN();
      expect(codec.absentValue).toBeNaN();
      expect(decodeStoredValue(codec, 0)).toBe(0);
    }
  });

  it("interprets signed storage, markers, and ranges in the declared unsigned domain", () => {
    const attrs = {
      _Unsigned: "true",
      _FillValue: -1,
      valid_range: [0, -2],
      scale_factor: 0.5,
    };
    const codec = buildValueCodec(attrs, -2, "int16", 3);
    expect(decodeStoredValue(codec, -1)).toBeNaN();
    expect(decodeStoredValue(codec, -2)).toBe(32767);
    expect(codec.absentValue).toBe(32767);
    const wide = buildValueCodec(attrs, -1, "int64", 3);
    expect(decodeStoredBigInt(wide, -1n)).toBeNaN();
    expect(decodeStoredBigInt(wide, -2n)).toBe(Number(2n ** 64n - 2n) * 0.5);
  });

  it("includes Float32 endpoints at stored precision", () => {
    const codec = buildValueCodec(
      { valid_range: [-0.1, 0.1] },
      0,
      "float32",
      3
    );
    expect(decodeStoredValue(codec, Math.fround(-0.1))).toBe(Math.fround(-0.1));
    expect(decodeStoredValue(codec, Math.fround(0.1))).toBe(Math.fround(0.1));
    expect(decodeStoredValue(codec, Math.fround(0.10001))).toBeNaN();
  });

  it("keeps valid zeros and masks declared markers, NaN and the valid range", () => {
    const codec = buildValueCodec(
      {
        _FillValue: -32767,
        scale_factor: 0.01,
        add_offset: 273.15,
        valid_min: -30000,
      },
      0,
      "int16"
    );
    expect(decodeStoredValue(codec, 0)).toBeCloseTo(273.15, 12); // zero fill_value with a CF fill attribute: valid
    expect(decodeStoredValue(codec, 100)).toBeCloseTo(274.15, 12);
    expect(decodeStoredValue(codec, -32767)).toBeNaN();
    expect(decodeStoredValue(codec, -31000)).toBeNaN();
    const floats = buildValueCodec(
      { missing_value: [1e20, -999] },
      Number.NaN,
      "float32"
    );
    expect(decodeStoredValue(floats, 0)).toBe(0);
    expect(decodeStoredValue(floats, Math.fround(1e20))).toBeNaN();
    expect(decodeStoredValue(floats, -999)).toBeNaN();
    expect(decodeStoredValue(floats, Number.NaN)).toBeNaN();
  });

  it("follows the map's rule for a bare zero fill value and null fills", () => {
    expect(decodeStoredValue(buildValueCodec({}, 0, "float32"), 0)).toBeNaN();
    expect(buildValueCodec({}, null, "float64").absentValue).toBeNaN();
    expect(
      buildValueCodec({ flag_values: [0, 1] }, null, "int8").categorical
    ).toBe(true);
  });
});

describe("vertical coordinates", () => {
  it("evaluates ocean_s_coordinate_g1/g2, sigma and hybrid pressure", () => {
    const s = Float64Array.from([-0.75, -0.25]);
    const C = Float64Array.from([-0.6, -0.1]);
    const scalar = { eta: 0.5, depth: 100, depth_c: 10 };
    // g1: S = depth_c*s + (depth-depth_c)*C; z = S + eta*(1+S/depth)
    const g1 = evaluateFormula(
      FORMULA_FAMILIES.OCEAN_S_G1,
      { perLevel: { s, C }, scalar },
      2
    );
    const s1 = 10 * -0.75 + 90 * -0.6;
    expect(g1[0]).toBeCloseTo(s1 + 0.5 * (1 + s1 / 100), 12);
    // g2: S = (depth_c*s + depth*C)/(depth_c+depth); z = eta + (eta+depth)*S
    const g2 = evaluateFormula(
      FORMULA_FAMILIES.OCEAN_S_G2,
      { perLevel: { s, C }, scalar },
      2
    );
    expect(g2[1]).toBeCloseTo(
      0.5 + 100.5 * ((10 * -0.25 + 100 * -0.1) / 110),
      12
    );
    const sigma = evaluateFormula(
      FORMULA_FAMILIES.OCEAN_SIGMA,
      { perLevel: { sigma: s }, scalar },
      2
    );
    expect(sigma[0]).toBeCloseTo(0.5 - 0.75 * 100.5, 12);
    const p = evaluateFormula(
      FORMULA_FAMILIES.HYBRID_PRESSURE,
      {
        perLevel: {
          ap: Float64Array.from([100, 200]),
          b: Float64Array.from([0.9, 0.5]),
        },
        scalar: { ps: 100000 },
      },
      2
    );
    expect(Array.from(p)).toEqual([90100, 50200]);
  });

  it("labels model levels and names missing formula terms", () => {
    const riomar = resolveVerticalAxis(
      1,
      "s_rho",
      { name: "s_rho" },
      () => false
    );
    expect(riomar.kind).toBe(VERTICAL_KINDS.MODEL);
    expect(riomar.note).toMatch(/s_rho has no standard_name/);
    const missing = resolveVerticalAxis(
      1,
      "s_rho",
      {
        standard_name: "ocean_s_coordinate_g2",
        formula_terms: "s: s_rho C: Cs_r eta: zeta depth: h depth_c: hc",
      },
      (name) => name !== "h" && name !== "hc"
    );
    expect(missing.kind).toBe(VERTICAL_KINDS.MODEL);
    expect(missing.note).toMatch(/depth, depth_c/);
    expect(missing.units).toBeUndefined();
    const depth = resolveVerticalAxis(
      1,
      "depth",
      { units: "m", positive: "down", standard_name: "depth" },
      () => true
    );
    expect(depth.kind).toBe(VERTICAL_KINDS.PHYSICAL);
  });
});

describe("HEALPix frame precedence (reproducer)", () => {
  const easygems = {
    grid_mapping_name: "healpix",
    healpix_nside: 8192,
    healpix_order: "nest",
  };
  // Publisher metadata as in the RiOMar store's dggs attribute.
  const dggs = {
    name: "healpix",
    refinement_level: 13,
    indexing_scheme: "nested",
    ellipsoid: {
      name: "wgs84",
      semimajor_axis: 6378137.0,
      inverse_flattening: 298.257223563,
    },
  };

  it("locates cells in the map's frame and names the declared ellipsoid (review of interim26)", () => {
    // The declared form is rejected verbatim by healpix-geo.
    expect(
      () =>
        new healpixGeo.Grid({
          scheme: "nested",
          level: 13,
          ellipsoid: dggs.ellipsoid as never,
        })
    ).toThrow();
    // The map draws an Easygems grid on its sphere: plots locate cells
    // there too (a click plots the cell drawn under it), and the declared
    // ellipsoid is named, since the two frames differ by about 14 km.
    const frame = resolveHealpixFrame({ crsAttrs: easygems, dggs });
    expect(frame.options.ellipsoid).toBeUndefined();
    expect(frame.conflicts.join(" ")).toMatch(/declares the .* ellipsoid/);
    const sphere = new healpixGeo.Grid({ scheme: "nested", level: 13 });
    const wgs84 = new healpixGeo.Grid({
      ...frame.options,
      ellipsoid: {
        semi_major_axis: 6378137,
        inverse_flattening: 298.257223563,
      },
    } as never);
    const point = new Float64Array([5, 45]);
    const onSphere = sphere.healpixToLonLat(sphere.lonLatToHealpix(point));
    const onWgs84 = sphere.healpixToLonLat(wgs84.lonLatToHealpix(point));
    const displacementKm =
      ((onSphere[1] - onWgs84[1]) * Math.PI * DRAWING_SPHERE_RADIUS_METERS) /
      180 /
      1000;
    expect(displacementKm).toBeGreaterThan(13);
    expect(displacementKm).toBeLessThan(15);
  });

  it("keeps spherical sources spherical and reports conflicting metadata", () => {
    expect(
      resolveHealpixFrame({ crsAttrs: easygems }).options.ellipsoid
    ).toBeUndefined();
    expect(
      resolveHealpixFrame({
        crsAttrs: easygems,
        dggs: { ...dggs, ellipsoid: undefined },
      }).options.ellipsoid
    ).toBeUndefined();
    expect(
      resolveHealpixFrame({ dggs: { ...dggs, ellipsoid: null } }).options
        .ellipsoid
    ).toBeNull();
    expect(resolveHealpixFrame({ cellCount: 12 * 4 ** 5 }).options.level).toBe(
      5
    );
    const conflict = resolveHealpixFrame({
      crsAttrs: easygems,
      dggs: { ...dggs, refinement_level: 12 },
    });
    expect(conflict.conflicts[0]).toMatch(/order 13.*order 12/);
    expect(conflict.options.ellipsoid).toBeUndefined();
    expect(normalizeEllipsoid("WGS 84")).toHaveProperty("ellipsoid");
    expect(normalizeEllipsoid({ foo: 1 })).toHaveProperty("error");
  });
});

describe("NetCDF implied valid ranges across storage types", () => {
  it("masks values beyond an explicit wide integer fill", () => {
    const codec = buildValueCodec({ _FillValue: -99n }, null, "int64", -2);
    expect(
      [-100n, -99n, -98n].map((v) => decodeStoredBigInt(codec, v))
    ).toEqual([NaN, NaN, -98]);
  });

  it("final review of interim41: the default short fill limits, the byte default does not", () => {
    // int16: NetCDF's default fill −32767 makes −32768 invalid too.
    const short = buildValueCodec({}, null, "int16", -2);
    expect(
      [-32768, -32767, -32766, 5].map((v) => decodeStoredValue(short, v))
    ).toEqual([NaN, NaN, -32766, 5]);
    // Bytes have no default fill: every value is data (Unidata).
    const byte = buildValueCodec({}, null, "int8", -2);
    expect([-128, -127, 0, 127].map((v) => decodeStoredValue(byte, v))).toEqual(
      [-128, -127, 0, 127]
    );
  });

  it("uses the default float fill to limit unbounded NetCDF data", () => {
    const codec = buildValueCodec({}, null, "float32", -2);
    expect(
      [1, 9.969209968386869e36, 1e37].map((v) =>
        decodeStoredValue(codec, Math.fround(v))
      )
    ).toEqual([1, NaN, NaN]);
  });
});

describe("64-bit integer fill and range", () => {
  it("keeps a written zero when Zarr v2 fills storage with 0 and CF says −999", () => {
    const codec = buildValueCodec({ _FillValue: -999 }, 0, "int64", 2);
    expect(decodeStoredBigInt(codec, 0n)).toBe(0);
    expect(decodeStoredBigInt(codec, -999n)).toBeNaN();
    // An unwritten chunk holds the logical fill 0: a value, not missing.
    expect(codec.absentValue).toBe(0);
  });

  it("still masks a non-zero v2 storage fill", () => {
    const codec = buildValueCodec({}, -1, "int64", 2);
    expect(decodeStoredBigInt(codec, -1n)).toBeNaN();
    expect(codec.absentValue).toBeNaN();
  });

  it("compares the valid range exactly next to 2^53", () => {
    const codec = buildValueCodec(
      { valid_max: "9007199254740993" },
      null,
      "int64",
      3
    );
    expect(decodeStoredBigInt(codec, 9007199254740993n)).toBe(2 ** 53);
    expect(decodeStoredBigInt(codec, 9007199254740994n)).toBeNaN();
  });
});

describe("64-bit markers from raw metadata (v7 review)", () => {
  it("masks exactly 9007199254740993, not its rounded neighbour", async () => {
    const { zarrAnalysisDatasetFromStore } =
      await import("@/lib/analysis/sourceAdapter.ts");
    const { ZARR_FORMAT } = await import("@/lib/types/GlobeTypes.ts");
    const text = (value: string) => new TextEncoder().encode(value);
    const data = new BigInt64Array([
      9007199254740992n,
      9007199254740993n,
      9007199254740994n,
    ]);
    const store = new Map<string, Uint8Array>([
      ["/.zgroup", text('{"zarr_format": 2}')],
      [
        "/x/.zarray",
        text(
          '{"zarr_format": 2, "shape": [3], "chunks": [3], "dtype": "<i8", "compressor": null, "fill_value": 0, "order": "C", "filters": null}'
        ),
      ],
      [
        "/x/.zattrs",
        text('{"_ARRAY_DIMENSIONS": ["i"], "_FillValue": 9007199254740993}'),
      ],
      ["/x/0", new Uint8Array(data.buffer)],
    ]);
    const dataset = zarrAnalysisDatasetFromStore(
      { get: async (key: string) => store.get(key) } as never,
      "",
      ZARR_FORMAT.V2,
      "raw-int64"
    );
    const array = await dataset.openArray("x");
    const codec = buildValueCodec(array.attrs, array.fillValue, array.dtype, 2);
    const chunk = await array.readChunk([0]);
    const values = Array.from(chunk.data as BigInt64Array, (v) =>
      decodeStoredBigInt(codec, v)
    );
    expect(values[0]).toBe(9007199254740992);
    expect(values[1]).toBeNaN();
    expect(values[2]).toBe(9007199254740994);
  });
});

describe("64-bit markers at the right metadata level (v8 review)", () => {
  async function decodedV2(
    zattrs: string,
    stored?: bigint[],
    /** Fails the given read of.zattrs (counted from 1) with a 503. */
    failing?: number
  ) {
    const { zarrAnalysisDatasetFromStore } =
      await import("@/lib/analysis/sourceAdapter.ts");
    const { ZARR_FORMAT } = await import("@/lib/types/GlobeTypes.ts");
    const text = (value: string) => new TextEncoder().encode(value);
    const data = new BigInt64Array(
      stored ?? [9007199254740992n, 9007199254740993n, 9007199254740994n]
    );
    const store = new Map<string, Uint8Array>([
      ["/.zgroup", text('{"zarr_format": 2}')],
      [
        "/x/.zarray",
        text(
          '{"zarr_format": 2, "shape": [3], "chunks": [3], "dtype": "<i8", "compressor": null, "fill_value": 0, "order": "C", "filters": null}'
        ),
      ],
      ["/x/.zattrs", text(zattrs)],
      ["/x/0", new Uint8Array(data.buffer)],
    ]);
    let attrsReads = 0;
    const dataset = zarrAnalysisDatasetFromStore(
      {
        get: async (key: string) => {
          if (key === "/x/.zattrs" && ++attrsReads === failing) {
            throw new Error("HTTP 503 Service Unavailable");
          }
          return store.get(key);
        },
      } as never,
      "",
      ZARR_FORMAT.V2,
      `level-${Math.random()}`
    );
    const array = await dataset
      .openArray("x")
      .catch(() => dataset.openArray("x"));
    const codec = buildValueCodec(array.attrs, array.fillValue, array.dtype, 2);
    const chunk = await array.readChunk([0]);
    return Array.from(chunk.data as BigInt64Array, (v) =>
      decodeStoredBigInt(codec, v)
    );
  }

  it("unpacks fractional int64 values when the product crosses the safe integer limit", async () => {
    const values = await decodedV2(
      '{"_ARRAY_DIMENSIONS":["i"],"scale_factor":2.5,"add_offset":-11258999068426240}',
      [4503599627370496n, 4503599627370497n, 4503599627370498n]
    );
    expect(values).toEqual([0, 2.5, 5]);
  });

  it("decodes large int64 values with a finite subnormal scale", async () => {
    const values = await decodedV2(
      '{"_ARRAY_DIMENSIONS":["i"],"scale_factor":1e-310}'
    );
    expect(values[0]).toBe(2 ** 53 * 1e-310);
  });

  it("final review of interim41: a 503 on the exact metadata read never swaps a value and its fill", async () => {
    // Fill 2^53 + 1 beside the valid 2^53: rounded, they would swap.
    const zattrs = '{"_ARRAY_DIMENSIONS":["i"],"_FillValue":9007199254740993}';
    for (const failing of [1, 2]) {
      expect(await decodedV2(zattrs, undefined, failing)).toEqual([
        9007199254740992,
        NaN,
        9007199254740994,
      ]);
    }
  });

  it("preserves an odd int64 bound of disjoint ranges in Zarr metadata", async () => {
    const values = await decodedV2(
      '{"_ARRAY_DIMENSIONS":["i"],"valid_ranges":[[9007199254740993,9007199254740993],[9007199254740994,9007199254740994]],"add_offset":-9007199254740992}'
    );
    expect(values).toEqual([NaN, 1, 2]);
  });

  it("masks an int64 sample between two disjoint valid ranges", async () => {
    const values = await decodedV2(
      '{"_ARRAY_DIMENSIONS":["i"],"valid_ranges":[[9007199254740992,9007199254740992],[9007199254740994,9007199254740994]]}'
    );
    expect(values).toEqual([9007199254740992, NaN, 9007199254740994]);
  });

  it("preserves a fractional step beside a cancelling offset when unpacking int64", async () => {
    const values = await decodedV2(
      '{"_ARRAY_DIMENSIONS":["i"],"scale_factor":0.5,"add_offset":-4503599627370496}'
    );
    expect(values).toEqual([0, 0.5, 1]);
  });

  it("preserves a wide packing offset from Zarr metadata before unpacking int64", async () => {
    const values = await decodedV2(
      '{"_ARRAY_DIMENSIONS":["i"],"scale_factor":1,"add_offset":-9007199254740993}'
    );
    expect(values).toEqual([-1, 0, 1]);
  });

  for (const [label, zattrs] of [
    [
      "a marker array",
      '{"_ARRAY_DIMENSIONS": ["i"], "missing_value": [9007199254740993, 5]}',
    ],
    [
      "a same-named nested key before the top-level one",
      '{"_ARRAY_DIMENSIONS": ["i"], "history": {"_FillValue": 9007199254740992}, "_FillValue": 9007199254740993}',
    ],
    [
      "an exact exponential literal",
      '{"_ARRAY_DIMENSIONS": ["i"], "_FillValue": 9.007199254740993e15}',
    ],
  ]) {
    it(`masks only 9007199254740993 with ${label}`, async () => {
      const values = await decodedV2(zattrs);
      expect(values[0]).toBe(9007199254740992);
      expect(values[1]).toBeNaN();
      expect(values[2]).toBe(9007199254740994);
    });
  }

  it("a shard's omitted inner chunks take the exact logical fill", async () => {
    const { zarrAnalysisDatasetFromStore } =
      await import("@/lib/analysis/sourceAdapter.ts");
    const { ZARR_FORMAT } = await import("@/lib/types/GlobeTypes.ts");
    const text = (value: string) => new TextEncoder().encode(value);
    // Inner chunks of one value; 1 holds 42 and 3 a real …992, 0 and 2
    // are omitted from the shard (index entries of all ones).
    const body = new BigInt64Array([42n, 9007199254740992n]);
    const index = new BigUint64Array([
      2n ** 64n - 1n,
      2n ** 64n - 1n,
      0n,
      8n,
      2n ** 64n - 1n,
      2n ** 64n - 1n,
      8n,
      8n,
    ]);
    const shard = new Uint8Array(body.byteLength + index.byteLength);
    shard.set(new Uint8Array(body.buffer), 0);
    shard.set(new Uint8Array(index.buffer), body.byteLength);
    const metadata = `{"zarr_format": 3, "node_type": "array", "shape": [4], "data_type": "int64",
      "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [4]}},
      "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
      "fill_value": 9007199254740993,
      "codecs": [{"name": "sharding_indexed", "configuration": {"chunk_shape": [1],
        "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
        "index_codecs": [{"name": "bytes", "configuration": {"endian": "little"}}]}}],
      "attributes": {"_FillValue": 9007199254740993}, "dimension_names": ["i"]}`;
    const store = new Map<string, Uint8Array>([
      ["/zarr.json", text('{"zarr_format": 3, "node_type": "group"}')],
      ["/x/zarr.json", text(metadata)],
      ["/x/c/0", shard],
    ]);
    const dataset = zarrAnalysisDatasetFromStore(
      {
        get: async (key: string) => store.get(key),
        getRange: async (
          key: string,
          range: { offset: number; length: number } | { suffixLength: number }
        ) => {
          const bytes = store.get(key);
          if (!bytes) {
            return undefined;
          }
          return "suffixLength" in range
            ? bytes.slice(bytes.length - range.suffixLength)
            : bytes.slice(range.offset, range.offset + range.length);
        },
      } as never,
      "",
      ZARR_FORMAT.V3,
      `shard-${Math.random()}`
    );
    const array = await dataset.openArray("x");
    expect(array.chunks).toEqual([1]);
    const codec = buildValueCodec(array.attrs, array.fillValue, array.dtype, 3);
    const values: number[] = [];
    for (let c = 0; c < 4; c++) {
      const chunk = await array.readChunk([c]);
      values.push(
        chunk.absent
          ? codec.absentValue
          : decodeStoredBigInt(codec, (chunk.data as BigInt64Array)[0])
      );
    }
    expect(values[0]).toBeNaN();
    expect(values[1]).toBe(42);
    expect(values[2]).toBeNaN();
    expect(values[3]).toBe(9007199254740992);
  });
});

describe("sharded coordinates and ids with omitted inner chunks (v9 review)", () => {
  const text = (value: string) => new TextEncoder().encode(value);
  /** A v3 array of one-value inner chunks; `stored` maps index → bytes. */
  function shardedArray(
    dtype: string,
    fill: number,
    length: number,
    stored: Map<number, Uint8Array>,
    attrs: Record<string, unknown>,
    dims: string[]
  ) {
    const parts: Uint8Array[] = [];
    const index = new BigUint64Array(2 * length).fill(2n ** 64n - 1n);
    let offset = 0;
    for (let at = 0; at < length; at++) {
      const bytes = stored.get(at);
      if (bytes) {
        index[2 * at] = BigInt(offset);
        index[2 * at + 1] = BigInt(bytes.length);
        parts.push(bytes);
        offset += bytes.length;
      }
    }
    const shard = new Uint8Array(offset + index.byteLength);
    let at = 0;
    for (const part of parts) {
      shard.set(part, at);
      at += part.length;
    }
    shard.set(new Uint8Array(index.buffer), offset);
    const metadata = JSON.stringify({
      zarr_format: 3,
      node_type: "array",
      shape: [length],
      data_type: dtype,
      chunk_grid: { name: "regular", configuration: { chunk_shape: [length] } },
      chunk_key_encoding: {
        name: "default",
        configuration: { separator: "/" },
      },
      fill_value: fill,
      codecs: [
        {
          name: "sharding_indexed",
          configuration: {
            chunk_shape: [1],
            codecs: [{ name: "bytes", configuration: { endian: "little" } }],
            index_codecs: [
              { name: "bytes", configuration: { endian: "little" } },
            ],
          },
        },
      ],
      attributes: attrs,
      dimension_names: dims,
    });
    return { metadata: text(metadata), shard };
  }

  function rangedStore(entries: [string, Uint8Array][]) {
    const store = new Map(entries);
    return {
      get: async (key: string) => store.get(key),
      getRange: async (
        key: string,
        range: { offset: number; length: number } | { suffixLength: number }
      ) => {
        const bytes = store.get(key);
        if (!bytes) {
          return undefined;
        }
        return "suffixLength" in range
          ? bytes.slice(bytes.length - range.suffixLength)
          : bytes.slice(range.offset, range.offset + range.length);
      },
    };
  }

  for (const written of [true, false]) {
    it(`a latitude of 0 ${written ? "written" : "omitted from its shard"} is a valid latitude`, async () => {
      const { zarrAnalysisDatasetFromStore } =
        await import("@/lib/analysis/sourceAdapter.ts");
      const { resolveVariableContext } =
        await import("@/lib/analysis/variableContext.ts");
      const { ByteLru } = await import("@/lib/analysis/byteLru.ts");
      const { ZARR_FORMAT } = await import("@/lib/types/GlobeTypes.ts");
      const f8 = (v: number) => new Uint8Array(Float64Array.of(v).buffer);
      const lat = shardedArray(
        "float64",
        0,
        2,
        new Map(
          written
            ? [
                [0, f8(0)],
                [1, f8(10)],
              ]
            : [[1, f8(10)]]
        ),
        { units: "degrees_north" },
        ["lat"]
      );
      const lon = shardedArray(
        "float64",
        0,
        1,
        new Map([[0, f8(5)]]),
        { units: "degrees_east" },
        ["lon"]
      );
      const tas = text(
        JSON.stringify({
          zarr_format: 3,
          node_type: "array",
          shape: [2, 1],
          data_type: "float64",
          chunk_grid: {
            name: "regular",
            configuration: { chunk_shape: [2, 1] },
          },
          chunk_key_encoding: {
            name: "default",
            configuration: { separator: "/" },
          },
          fill_value: "NaN",
          codecs: [{ name: "bytes", configuration: { endian: "little" } }],
          attributes: {},
          dimension_names: ["lat", "lon"],
        })
      );
      const store = rangedStore([
        ["/zarr.json", text('{"zarr_format": 3, "node_type": "group"}')],
        ["/lat/zarr.json", lat.metadata],
        ["/lat/c/0", lat.shard],
        ["/lon/zarr.json", lon.metadata],
        ["/lon/c/0", lon.shard],
        ["/tas/zarr.json", tas],
        ["/tas/c/0/0", new Uint8Array(Float64Array.of(1, 2).buffer)],
      ]);
      const ctx = await resolveVariableContext(
        zarrAnalysisDatasetFromStore(
          store as never,
          "",
          ZARR_FORMAT.V3,
          `shard-lat-${written}-${Math.random()}`
        ),
        "tas",
        new ByteLru<BigInt64Array>(2 ** 20)
      );
      expect(ctx.grid.kind).toBe("rectilinear");
      expect(
        Array.from(
          (ctx.grid as unknown as { lat: { values: ArrayLike<number> } }).lat
            .values
        )
      ).toEqual([0, 10]);
    });
  }

  it("an omitted int64 inner chunk reads as the exact logical fill", async () => {
    const { zarrAnalysisDatasetFromStore } =
      await import("@/lib/analysis/sourceAdapter.ts");
    const { ZARR_FORMAT } = await import("@/lib/types/GlobeTypes.ts");
    const i8 = (v: bigint) => new Uint8Array(BigInt64Array.of(v).buffer);
    const ids = shardedArray("int64", 0, 2, new Map([[1, i8(3n)]]), {}, [
      "cell",
    ]);
    const store = rangedStore([
      ["/zarr.json", text('{"zarr_format": 3, "node_type": "group"}')],
      ["/cell_ids/zarr.json", ids.metadata],
      ["/cell_ids/c/0", ids.shard],
    ]);
    const dataset = zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `shard-ids-${Math.random()}`
    );
    const array = await dataset.openArray("cell_ids");
    const omitted = await array.readChunk([0]);
    const stored = await array.readChunk([1]);
    expect(omitted.absent).toBe(true);
    expect(Array.from(omitted.data as BigInt64Array)).toEqual([0n]);
    expect(Array.from(stored.data as BigInt64Array)).toEqual([3n]);
  });
});

describe("bounded rectilinear outer edges", () => {
  it("includes polar edges with either axis direction and assigns shared edges once", () => {
    for (const descending of [true, false]) {
      const values = Float64Array.from(descending ? [85, 75] : [75, 85]);
      const bounds = Float64Array.from(
        descending ? [90, 80, 80, 70] : [70, 80, 80, 90]
      );
      const axis = { values, bounds, periodic: false };
      expect(locateOnAxis(axis, 90).index).toBe(descending ? 0 : 1);
      expect(locateOnAxis(axis, 80).index).toBe(descending ? 0 : 1);
      expect(locateOnAxis(axis, 70).index).toBe(descending ? 1 : 0);
      expect(locateOnAxis(axis, 91).index).toBe(-1);
    }
  });

  it("includes the seam of a single full-circle longitude cell", () => {
    const axis = {
      values: Float64Array.of(0),
      bounds: Float64Array.of(-180, 180),
      longitude: true,
      periodic: false,
    };
    for (const x of [-540, -180, 180, 540]) {
      expect(locateOnAxis(axis, x).index).toBe(0);
    }
  });
});

describe("review of interim10: a republished shard is read afresh", () => {
  const text = (value: string) => new TextEncoder().encode(value);
  const EMPTY = 2n ** 64n - 1n;
  /** One shard of three float64 inner chunks; `slots` maps slot → value. */
  function shardOf(slots: [number, number][]) {
    const body = new Float64Array(slots.map(([, value]) => value));
    const index = new BigUint64Array(6).fill(EMPTY);
    slots.forEach(([slot], at) => {
      index[2 * slot] = BigInt(8 * at);
      index[2 * slot + 1] = 8n;
    });
    const shard = new Uint8Array(body.byteLength + index.byteLength);
    shard.set(new Uint8Array(body.buffer), 0);
    shard.set(new Uint8Array(index.buffer), body.byteLength);
    return shard;
  }

  it("uses the new offsets and slots after a publication, not the old index", async () => {
    const { zarrAnalysisDatasetFromStore } =
      await import("@/lib/analysis/sourceAdapter.ts");
    const { ZARR_FORMAT } = await import("@/lib/types/GlobeTypes.ts");
    const metadata = `{"zarr_format": 3, "node_type": "array", "shape": [3], "data_type": "float64",
      "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [3]}},
      "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
      "fill_value": "NaN",
      "codecs": [{"name": "sharding_indexed", "configuration": {"chunk_shape": [1],
        "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
        "index_codecs": [{"name": "bytes", "configuration": {"endian": "little"}}]}}],
      "attributes": {}, "dimension_names": ["time"]}`;
    const store = new Map<string, Uint8Array>([
      ["/zarr.json", text('{"zarr_format": 3, "node_type": "group"}')],
      ["/x/zarr.json", text(metadata)],
      // Slots 0 and 1 hold 11 and 22; slot 2 is omitted.
      [
        "/x/c/0",
        shardOf([
          [0, 11],
          [1, 22],
        ]),
      ],
    ]);
    const dataset = zarrAnalysisDatasetFromStore(
      {
        get: async (key: string) => store.get(key),
        getRange: async (
          key: string,
          range: { offset: number; length: number } | { suffixLength: number }
        ) => {
          const bytes = store.get(key);
          return !bytes
            ? undefined
            : "suffixLength" in range
              ? bytes.slice(bytes.length - range.suffixLength)
              : bytes.slice(range.offset, range.offset + range.length);
        },
      } as never,
      "",
      ZARR_FORMAT.V3,
      `shard-${Math.random()}`
    );
    const array = await dataset.openArray("x");
    const value = async (slot: number) => {
      const chunk = await array.readChunk([slot]);
      return chunk.absent ? "missing" : (chunk.data as Float64Array)[0];
    };
    expect([await value(1), await value(2)]).toEqual([22, "missing"]);
    // Republished, repacked: slot 2 first in the payload, then slot 1.
    store.set(
      "/x/c/0",
      shardOf([
        [2, 77],
        [1, 55],
        [0, 11],
      ])
    );
    array.forgetShards?.(0, 1, 2);
    expect([await value(1), await value(2)]).toEqual([55, 77]);
  });

  it("independent review of interim41: a republished shard's index counts once per reader that holds it", async () => {
    const { zarrAnalysisDatasetFromStore } =
      await import("@/lib/analysis/sourceAdapter.ts");
    const { ZARR_FORMAT } = await import("@/lib/types/GlobeTypes.ts");
    // 64 spatial shards at one time step, 65,536 slots: a 1 MiB index each.
    const slots = 65_536;
    const shards = 64;
    const index = new BigUint64Array(2 * slots).fill(EMPTY);
    index[0] = 0n;
    index[1] = 8n;
    const shard = new Uint8Array(8 + index.byteLength);
    shard.set(new Uint8Array(new Float64Array([5]).buffer), 0);
    shard.set(new Uint8Array(index.buffer), 8);
    const metadata = `{"zarr_format": 3, "node_type": "array", "shape": [1, ${slots * shards}], "data_type": "float64",
      "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [1, ${slots}]}},
      "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
      "fill_value": "NaN",
      "codecs": [{"name": "sharding_indexed", "configuration": {"chunk_shape": [1, 1],
        "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
        "index_codecs": [{"name": "bytes", "configuration": {"endian": "little"}}]}}],
      "attributes": {}, "dimension_names": ["time", "cell"]}`;
    let indexReads = 0;
    const dataset = zarrAnalysisDatasetFromStore(
      {
        get: async (key: string) =>
          key === "/zarr.json"
            ? text('{"zarr_format": 3, "node_type": "group"}')
            : key === "/x/zarr.json"
              ? text(metadata)
              : undefined,
        getRange: async (
          key: string,
          range: { offset: number; length: number } | { suffixLength: number }
        ) => {
          if (!/^\/x\/c\/0\/\d+$/.test(key)) {
            return undefined;
          }
          if ("suffixLength" in range) {
            indexReads++;
            return shard.slice(shard.length - range.suffixLength);
          }
          return shard.slice(range.offset, range.offset + range.length);
        },
      } as never,
      "",
      ZARR_FORMAT.V3,
      `shard-held-${Math.random()}`
    );
    const array = await dataset.openArray("x");
    const sweep = async () => {
      const before = indexReads;
      for (let s = 0; s < shards; s++) {
        expect((await array.readChunk([0, s * slots])).data[0]).toBe(5);
      }
      return indexReads - before;
    };
    const held = () => {
      collect();
      return process.memoryUsage().arrayBuffers;
    };
    const base = held();
    expect(await sweep()).toBe(shards);
    expect(held() - base).toBeLessThan(72 * 2 ** 20);
    // Twice: published, the same 64 cells read again, then left alone
    // (no other shard is read that would start the readers over).
    for (let pass = 0; pass < 2; pass++) {
      array.forgetShards?.(0, 0, 0);
      expect(await sweep()).toBe(shards);
      expect(held() - base).toBeLessThan(72 * 2 ** 20);
    }
  });

  it("review of interim43: four sharded variables share one index budget", async () => {
    const { zarrAnalysisDatasetFromStore } =
      await import("@/lib/analysis/sourceAdapter.ts");
    const { ZARR_FORMAT } = await import("@/lib/types/GlobeTypes.ts");
    // Four variables, 64 spatial shards each at one time step, 65,536
    // slots: a 1 MiB index a shard.
    const slots = 65_536;
    const shards = 64;
    const index = new BigUint64Array(2 * slots).fill(EMPTY);
    index[0] = 0n;
    index[1] = 8n;
    const shard = new Uint8Array(8 + index.byteLength);
    shard.set(new Uint8Array(new Float64Array([5]).buffer), 0);
    shard.set(new Uint8Array(index.buffer), 8);
    const metadata = `{"zarr_format": 3, "node_type": "array", "shape": [1, ${slots * shards}], "data_type": "float64",
      "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [1, ${slots}]}},
      "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
      "fill_value": "NaN",
      "codecs": [{"name": "sharding_indexed", "configuration": {"chunk_shape": [1, 1],
        "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
        "index_codecs": [{"name": "bytes", "configuration": {"endian": "little"}}]}}],
      "attributes": {}, "dimension_names": ["time", "cell"]}`;
    const dataset = zarrAnalysisDatasetFromStore(
      {
        get: async (key: string) =>
          key === "/zarr.json"
            ? text('{"zarr_format": 3, "node_type": "group"}')
            : /^\/v\d\/zarr\.json$/.test(key)
              ? text(metadata)
              : undefined,
        getRange: async (
          key: string,
          range: { offset: number; length: number } | { suffixLength: number }
        ) => {
          if (!/^\/v\d\/c\/0\/\d+$/.test(key)) {
            return undefined;
          }
          return "suffixLength" in range
            ? shard.slice(shard.length - range.suffixLength)
            : shard.slice(range.offset, range.offset + range.length);
        },
      } as never,
      "",
      ZARR_FORMAT.V3,
      `shard-page-${Math.random()}`
    );
    const arrays = await Promise.all(
      [0, 1, 2, 3].map((v) => dataset.openArray(`v${v}`))
    );
    const held = () => {
      collect();
      return process.memoryUsage().arrayBuffers;
    };
    const base = held();
    for (const array of arrays) {
      for (let s = 0; s < shards; s++) {
        expect((await array.readChunk([0, s * slots])).data[0]).toBe(5);
      }
      // One budget for all four, not one each (256 MiB).
      expect(held() - base).toBeLessThan(72 * 2 ** 20);
    }
    // The first one, its readers let go, reads afresh.
    expect((await arrays[0].readChunk([0, 0])).data[0]).toBe(5);
  });

  it("independent review of interim45: one index past the budget lets one go, not an array's", async () => {
    const { zarrAnalysisDatasetFromStore } =
      await import("@/lib/analysis/sourceAdapter.ts");
    const { ZARR_FORMAT } = await import("@/lib/types/GlobeTypes.ts");
    // Four variables of 17 shards, 65,536 slots: a 1 MiB index a shard.
    const slots = 65_536;
    const shards = 17;
    const index = new BigUint64Array(2 * slots).fill(EMPTY);
    index[0] = 0n;
    index[1] = 8n;
    const shard = new Uint8Array(8 + index.byteLength);
    shard.set(new Uint8Array(new Float64Array([5]).buffer), 0);
    shard.set(new Uint8Array(index.buffer), 8);
    const metadata = `{"zarr_format": 3, "node_type": "array", "shape": [1, ${slots * shards}], "data_type": "float64",
      "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [1, ${slots}]}},
      "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
      "fill_value": "NaN",
      "codecs": [{"name": "sharding_indexed", "configuration": {"chunk_shape": [1, 1],
        "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
        "index_codecs": [{"name": "bytes", "configuration": {"endian": "little"}}]}}],
      "attributes": {}, "dimension_names": ["time", "cell"]}`;
    const indexReads: string[] = [];
    const dataset = zarrAnalysisDatasetFromStore(
      {
        get: async (key: string) =>
          key === "/zarr.json"
            ? text('{"zarr_format": 3, "node_type": "group"}')
            : /^\/v\d\/zarr\.json$/.test(key)
              ? text(metadata)
              : undefined,
        getRange: async (
          key: string,
          range: { offset: number; length: number } | { suffixLength: number }
        ) => {
          if (!/^\/v\d\/c\/0\/\d+$/.test(key)) {
            return undefined;
          }
          if ("suffixLength" in range) {
            indexReads.push(key);
            return shard.slice(shard.length - range.suffixLength);
          }
          return shard.slice(range.offset, range.offset + range.length);
        },
      } as never,
      "",
      ZARR_FORMAT.V3,
      `shard-one-${Math.random()}`
    );
    const arrays = await Promise.all(
      [0, 1, 2, 3].map((v) => dataset.openArray(`v${v}`))
    );
    // 16 shards each: the whole 64 MiB budget.
    for (const array of arrays) {
      for (let s = 0; s < 16; s++) {
        await array.readChunk([0, s * slots]);
      }
    }
    expect(indexReads).toHaveLength(64);
    // One more on the fourth: the oldest index, the first's shard 0, goes.
    await arrays[3].readChunk([0, 16 * slots]);
    indexReads.length = 0;
    for (let s = 1; s < 16; s++) {
      expect((await arrays[0].readChunk([0, s * slots])).data[0]).toBe(5);
    }
    // Its fifteen hotter neighbours were kept (15 MiB read again before).
    expect(indexReads).toEqual([]);
    // And shard 0 itself is read again, once.
    await arrays[0].readChunk([0, 0]);
    expect(indexReads).toEqual(["/v0/c/0/0"]);
  });

  it("independent review of interim41: a publication over 500,000 shards lists none of them", async () => {
    const { zarrAnalysisDatasetFromStore } =
      await import("@/lib/analysis/sourceAdapter.ts");
    const { ZARR_FORMAT } = await import("@/lib/types/GlobeTypes.ts");
    const steps = 500_000;
    const metadata = `{"zarr_format": 3, "node_type": "array", "shape": [${steps}], "data_type": "float64",
      "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [1]}},
      "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
      "fill_value": "NaN",
      "codecs": [{"name": "sharding_indexed", "configuration": {"chunk_shape": [1],
        "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
        "index_codecs": [{"name": "bytes", "configuration": {"endian": "little"}}]}}],
      "attributes": {}, "dimension_names": ["time"]}`;
    // One slot a shard: the value 7, then its offset and length.
    const one = new Uint8Array(24);
    one.set(new Uint8Array(new Float64Array([7]).buffer), 0);
    one.set(new Uint8Array(new BigUint64Array([0n, 8n]).buffer), 8);
    const dataset = zarrAnalysisDatasetFromStore(
      {
        get: async (key: string) =>
          key === "/zarr.json"
            ? text('{"zarr_format": 3, "node_type": "group"}')
            : key === "/x/zarr.json"
              ? text(metadata)
              : undefined,
        getRange: async (
          _key: string,
          range: { offset: number; length: number } | { suffixLength: number }
        ) =>
          "suffixLength" in range
            ? one.slice(one.length - range.suffixLength)
            : one.slice(range.offset, range.offset + range.length),
      } as never,
      "",
      ZARR_FORMAT.V3,
      `shard-wide-${Math.random()}`
    );
    const array = await dataset.openArray("x");
    expect((await array.readChunk([steps - 1])).data[0]).toBe(7);
    collect();
    const before = process.memoryUsage().heapUsed;
    array.forgetShards?.(0, 0, steps - 1);
    expect((await array.readChunk([steps - 1])).data[0]).toBe(7);
    expect((await array.readChunk([0])).data[0]).toBe(7);
    // One reader for all of them, not an entry per shard (25 MiB before).
    collect();
    expect(process.memoryUsage().heapUsed - before).toBeLessThan(4 * 2 ** 20);
  });

  it("keeps renewed shard indices within the 64 MiB budget (review of interim33)", async () => {
    const { zarrAnalysisDatasetFromStore } =
      await import("@/lib/analysis/sourceAdapter.ts");
    const { ZARR_FORMAT } = await import("@/lib/types/GlobeTypes.ts");
    // 80 shards of 65,536 one-value slots: a 1 MiB index each.
    const slots = 65_536;
    const shards = 80;
    const index = new BigUint64Array(2 * slots).fill(EMPTY);
    index[0] = 0n;
    index[1] = 8n;
    const shard = new Uint8Array(8 + index.byteLength);
    shard.set(new Uint8Array(new Float64Array([5]).buffer), 0);
    shard.set(new Uint8Array(index.buffer), 8);
    const metadata = `{"zarr_format": 3, "node_type": "array", "shape": [${slots * shards}], "data_type": "float64",
      "chunk_grid": {"name": "regular", "configuration": {"chunk_shape": [${slots}]}},
      "chunk_key_encoding": {"name": "default", "configuration": {"separator": "/"}},
      "fill_value": "NaN",
      "codecs": [{"name": "sharding_indexed", "configuration": {"chunk_shape": [1],
        "codecs": [{"name": "bytes", "configuration": {"endian": "little"}}],
        "index_codecs": [{"name": "bytes", "configuration": {"endian": "little"}}]}}],
      "attributes": {}, "dimension_names": ["time"]}`;
    let indexReads = 0;
    let metadataReads = 0;
    const dataset = zarrAnalysisDatasetFromStore(
      {
        get: async (key: string) => {
          metadataReads += key === "/x/zarr.json" ? 1 : 0;
          return key === "/zarr.json"
            ? text('{"zarr_format": 3, "node_type": "group"}')
            : key === "/x/zarr.json"
              ? text(metadata)
              : undefined;
        },
        getRange: async (
          key: string,
          range: { offset: number; length: number } | { suffixLength: number }
        ) => {
          if (!/^\/x\/c\/\d+$/.test(key)) {
            return undefined;
          }
          if ("suffixLength" in range) {
            indexReads++;
            return shard.slice(shard.length - range.suffixLength);
          }
          return shard.slice(range.offset, range.offset + range.length);
        },
      } as never,
      "",
      ZARR_FORMAT.V3,
      `shard-budget-${Math.random()}`
    );
    const array = await dataset.openArray("x");
    const sweep = async () => {
      const before = indexReads;
      for (let s = 0; s < shards; s++) {
        await array.readChunk([s * slots]);
      }
      return indexReads - before;
    };
    expect(await sweep()).toBe(shards);
    // Readers of its own, rotated past the budget from the metadata read once
    // more, not per rotation.
    const afterFirst = metadataReads;
    expect(afterFirst).toBeLessThanOrEqual(2);
    expect(await sweep()).toBeGreaterThan(0);
    expect(metadataReads).toBe(afterFirst);
    // Every shard republished: renewed readers read the indices again…
    array.forgetShards?.(0, 0, slots * shards);
    expect(await sweep()).toBe(shards);
    // …and do not keep all 80 MiB of them: another sweep reads some again.
    expect(await sweep()).toBeGreaterThan(0);
  });
});
