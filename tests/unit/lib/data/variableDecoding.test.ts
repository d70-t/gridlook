import { expect, it } from "vitest";
import type * as zarr from "zarrita";

import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
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
