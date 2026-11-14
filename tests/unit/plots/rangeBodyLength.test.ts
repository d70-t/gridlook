import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import {
  type ChunkRef,
  ReadSession,
  Repository,
  type Storage,
} from "icechunk-js";
import { afterEach, expect, it, vi } from "vitest";

import { countedBody } from "@/lib/data/countedBody.ts";
import {
  exactRange,
  resetSkippedBytes,
  SKIPPED_BYTES_PER_FILE,
} from "@/lib/data/rangeResponse.ts";
import { createReferenceStore } from "@/lib/data/referenceStore.ts";
import { RequestGate } from "@/lib/data/requestGate.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetSkippedBytes();
});

setFlagsFromString("--expose-gc");
const gc = runInNewContext("gc") as () => void;

const file = "https://data.example/obs.bin";

function streamOf(size: number, fill: (at: number) => number) {
  const block = 64 * 1024;
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const n = Math.min(block, size - sent);
      controller.enqueue(
        Uint8Array.from({ length: n }, (_, i) => fill(sent + i) & 255)
      );
      sent += n;
      if (sent >= size) {
        controller.close();
      }
    },
  });
}

/** `size` bytes of 7, in shared 1 MiB blocks. */
function sameBlocks(size: number) {
  const block = new Uint8Array(2 ** 20).fill(7);
  let sent = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      const n = Math.min(block.length, size - sent);
      controller.enqueue(block.subarray(0, n));
      sent += n;
      if (sent >= size) {
        controller.close();
      }
    },
  });
}

it("refuses a 206 whose body has another length than the range asked", async () => {
  const response = new Response(new Uint8Array([1, 2, 3]), { status: 206 });
  const checked = await exactRange(file, 2, 3, response);
  await expect(checked.arrayBuffer()).rejects.toThrow(/more than 2 bytes/);
});

it("keeps a correct 206 and cuts a 200 to the asked bytes", async () => {
  const ok = await exactRange(
    file,
    2,
    3,
    new Response(new Uint8Array([10, 20]), {
      status: 206,
      headers: { "Content-Range": "bytes 2-3/4" },
    })
  );
  expect(Array.from(new Uint8Array(await ok.arrayBuffer()))).toEqual([10, 20]);
  const whole = await exactRange(
    file,
    70_000,
    70_001,
    new Response(
      streamOf(200_000, (i) => i % 251),
      { status: 200 }
    )
  );
  expect(Array.from(new Uint8Array(await whole.arrayBuffer()))).toEqual([
    70_000 % 251,
    70_001 % 251,
  ]);
});

it("refuses ranges of a range-ignoring file once its skipped bytes pass the budget", async () => {
  const offset = 48 * 2 ** 20;
  const read = () =>
    exactRange(
      file,
      offset,
      offset,
      new Response(sameBlocks(offset + 1), { status: 200 })
    );
  const reads = Math.floor(SKIPPED_BYTES_PER_FILE / offset);
  for (let i = 0; i < reads; i++) {
    await read();
  }
  await expect(read()).rejects.toThrow(/ignores range requests/);
  // Another file has its own budget.
  const other = await exactRange(
    file + "2",
    1,
    1,
    new Response(new Uint8Array([0, 5]), { status: 200 })
  );
  expect(new Uint8Array(await other.arrayBuffer())[0]).toBe(5);
});

it("reads a one-element [url] reference as the whole object", async () => {
  const manifest = "https://data.example/whole.json";
  const spec = { version: 1, refs: { "v/0": [file] } };
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    if (request.url === manifest) {
      return Response.json(spec);
    }
    expect(request.headers.get("Range")).toBeNull();
    return new Response(new Uint8Array([4, 5, 6]), { status: 200 });
  });
  const store = await createReferenceStore("reference+" + manifest, {
    fresh: true,
  });
  expect(Array.from((await store.get("/v/0"))!)).toEqual([4, 5, 6]);
});

it("holds the slot of a body still being read after its response is collected", async () => {
  const gate = new RequestGate(1);
  let started = 0;
  vi.spyOn(globalThis, "fetch").mockImplementation(async () => {
    started++;
    return new Response(
      new ReadableStream({ pull() {} }, { highWaterMark: 0 }),
      { status: 206 }
    );
  });
  const reader = await (async () =>
    (await gate.fetch(new Request(file))).body!.getReader())();
  const second = gate.fetch(new Request(file));
  for (let i = 0; i < 20; i++) {
    gc();
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
  expect(started).toBe(1);
  await reader.cancel();
  await (await second).body?.cancel();
  expect(started).toBe(2);
});

it("leaves the queue at once when the init signal of a queued request aborts", async () => {
  const gate = new RequestGate(1);
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(new ReadableStream({ pull() {} }, { highWaterMark: 0 }), {
        status: 206,
      })
  );
  const first = await gate.fetch(new Request(file));
  const controller = new AbortController();
  const queued = gate.fetch(new Request(file), { signal: controller.signal });
  controller.abort(new Error("stopped"));
  await expect(queued).rejects.toThrow("stopped");
  await first.body?.cancel();
  expect(gate.inFlight).toBe(0);
});

it("counts the body bytes that arrive, not the declared length", async () => {
  let bytes = 0;
  const response = countedBody(
    new Response(
      streamOf(6, () => 1),
      {
        headers: { "Content-Length": String(8 * 2 ** 20) },
      }
    ),
    (n) => (bytes += n)
  );
  const reader = response.body!.getReader();
  await reader.read();
  await reader.cancel();
  expect(bytes).toBe(6);
});

function mockRepository(kind: "native" | "virtual", n: number) {
  const nodeId = new Uint8Array(8);
  const manifestId = new Uint8Array(12);
  const node = {
    id: nodeId,
    path: "/temperature",
    nodeData: {
      type: "array",
      manifests: [{ objectId: manifestId, extents: [{ from: 0, to: n }] }],
    },
  };
  const manifest = {
    id: manifestId,
    arrays: [
      {
        nodeId,
        numRefs: n,
        refIndex: (i: number) => [i],
        refAt: (i: number): ChunkRef => ({
          index: [i],
          inline: null,
          offset: 0,
          length: 1,
          chunkId: kind === "native" ? new Uint8Array(12).fill(i) : null,
          location: kind === "virtual" ? `https://data.example/${i}.nc` : null,
          checksumEtag: null,
          checksumLastModified: 0,
        }),
      },
    ],
  };
  // Inject an already decoded repository catalogue and manifest. The actual
  // store, native storage, virtual client, coalescer and body path run normally.
  vi.spyOn(Repository, "open").mockImplementation(async ({ storage }) => {
    const fixtureSession = Reflect.construct(
      ReadSession as unknown as new (
        storage: Storage,
        snapshot: object,
        version: number
      ) => ReadSession,
      [storage, { nodes: [node] }, 2]
    ) as ReadSession;
    Object.defineProperty(fixtureSession, "loadManifest", {
      value: async () => manifest,
    });
    const repository = {
      checkoutBranch: async () => fixtureSession,
    } satisfies Pick<Repository, "checkoutBranch">;
    return repository as unknown as Repository;
  });
}

it.each([
  ["ignores Range", 200],
  ["names other bytes", 206],
] as const)(
  "reads one byte of an Icechunk native chunk from a server that %s",
  async (_, status) => {
    mockRepository("native", 1);
    let pulled = 0;
    vi.spyOn(globalThis, "fetch").mockImplementation(async () =>
      status === 200
        ? new Response(
            streamOf(4 * 2 ** 20, (i) => {
              pulled++;
              return i === 0 ? 42 : 0;
            }),
            { status }
          )
        : new Response(new Uint8Array([9]), {
            status,
            headers: { "Content-Range": "bytes 5-5/9" },
          })
    );
    const store = await ZarrDataManager.createNewStore(
      "icechunk+https://data.example/repo",
      true,
      { byteCache: false }
    );
    const read = store.get("/temperature/c/0");
    if (status === 206) {
      await expect(read).rejects.toThrow(/bytes 5–5/);
      return;
    }
    expect((await read)?.[0]).toBe(42);
    expect(pulled).toBeLessThanOrEqual(2 * 64 * 1024);
  }
);
