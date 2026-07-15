import { describe, expect, it } from "vitest";
import { registry } from "zarrita";

import { GribscanRawGribCodec } from "@/lib/data/gribscan.ts";
import "@/lib/data/ZarrDataManager.ts";

describe("GribscanRawGribCodec", () => {
  it("is registered under the codec name emitted by gribscan", () => {
    expect(registry.has("numcodecs.gribscan.rawgrib")).toBe(true);
  });

  it("decodes a simply packed GRIB1 message", () => {
    const decoded = new Float32Array(
      new GribscanRawGribCodec("float32").decode(createGrib1Message()).buffer
    );

    expect(Array.from(decoded)).toEqual([1, 2, 3, 4]);
  });
});

function createGrib1Message() {
  const message = new Uint8Array(52);
  const view = new DataView(message.buffer);

  message.set([0x47, 0x52, 0x49, 0x42]);
  setUint24(message, 4, message.length);
  message[7] = 1;

  const productDefinitionOffset = 8;
  setUint24(message, productDefinitionOffset, 28);

  const binaryDataOffset = 36;
  setUint24(message, binaryDataOffset, 12);
  view.setUint32(binaryDataOffset + 6, 0x41100000, false);
  message[binaryDataOffset + 10] = 2;
  message[binaryDataOffset + 11] = 0x1b;
  message.set([0x37, 0x37, 0x37, 0x37], 48);

  return message;
}

function setUint24(target: Uint8Array, offset: number, value: number) {
  target[offset] = value >>> 16;
  target[offset + 1] = value >>> 8;
  target[offset + 2] = value;
}
