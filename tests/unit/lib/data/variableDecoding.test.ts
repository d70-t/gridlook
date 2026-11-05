import { expect, it } from "vitest";
import * as zarr from "zarrita";

import {
  castDataVarToFloat32,
  decodeVariableDataAndGetBounds,
  getFillValue,
  markZarrV2Array,
} from "@/lib/data/variableDecoding.ts";

const encoder = new TextEncoder();

function zarrV2Store(dtype: string, fillValue: boolean | number | null) {
  const zarray = {
    zarr_format: 2, // eslint-disable-line camelcase
    shape: [3],
    chunks: [3],
    dtype,
    compressor: null,
    fill_value: fillValue, // eslint-disable-line camelcase
    order: "C",
    filters: null,
  };
  return new Map([["/dn/.zarray", encoder.encode(JSON.stringify(zarray))]]);
}

function zarrV3Store(dataType: string, fillValue: number) {
  const zarrJson = {
    zarr_format: 3, // eslint-disable-line camelcase
    node_type: "array", // eslint-disable-line camelcase
    shape: [3],
    data_type: dataType, // eslint-disable-line camelcase
    // eslint-disable-next-line camelcase
    chunk_grid: {
      name: "regular",
      configuration: { chunk_shape: [3] }, // eslint-disable-line camelcase
    },
    chunk_key_encoding: { name: "default" }, // eslint-disable-line camelcase
    codecs: [{ name: "bytes", configuration: { endian: "little" } }],
    fill_value: fillValue, // eslint-disable-line camelcase
    attributes: {},
  };
  return new Map([["/dn/zarr.json", encoder.encode(JSON.stringify(zarrJson))]]);
}

async function openZarrV2Array(
  dtype: string,
  fillValue: boolean | number | null
) {
  const store = zarrV2Store(dtype, fillValue);
  const array = (await zarr.open.v2(zarr.root(store).resolve("dn"), {
    kind: "array",
  })) as unknown as zarr.Array<zarr.DataType, zarr.AsyncReadable>;
  markZarrV2Array(array);
  return array;
}

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

it.each(["<u2", "<f4"])(
  "masks zeros when a Zarr v2 %s array has fill_value 0",
  async (dtype) => {
    const dn = await openZarrV2Array(dtype, 0);
    const values = new Float32Array([0, 1200, 0]);

    const { fillValue, min, max } = decodeVariableDataAndGetBounds(dn, values);

    expect(fillValue).toBe(0);
    expect(Array.from(values)).toEqual([NaN, 1200, NaN]);
    expect([min, max]).toEqual([1200, 1200]);
  }
);

it("masks zeros when a Zarr v2 int64 array has fill_value 0", async () => {
  const dn = await openZarrV2Array("<i8", 0);
  expect(dn.fillValue).toBe(0n);
  expect(getFillValue(dn)).toBe(0);
});

it("does not mask zeros when a Zarr v2 fill_value is null", async () => {
  const dn = await openZarrV2Array("<u2", null);
  const values = new Float32Array([0, 1200]);

  const { fillValue } = decodeVariableDataAndGetBounds(dn, values);

  expect(fillValue).toBeNaN();
  expect(values).toEqual(new Float32Array([0, 1200]));
});

it("does not mask false in a Zarr v2 bool array with fill_value false", async () => {
  const mask = await openZarrV2Array("|b1", false);
  const values = new Float32Array([0, 1, 0]);

  const { fillValue } = decodeVariableDataAndGetBounds(mask, values);

  expect(fillValue).toBeNaN();
  expect(values).toEqual(new Float32Array([0, 1, 0]));
});

it("does not mask zeros for the default Zarr v3 fill_value 0", async () => {
  // zarr-python writes fill_value 0 to every v3 array created without one.
  const store = zarrV3Store("uint16", 0);
  const dn = (await zarr.open.v3(zarr.root(store).resolve("dn"), {
    kind: "array",
  })) as unknown as zarr.Array<zarr.DataType, zarr.AsyncReadable>;
  const values = new Float32Array([0, 1200]);

  const { fillValue } = decodeVariableDataAndGetBounds(dn, values);

  expect(fillValue).toBeNaN();
  expect(values).toEqual(new Float32Array([0, 1200]));
});

it("masks zeros when a Zarr v3 array sets _FillValue 0", () => {
  const dn = {
    fillValue: 0,
    attrs: { _FillValue: 0 },
  } as unknown as zarr.Array<zarr.DataType, zarr.AsyncReadable>;
  const values = new Float32Array([0, 1200]);

  const { fillValue } = decodeVariableDataAndGetBounds(dn, values);

  expect(fillValue).toBe(0);
  expect(Array.from(values)).toEqual([NaN, 1200]);
});
