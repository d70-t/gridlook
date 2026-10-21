import { expect, it } from "vitest";

import { hashParams, parseCatalog } from "@/utils/catalog.ts";

it("normalizes catalog entries", () => {
  const catalog = parseCatalog({
    type: "gridlook_catalog",
    datasets: [
      {
        url: "a",
        tags: { grid: "healpix", bad: 1 },
        params: { varname: "tas" },
      },
      { url: "b", tag: "regular" },
      { title: "no url" },
      null,
    ],
  });
  expect(catalog?.datasets).toEqual([
    {
      url: "a",
      title: undefined,
      description: undefined,
      tags: { grid: "healpix" },
      params: { varname: "tas" },
    },
    {
      url: "b",
      title: undefined,
      description: undefined,
      tags: { tag: "regular" },
      params: undefined,
    },
  ]);
  expect(parseCatalog({ type: "other", datasets: [] })).toBeNull();
});

it("parses params given as a copied hash", () => {
  const catalog = parseCatalog({
    type: "gridlook_catalog",
    datasets: [
      { url: "a", params: "varname=tas::catalog=static%2Fcatalog.json" },
    ],
  });
  const params = catalog?.datasets[0].params;
  expect(params).toEqual({ varname: "tas", catalog: "static/catalog.json" });
  expect(hashParams(params)).toBe(
    "::varname=tas::catalog=static%2Fcatalog.json"
  );
});

it("encodes params for the hash", () => {
  expect(hashParams({ varname: "tas", colormap: "a&b=c" })).toBe(
    "::varname=tas::colormap=a%26b%3Dc"
  );
  expect(hashParams()).toBe("");
});
