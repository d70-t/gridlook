/* eslint-disable camelcase -- CF and Zarr metadata use snake_case keys. */
import { expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import {
  zarrAnalysisDatasetFromStore,
  type TAnalysisDataset,
} from "@/lib/analysis/sourceAdapter.ts";
import {
  ANALYSIS_KINDS,
  type TAnalysisQuery,
  type TGeometry,
} from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;

const LATS = [-90, -60, -30, 0, 30, 60, 90];
const LONS = [0, 45, 90, 135, 180, 225, 270, 315];
const NT = 2;
const DATA_URL =
  "https://storage.googleapis.com/cmip6/CMIP6/PMIP/IPSL/IPSL-CM6A-LR/midHolocene/r1i1p1f3/Amon/tas/gr/v20180926/";

const tasAt = (t: number, i: number, j: number) => 270 + t + i + j / 10;
/** Not a row factor times a column factor; one cell without an area. */
const areaAt = (i: number, j: number) =>
  i === 3 && j === 2 ? Number.NaN : (1 + i) * (1 + (j % 3)) * 1e10 + j * 1e8;

async function write(
  store: TStore,
  path: string,
  dims: string[],
  shape: number[],
  values: ArrayLike<number>,
  attrs: Record<string, unknown> = {},
  chunkShape = shape
) {
  const node = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape,
    dtype: "float64",
    dimensionNames: dims,
    attributes: attrs,
    fillValue: Number.NaN as never,
  });
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((p, n) => p * n, 1)
  );
  await zarr.set(node as never, null, {
    data: Float64Array.from(values),
    shape,
    stride,
  } as never);
}

async function axes(
  store: TStore,
  lats = LATS,
  lons = LONS,
  lonBounds?: number[]
) {
  await write(store, "lat", ["lat"], [lats.length], lats, {
    units: "degrees_north",
  });
  await write(store, "lon", ["lon"], [lons.length], lons, {
    units: "degrees_east",
    ...(lonBounds ? { bounds: "lon_bnds" } : {}),
  });
  if (lonBounds) {
    await write(store, "lon_bnds", ["lon", "nv"], [lons.length, 2], lonBounds, {
      units: "degrees_east",
    });
  }
}

function areaValues(order: "latlon" | "lonlat") {
  return order === "latlon"
    ? LATS.flatMap((_, i) => LONS.map((__, j) => areaAt(i, j)))
    : LONS.flatMap((_, j) => LATS.map((__, i) => areaAt(i, j)));
}

/** The temperature store, and (optionally) its fixed-field sibling. */
// eslint-disable-next-line max-lines-per-function
async function sources(
  options: {
    colocated?: boolean;
    units?: string;
    order?: "latlon" | "lonlat";
    siblingLats?: number[];
    dataLons?: number[];
    siblingLons?: number[];
    sibling?: boolean;
    dataLonBounds?: number[];
    siblingLonBounds?: number[];
  } = {}
) {
  const order = options.order ?? "latlon";
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), {
    attributes: options.colocated ? {} : { external_variables: "areacella" },
  });
  await axes(store, LATS, options.dataLons, options.dataLonBounds);
  await write(store, "time", ["time"], [NT], [0, 31], {
    units: "days since 1850-01-01",
  });
  await write(
    store,
    "tas",
    ["time", "lat", "lon"],
    [NT, LATS.length, LONS.length],
    Array.from({ length: NT * LATS.length * LONS.length }, (_, at) =>
      tasAt(
        Math.floor(at / (LATS.length * LONS.length)),
        Math.floor(at / LONS.length) % LATS.length,
        at % LONS.length
      )
    ),
    { units: "K", cell_measures: "area: areacella" }
  );
  const areaStore: TStore = new Map();
  const target = options.colocated ? store : areaStore;
  if (!options.colocated) {
    await zarr.create(zarr.root(areaStore), { attributes: {} });
    await axes(
      areaStore,
      options.siblingLats,
      options.siblingLons ?? options.dataLons,
      options.siblingLonBounds
    );
  }
  await write(
    target,
    "areacella",
    order === "latlon" ? ["lat", "lon"] : ["lon", "lat"],
    order === "latlon"
      ? [LATS.length, LONS.length]
      : [LONS.length, LATS.length],
    areaValues(order),
    { units: options.units ?? "m2", standard_name: "cell_area" }
  );
  const opened: string[] = [];
  const sibling = zarrAnalysisDatasetFromStore(
    areaStore as never,
    "",
    ZARR_FORMAT.V3,
    "fx"
  );
  const dataset: TAnalysisDataset = {
    ...zarrAnalysisDatasetFromStore(store as never, "", ZARR_FORMAT.V3, "tas"),
    location: DATA_URL,
    async openStore(url) {
      opened.push(url);
      if (options.sibling === false) {
        throw Object.assign(new Error("404 Not Found"), {
          name: "NotFoundError",
        });
      }
      return sibling;
    },
  };
  return { dataset, opened, areaStore };
}

const indexCache = new ByteLru<BigInt64Array>(8 * 2 ** 20);
const query = (
  kind: TAnalysisQuery["kind"],
  geometry: TGeometry
): TAnalysisQuery => ({
  version: 1,
  kind,
  source: { ref: "memory://ipsl", versionStatus: "session" as const },
  variable: "tas",
  geometry,
  fixed: {},
});

it("uses a published conflicting edge even if the other edge is missing", async () => {
  const ours = LONS.flatMap((l) => [l - 22.5, l + 22.5]);
  const run = async (partial: boolean) => {
    const edges = ours.slice();
    edges[1] = edges[2] = 30;
    if (partial) {
      edges[0] = NaN;
      edges[3] = NaN;
    }
    const { dataset } = await sources({
      dataLonBounds: ours,
      siblingLonBounds: edges,
    });
    const ctx = await resolveVariableContext(dataset, "tas", indexCache);
    return (
      await planAnalysis(
        ctx,
        query(ANALYSIS_KINDS.REGION_SERIES, {
          kind: "box",
          south: -34,
          north: 34,
          west: -1,
          east: 46,
        }),
        new ReadContext()
      )
    ).execute();
  };
  const full = await run(false).catch(String),
    partial = await run(true).catch(String);
  // Refused with all edges, and with the outer ones missing.
  expect(typeof full).toBe("string");
  expect(typeof partial).toBe("string");
});
