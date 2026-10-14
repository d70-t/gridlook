import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createIcechunkStore,
  splitIcechunkStoreAndGroup,
  withStoreXsrfToken,
} from "@/lib/data/icechunkStore.ts";

const PAGE = "https://hub.example.org/user/x/gridlook/";
const COOKIE = "_xsrf=tok";

describe("withStoreXsrfToken", () => {
  it("tokenizes the URL inside an icechunk+ store path", () => {
    expect(
      withStoreXsrfToken(
        "icechunk+https://hub.example.org/user/x/files/r",
        COOKIE,
        PAGE
      )
    ).toBe("icechunk+https://hub.example.org/user/x/files/r?_xsrf=tok");
  });

  it("tokenizes bare .icechunk and zarr URLs like any other", () => {
    expect(withStoreXsrfToken("/user/x/files/r.icechunk", COOKIE, PAGE)).toBe(
      "/user/x/files/r.icechunk?_xsrf=tok"
    );
    const remote = "icechunk+https://bucket.example.com/r";
    expect(withStoreXsrfToken(remote, COOKIE, PAGE)).toBe(remote);
  });
});

describe("createIcechunkStore", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("moves the token from the URL into an X-XSRFToken header", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 404 }));
    await createIcechunkStore(
      "https://hub.example.org/user/x/files/r.icechunk?_xsrf=2%7Cab"
    ).catch(() => undefined);
    expect(fetchMock).toHaveBeenCalled();
    for (const [input, init] of fetchMock.mock.calls) {
      const request = new Request(input, init);
      expect(request.url).toMatch(
        /^https:\/\/hub\.example\.org\/user\/x\/files\/r\.icechunk\/[^?]+$/
      );
      expect(request.headers.get("X-XSRFToken")).toBe("2|ab");
    }
  });

  it("keeps the token on every parent probed for the repo root", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 404 }));
    const { storePath } = await splitIcechunkStoreAndGroup(
      "https://hub.example.org/user/x/files/index.json?_xsrf=2%7Cab"
    );
    expect(storePath).toBe(
      "icechunk+https://hub.example.org/user/x/files/index.json?_xsrf=2%7Cab"
    );
    // the repo root is probed at index.json, files, x, user, and the origin
    expect(fetchMock.mock.calls.length).toBeGreaterThanOrEqual(5);
    for (const [input, init] of fetchMock.mock.calls) {
      expect(new Request(input, init).headers.get("X-XSRFToken")).toBe("2|ab");
    }
  });

  it("sends no header for a store without a token", async () => {
    const fetchMock = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(new Response("", { status: 404 }));
    await createIcechunkStore("https://bucket.example.com/r.icechunk").catch(
      () => undefined
    );
    expect(fetchMock).toHaveBeenCalled();
    for (const [input, init] of fetchMock.mock.calls) {
      expect(new Request(input, init).headers.has("X-XSRFToken")).toBe(false);
    }
  });
});
