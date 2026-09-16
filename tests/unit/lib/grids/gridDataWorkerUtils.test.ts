import { describe, expect, it } from "vitest";
import * as zarr from "zarrita";

import { serializeGridDataChunk } from "@/lib/grids/gridDataWorkerUtils.ts";

describe("serializeGridDataChunk", () => {
  it("preserves native arrays and chunk shape", () => {
    const data = new Float32Array([1, 2]);
    const result = serializeGridDataChunk({ data, shape: [1, 2] });

    expect(result.data).toBe(data);
    expect(result.shape).toEqual([1, 2]);
  });

  it("converts Zarrita custom arrays to clone-safe values", () => {
    const booleans = serializeGridDataChunk({
      data: new zarr.BoolArray([true, false]),
      shape: [2],
    });
    const strings = serializeGridDataChunk({
      data: new zarr.UnicodeStringArray(2, ["a", "bc"]),
      shape: [2],
    });
    const byteStrings = serializeGridDataChunk({
      data: new zarr.ByteStringArray(2, ["d", "ef"]),
      shape: [2],
    });

    expect(structuredClone(booleans)).toEqual({
      data: [true, false],
      shape: [2],
    });
    expect(structuredClone(strings)).toEqual({
      data: ["a", "bc"],
      shape: [2],
    });
    expect(structuredClone(byteStrings)).toEqual({
      data: ["d", "ef"],
      shape: [2],
    });
  });

  it("rejects scalar selections", () => {
    expect(() => serializeGridDataChunk(4)).toThrow(
      "selection returned a scalar"
    );
  });
});
