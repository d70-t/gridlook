import { describe, expect, it } from "vitest";

import {
  joinUrlPath,
  splitXsrfToken,
  withXsrfToken,
} from "@/utils/xsrfToken.ts";

const PAGE = "https://hub.example.org/user/x/gridlook/";
const COOKIE = "other=1; _xsrf=2|ab:c=; more=2";
const TOKEN = "2%7Cab%3Ac%3D";

describe("withXsrfToken", () => {
  it("adds the token to URLs on the same Jupyter server, absolute or not", () => {
    expect(
      withXsrfToken("https://hub.example.org/user/x/files/s.zarr", COOKIE, PAGE)
    ).toBe(`https://hub.example.org/user/x/files/s.zarr?_xsrf=${TOKEN}`);
    expect(withXsrfToken("/user/x/gridlook/s3/b/s.zarr", COOKIE, PAGE)).toBe(
      `/user/x/gridlook/s3/b/s.zarr?_xsrf=${TOKEN}`
    );
    expect(
      withXsrfToken("/files/s.zarr", COOKIE, "http://localhost:8888/gridlook/")
    ).toBe(`/files/s.zarr?_xsrf=${TOKEN}`);
  });

  it("appends to an existing query", () => {
    expect(withXsrfToken("/user/x/files/s.zarr?v=1", COOKIE, PAGE)).toBe(
      `/user/x/files/s.zarr?v=1&_xsrf=${TOKEN}`
    );
  });

  it("never sends the token to another origin or another user's server", () => {
    const remote = "https://storage.googleapis.com/bucket/s.zarr";
    expect(withXsrfToken(remote, COOKIE, PAGE)).toBe(remote);
    const icechunk = "icechunk+https://hub.example.org/user/x/files/s";
    expect(withXsrfToken(icechunk, COOKIE, PAGE)).toBe(icechunk);
    const otherUser = "/user/y/files/s.zarr";
    expect(withXsrfToken(otherUser, COOKIE, PAGE)).toBe(otherUser);
  });

  it("does nothing on a page not served by gridlook-jupyter", () => {
    // cookies ignore the port: a dev server sees a local JupyterLab's _xsrf
    const url = "/public/s.zarr";
    expect(withXsrfToken(url, COOKIE, "http://localhost:5173/")).toBe(url);
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

  it("passes a cookie value that is not valid percent-encoding through", () => {
    expect(withXsrfToken("/user/x/files/s.zarr", "_xsrf=%E0%A4%A", PAGE)).toBe(
      "/user/x/files/s.zarr?_xsrf=%25E0%25A4%25A"
    );
  });
});

describe("token-aware URL helpers", () => {
  it("joins paths in front of the query", () => {
    expect(joinUrlPath("https://h/u/s.zarr?_xsrf=T", "current-timestep")).toBe(
      "https://h/u/s.zarr/current-timestep?_xsrf=T"
    );
    expect(joinUrlPath("u/s.zarr/?_xsrf=T", "grp")).toBe(
      "u/s.zarr/grp?_xsrf=T"
    );
    expect(joinUrlPath("https://h/s.zarr/", "")).toBe("https://h/s.zarr/");
  });

  it("splits only a trailing _xsrf parameter, still encoded", () => {
    expect(splitXsrfToken(`/u/r.icechunk?_xsrf=${TOKEN}`)).toEqual({
      url: "/u/r.icechunk",
      token: TOKEN,
    });
    expect(splitXsrfToken(`/u/r.icechunk?v=1&_xsrf=${TOKEN}`)).toEqual({
      url: "/u/r.icechunk?v=1",
      token: TOKEN,
    });
    expect(splitXsrfToken("/u/r.icechunk?v=1")).toEqual({
      url: "/u/r.icechunk?v=1",
    });
  });
});
