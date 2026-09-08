import { describe, expect, it } from "vitest";
import { get, open } from "zarrita";

import "@/lib/data/codecs.ts";
import { explainCodecError } from "@/lib/data/codecErrors.ts";
import { flattenErrorMessage } from "@/utils/errorHandling.ts";

/**
 * Every error fed to `explainCodecError` here is one zarrita actually threw,
 * not a hand-written stand-in, so the patterns stay tied to the real messages.
 *
 * Each case is checked twice: once as thrown, and once after the round trip
 * through `flattenErrorMessage` plus `new Error(...)` that the grid data
 * worker performs, which strips the error's class and its fields.
 */

const V2MetadataKey = {
  FILL_VALUE: "fill_value",
  ZARR_FORMAT: "zarr_format",
} as const;

function base64Bytes(encoded: string) {
  return Uint8Array.from(atob(encoded), (character) => character.charCodeAt(0));
}

/** What `gridData.worker.ts` posts back and `gridDataWorkerClient.ts` rebuilds. */
function throughWorker(error: unknown) {
  return new Error(flattenErrorMessage(error));
}

function v2Store(dtype: string, compressor: unknown, chunk: Uint8Array) {
  const metadata = new TextEncoder().encode(
    JSON.stringify({
      chunks: [4],
      compressor,
      dtype,
      filters: [],
      order: "C",
      shape: [4],
      [V2MetadataKey.FILL_VALUE]: null,
      [V2MetadataKey.ZARR_FORMAT]: 2,
    })
  );
  return new Map([
    ["/.zarray", metadata],
    ["/0", chunk],
  ]);
}

async function readV2(compressor: unknown, chunk: Uint8Array) {
  const array = await open.v2(v2Store("<f4", compressor, chunk), {
    kind: "array",
  });
  return await get(array);
}

function caught(promise: Promise<unknown>) {
  return promise.then(
    () => undefined,
    (error: unknown) => error
  );
}

describe("an unregistered codec", () => {
  async function unknownCodecError() {
    return await caught(readV2({ id: "quantize" }, new Uint8Array(16)));
  }

  it("names the codec in the heading", async () => {
    const explanation = explainCodecError(await unknownCodecError());
    expect(explanation?.heading).toBe("Unsupported codec: numcodecs.quantize");
  });

  it("says the network is not the problem", async () => {
    const explanation = explainCodecError(await unknownCodecError());
    expect(explanation?.detail).toContain("numcodecs.quantize");
    expect(explanation?.detail).toContain("connection are fine");
  });

  it("is still recognised after the worker flattens it", async () => {
    const explanation = explainCodecError(
      throughWorker(await unknownCodecError())
    );
    expect(explanation?.heading).toBe("Unsupported codec: numcodecs.quantize");
  });
});

describe("a registered codec that rejects the chunk", () => {
  // A fletcher32 chunk whose trailing checksum does not match its payload.
  const CORRUPT_FLETCHER32 = "AACAPwAAAEAAAEBAAACAQAAAAAA=";

  async function codecPipelineError() {
    return await caught(
      readV2({ id: "fletcher32" }, base64Bytes(CORRUPT_FLETCHER32))
    );
  }

  it("names the codec that failed", async () => {
    const explanation = explainCodecError(await codecPipelineError());
    expect(explanation?.heading).toBe("Codec failed: numcodecs.fletcher32");
  });

  it("keeps the reason zarrita put on the cause", async () => {
    const explanation = explainCodecError(await codecPipelineError());
    expect(explanation?.detail).toContain("checksum mismatch");
  });

  it("keeps the reason across the worker boundary", async () => {
    // Without `flattenErrorMessage` the cause is dropped by structured clone
    // and the reader is told only that some codec failed.
    const explanation = explainCodecError(
      throughWorker(await codecPipelineError())
    );
    expect(explanation?.heading).toBe("Codec failed: numcodecs.fletcher32");
    expect(explanation?.detail).toContain("checksum mismatch");
  });
});

describe("a data type this browser cannot represent", () => {
  async function unsupportedDataTypeError() {
    // zarrita maps float16 onto `globalThis.Float16Array`, which older
    // browsers do not have.
    const original = Reflect.get(globalThis, "Float16Array");
    Reflect.deleteProperty(globalThis, "Float16Array");
    try {
      const store = v2Store("<f2", null, new Uint8Array(8));
      return await caught(open.v2(store, { kind: "array" }));
    } finally {
      Reflect.set(globalThis, "Float16Array", original);
    }
  }

  it("names the data type and the browsers that support it", async () => {
    const explanation = explainCodecError(await unsupportedDataTypeError());
    expect(explanation?.heading).toBe("Unsupported data type: float16");
    expect(explanation?.detail).toContain("Safari 26");
  });
});

describe("errors that are not codec problems", () => {
  const UNRELATED = [
    new Error("Failed to fetch chunk bytes from example.invalid"),
    new TypeError("Failed to fetch"),
    new Error("Cannot convert a BigInt value to a number"),
    new Error("Not found: /some/path"),
    "a bare string",
    undefined,
  ];

  it.each(UNRELATED)("passes through %s", (error) => {
    expect(explainCodecError(error)).toBeUndefined();
  });
});
