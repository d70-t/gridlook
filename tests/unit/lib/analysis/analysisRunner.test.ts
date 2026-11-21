/* eslint-disable camelcase -- CF and Zarr metadata use snake_case keys. */
import * as healpixGeo from "healpix-geo";
import { afterAll, beforeAll, expect, it, vi } from "vitest";
import * as zarr from "zarrita";

import { AnalysisRunner } from "@/lib/analysis/analysisRunner.ts";
import { timeLabelAt } from "@/lib/analysis/calendar.ts";
import { ANALYSIS_KINDS, type TAnalysisQuery } from "@/lib/analysis/types.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

// The worker's code path end to end: FetchStore (via ZarrDataManager), range
// coalescing and byte caching, the analysis store observer and the runner,
// against an in-memory store served through a stubbed fetch. Two multiscale
// levels mimic the RiOMar layout, including its publisher ellipsoid keys.
const BASE = "https://example.test/pyramid.zarr";
const memory = new Map<string, Uint8Array>();
const requests: string[] = [];

// eslint-disable-next-line max-lines-per-function
async function level(order: number, cells: number[]) {
  const root = zarr.root(memory);
  await zarr.create(root.resolve(String(order === 3 ? 0 : 1)), {
    attributes: {
      dggs: {
        name: "healpix",
        refinement_level: order,
        indexing_scheme: "nested",
        spatial_dimension: "cell",
        coordinate: "cell_ids",
        ellipsoid: {
          name: "wgs84",
          semimajor_axis: 6378137.0,
          inverse_flattening: 298.257223563,
        },
      },
    },
  });
  const group = order === 3 ? "0" : "1";
  const ids = await zarr.create(root.resolve(`${group}/cell_ids`), {
    shape: [cells.length],
    chunkShape: [cells.length],
    dtype: "int64",
    dimensionNames: ["cell"],
    fillValue: 0 as never,
  });
  await zarr.set(ids as never, null, {
    data: BigInt64Array.from(cells.map(BigInt)),
    shape: [cells.length],
    stride: [1],
  } as never);
  const time = await zarr.create(root.resolve(`${group}/time_counter`), {
    shape: [3],
    chunkShape: [3],
    dtype: "float64",
    dimensionNames: ["time_counter"],
    attributes: {
      units: "seconds since 2000-01-01",
      calendar: "gregorian",
      standard_name: "time",
    },
  });
  await zarr.set(time as never, null, {
    data: Float64Array.from([0, 3600, 7200]),
    shape: [3],
    stride: [1],
  } as never);
  const s = await zarr.create(root.resolve(`${group}/s_rho`), {
    shape: [2],
    chunkShape: [2],
    dtype: "float32",
    dimensionNames: ["s_rho"],
    attributes: { name: "s_rho" },
  });
  await zarr.set(s as never, null, {
    data: Float32Array.from([-0.75, -0.25]),
    shape: [2],
    stride: [1],
  } as never);
  const temp = await zarr.create(root.resolve(`${group}/temp`), {
    shape: [3, 2, cells.length],
    chunkShape: [2, 2, 16],
    dtype: "float64",
    dimensionNames: ["time_counter", "s_rho", "cell"],
    fillValue: Number.NaN as never,
  });
  const data = new Float64Array(3 * 2 * cells.length);
  cells.forEach((cell, c) => {
    for (let t = 0; t < 3; t++) {
      for (let k = 0; k < 2; k++) {
        data[(t * 2 + k) * cells.length + c] = 1000 * t + 10 * k + (cell % 97);
      }
    }
  });
  await zarr.set(temp as never, null, {
    data,
    shape: [3, 2, cells.length],
    stride: [2 * cells.length, cells.length, 1],
  } as never);
}

beforeAll(async () => {
  await zarr.create(zarr.root(memory), {
    attributes: { multiscales: { layout: [{ asset: "0" }, { asset: "1" }] } },
  });
  const fine = Array.from({ length: 48 }, (_, at) => 4 * 64 + at); // order 3 cells of base cell 4
  await level(3, fine);
  await level(
    2,
    Array.from({ length: 12 }, (_, at) => 64 + at)
  );
  vi.stubGlobal("fetch", async (input: Request | string) => {
    const url = typeof input === "string" ? input : input.url;
    const path = decodeURIComponent(
      new URL(url).pathname.replace("/pyramid.zarr", "")
    );
    requests.push(path);
    const bytes = memory.get(path);
    return bytes
      ? new Response(bytes as BodyInit, { status: 200 })
      : new Response(null, { status: 404 });
  });
});

afterAll(() => vi.unstubAllGlobals());

it("keeps the field's subgroup when looking for a coarser overview", async () => {
  for (const [key, bytes] of [...memory]) {
    if (/^\/[01]\//.test(key)) {
      memory.set(key.replace(/^(\/[01])\//, "$1/atmos/"), bytes);
    }
  }
  const runner = new AnalysisRunner();
  const source = {
    key: "nested-overview",
    store: BASE,
    dataset: "",
    format: ZARR_FORMAT.V3,
  };
  try {
    const summary = await runner.describe(source, "0/atmos/temp");
    expect(summary.overviews).toEqual([{ variable: "1/atmos/temp", order: 2 }]);
  } finally {
    await runner.release(source.key);
  }
});

// eslint-disable-next-line max-lines-per-function
it("describes, plans and runs through the worker's real reader stack", async () => {
  const runner = new AnalysisRunner();
  const source = {
    key: `${BASE}#1`,
    store: BASE,
    dataset: "",
    format: ZARR_FORMAT.V3,
  };
  const summary = await runner.describe(source, "0/temp");
  expect(summary.order).toBe(3);
  expect(summary.frame).toMatch(/wgs84/);
  expect(summary.vertical).toMatchObject({
    dimension: "s_rho",
    kind: "model",
    physical: false,
  });
  expect(summary.vertical!.note).toMatch(
    /no standard_name, formula_terms or physical units/
  );
  expect(timeLabelAt(summary.time, 1)).toBe("2000-01-01 01:00:00");
  expect(summary.capabilities[ANALYSIS_KINDS.PROFILE].available).toBe(true);
  expect(summary.overviews).toEqual([{ variable: "1/temp", order: 2 }]);

  const query: TAnalysisQuery = {
    version: 1,
    kind: ANALYSIS_KINDS.REGION_SERIES,
    source: { ref: BASE, versionStatus: "best-effort" },
    variable: "0/temp",
    geometry: { kind: "box", west: -180, east: 180, south: -90, north: 90 },
    fixed: {},
    level: 1,
  };
  const before = requests.length;
  const estimate = await runner.plan("r1", source, query);
  expect(estimate.modest).toBe(true);
  const result = await runner.execute("r1");
  // All 768 cells are selected; only base cell 4's 48 are stored.
  expect(result.region!.totalCells).toBe("768");
  expect(result.region!.footprintCoverage).toBeCloseTo(48 / 768, 12);
  const expected =
    Array.from({ length: 48 }, (_, at) => 10 + ((4 * 64 + at) % 97)).reduce(
      (a, b) => a + b,
      0
    ) / 48;
  expect(result.values[0]).toBeCloseTo(expected, 10);
  expect(result.counters.chunkReads).toBe(result.counters.plannedChunks);
  expect(result.counters.storeRequests).toBeGreaterThan(0);
  expect(requests.length).toBeGreaterThan(before);

  // Cancelling a planned run means its execute is refused.
  await runner.plan("r2", source, { ...query, level: 0 });
  runner.cancel("r2");
  await expect(runner.execute("r2")).rejects.toThrow(
    /not planned or was cancelled/
  );
  await runner.release(source.key);
  expect(runner.memory().chunkCacheBytes).toBe(0);
});

// The centre of a stored cell (base cell 4 at order 3).
function storedPoint() {
  const grid = new healpixGeo.Grid({ scheme: "nested", level: 3 });
  const [lon, lat] = grid.healpixToLonLat(new BigUint64Array([4n * 64n + 10n]));
  return { kind: "point" as const, lat, lon };
}

it("pauses between parts and resumes", async () => {
  const runner = new AnalysisRunner();
  const source = {
    key: `${BASE}#2`,
    store: BASE,
    dataset: "",
    format: ZARR_FORMAT.V3,
  };
  const query: TAnalysisQuery = {
    version: 1,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    source: { ref: BASE, versionStatus: "best-effort" },
    variable: "0/temp",
    geometry: storedPoint(),
    fixed: {},
  };
  await runner.plan("p1", source, query);
  let settled = false;
  const partials: number[] = [];
  const running = runner
    .execute("p1", (partial) => {
      partials.push(partial.partial!.done);
      runner.pause("p1");
    })
    .then((result) => {
      settled = true;
      return result;
    });
  await new Promise((resolve) => setTimeout(resolve, 50));
  // time_counter has chunks of 2 over 3 steps: two parts. The empty frame
  // (0) comes first; the pause takes effect after the first part (1).
  expect(partials).toEqual([0, 1]);
  expect(settled).toBe(false);
  runner.resume("p1");
  const result = await running;
  expect(result.partial).toBeUndefined();
  expect(result.values).toHaveLength(3);
});

it("cancelling a cold plan stops context creation from issuing more reads", async () => {
  const runner = new AnalysisRunner();
  // Distinct hosts: no shared HTTP cache between the two creations.
  const coldStore = "https://cold.example.test/pyramid.zarr";
  const fullStore = "https://full.example.test/pyramid.zarr";
  const source = {
    key: `${coldStore}#cold`,
    store: coldStore,
    dataset: "",
    format: ZARR_FORMAT.V3,
  };
  const query: TAnalysisQuery = {
    version: 1,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    source: { ref: BASE, versionStatus: "best-effort" },
    variable: "0/temp",
    geometry: storedPoint(),
    fixed: {},
    level: 0,
  };
  // A full cold creation, for comparison.
  const full = requests.length;
  await runner.describe(
    { ...source, key: `${fullStore}#full`, store: fullStore },
    "0/temp"
  );
  const fullRequests = requests.length - full;
  // The cold host answers slowly, so creation is mid-way when cancelled.
  const fast = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: Request | string) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return fast(input as never);
  });
  const before = requests.length;
  const planning = runner.plan("cold", source, query);
  planning.catch(() => undefined);
  while (requests.length === before) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  runner.cancel("cold");
  await expect(planning).rejects.toMatchObject({ name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Creation stopped: far fewer requests than a full creation.
  expect(requests.length - before).toBeLessThan(fullRequests / 2);
  vi.stubGlobal("fetch", fast);
  // A later request creates the context afresh and succeeds.
  await expect(runner.describe(source, "0/temp")).resolves.toMatchObject({
    order: 3,
  });
});

it("releasing a source stops its description's remaining coordinate reads", async () => {
  const runner = new AnalysisRunner();
  const store = "https://describe.example.test/pyramid.zarr";
  const fullStore = "https://describe-full.example.test/pyramid.zarr";
  const source = {
    key: `${store}#d`,
    store,
    dataset: "",
    format: ZARR_FORMAT.V3,
  };
  const full = requests.length;
  await runner.describe(
    { ...source, key: `${fullStore}#d`, store: fullStore },
    "0/temp"
  );
  const fullRequests = requests.length - full;
  const fast = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: Request | string) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return fast(input as never);
  });
  const before = requests.length;
  const describing = runner.describe(source, "0/temp");
  describing.catch(() => undefined);
  while (requests.length === before) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  await runner.release(source.key);
  await expect(describing).rejects.toMatchObject({ name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(requests.length - before).toBeLessThan(fullRequests / 2);
  vi.stubGlobal("fetch", fast);
});

it("releasing a source mid-overview stops the remaining overview opens (v8 review)", async () => {
  const runner = new AnalysisRunner();
  const store = "https://overview.example.test/pyramid.zarr";
  const source = {
    key: `${store}#o`,
    store,
    dataset: "",
    format: ZARR_FORMAT.V3,
  };
  const fast = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: Request | string) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return fast(input as never);
  });
  const before = requests.length;
  const overviewRequests = () =>
    requests.slice(before).filter((path) => path.startsWith("/1/"));
  const describing = runner.describe(source, "0/temp");
  describing.catch(() => undefined);
  while (overviewRequests().length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const atRelease = overviewRequests().length;
  await runner.release(source.key);
  await expect(describing).rejects.toMatchObject({ name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  // Only the open already in flight may land.
  expect(overviewRequests().length - atRelease).toBeLessThanOrEqual(1);
  vi.stubGlobal("fetch", fast);
});

it("closing the only waiting window stops its description (v9 review)", async () => {
  const runner = new AnalysisRunner();
  const store = "https://closing.example.test/pyramid.zarr";
  const source = {
    key: `${store}#c`,
    store,
    dataset: "",
    format: ZARR_FORMAT.V3,
  };
  const fast = globalThis.fetch;
  vi.stubGlobal("fetch", async (input: Request | string) => {
    await new Promise((resolve) => setTimeout(resolve, 5));
    return fast(input as never);
  });
  const before = requests.length;
  const overviewRequests = () =>
    requests.slice(before).filter((path) => path.startsWith("/1/"));
  const controller = new AbortController();
  const describing = runner.describe(source, "0/temp", controller.signal);
  describing.catch(() => undefined);
  while (overviewRequests().length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const atClose = overviewRequests().length;
  controller.abort(new DOMException("closed", "AbortError"));
  await expect(describing).rejects.toMatchObject({ name: "AbortError" });
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(overviewRequests().length - atClose).toBeLessThanOrEqual(1);
  vi.stubGlobal("fetch", fast);
});
