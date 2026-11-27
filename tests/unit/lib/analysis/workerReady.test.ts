import { expect, it, vi } from "vitest";

/**
 * The analysis worker awaits HEALPix WebAssembly at the top level before it
 * installs its handler; a message posted during that wait is dropped. The
 * client must hold every request until the worker says READY.
 */
it("holds requests until the worker is ready, then posts them in order", async () => {
  const posted: { type: string; requestId: number }[] = [];
  const created: { onmessage: (event: { data: unknown }) => void }[] = [];
  class StubWorker {
    onmessage!: (event: { data: unknown }) => void;
    onerror = null;
    constructor() {
      created.push(this);
    }
    postMessage(message: { type: string; requestId: number }) {
      posted.push(message);
    }
    terminate() {}
  }
  vi.stubGlobal("Worker", StubWorker);
  const { describeVariable } = await import("@/lib/analysis/analysisClient.ts");
  const source = {
    key: "s#1",
    store: "https://example.org/a.zarr",
    dataset: "",
    format: 3 as const,
  };
  const first = describeVariable(source, "tas");
  const second = describeVariable(source, "pr");
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(posted).toEqual([]);
  const [worker] = created;
  worker.onmessage({ data: { type: "ready" } });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(posted.map((m) => [m.type, m.requestId])).toEqual([
    ["describe", 1],
    ["describe", 2],
  ]);
  worker.onmessage({
    data: { type: "result", requestId: 2, payload: { variable: "pr" } },
  });
  worker.onmessage({
    data: { type: "result", requestId: 1, payload: { variable: "tas" } },
  });
  expect(await first).toEqual({ variable: "tas" });
  expect(await second).toEqual({ variable: "pr" });
  vi.unstubAllGlobals();
});
