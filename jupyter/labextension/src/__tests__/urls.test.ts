import { dataUrl, viewerSrc, viewerUrl } from "../urls";

describe("viewerUrl", () => {
  it("joins a hub base URL with a user prefix", () => {
    expect(viewerUrl("/user/x/")).toBe("/user/x/gridlook/");
  });

  it("handles the root base URL", () => {
    expect(viewerUrl("/")).toBe("/gridlook/");
  });

  it("keeps an absolute base URL's origin (what makeSettings() reports)", () => {
    expect(viewerUrl("http://127.0.0.1:8888/")).toBe(
      "http://127.0.0.1:8888/gridlook/"
    );
    expect(viewerUrl("https://hub.example.org/user/x/")).toBe(
      "https://hub.example.org/user/x/gridlook/"
    );
  });
});

describe("dataUrl", () => {
  it("routes through jupyter's /files/ handler under the base URL", () => {
    expect(dataUrl("/user/x/", "data/store.zarr")).toBe(
      "/user/x/files/data/store.zarr"
    );
  });

  it("percent-encodes spaces and # per segment, keeping the slashes", () => {
    expect(dataUrl("/", "my data/a#b.zarr")).toBe(
      "/files/my%20data/a%23b.zarr"
    );
  });

  it("encodes colons so the SPA's :: parameter separator cannot be forged", () => {
    expect(dataUrl("/", "t::x.zarr")).toBe("/files/t%3A%3Ax.zarr");
    expect(dataUrl("/", "a:b/c::d.zarr")).toBe("/files/a%3Ab/c%3A%3Ad.zarr");
  });

  it("drops empty segments", () => {
    expect(dataUrl("/", "/a//b/")).toBe("/files/a/b");
  });
});

describe("viewerSrc", () => {
  it("puts the data URL in the hash", () => {
    expect(viewerSrc("/user/x/", "store.zarr")).toBe(
      "/user/x/gridlook/#/user/x/files/store.zarr"
    );
    expect(viewerSrc("https://hub.example.org/user/x/", "a b/c.zarr")).toBe(
      "https://hub.example.org/user/x/gridlook/#https://hub.example.org/user/x/files/a%20b/c.zarr"
    );
  });

  it("yields no hash for the launcher (no path) case", () => {
    expect(viewerSrc("/user/x/")).toBe("/user/x/gridlook/");
    expect(viewerSrc("/user/x/", "")).toBe("/user/x/gridlook/");
  });
});
