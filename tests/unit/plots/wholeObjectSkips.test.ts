import { afterEach, expect, it, vi } from "vitest";

import { createReferenceStore } from "@/lib/data/referenceStore.ts";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

const file = "https://data.example/observations.bin";
const manifest = "https://data.example/observations.json";

async function reader(offset: number, bytes: () => Response) {
  const spec = { version: 1, refs: { "signal/0": [file, offset, 2] } };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    if (String(input instanceof Request ? input.url : input) === manifest) {
      return Response.json(spec);
    }
    return bytes();
  });
  return createReferenceStore("reference+" + manifest, { fresh: true });
}

it("buffers just the requested observation while skipping a whole-object prefix", async () => {
  const block = new Uint8Array(64 * 1024);
  block.set([10, 20], block.length - 2);
  const size = 8 * 2 ** 20;
  const store = await reader(size - 2, () => {
    let sent = 0;
    return new Response(
      new ReadableStream<Uint8Array>({
        pull(controller) {
          controller.enqueue(block);
          sent += block.length;
          if (sent === size) {
            controller.close();
          }
        },
      }),
      { status: 200 }
    );
  });
  const TypedArray = Uint8Array;
  let largest = 0;
  vi.stubGlobal(
    "Uint8Array",
    new Proxy(TypedArray, {
      construct(target, args, newTarget) {
        if (typeof args[0] === "number") {
          largest = Math.max(largest, args[0]);
        }
        return Reflect.construct(target, args, newTarget);
      },
    })
  );
  expect(Array.from((await store.get("/signal/0"))!)).toEqual([10, 20]);
  expect(largest).toBeLessThanOrEqual(2 * block.length);
});

it("rejects a partial reply that explicitly contains a different observation", async () => {
  const store = await reader(
    2,
    () =>
      new Response(new Uint8Array([99, 98]), {
        status: 206,
        headers: { "Content-Range": "bytes 0-1/4" },
      })
  );
  await expect(store.get("/signal/0")).rejects.toThrow();
});
