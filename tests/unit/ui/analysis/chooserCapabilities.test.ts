/* eslint-disable camelcase -- CF and Zarr metadata use snake_case keys. */
import { describe, expect, it, vi } from "vitest";
import { createSSRApp } from "vue";
import { renderToString } from "vue/server-renderer";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS } from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";
import { cheapToDescribe, chooserReasons } from "@/ui/analysis/orbitDial.ts";
import OrbitDial from "@/ui/analysis/OrbitDial.vue";

type TStore = Map<string, Uint8Array>;

// The dial listens for Escape and reads media queries while it renders.
const media = () => ({
  matches: false,
  addEventListener() {},
  removeEventListener() {},
});
vi.stubGlobal("window", {
  addEventListener() {},
  removeEventListener() {},
  matchMedia: media,
});

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
  await zarr.set(array as never, null, {
    data: Float64Array.from(data),
    shape,
    stride: shape.map((_, d) => shape.slice(d + 1).reduce((a, n) => a * n, 1)),
  } as never);
}

/** `time(record)` and a pressure coordinate along `layer_id`. */
async function recordStore() {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "lat", [0], [1], ["lat"], { units: "degrees_north" });
  await write(store, "lon", [0], [1], ["lon"], { units: "degrees_east" });
  await write(store, "time", [0, 1, 2], [3], ["record"], {
    units: "days since 2000-01-01",
    standard_name: "time",
  });
  await write(store, "pressure", [900, 500], [2], ["layer_id"], {
    units: "hPa",
    standard_name: "air_pressure",
    positive: "down",
  });
  await write(
    store,
    "u",
    [1, 2, 3, 4, 5, 6],
    [3, 2, 1, 1],
    ["record", "layer_id", "lat", "lon"],
    { coordinates: "time pressure" }
  );
  return store;
}

describe("the plot chooser before a plot has described the variable", () => {
  it("offers time series and profiles that the planner accepts", async () => {
    const context = await resolveVariableContext(
      zarrAnalysisDatasetFromStore(
        (await recordStore()) as never,
        "",
        ZARR_FORMAT.V3,
        `chooser-${Math.random()}`
      ),
      "u",
      new ByteLru<BigInt64Array>(2 ** 20)
    );
    for (const kind of [ANALYSIS_KINDS.POINT_SERIES, ANALYSIS_KINDS.PROFILE]) {
      expect(context.capabilities[kind].available).toBe(true);
      // Unknown (no summary yet) and known both offer it.
      expect(chooserReasons()[kind]).toBe("");
      expect(chooserReasons(context)[kind]).toBe("");
    }
    const html = await renderToString(
      createSSRApp(OrbitDial, {
        button: { x: 18, y: 500, w: 160, h: 36 },
        growOrigin: { x: 30, y: 518 },
        area: { width: 1200, height: 800 },
        variable: "u",
        capabilities: chooserReasons(),
        note: "",
      })
    );
    const rows = html.match(/<button[^>]*class="dial-row[^>]*>/g) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => !row.includes('aria-disabled="true"'))).toBe(
      true
    );
  });

  it("still names a reason once the variable is described", () => {
    const off = {
      available: false,
      reason: "The variable has no time dimension.",
    };
    const on = { available: true };
    const capabilities = Object.fromEntries(
      Object.values(ANALYSIS_KINDS).map((kind) => [kind, on])
    ) as never as Record<string, typeof on | typeof off>;
    capabilities[ANALYSIS_KINDS.POINT_SERIES] = off;
    expect(
      chooserReasons({ capabilities } as never)[ANALYSIS_KINDS.POINT_SERIES]
    ).toBe(off.reason);
  });
});

it("locks the vertical plots of a map variable without levels", () => {
  const range = (name: string) => ({
    name,
    startPos: 0,
    minBound: 0,
    maxBound: 9,
  });
  // (time, cell): nothing but time beside the horizontal dimension.
  const flat = chooserReasons(undefined, {
    dimRanges: [range("time"), null],
    dimInfo: [{ attrs: { units: "hours since 2020-01-01" } }, {}] as never,
  });
  for (const kind of [
    ANALYSIS_KINDS.PROFILE,
    ANALYSIS_KINDS.TIME_DEPTH,
    ANALYSIS_KINDS.LAT_VERTICAL,
  ]) {
    expect(flat[kind]).toMatch(/no vertical dimension/);
  }
  expect(flat[ANALYSIS_KINDS.POINT_SERIES]).toBe("");
  expect(flat[ANALYSIS_KINDS.SECTION]).toBe("");
  // Any other dimension may carry levels: offered until described.
  const layered = chooserReasons(undefined, {
    dimRanges: [range("time"), range("layer_id"), null, null],
    dimInfo: [{}, {}, {}, {}] as never,
  });
  expect(layered[ANALYSIS_KINDS.PROFILE]).toBe("");
  // A described variable decides.
  const on = { available: true };
  const capabilities = Object.fromEntries(
    Object.values(ANALYSIS_KINDS).map((kind) => [kind, on])
  ) as never;
  expect(
    chooserReasons(
      { capabilities },
      {
        dimRanges: [range("time"), null],
        dimInfo: [{}, {}] as never,
      }
    )[ANALYSIS_KINDS.PROFILE]
  ).toBe("");
});

it("rules out what a one-date or timeless map variable cannot plot before it is described", () => {
  const range = (name: string, maxBound: number) => ({
    name,
    startPos: 0,
    minBound: 0,
    maxBound,
  });
  // One ERA5 analysis time beside the horizontal dimension.
  const oneDate = {
    dimRanges: [range("time", 0), null, null],
    dimInfo: [{ values: [0], attrs: {} }, {}, {}] as never,
  };
  const reasons = chooserReasons(undefined, oneDate);
  for (const kind of [
    ANALYSIS_KINDS.TIME_DEPTH,
    ANALYSIS_KINDS.HOVMOLLER_LON,
    ANALYSIS_KINDS.HOVMOLLER_PATH,
  ]) {
    expect(reasons[kind]).toMatch(/only one time step/);
  }
  // A series of one date may still be made: its description decides.
  expect(reasons[ANALYSIS_KINDS.POINT_SERIES]).toBe("");
  // Short axes: described as the menu opens, which settles the rest.
  expect(cheapToDescribe(oneDate)).toBe(true);
  // No dimension besides the horizontal ones: no time at all.
  const still = chooserReasons(undefined, {
    dimRanges: [null, null],
    dimInfo: [{}, {}] as never,
  });
  expect(still[ANALYSIS_KINDS.POINT_SERIES]).toMatch(/no time dimension/);
  expect(still[ANALYSIS_KINDS.REGION_SERIES]).toMatch(/no time dimension/);
  expect(still[ANALYSIS_KINDS.DISTRIBUTION]).toBe("");
  // A long axis waits for a plot to be chosen before it is described.
  expect(
    cheapToDescribe({
      dimRanges: [range("time", 99_999), null],
      dimInfo: [{}, {}] as never,
    })
  ).toBe(false);
});

it("names a one-step time dimension without a coordinate as one date", async () => {
  // One ERA5 analysis time: `time` of length 1, with no time array.
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "lat", [0, 1], [2], ["lat"], { units: "degrees_north" });
  await write(store, "lon", [0, 1], [2], ["lon"], { units: "degrees_east" });
  await write(
    store,
    "t2m",
    [280, 281, 282, 283],
    [1, 2, 2],
    ["time", "lat", "lon"]
  );
  const context = await resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `one-step-${Math.random()}`
    ),
    "t2m",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
  expect(chooserReasons(context)[ANALYSIS_KINDS.POINT_SERIES]).toMatch(
    /only one time step/
  );
});

it("final review of interim41: a field with its own latitude/longitude mapping beside HEALPix ones is a map", async () => {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), {
    attributes: { dggs: { name: "healpix", refinement_level: 0 } },
  });
  await write(store, "lat", [0, 1], [2], ["lat"], { units: "degrees_north" });
  await write(store, "lon", [0, 1], [2], ["lon"], { units: "degrees_east" });
  await write(store, "time", [0, 1], [2], ["time"], {
    units: "days since 2000-01-01",
  });
  await write(store, "latlon", [0], [1], ["one"], {
    grid_mapping_name: "latitude_longitude",
  });
  await write(
    store,
    "t2m",
    Array(8).fill(280),
    [2, 2, 2],
    ["time", "lat", "lon"],
    {
      grid_mapping: "latlon",
    }
  );
  const context = await resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `mixed-${Math.random()}`
    ),
    "t2m",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
  expect(context.grid.kind).toBe("rectilinear");
  expect(context.capabilities[ANALYSIS_KINDS.POINT_SERIES].available).toBe(
    true
  );
});
