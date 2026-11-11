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

async function probe(src: string, page: string) {
  const fetchMock = vi
    .spyOn(globalThis, "fetch")
    .mockResolvedValue(new Response("", { status: 404 }));
  const { storePath } = await splitIcechunkStoreAndGroup(src, page);
  const requests = fetchMock.mock.calls.map(
    ([input, init]) => new Request(input, init)
  );
  return { storePath, requests };
}

function expectNoTokenOutside(requests: Request[], base: string) {
  for (const request of requests) {
    if (!request.url.startsWith(base)) {
      expect(request.headers.has("X-XSRFToken")).toBe(false);
    }
  }
}

describe("splitIcechunkStoreAndGroup", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("keeps the token only on parents under the user's server", async () => {
    const { storePath, requests } = await probe(
      "https://hub.example.org/user/x/files/index.json?_xsrf=2%7Cab",
      PAGE
    );
    expect(storePath).toBe(
      "icechunk+https://hub.example.org/user/x/files/index.json?_xsrf=2%7Cab"
    );
    // the repo root is probed at index.json, files, x, user, and the origin
    expect(requests.length).toBeGreaterThanOrEqual(5);
    expect(requests[0].headers.get("X-XSRFToken")).toBe("2|ab");
    expectNoTokenOutside(requests, "https://hub.example.org/user/x/");
  });

  it("does not send the token above a hub served under a sub-path", async () => {
    const { requests } = await probe(
      "https://example.org/jupyter/user/alice/files/data/index.json?_xsrf=t",
      "https://example.org/jupyter/user/alice/gridlook/"
    );
    expect(requests.some((r) => r.url === "https://example.org/repo")).toBe(
      true
    );
    expect(requests[0].headers.get("X-XSRFToken")).toBe("t");
    expectNoTokenOutside(requests, "https://example.org/jupyter/user/alice/");
  });

  it("does not probe another user's server through a `..` path", async () => {
    const { requests } = await probe(
      "https://hub.example.org/user/y/../x/files/r.zarr?_xsrf=t",
      PAGE
    );
    for (const request of requests) {
      expect(request.url).not.toContain("/user/y");
    }
    expectNoTokenOutside(requests, "https://hub.example.org/user/x/");
  });
});
