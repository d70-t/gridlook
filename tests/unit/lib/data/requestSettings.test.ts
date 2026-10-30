import { afterEach, expect, it, vi } from "vitest";

import { createIcechunkStore } from "@/lib/data/icechunkStore.ts";
import { ZarrDataManager } from "@/lib/data/ZarrDataManager.ts";

afterEach(() => {
  vi.restoreAllMocks();
  ZarrDataManager.setRequestSettings({ headers: {}, withCredentials: false });
});

function mockFetch() {
  return vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("", { status: 404 }));
}

function requests(fetchMock: ReturnType<typeof mockFetch>) {
  return fetchMock.mock.calls.map(([input, init]) => new Request(input, init));
}

it("sends headers and cookies with Zarr requests", async () => {
  const fetchMock = mockFetch();
  ZarrDataManager.setRequestSettings({
    headers: { Authorization: "Bearer abc", "X-Api-Key": "key" },
    withCredentials: true,
  });
  const store = await ZarrDataManager.createNewStore(
    "https://example.org/data.zarr"
  );
  await store.get("/zarr.json");
  const [request] = requests(fetchMock);
  expect(request.headers.get("Authorization")).toBe("Bearer abc");
  expect(request.headers.get("X-Api-Key")).toBe("key");
  expect(request.credentials).toBe("include");
});

it("sends headers and cookies with Icechunk requests", async () => {
  const fetchMock = mockFetch();
  ZarrDataManager.setRequestSettings({
    headers: { "X-Api-Key": "key" },
    withCredentials: true,
  });
  await createIcechunkStore("https://example.org/r.icechunk").catch(
    () => undefined
  );
  expect(fetchMock).toHaveBeenCalled();
  for (const request of requests(fetchMock)) {
    expect(request.headers.get("X-Api-Key")).toBe("key");
    expect(request.credentials).toBe("include");
  }
});
