import { afterEach, expect, it, vi } from "vitest";

import { createReferenceStore } from "@/lib/data/referenceStore.ts";
import { RequestGate } from "@/lib/data/requestGate.ts";

afterEach(() => vi.restoreAllMocks());

it("interim48: a reference range answered with the whole file reads the named bytes", async () => {
  const manifest = {
    version: 1,
    refs: {
      ".zgroup": '{"zarr_format":2}',
      "t/0": ["https://data.example/raw.bin", 1, 2],
      "t/1": ["https://data.example/huge.bin", 100 * 2 ** 20, 2],
    },
  };
  const ranges: string[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const request = input as Request;
    if (String(request.url ?? input).endsWith(".json")) {
      return Response.json(manifest);
    }
    ranges.push(request.headers.get("Range") ?? "");
    // Range ignored: the whole object, status 200.
    return new Response(new Uint8Array([99, 10, 20, 30]), { status: 200 });
  });
  const store = await createReferenceStore(
    "reference+https://data.example/ref.json",
    { fresh: true }
  );
  expect(Array.from((await store.get("/t/0"))!)).toEqual([10, 20]);
  expect(ranges).toEqual(["bytes=1-2"]);
  await expect(store.get("/t/1")).rejects.toThrow(/huge\.bin.*HTTP 200/);
});

it("interim48: the gate passes headers at once, keeps its slot until the body ends, and names the URL", async () => {
  const gate = new RequestGate(1);
  let release!: () => void;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array([1]));
      release = () => controller.close();
    },
  });
  const original = new Response(body, { status: 206 });
  Object.defineProperty(original, "url", { value: "https://data.example/a" });
  vi.spyOn(globalThis, "fetch").mockResolvedValue(original);
  const response = await gate.fetch(new Request("https://data.example/a"));
  expect([response.status, response.url, gate.inFlight]).toEqual([
    206,
    "https://data.example/a",
    1,
  ]);
  const bytes = response.arrayBuffer();
  release();
  expect(new Uint8Array(await bytes)).toEqual(new Uint8Array([1]));
  expect(gate.inFlight).toBe(0);
  // An error's short body is read at once; the slot is free.
  vi.spyOn(globalThis, "fetch").mockResolvedValue(
    new Response("missing", { status: 404 })
  );
  const missing = await gate.fetch(new Request("https://data.example/b"));
  expect([missing.status, gate.inFlight, await missing.text()]).toEqual([
    404,
    0,
    "missing",
  ]);
});
