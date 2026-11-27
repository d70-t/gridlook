/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
/** Against paired member 20 of A with member 10 of B by position. */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { partnerQuery } from "@/lib/analysis/companionAlign.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import {
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  type TAnalysisQuery,
} from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;

async function write(
  store: TStore,
  path: string,
  data: number[],
  shape: number[],
  dims: string[],
  attrs: Record<string, unknown> = {}
) {
  const array = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape: shape,
    dtype: "float64",
    dimensionNames: dims,
    attributes: attrs,
    fillValue: Number.NaN as never,
  });
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((p, n) => p * n, 1)
  );
  await zarr.set(array as never, null, {
    data: Float64Array.from(data),
    shape,
    stride,
  } as never);
}

async function store() {
  const s: TStore = new Map();
  await zarr.create(zarr.root(s), { attributes: {} });
  await write(s, "time", [0, 1], [2], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(s, "lat", [0], [1], ["lat"], { units: "degrees_north" });
  await write(s, "lon", [0], [1], ["lon"], { units: "degrees_east" });
  await write(s, "a_id", [20, 10], [2], ["run"], {
    standard_name: "realization",
  });
  await write(s, "b_id", [10, 20], [2], ["run"], {
    standard_name: "realization",
  });
  const dims = ["time", "run", "lat", "lon"];
  await write(s, "a", [200, 100, 201, 101], [2, 2, 1, 1], dims, {
    units: "K",
    coordinates: "a_id",
  });
  await write(s, "b", [10, 20, 11, 21], [2, 2, 1, 1], dims, {
    units: "Pa",
    coordinates: "b_id",
  });
  return zarrAnalysisDatasetFromStore(
    s as never,
    "",
    ZARR_FORMAT.V3,
    `aux-members-${Math.random()}`
  );
}

it("pairs member 20 of A with member 20 of B, named by auxiliary coordinates", async () => {
  const ds = await store();
  const describe = (name: string) =>
    resolveVariableContext(ds, name, new ByteLru<BigInt64Array>(2 ** 20));
  const [a, b] = await Promise.all([describe("a"), describe("b")]);
  expect(a.others[0].ids).toEqual(["20", "10"]);
  expect(b.others[0].ids).toEqual(["10", "20"]);
  const matched = partnerQuery(
    {
      version: ALGORITHM_VERSION,
      kind: ANALYSIS_KINDS.POINT_SERIES,
      variable: "a",
      geometry: { kind: "point", lat: 0, lon: 0 },
      source: { ref: "memory", versionStatus: "best-effort" },
      fixed: { run: 0 },
    },
    { others: a.others },
    { others: b.others },
    "b"
  );
  expect("fixed" in matched ? matched.fixed.run : matched.reason).toBe(1);
});

it("refuses a partner whose member IDs are listed twice or could not be read", () => {
  const query: TAnalysisQuery = {
    version: ALGORITHM_VERSION,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    variable: "a",
    geometry: { kind: "point", lat: 0, lon: 0 },
    source: { ref: "memory", versionStatus: "best-effort" },
    fixed: { run: 0 },
  };
  const mine = { others: [{ dimension: "run", size: 2, ids: ["20", "10"] }] };
  const twice = partnerQuery(
    query,
    mine,
    { others: [{ dimension: "run", size: 2, ids: ["20", "20"] }] },
    "b"
  );
  expect("reason" in twice && twice.reason).toMatch(/more than once/);
  const unread = partnerQuery(
    query,
    mine,
    { others: [{ dimension: "run", size: 2, idsUnread: true }] },
    "b"
  );
  expect("reason" in unread && unread.reason).toMatch(/could not be read/);
});
