/* eslint-disable camelcase -- CF attribute names. */
import { expect, it } from "vitest";

import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import {
  buildValueCodec,
  decodeStoredBigInt,
  decodeStoredValue,
} from "@/lib/analysis/valueDecoding.ts";

const NETCDF = -2;
const tiny = 2 ** -149;

const decode = (
  attrs: Record<string, unknown>,
  dtype: string,
  raw: number[]
) => {
  const codec = buildValueCodec(attrs, null, dtype, NETCDF);
  return raw.map((value) => decodeStoredValue(codec, value));
};

it("a fill at the smallest float32 subnormal limits as the explicit ceiling does", () => {
  const raw = [-1, 0, 1000, 3];
  const implied = decode({ _FillValue: tiny }, "float32", raw);
  expect(implied).toEqual(decode({ valid_max: -tiny }, "float32", raw));
  expect(implied.filter(Number.isFinite)).toEqual([-1]);
  // A negative subnormal fill: a floor of +δ.
  const above = [tiny, 2 * tiny, 0, -1];
  expect(decode({ _FillValue: -tiny }, "float32", above)).toEqual(
    decode({ valid_min: tiny }, "float32", above)
  );
});

it("fills of +0 and −0 give the same mask", () => {
  for (const dtype of ["float32", "float64"]) {
    const d = dtype === "float32" ? tiny : Number.MIN_VALUE;
    const raw = [d, 2 * d, 3 * d, -1, 5];
    const plus = decode({ _FillValue: 0 }, dtype, raw);
    expect(decode({ _FillValue: -0 }, dtype, raw), dtype).toEqual(plus);
    expect(plus.map(Number.isFinite), dtype).toEqual([
      false,
      true,
      true,
      false,
      true,
    ]);
  }
});

it("an _Unsigned short's fill limits in the unsigned domain", () => {
  // Stored [−3, −2, −1, 4] are 65533, 65534, 65535 and 4; the fill −2 is
  // 65534, positive: a valid maximum of 65533.
  const raw = [-3, -2, -1, 4];
  const implied = decode({ _Unsigned: "true", _FillValue: -2 }, "int16", raw);
  expect(implied).toEqual([65533, Number.NaN, Number.NaN, 4]);
  expect(
    decode({ _Unsigned: "true", valid_range: [0, 65533] }, "int16", raw)
  ).toEqual(implied);
  // As native uint16 storage of the same fill.
  expect(
    decode({ _FillValue: 65534 }, "uint16", [65533, 65534, 65535, 4])
  ).toEqual(implied);
});

it.each(["truncated", "missing"] as const)(
  "an exact int64 reread %s fails the open, and the retry is exact",
  async (mode) => {
    // 2^53 is data and 2^53 + 1 its fill; rounded through JSON they are
    // one number.
    const encode = (text: string) => new TextEncoder().encode(text);
    const raw = new BigInt64Array([9007199254740992n, 9007199254740993n]);
    const files = new Map<string, Uint8Array>([
      ["/.zgroup", encode('{"zarr_format":2}')],
      [
        "/x/.zarray",
        encode(
          '{"zarr_format":2,"shape":[2],"chunks":[2],"dtype":"<i8","compressor":null,"fill_value":null,"order":"C","filters":null}'
        ),
      ],
      [
        "/x/.zattrs",
        encode('{"_ARRAY_DIMENSIONS":["i"],"_FillValue":9007199254740993}'),
      ],
      ["/x/0", new Uint8Array(raw.buffer)],
    ]);
    let attrsReads = 0;
    const store = {
      async get(key: string) {
        // The second read of.zattrs is the exact reread.
        if (key === "/x/.zattrs" && ++attrsReads === 2) {
          return mode === "truncated"
            ? encode('{"_ARRAY_DIMENSIONS":[')
            : undefined;
        }
        return files.get(key);
      },
    };
    const dataset = zarrAnalysisDatasetFromStore(
      store as never,
      "",
      2,
      `exact43-${mode}`
    );
    const values = async () => {
      const array = await dataset.openArray("x");
      const codec = buildValueCodec(
        array.attrs,
        array.fillValue,
        array.dtype,
        2
      );
      return Array.from((await array.readChunk([0])).data, (x) =>
        decodeStoredBigInt(codec, x as bigint)
      );
    };
    await expect(values()).rejects.toThrow(/open it again/);
    expect(await values()).toEqual([9007199254740992, Number.NaN]);
  }
);
