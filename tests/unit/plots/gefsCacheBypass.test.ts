// A GEFS point plot waited two minutes for one shard the map was also
// reading: the browser lets one request at a time use a file's cache entry,
// so the plot's read queued behind the map's. Plot reads skip that cache.
import { afterEach, expect, it, vi } from "vitest";

import { openZarrAnalysisDataset } from "@/lib/analysis/sourceAdapter.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

afterEach(() => {
  vi.restoreAllMocks();
  ZarrDataManager.setRequestSettings({ headers: {}, withCredentials: false });
});

function mockFetch() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("", { status: 404 }));
}

it("reads plot data past the browser cache, keeping cookies", async () => {
  const fetchMock = mockFetch();
  ZarrDataManager.setRequestSettings({ headers: {}, withCredentials: true });
  const plot = await openZarrAnalysisDataset(
    { store: "https://example.org/gefs.zarr", dataset: "" },
    ZARR_FORMAT.V3
  );
  await plot.openArray("temperature_2m").catch(() => undefined);
  expect(fetchMock).toHaveBeenCalled();
  for (const [, init] of fetchMock.mock.calls) {
    expect(init).toMatchObject({ cache: "no-store", credentials: "include" });
  }
});

it("leaves the map's reads to the browser cache", async () => {
  const fetchMock = mockFetch();
  const map = await ZarrDataManager.createNewStore(
    "https://example.org/gefs.zarr"
  );
  await map.get("/zarr.json");
  expect(fetchMock.mock.calls[0][1]?.cache).toBeUndefined();
});

it("reads an Icechunk plot store past the browser cache too", async () => {
  // A branch ref, then nothing: the snapshot read is the one to check.
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockImplementation(async (input) =>
      String(input instanceof Request ? input.url : input).endsWith("ref.json")
        ? new Response('{"snapshot":"0000000000000000000G"}', { status: 200 })
        : new Response("", { status: 404 })
    );
  await openZarrAnalysisDataset(
    { store: "icechunk::https://example.org/repo", dataset: "" },
    ZARR_FORMAT.ICECHUNK
  ).catch(() => undefined);
  expect(fetchMock).toHaveBeenCalled();
  // Reads (GET); the library's HEAD existence probes take no cache option.
  const reads = fetchMock.mock.calls
    .map(([input, init]) => new Request(input, init))
    .filter(
      (request) => request.method === "GET" && /snapshots/.test(request.url)
    );
  expect(reads.length).toBeGreaterThan(0);
  for (const request of reads) {
    expect(request.cache, request.url).not.toBe("default");
  }
});
