/* eslint-disable camelcase -- CF attribute names. */
import { expect, it } from "vitest";

import {
  buildValueCodec,
  decodeStoredValue,
} from "@/lib/analysis/valueDecoding.ts";

const NETCDF = -2;
const below = (x: number, n: number) => {
  const f = new Float32Array([x]);
  const bits = new Int32Array(f.buffer);
  bits[0] -= n;
  return f[0];
};

it("takes NetCDF's valid range from a lone _FillValue (review of interim37)", () => {
  const shorts = buildValueCodec({ _FillValue: -99 }, null, "int16", NETCDF);
  expect([-100, -99, -98, 12].map((v) => decodeStoredValue(shorts, v))).toEqual(
    [NaN, NaN, -98, 12]
  );
  const floats = buildValueCodec({ _FillValue: 50 }, null, "float32", NETCDF);
  expect(decodeStoredValue(floats, 51)).toBeNaN();
  expect(decodeStoredValue(floats, below(50, 1))).toBeNaN();
  expect(decodeStoredValue(floats, below(50, 2))).toBe(below(50, 2));
  // A declared range wins; Zarr is left as it is.
  const ranged = buildValueCodec(
    { _FillValue: -99, valid_min: -200 },
    null,
    "int16",
    NETCDF
  );
  expect(decodeStoredValue(ranged, -100)).toBe(-100);
  const zarr = buildValueCodec({ _FillValue: -99 }, null, "int16", 3);
  expect(decodeStoredValue(zarr, -100)).toBe(-100);
});
