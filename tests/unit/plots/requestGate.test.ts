/**
 * Store requests are held to a few in flight, through to their bodies, in
 * order, and a queued one can be abandoned.
 */
import { afterEach, expect, it, vi } from "vitest";

import { RequestGate } from "@/lib/data/requestGate.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";

afterEach(() => vi.restoreAllMocks());

function slowFetch() {
  let open = 0;
  let most = 0;
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async () => {
      open++;
      most = Math.max(most, open);
      await new Promise((resolve) => setTimeout(resolve, 2));
      open--;
      return new Response(new Uint8Array(8), { status: 200 });
    });
  return { fetchMock, most: () => most };
}

it("keeps a flood of chunk reads to a bounded number in flight", async () => {
  const { fetchMock, most } = slowFetch();
  const store = await ZarrDataManager.createNewStore(
    "https://example.org/gefs.zarr"
  );
  const keys = Array.from({ length: 400 }, (_, k) => `/t/c/${k}/0` as const);
  const got = await Promise.all(keys.map((key) => store.get(key)));
  expect(got.every((bytes) => bytes?.length === 8)).toBe(true);
  expect(fetchMock).toHaveBeenCalledTimes(400);
  expect(most()).toBeLessThanOrEqual(24);
});

it("holds a slot until the body has arrived, and lets a queued read go", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () => new Response(new Uint8Array(4))
  );
  const gate = new RequestGate(1);
  const first = gate.fetch(new Request("https://example.org/a"));
  const controller = new AbortController();
  const queued = gate.fetch(
    new Request("https://example.org/b", { signal: controller.signal })
  );
  controller.abort(new DOMException("Stopped", "AbortError"));
  await expect(queued).rejects.toThrow("Stopped");
  expect((await (await first).arrayBuffer()).byteLength).toBe(4);
  expect(gate.inFlight).toBe(0);
  expect(globalThis.fetch).toHaveBeenCalledTimes(1);
});
