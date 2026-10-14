import { describe, expect, it } from "vitest";

import { withXsrfToken } from "@/utils/xsrfToken.ts";

const PAGE = "https://hub.example.org/user/x/gridlook/";
const COOKIE = "other=1; _xsrf=2|ab:c=; more=2";
const TOKEN = "2%7Cab%3Ac%3D";

describe("withXsrfToken", () => {
  it("adds the token to same-origin URLs, absolute or not", () => {
    expect(
      withXsrfToken("https://hub.example.org/user/x/files/s.zarr", COOKIE, PAGE)
    ).toBe(`https://hub.example.org/user/x/files/s.zarr?_xsrf=${TOKEN}`);
    expect(withXsrfToken("/user/x/gridlook/s3/b/s.zarr", COOKIE, PAGE)).toBe(
      `/user/x/gridlook/s3/b/s.zarr?_xsrf=${TOKEN}`
    );
  });

  it("appends to an existing query", () => {
    expect(withXsrfToken("/user/x/files/s.zarr?v=1", COOKIE, PAGE)).toBe(
      `/user/x/files/s.zarr?v=1&_xsrf=${TOKEN}`
    );
  });

  it("never sends the token to another origin", () => {
    const remote = "https://storage.googleapis.com/bucket/s.zarr";
    expect(withXsrfToken(remote, COOKIE, PAGE)).toBe(remote);
    const icechunk = "icechunk:https://hub.example.org/user/x/files/s";
    expect(withXsrfToken(icechunk, COOKIE, PAGE)).toBe(icechunk);
  });

  it("leaves URLs alone without the cookie or with a token already set", () => {
    const url = "/user/x/files/s.zarr";
    expect(withXsrfToken(url, "other=1", PAGE)).toBe(url);
    expect(withXsrfToken(url, "", PAGE)).toBe(url);
    expect(withXsrfToken(`${url}?_xsrf=t`, COOKIE, PAGE)).toBe(
      `${url}?_xsrf=t`
    );
  });

  it("does not match a cookie whose name only ends in _xsrf", () => {
    const url = "/user/x/files/s.zarr";
    expect(withXsrfToken(url, "not_xsrf=1", PAGE)).toBe(url);
  });
});
