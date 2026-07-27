import { expect, it } from "vitest";
import { get, open, registry } from "zarrita";

import "@/lib/data/codecs.ts";

const V2MetadataKey = {
  FILL_VALUE: "fill_value",
  ZARR_FORMAT: "zarr_format",
} as const;

it("decodes the values produced by the Python log_bins codec", async () => {
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      chunks: [5],
      compressor: null,
      dtype: "<f4",
      [V2MetadataKey.FILL_VALUE]: "NaN",
      filters: [{ high: 1e2, id: "log_bins", low: 1e-4 }],
      order: "C",
      shape: [5],
      [V2MetadataKey.ZARR_FORMAT]: 2,
    })
  );
  const store = new Map([
    ["/.zarray", metadata],
    ["/0", new Uint8Array([0, 1, 253, 254, 255])],
  ]);

  const array = await open.v2(store, { kind: "array" });
  const decoded = await get(array);

  expect(registry.has("numcodecs.log_bins")).toBe(true);
  expect(decoded.data).toBeInstanceOf(Float32Array);
  if (!(decoded.data instanceof Float32Array)) {
    throw new Error("log_bins must decode to Float32Array data");
  }
  expect(decoded.data[0]).toBe(0);
  expect(decoded.data[1]).toBeCloseTo(0.00010280626);
  expect(decoded.data[2]).toBeCloseTo(97.34287);
  expect(decoded.data[3]).toBe(100);
  expect(decoded.data[4]).toBeNaN();
});
