import {
  type ChunkRef,
  ReadSession,
  Repository,
  type Storage,
} from "icechunk-js";
import { afterEach, expect, it, vi } from "vitest";

import { storeRequests } from "@/lib/data/requestGate.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";

afterEach(() => vi.restoreAllMocks());

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

it.each(["native", "virtual"] as const)(
  "applies the 24-request cap to %s Icechunk payloads shared by map and plot",
  async (kind) => {
    const n = 28;
    mockRepository(kind, n);
    const gated = vi.spyOn(storeRequests, "fetch");
    let open = 0;
    let peak = 0;
    let fresh = 0;
    const network = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation(async (url, init) => {
        if (new Request(url, init).cache === "no-store") {
          fresh++;
        }
        peak = Math.max(peak, ++open);
        await new Promise((resolve) => setTimeout(resolve, 20));
        open--;
        return new Response(new Uint8Array([42]), {
          status: 206,
          headers: { "Content-Range": "bytes 0-0/1" },
        });
      });
    const source = "icechunk+https://data.example/repo";
    const map = await ZarrDataManager.createNewStore(source);
    const plot = await ZarrDataManager.createNewStore(source, true, {
      byteCache: false,
    });
    const values = await Promise.all(
      Array.from({ length: n }, (_, i) =>
        (i % 2 ? plot : map).get(`/temperature/c/${i}`)
      )
    );
    expect(values.every((b) => b?.[0] === 42)).toBe(true);
    expect(network).toHaveBeenCalledTimes(n);
    expect(fresh).toBe(14);
    console.log({
      kind,
      reads: n,
      freshPlotReads: fresh,
      peak,
      gated: gated.mock.calls.length,
    });
    expect(peak).toBeLessThanOrEqual(24);
  }
);
