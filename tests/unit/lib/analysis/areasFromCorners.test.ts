/* eslint-disable max-lines-per-function -- one store and one check per case. */
/* eslint-disable camelcase -- CF metadata uses snake_case keys. */
// AWI-CM-1-1-MR (FESOM) ocean: 830,305 cells with 16 corner slots, the bounds
// stored as one float64 chunk each. The outlines (about 561 MiB to hold) are
// over the 512 MiB plots use, and the store publishes no cell areas: area means
// were refused ("Needs cell areas"). The corners now stream through once for
// the areas alone.
import { describe, expect, it, vi } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import { ANALYSIS_KINDS, MAX_WORKING_BYTES } from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;

async function write(
  store: TStore,
  path: string,
  data: Float64Array,
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
    shape.slice(d + 1).reduce((product, n) => product * n, 1)
  );
  await zarr.set(array as never, null, { data, shape, stride } as never);
}

// A regular 0.25° × (360/1153)° layout as unstructured cells: 830,160
// cells, each with 4 real corners and 12 padding slots repeating the last
// (as FESOM pads), in AWI's order (cells along one dimension).
const NX = 1153;
const NY = 720;
const DLAT = 180 / NY;
const DLON = 360 / NX;
const CORNERS = 16;

async function awiLike(withoutCorners?: number) {
  const count = NX * NY;
  const lat = new Float64Array(count);
  const lon = new Float64Array(count);
  const latB = new Float64Array(count * CORNERS);
  const lonB = new Float64Array(count * CORNERS);
  const tos = new Float64Array(2 * count);
  for (let j = 0; j < NY; j++) {
    for (let i = 0; i < NX; i++) {
      const cell = j * NX + i;
      const south = -90 + j * DLAT;
      const west = -180 + i * DLON;
      lat[cell] = south + DLAT / 2;
      lon[cell] = west + DLON / 2;
      const ring = [
        [south, west],
        [south, west + DLON],
        [south + DLAT, west + DLON],
        [south + DLAT, west],
      ];
      for (let k = 0; k < CORNERS; k++) {
        const [la, lo] = ring[Math.min(k, 3)];
        latB[cell * CORNERS + k] = cell === withoutCorners ? Number.NaN : la;
        lonB[cell * CORNERS + k] = lo;
      }
      // The value is the cell's latitude (time 0) and twice it (time 1).
      tos[cell] = lat[cell];
      tos[count + cell] = 2 * lat[cell];
    }
  }
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "time", Float64Array.from([0, 1]), [2], ["time"], {
    units: "days since 1850-01-01",
  });
  const coordinate = (name: string, units: string) => ({
    standard_name: name,
    units,
    bounds: `${name === "latitude" ? "lat" : "lon"}_bnds`,
  });
  await write(store, "lat", lat, [count], ["ncells"], {
    ...coordinate("latitude", "degrees_north"),
  });
  await write(store, "lon", lon, [count], ["ncells"], {
    ...coordinate("longitude", "degrees_east"),
  });
  await write(
    store,
    "lat_bnds",
    latB,
    [count, CORNERS],
    ["ncells", "vertices"]
  );
  await write(
    store,
    "lon_bnds",
    lonB,
    [count, CORNERS],
    ["ncells", "vertices"]
  );
  await write(store, "tos", tos, [2, count], ["time", "ncells"], {
    coordinates: "lat lon",
    units: "degC",
  });
  return store;
}

describe("area means on a grid whose outlines are too large to hold", () => {
  it("weighs cells by areas read from their corners, keeping no outline", async () => {
    const store = await awiLike();
    const dataset = zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `awi-${Math.random()}`
    );
    const context = await resolveVariableContext(
      dataset,
      "tos",
      new ByteLru<BigInt64Array>(2 ** 20)
    );
    const area = context.capabilities[ANALYSIS_KINDS.REGION_SERIES];
    expect(area.available, area.reason).toBe(true);
    // Distributions over an area take the same weights.
    const spread = context.capabilities[ANALYSIS_KINDS.DISTRIBUTION];
    expect(spread.available, spread.reason).toBe(true);
    const grid = context.grid as {
      weighting?: string;
      method: string;
      geometryBytes: number;
      cornerAreas?: { bytes: number };
      label: string;
    };
    // Outlines not kept: cells located by centre, areas from corners,
    // the peak under the plots' limit.
    expect(grid.weighting).toMatch(/from the cell corners.*not kept/);
    expect(grid.method).toMatch(/nearest cell centre.*outlines would need/);
    expect(grid.label).toMatch(/areas from corners/);
    // Locating needs the centres only (about 57 MiB); the corner pass for area
    // plots peaks at about 507 MiB, both longitude buffers counted, under the
    // 512 MiB limit.
    expect(Math.round(grid.geometryBytes / 2 ** 20)).toBe(57);
    expect(Math.round(grid.cornerAreas!.bytes / 2 ** 20)).toBe(507);
    expect(grid.cornerAreas!.bytes).toBeLessThanOrEqual(MAX_WORKING_BYTES);

    // A box from 10° to 20° N, 0° to 30° E: cells whose centres are in.
    const box = { south: 10, north: 20, west: 0, east: 30 };
    const boxQuery = {
      version: 1 as const,
      kind: ANALYSIS_KINDS.REGION_SERIES,
      source: { ref: "memory", versionStatus: "session" as const },
      variable: "tos",
      fixed: {},
      geometry: { kind: "box", ...box },
      time: { start: 0, stop: 2 },
    } as never;
    // Asked first: the two corner chunks decode about 203 MiB (and the centres
    // 13 MiB stored); the pass holds
    // up to about 507 MiB.
    const asked = await planAnalysis(context, boxQuery, new ReadContext());
    expect(asked.estimate.needsConfirmation).toBe(true);
    expect(Math.round(asked.estimate.decodedBytes / 2 ** 20)).toBe(215);
    expect(Math.round(asked.estimate.workingBytes / 2 ** 20)).toBe(507);
    expect(asked.estimate.notes.join(" ")).toMatch(
      /decoding about 203 MiB, and about 13 MiB of stored coordinates, up to about 507 MiB in memory/
    );
    const planned = await planAnalysis(
      context,
      {
        version: 1 as const,
        kind: ANALYSIS_KINDS.REGION_SERIES,
        source: { ref: "memory", versionStatus: "session" as const },
        variable: "tos",
        fixed: {},
        geometry: { kind: "box", ...box },
        time: { start: 0, stop: 2 },
      } as never,
      new ReadContext(),
      undefined,
      true
    );
    const result = await planned.execute();
    // Expected: each row's latitude weighted by its exact band area,
    // sin(north) − sin(south) (all cells of a row have the same width).
    let sum = 0;
    let weight = 0;
    for (let j = 0; j < NY; j++) {
      const south = -90 + j * DLAT;
      const centre = south + DLAT / 2;
      if (centre < box.south || centre > box.north) {
        continue;
      }
      const columns = Array.from(
        { length: NX },
        (_, i) => -180 + (i + 0.5) * DLON
      ).filter((lon) => lon >= box.west && lon <= box.east).length;
      const band =
        Math.sin(((south + DLAT) * Math.PI) / 180) -
        Math.sin((south * Math.PI) / 180);
      sum += columns * band * centre;
      weight += columns * band;
    }
    const expected = sum / weight;
    expect(result.values[0]).toBeCloseTo(expected, 5);
    expect(result.values[1]).toBeCloseTo(2 * expected, 5);
    // Not the plain mean of the latitudes (an unweighted mean differs).
    expect(Math.abs(result.values[0] - 15)).toBeGreaterThan(1e-4);
  }, 240_000);
});

describe("point series on a grid whose outlines are too large to hold", () => {
  it("reads a nearest-centre series without fetching cell-area bounds", async () => {
    const store = await awiLike();
    const reads = vi.spyOn(store, "get");
    const dataset = zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `awi-point-${Math.random()}`
    );
    const context = await resolveVariableContext(
      dataset,
      "tos",
      new ByteLru<BigInt64Array>(2 ** 20)
    );
    const planned = await planAnalysis(
      context,
      {
        version: 1,
        kind: ANALYSIS_KINDS.POINT_SERIES,
        source: { ref: "memory", versionStatus: "session" },
        variable: "tos",
        fixed: {},
        geometry: { kind: "point", lat: 10.125, lon: 0.1 },
        time: { start: 0, stop: 2 },
      },
      new ReadContext(),
      undefined,
      true
    );
    const result = await planned.execute();
    expect(result.values).toEqual([10.125, 20.25]);
    // Opening bounds metadata is fine. Neither bounds payload is needed to
    // locate a cell by its centre or to extract values at that cell.
    const boundsChunkReads = reads.mock.calls
      .map(([key]) => key)
      .filter((key) => /\/(lat|lon)_bnds\/c\//.test(key));
    expect(boundsChunkReads).toEqual([]);
  }, 240_000);
});

describe("a cell whose corners are missing (review of interim26)", () => {
  it("keeps its own series at its centre, and area means name it", async () => {
    // Centre 415,656: 0.125° N, about 0° E.
    const cell = 360 * NX + 576;
    const store = await awiLike(cell);
    const dataset = zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `awi-hole-${Math.random()}`
    );
    const context = await resolveVariableContext(
      dataset,
      "tos",
      new ByteLru<BigInt64Array>(2 ** 20)
    );
    const query = (geometry: object, kind: string) =>
      ({
        version: 1 as const,
        kind,
        source: { ref: "memory", versionStatus: "session" as const },
        variable: "tos",
        fixed: {},
        geometry,
        time: { start: 0, stop: 2 },
      }) as never;
    const lat = -90 + 360 * DLAT + DLAT / 2;
    const lon = -180 + 576 * DLON + DLON / 2;
    const point = await planAnalysis(
      context,
      query({ kind: "point", lat, lon }, ANALYSIS_KINDS.POINT_SERIES),
      new ReadContext(),
      undefined,
      true
    );
    // Its own values (latitude, twice it), not its neighbour's.
    expect(Array.from((await point.execute()).values)).toEqual([lat, 2 * lat]);
    const area = await planAnalysis(
      context,
      query(
        { kind: "box", south: -1, north: 1, west: -1, east: 1 },
        ANALYSIS_KINDS.REGION_SERIES
      ),
      new ReadContext(),
      undefined,
      true
    );
    const result = await area.execute();
    expect(Number.isFinite(result.values[0])).toBe(true);
    expect(JSON.stringify(result)).toMatch(
      /1 cell inside without an area from its corners left out/
    );
    expect(result.region?.unweighedCells).toBe(1);
    const region = result.region!;
    expect(region.footprintCoverage).toBeLessThan(1);
    expect(region.footprintCoverage).toBeCloseTo(
      (region.storedCells - 1) / Number(region.totalCells),
      12
    );
  }, 240_000);
});

it("cancelling one area plot keeps another plot's shared corner read alive", async () => {
  const store = await awiLike();
  let notifyRead!: () => void;
  const started = new Promise<void>((resolve) => {
    notifyRead = resolve;
  });
  let finishRead!: () => void;
  const release = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  const counted = {
    async get(key: string) {
      if (key === "/lat_bnds/c/0/0") {
        notifyRead();
        await release;
      }
      return store.get(key);
    },
  };
  const dataset = zarrAnalysisDatasetFromStore(
    counted as never,
    "",
    ZARR_FORMAT.V3,
    `cancel-corners-${Math.random()}`
  );
  const context = await resolveVariableContext(
    dataset,
    "tos",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
  if (context.grid.kind !== "native" || !context.grid.cornerAreas) {
    throw new Error("Fixture needs deferred corner areas");
  }
  const cornerAreas = context.grid.cornerAreas;
  await context.grid.geometry();
  const stop = new AbortController();
  const first = cornerAreas.load(stop.signal);
  await started;
  // The second caller has its own lifetime and still needs these bytes.
  const second = cornerAreas.load(new AbortController().signal);
  const outcomes = Promise.allSettled([first, second]);
  stop.abort(new DOMException("First plot closed", "AbortError"));
  finishRead();
  const [cancelled, continuing] = await outcomes;
  expect(cancelled.status).toBe("rejected");
  expect(continuing.status).toBe("fulfilled");
  if (continuing.status === "fulfilled") {
    expect(continuing.value[360 * NX + 576]).toBeGreaterThan(0);
  }
}, 240_000);

it("offers the estimate before decoding oversized corner payloads for a country", async () => {
  const store = await awiLike();
  const reads = vi.spyOn(store, "get");
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `area-cost-${Math.random()}`
  );
  const context = await resolveVariableContext(
    dataset,
    "tos",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
  const p = await planAnalysis(
    context,
    {
      version: 1,
      kind: ANALYSIS_KINDS.REGION_SERIES,
      source: { ref: "memory", versionStatus: "session" },
      variable: "tos",
      fixed: {},
      geometry: { kind: "country", id: "276", resolution: "50m" },
      time: { start: 0, stop: 1 },
    },
    new ReadContext()
  );
  const fetched = reads.mock.calls
    .map(([key]) => key)
    .filter((key) => /\/(lat|lon)_bnds\/c\//.test(key));
  expect(fetched).toEqual([]);
  expect(p.estimate.modest).toBe(false);
}, 240_000);

it("prices corner reads by each array's own chunks (review of interim37)", async () => {
  const store = await awiLike();
  const count = NX * NY;
  const rows = Math.ceil(count / 8);
  // Latitude corners in eight chunks, longitude corners in one.
  const key = "/lat_bnds/zarr.json";
  const meta = JSON.parse(new TextDecoder().decode(store.get(key)));
  meta.chunk_grid.configuration.chunk_shape = [rows, CORNERS];
  store.set(key, new TextEncoder().encode(JSON.stringify(meta)));
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `awi-chunks-${Math.random()}`
  );
  const context = await resolveVariableContext(
    dataset,
    "tos",
    new ByteLru<BigInt64Array>(2 ** 20)
  );
  const corners = (
    context.grid as {
      cornerAreas?: { readsNow(): number; decodedNow(): number };
    }
  ).cornerAreas!;
  expect(corners.readsNow()).toBe(9);
  const expected = count * CORNERS * 8 + 8 * rows * CORNERS * 8;
  expect(corners.decodedNow()).toBe(expected);
});
