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

  it("decodes sign-magnitude scale factors in a CCSDS-packed GRIB2 message", () => {
    const decoded = new Float64Array(
      new GribscanRawGribCodec("float64").decode(createGrib2Message()).buffer
    );

    expect(Array.from(decoded)).toEqual([-3, 2, 7, 12, 17, 22, 27, 32]);
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

function createGrib2Message() {
  const message = new Uint8Array(79);
  const view = new DataView(message.buffer);

  message.set([0x47, 0x52, 0x49, 0x42]);
  message[7] = 2;
  view.setBigUint64(8, BigInt(message.length), false);

  const gridDefinitionOffset = 16;
  view.setUint32(gridDefinitionOffset, 14, false);
  message[gridDefinitionOffset + 4] = 3;
  view.setUint32(gridDefinitionOffset + 6, 8, false);

  const dataRepresentationOffset = 30;
  view.setUint32(dataRepresentationOffset, 25, false);
  message[dataRepresentationOffset + 4] = 5;
  view.setUint32(dataRepresentationOffset + 5, 8, false);
  view.setUint16(dataRepresentationOffset + 9, 42, false);
  view.setFloat32(dataRepresentationOffset + 11, -3, false);
  view.setUint16(dataRepresentationOffset + 15, 0x8001, false);
  view.setUint16(dataRepresentationOffset + 17, 0x8001, false);
  message[dataRepresentationOffset + 19] = 8;
  message[dataRepresentationOffset + 22] = 8;
  view.setUint16(dataRepresentationOffset + 23, 1, false);

  const bitmapOffset = 55;
  view.setUint32(bitmapOffset, 6, false);
  message[bitmapOffset + 4] = 6;
  message[bitmapOffset + 5] = 255;

  const dataOffset = 61;
  view.setUint32(dataOffset, 14, false);
  message[dataOffset + 4] = 7;
  writeBits(message.subarray(dataOffset + 5), [
    1,
    1,
    1, // Uncompressed AEC block.
    ...Array.from({ length: 8 }, (_, value) =>
      Array.from({ length: 8 }, (_, bit) => (value >> (7 - bit)) & 1)
    ).flat(),
  ]);

  message.set([0x37, 0x37, 0x37, 0x37], 75);
  return message;
}

function writeBits(target: Uint8Array, bits: number[]) {
  for (let i = 0; i < bits.length; i++) {
    target[i >> 3] |= bits[i] << (7 - (i & 7));
  }
}

function setUint24(target: Uint8Array, offset: number, value: number) {
  target[offset] = value >>> 16;
  target[offset + 1] = value >>> 8;
  target[offset + 2] = value;
}
