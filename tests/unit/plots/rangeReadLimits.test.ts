import { FetchStore } from "@zarrita/storage";
import { afterEach, expect, it, vi } from "vitest";

import { createReferenceStore } from "@/lib/data/referenceStore.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";

afterEach(() => vi.restoreAllMocks());

const base = "https://data.example/forecast.zarr";
const blockSize = 64 * 1024;
const objectSize = 4 * 1024 * 1024;

// Holding back pulls until a reader attaches makes the count independent
// of the runtime's default stream prefetch behaviour.
function wholeObject(declareLength: boolean) {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        controller.enqueue(new Uint8Array(blockSize));
        pulled += blockSize;
        if (pulled === objectSize) {
          controller.close();
        }
      },
    },
    { highWaterMark: 0 }
  );
  const headers = declareLength
    ? { "Content-Length": String(objectSize) }
    : undefined;
  return {
    response: new Response(body, { status: 200, headers }),
    bytes: () => pulled,
  };
}

async function checkRange(declareLength: boolean) {
  const original = wholeObject(declareLength);
  const actual = wholeObject(declareLength);
  const fetcher = vi.spyOn(globalThis, "fetch");
  fetcher
    .mockResolvedValueOnce(original.response)
    .mockResolvedValueOnce(actual.response);
  const range = { offset: 8, length: 16 };
  await expect(new FetchStore(base).getRange("/c/0", range)).rejects.toThrow();
  const store = await ZarrDataManager.createNewStore(base, false, {
    byteCache: false,
  });
  await expect(store.getRange!("/c/0", range)).rejects.toThrow();
  expect(original.bytes()).toBe(declareLength ? 0 : blockSize);
  expect(actual.bytes()).toBeLessThanOrEqual(original.bytes());
}

it("stops a range read at the headers when a full object declares its size", async () => {
  await checkRange(true);
});

it("stops a range read after its first excess block when object size is unknown", async () => {
  await checkRange(false);
});

it("opens the selected revision of a reference manifest when its URL has a query", async () => {
  const url = "https://data.example/daily.json?version=2";
  const fetcher = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(
      Response.json({ version: 1, refs: { ".zgroup": '{"zarr_format":2}' } })
    );
  await createReferenceStore("reference+" + url, { fresh: true });
  expect(fetcher.mock.calls[0][0]).toBe(url);
});
