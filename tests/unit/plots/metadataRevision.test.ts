// If the file changes between the two, the mask mixed both revisions; now the
// open is refused and tried again.
import { expect, it } from "vitest";

import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import {
  buildValueCodec,
  decodeStoredBigInt,
} from "@/lib/analysis/valueDecoding.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

const text = (value: string) => new TextEncoder().encode(value);
const dims = '"_ARRAY_DIMENSIONS":["i"],"add_offset":-9007199254740992';
const wide = `{${dims},"_FillValue":9007199254740993}`;
const small = `{${dims},"_FillValue":5}`;
const raw = new BigInt64Array([9007199254740992n, 9007199254740993n, 5n]);

/** A store whose attributes become `then` at their second read. */
function reader(then?: string) {
  const files = new Map<string, Uint8Array>([
    ["/.zgroup", text('{"zarr_format":2}')],
    [
      "/x/.zarray",
      text(
        '{"zarr_format":2,"shape":[3],"chunks":[3],"dtype":"<i8",' +
          '"compressor":null,"fill_value":null,"order":"C","filters":null}'
      ),
    ],
    ["/x/.zattrs", text(wide)],
    ["/x/0", new Uint8Array(raw.buffer)],
  ]);
  let reads = 0;
  const dataset = zarrAnalysisDatasetFromStore(
    {
      get: async (key: string) => {
        if (key === "/x/.zattrs" && ++reads === 2 && then) {
          files.set(key, text(then));
        }
        return files.get(key);
      },
    } as never,
    "",
    ZARR_FORMAT.V2,
    "rev44"
  );
  return async () => {
    const array = await dataset.openArray("x");
    const codec = buildValueCodec(array.attrs, array.fillValue, array.dtype, 2);
    const chunk = await array.readChunk([0]);
    return Array.from(chunk.data as BigInt64Array, (value) =>
      decodeStoredBigInt(codec, value)
    );
  };
}

it("refuses an open whose metadata changed between its reads", async () => {
  const open = reader(small);
  await expect(open()).rejects.toThrow(/changed while it was read/);
  // Opened again, it is the new revision throughout.
  expect(await open()).toEqual([0, 1, NaN]);
});

it("opens unchanged wide metadata at once, exactly", async () => {
  expect(await reader()()).toEqual([0, NaN, -9007199254740987]);
});

it("discards the original integer layout when the second metadata read reveals other endianness", async () => {
  const layout = (dtype: string) =>
    text(
      JSON.stringify({
        zarr_format: 2, // eslint-disable-line camelcase -- Zarr v2 property.
        shape: [3],
        chunks: [3],
        dtype,
        compressor: null,
        filters: null,
        order: "C",
        fill_value: null, // eslint-disable-line camelcase -- Zarr v2 property.
      })
    );
  const data = new Uint8Array(24);
  const view = new DataView(data.buffer);
  [1n, 2n, 3n].forEach((v, at) => view.setBigInt64(8 * at, v, false));
  let opens = 0;
  const get = async (key: string) => {
    if (key === "/.zgroup") {
      return text('{"zarr_format":2}');
    }
    if (key === "/x/.zattrs") {
      return text('{"_ARRAY_DIMENSIONS":["i"]}');
    }
    if (key === "/x/.zarray") {
      return layout(++opens === 1 ? "<i8" : ">i8");
    }
    if (key === "/x/0") {
      return data;
    }
    return undefined;
  };
  const ds = zarrAnalysisDatasetFromStore(
    { get } as never,
    "",
    ZARR_FORMAT.V2,
    "order-change"
  );
  const run = async () => {
    const array = await ds.openArray("x");
    return Array.from((await array.readChunk([0])).data, Number);
  };
  // The reader may refuse the inconsistent open, or use the complete new layout.
  const during = await run().catch(() => undefined);
  expect(await run()).toEqual([1, 2, 3]);
  if (during) {
    expect(during).toEqual([1, 2, 3]);
  }
});

it("accepts equivalent metadata when the response serializes attributes in another order", async () => {
  const reordered = '{"_FillValue":9007199254740993,' + dims + "}";
  await expect(reader(reordered)()).resolves.toEqual([
    0,
    NaN,
    -9007199254740987,
  ]);
});
