import { afterEach, expect, it, vi } from "vitest";

import { countedBody } from "@/lib/data/countedBody.ts";
import {
  exactRange,
  exactSuffix,
  resetSkippedBytes,
  SKIPPED_BYTES_PER_FILE,
} from "@/lib/data/rangeResponse.ts";
import { createReferenceStore } from "@/lib/data/referenceStore.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";

afterEach(() => {
  vi.restoreAllMocks();
  resetSkippedBytes();
});

const file = "https://data.example/obs.bin";
const object = Uint8Array.from({ length: 38 }, (_, i) => i);

/** A range server for `object`: 206 for ranges and suffixes, bodyless HEAD. */
function serve(seen: string[]) {
  return async (input: RequestInfo | URL) => {
    const request = input instanceof Request ? input : new Request(input);
    const range = request.headers.get("Range");
    seen.push(`${request.method} ${range ?? "-"}`);
    if (request.method === "HEAD") {
      return new Response(null, {
        status: 200,
        headers: { "Content-Length": String(object.length) },
      });
    }
    const explicit = /^bytes=(\d+)-(\d+)$/.exec(range ?? "");
    const suffix = /^bytes=-(\d+)$/.exec(range ?? "");
    const [a, b] = explicit
      ? [Number(explicit[1]), Number(explicit[2])]
      : suffix
        ? [object.length - Number(suffix[1]), object.length - 1]
        : [0, object.length - 1];
    return new Response(object.slice(a, b + 1), {
      status: range ? 206 : 200,
      headers: range
        ? { "Content-Range": `bytes ${a}-${b}/${object.length}` }
        : {},
    });
  };
}

async function store(refs: Record<string, unknown>, seen: string[]) {
  const manifest = "https://data.example/refs.json";
  const server = serve(seen);
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
    const request = input instanceof Request ? input : new Request(input);
    return request.url === manifest
      ? Response.json({ version: 1, refs })
      : server(request);
  });
  return createReferenceStore("reference+" + manifest, { fresh: true });
}

it("a referenced shard's trailing index is read against the reference's length", async () => {
  const seen: string[] = [];
  const ranged = await store({ s: [file, 9, 20] }, seen);
  const tail = await ranged.getRange!("/s", { suffixLength: 6 });
  // Bytes 23–28: the reference's last six, with no HEAD sent.
  expect(Array.from(tail!)).toEqual([23, 24, 25, 26, 27, 28]);
  expect(seen).toEqual(["GET bytes=23-28"]);
  seen.length = 0;
  const whole = await store({ w: [file] }, seen);
  const end = await whole.getRange!("/w", { suffixLength: 4 });
  expect(Array.from(end!)).toEqual([34, 35, 36, 37]);
  expect(seen).toEqual(["HEAD -", "GET bytes=34-37"]);
});

it("a whole-object suffix of unknown length is asked and checked as one", async () => {
  const sent = new Response(object.slice(34), {
    status: 206,
    headers: { "Content-Range": "bytes 34-37/38" },
  });
  const ok = await exactSuffix(file, 4, sent);
  expect(Array.from(new Uint8Array(await ok.arrayBuffer()))).toEqual([
    34, 35, 36, 37,
  ]);
  const wrong = new Response(object.slice(30, 34), {
    status: 206,
    headers: { "Content-Range": "bytes 30-33/38" },
  });
  await expect(exactSuffix(file, 4, wrong)).rejects.toThrow(/30–33 of 38/);
  const sizeless = new Response(object.slice(34), {
    status: 206,
    headers: { "Content-Range": "bytes 34-37/*" },
  });
  // RFC 9110's unspecified length: the n bytes asked for are the suffix.
  const unsized = await exactSuffix(file, 4, sizeless);
  expect(Array.from(new Uint8Array(await unsized.arrayBuffer()))).toEqual([
    34, 35, 36, 37,
  ]);
});

it("a visible but malformed Content-Range is refused, not taken as absent", async () => {
  const reply = new Response(new Uint8Array([99]), {
    status: 206,
    headers: { "Content-Range": "bytes 0-0" },
  });
  await expect(exactRange(file, 1, 1, reply)).rejects.toThrow(
    /unreadable Content-Range/
  );
});

it("a declared length other than the range's is refused before the body", async () => {
  let pulled = 0;
  const body = new ReadableStream<Uint8Array>({
    pull(controller) {
      pulled++;
      controller.enqueue(new Uint8Array(1024));
    },
  });
  const reply = new Response(body, {
    status: 206,
    headers: { "Content-Length": String(8 * 2 ** 20) },
  });
  await expect(exactRange(file, 2, 2, reply)).rejects.toThrow(/declared/);
  expect(pulled).toBeLessThanOrEqual(1);
});

it("a 206 is passed on as a stream, checked as it is read", async () => {
  const reply = new Response(new Uint8Array([10, 20]), {
    status: 206,
    headers: { "Content-Range": "bytes 2-3/4" },
  });
  const checked = await exactRange(file, 2, 3, reply);
  expect(checked.body).toBeInstanceOf(ReadableStream);
  expect(Array.from(new Uint8Array(await checked.arrayBuffer()))).toEqual([
    10, 20,
  ]);
});

it("concurrent reads of a range-ignoring file share its skip budget", async () => {
  const offset = 48 * 2 ** 20;
  const block = new Uint8Array(2 ** 20);
  const stream = () => {
    let sent = 0;
    return new ReadableStream<Uint8Array>({
      async pull(controller) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        controller.enqueue(block);
        sent += block.length;
        if (sent > offset) {
          controller.close();
        }
      },
    });
  };
  const reads = Array.from({ length: 8 }, () =>
    exactRange(
      file,
      offset,
      offset,
      new Response(stream(), { status: 200 })
    ).then(
      () => "ok",
      () => "refused"
    )
  );
  const outcomes = await Promise.all(reads);
  const passed = outcomes.filter((o) => o === "ok").length;
  expect(passed).toBeLessThanOrEqual(
    Math.floor(SKIPPED_BYTES_PER_FILE / offset) + 1
  );
  expect(passed).toBeGreaterThan(0);
});

it("the direct Zarr reader refuses a 206 naming other bytes", async () => {
  vi.spyOn(globalThis, "fetch").mockImplementation(
    async () =>
      new Response(new Uint8Array([7, 7]), {
        status: 206,
        headers: { "Content-Range": "bytes 4-5/38" },
      })
  );
  const direct = await ZarrDataManager.createNewStore(
    "https://data.example/direct.zarr",
    false,
    { byteCache: false }
  );
  await expect(
    direct.getRange!("/t/c/0", { offset: 0, length: 2 })
  ).rejects.toThrow(/bytes 4–5/);
});

it("an HTTP-encoded body counts at most its declared transfer", async () => {
  let counted = 0;
  const decoded = new Uint8Array(2 ** 20);
  const response = new Response(decoded, {
    headers: { "Content-Length": "1052" },
  });
  const read = countedBody(response, (n) => (counted += n));
  await read.arrayBuffer();
  expect(counted).toBe(1052);
});
