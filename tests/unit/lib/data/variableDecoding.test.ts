import { expect, it } from "vitest";
import type * as zarr from "zarrita";

import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
  getDefaultRange,
  getDefaultRangeFromAttributes,
} from "@/lib/data/variableDecoding.ts";

it("converts signed and unsigned 64-bit arrays to renderable values", () => {
  expect(
    castDataVarToFloat32(new BigInt64Array([-42n, 0n, 4294967296n]))
  ).toEqual(new Float32Array([-42, 0, 4294967296]));
  expect(
    castDataVarToFloat32(new BigUint64Array([0n, 4294967296n, 2n ** 63n]))
  ).toEqual(new Float32Array([0, 4294967296, 2 ** 63]));
});

it("does not mask zeros when _FillValue is null", () => {
  // xarray writes `_FillValue: null` for "no fill value", e.g. on lon axes
  // starting at 0; masking 0 there opens a seam at the prime meridian.
  const longitude = {
    fillValue: null,
    attrs: { units: "degrees_east", _FillValue: null },
  } as unknown as zarr.Array<zarr.DataType, zarr.AsyncReadable>;
  const values = new Float32Array([0, 0.25, 359.75]);

  const { fillValue } = decodeVariableDataAndGetBounds(longitude, values);

  expect(fillValue).toBeNaN();
  expect(values).toEqual(new Float32Array([0, 0.25, 359.75]));
});

it("does not mask zeros when missing_value is null", () => {
  const precipitation = {
    fillValue: null,
    attrs: { units: "kg m-2 s-1", ["missing_value"]: null },
  } as unknown as zarr.Array<zarr.DataType, zarr.AsyncReadable>;
  const values = new Float32Array([0, 1e-5]);

  const { missingValue } = decodeVariableDataAndGetBounds(
    precipitation,
    values
  );

  expect(missingValue).toBeNaN();
  expect(values).toEqual(new Float32Array([0, 1e-5]));
});

/* eslint-disable camelcase -- CF attribute names are snake_case. */
it("takes the default colour range from actual_range as it is", () => {
  // CF: actual_range is in unpacked units, even when the data is packed.
  expect(
    getDefaultRangeFromAttributes({
      actual_range: [0, 0.3],
      scale_factor: 0.0001,
      add_offset: -0.1,
      valid_min: 1,
      valid_max: 65535,
    })
  ).toEqual({ low: 0, high: 0.3 });
});

it("does not use valid_range, valid_min or valid_max", () => {
  // They often hold the dtype limits, not a range worth looking at.
  expect(
    getDefaultRangeFromAttributes({ valid_range: [-32767, 32767] })
  ).toBeUndefined();
  expect(
    getDefaultRangeFromAttributes({
      valid_min: 1,
      valid_max: 65535,
      scale_factor: 0.0001,
    })
  ).toBeUndefined();
});

it("orders an actual_range given high to low", () => {
  expect(getDefaultRangeFromAttributes({ actual_range: [10, 0] })).toEqual({
    low: 0,
    high: 10,
  });
});

it("ignores empty or malformed range attributes", () => {
  expect(getDefaultRangeFromAttributes(undefined)).toBeUndefined();
  expect(getDefaultRangeFromAttributes({})).toBeUndefined();
  expect(getDefaultRangeFromAttributes({ actual_range: [1] })).toBeUndefined();
  expect(
    getDefaultRangeFromAttributes({ actual_range: [2, 2] })
  ).toBeUndefined();
  expect(
    getDefaultRangeFromAttributes({ actual_range: ["a", 1] })
  ).toBeUndefined();
});

it("prefers the index's default_range over the variable's attributes", () => {
  expect(
    getDefaultRange({
      default_range: { low: 0.05, high: 0.2 },
      attrs: { actual_range: [0, 0.3] },
    })
  ).toEqual({ low: 0.05, high: 0.2 });
  expect(getDefaultRange({ attrs: { actual_range: [0, 0.3] } })).toEqual({
    low: 0,
    high: 0.3,
  });
  expect(getDefaultRange({ attrs: { units: "K" } })).toBeUndefined();
  expect(getDefaultRange(undefined)).toBeUndefined();
});
