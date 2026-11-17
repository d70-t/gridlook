/* eslint-disable max-lines-per-function -- one reproducer per finding. */
/* eslint-disable camelcase -- CF and Zarr metadata use snake_case keys. */
import { describe, expect, it, vi } from "vitest";
import * as zarr from "zarrita";

import { AnalysisRunner } from "@/lib/analysis/analysisRunner.ts";
import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { SphereIndex } from "@/lib/analysis/nativeGrid.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { exportModel } from "@/lib/analysis/scientificExport.ts";
import {
  composeDatasets,
  zarrAnalysisDatasetFromStore,
} from "@/lib/analysis/sourceAdapter.ts";
import {
  ANALYSIS_KINDS,
  type TAnalysisKind,
  type TGeometry,
} from "@/lib/analysis/types.ts";
import {
  buildValueCodec,
  decodeStoredBigInt,
} from "@/lib/analysis/valueDecoding.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;

async function write(
  store: TStore,
  path: string,
  data: number[],
  shape: number[],
  dims: string[],
  attrs: Record<string, unknown> = {},
  chunkShape = shape
) {
  const array = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape,
    dtype: "float64",
    dimensionNames: dims,
    attributes: attrs,
    fillValue: Number.NaN as never,
  });
  if (!shape.length) {
    await zarr.set(array as never, null, data[0] as never);
    return;
  }
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((product, n) => product * n, 1)
  );
  await zarr.set(array as never, null, {
    data: Float64Array.from(data),
    shape,
    stride,
  } as never);
}

async function newStore(...groups: string[]) {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  for (const group of groups) {
    await zarr.create(zarr.root(store).resolve(group), { attributes: {} });
  }
  return store;
}

function open(
  store: TStore,
  variable: string,
  dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `v15-${Math.random()}`
  )
) {
  return resolveVariableContext(
    dataset,
    variable,
    new ByteLru<BigInt64Array>(2 ** 20)
  );
}

function query(
  kind: TAnalysisKind,
  variable: string,
  geometry: TGeometry,
  extra: Record<string, unknown> = {}
) {
  return {
    version: 1 as const,
    kind,
    source: { ref: "memory", versionStatus: "session" as const },
    variable,
    fixed: {},
    geometry,
    ...extra,
  };
}

const POINT = { kind: "point", lat: 0, lon: 0 } as const;

function datasetOf(store: TStore, label: string) {
  return zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `${label}-${Math.random()}`
  );
}

async function grid(store: TStore) {
  await write(store, "lat", [0], [1], ["lat"], { units: "degrees_north" });
  await write(store, "lon", [0], [1], ["lon"], { units: "degrees_east" });
}

describe("v15 review: references bind to the store that declares them", () => {
  it("time bounds come from the time sidecar, not a same-named data array", async () => {
    const data = await newStore();
    await grid(data);
    await write(data, "u", [5, 6], [2, 1, 1], ["time", "lat", "lon"]);
    // Unrelated, same name, another first dimension.
    await write(data, "tb", [100, 110, 110, 120], [2, 2], ["other", "nv"]);
    const times = await newStore();
    await write(times, "time", [12, 36], [2], ["time"], {
      units: "hours since 2000-01-01",
      standard_name: "time",
      bounds: "tb",
    });
    await write(times, "tb", [0, 24, 24, 48], [2, 2], ["time", "nv"]);
    const dataset = composeDatasets(datasetOf(data, "data"), [
      datasetOf(times, "time"),
    ]);
    const context = await open(data, "u", dataset);
    const planned = await planAnalysis(
      context,
      query(ANALYSIS_KINDS.POINT_SERIES, "u", POINT, {
        time: { start: 0, stop: 2 },
      }),
      new ReadContext()
    );
    const result = await planned.execute();
    expect(result.values).toEqual([5, 6]);
    expect(result.time!.bounds).toEqual([0, 24, 24, 48]);
  });

  it("site footprints come from the grid sidecar; requests of both stores count", async () => {
    const data = await newStore();
    await write(data, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(data, "temp", [41, 42, 43], [1, 3], ["time", "site"], {
      coordinates: "lat lon",
    });
    // An unrelated ±5° footprint of the same names in the data store.
    const wide = [0, 10, 20].flatMap((c) => [c - 5, c + 5, c + 5, c - 5]);
    const tall = [0, 0, 0].flatMap((c) => [c - 5, c - 5, c + 5, c + 5]);
    await write(data, "lon_bnds", wide, [3, 4], ["site", "nv"]);
    await write(data, "lat_bnds", tall, [3, 4], ["site", "nv"]);
    const cells = await newStore();
    await write(cells, "lat", [0, 0, 0], [3], ["site"], {
      units: "degrees_north",
      standard_name: "latitude",
      bounds: "lat_bnds",
    });
    await write(cells, "lon", [0, 10, 20], [3], ["site"], {
      units: "degrees_east",
      standard_name: "longitude",
      bounds: "lon_bnds",
    });
    const narrow = [0, 10, 20].flatMap((c) => [
      c - 0.5,
      c + 0.5,
      c + 0.5,
      c - 0.5,
    ]);
    const short = [0, 0, 0].flatMap((c) => [
      c - 0.5,
      c - 0.5,
      c + 0.5,
      c + 0.5,
    ]);
    await write(cells, "lon_bnds", narrow, [3, 4], ["site", "nv"]);
    await write(cells, "lat_bnds", short, [3, 4], ["site", "nv"]);
    const primary = datasetOf(data, "data");
    const sidecar = datasetOf(cells, "grid");
    const dataset = composeDatasets(primary, [sidecar]);
    const context = await open(data, "temp", dataset);
    const series = async (lon: number) =>
      (
        await (
          await planAnalysis(
            context,
            query(
              ANALYSIS_KINDS.POINT_SERIES,
              "temp",
              { kind: "point", lat: 0, lon },
              { time: { start: 0, stop: 1 } }
            ),
            new ReadContext()
          )
        ).execute()
      ).values[0];
    expect(await series(0.2)).toBe(41);
    // 4° E is outside site 0's true ±0.5° cell.
    expect(await series(4)).toBeNaN();
    expect(dataset.stats.requests).toBe(
      primary.stats.requests + sidecar.stats.requests
    );
    expect(sidecar.stats.requests).toBeGreaterThan(0);
  });
});

describe("v15 review: live publication through the runner", () => {
  it("re-reads gaps, half-written chunks and reads in flight of a routed variable", async () => {
    const store = await newStore();
    await grid(store);
    await write(store, "time", [0, 1, 2, 3], [4], ["time"], {
      units: "days since 2000-01-01",
    });
    // Two steps per chunk. Step 1 is not written yet (fill) and chunk 1
    // (steps 2 and 3) does not exist.
    await write(
      store,
      "u",
      [1, NaN, 0, 0],
      [4, 1, 1],
      ["time", "lat", "lon"],
      {},
      [2, 1, 1]
    );
    const key = (c: number) =>
      [...store.keys()].find((k) => new RegExp(`u/c/${c}/`).test(k))!;
    const chunk1 = key(1);
    store.delete(chunk1);
    const half = store.get(key(0))!;
    // The published versions, to be written later.
    const later = await newStore();
    await write(
      later,
      "u",
      [1, 7, 71, 85],
      [4, 1, 1],
      ["time", "lat", "lon"],
      {},
      [2, 1, 1]
    );
    const full = [0, 1].map((c) =>
      later.get(
        [...later.keys()].find((k) => new RegExp(`u/c/${c}/`).test(k))!
      )!
    );
    expect(half).not.toEqual(full[0]);
    // Reads of chunk 1 can be held back to stay in flight.
    let hold: Promise<void> | undefined;
    const slow = {
      get: async (path: string) => {
        // The bytes as stored when the request reached the server.
        const value = store.get(path.replace(/^\//, "")) ?? store.get(path);
        if (hold && path.includes("u/c/1/")) {
          await hold;
        }
        return value;
      },
      has: (path: string) => store.has(path),
    };
    const runner = new AnalysisRunner();
    const base = "live#1";
    const source = {
      key: `${base}|mem|`,
      store: "memory",
      dataset: "",
      format: ZARR_FORMAT.V3,
    };
    (runner as unknown as { datasets: Map<string, unknown> }).datasets.set(
      source.key,
      Promise.resolve(
        zarrAnalysisDatasetFromStore(slow as never, "", ZARR_FORMAT.V3, base)
      )
    );
    let run = 0;
    const series = async () => {
      const id = `r${++run}`;
      await runner.plan(
        id,
        source as never,
        query(ANALYSIS_KINDS.POINT_SERIES, "u", POINT, {
          time: { start: 0, stop: 4 },
        })
      );
      return runner.execute(id);
    };
    expect((await series()).values).toEqual([1, NaN, NaN, NaN]);
    // Published: step 1 written into the existing chunk, chunk 1 created.
    store.set(key(0), full[0]);
    store.set(chunk1, full[1]);
    await runner.forgetPublished(base, 1, 3);
    expect((await series()).values).toEqual([1, 7, 71, 85]);
    // A read in flight across a publication: started on the old chunk 1,
    // which is then replaced; a reader after the publication reads afresh.
    let release!: () => void;
    hold = new Promise((resolve) => (release = resolve));
    store.delete(chunk1);
    await runner.forgetPublished(base, 2, 3);
    const before = series();
    await new Promise((resolve) => setTimeout(resolve, 20));
    store.set(chunk1, full[1]);
    await runner.forgetPublished(base, 2, 3);
    const after = series();
    await new Promise((resolve) => setTimeout(resolve, 20));
    hold = undefined;
    release();
    expect((await before).values.slice(2)).toEqual([NaN, NaN]);
    expect((await after).values).toEqual([1, 7, 71, 85]);
  });
});

describe("v15 review: the published physical vertical coordinate", () => {
  /** Two columns (lon 0 and 10) on two levels, one time. */
  async function columns(
    store: TStore,
    level: string,
    position: { name: string; values: number[]; attrs: Record<string, unknown> }
  ) {
    await write(store, "lat", [0], [1], ["lat"], { units: "degrees_north" });
    await write(store, "lon", [0, 10], [2], ["lon"], { units: "degrees_east" });
    await write(store, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(
      store,
      position.name,
      position.values,
      [2, 1, 2],
      [level, "lat", "lon"],
      position.attrs
    );
    await write(
      store,
      "ta",
      [10, 11, 14, 15],
      [1, 2, 1, 2],
      ["time", level, "lat", "lon"],
      { coordinates: position.name }
    );
  }

  async function profile(store: TStore, lon: number) {
    const context = await open(store, "ta");
    const planned = await planAnalysis(
      context,
      query(
        ANALYSIS_KINDS.PROFILE,
        "ta",
        { kind: "point", lat: 0, lon },
        { time: { start: 0, stop: 1 } }
      ),
      new ReadContext()
    );
    return planned.execute();
  }

  it("a model_level_number axis takes the field's pressure(lev, lat, lon)", async () => {
    const store = await newStore();
    await write(store, "lev", [1, 2], [2], ["lev"], {
      standard_name: "model_level_number",
      axis: "Z",
    });
    await columns(store, "lev", {
      name: "pressure",
      values: [850, 849, 500, 499],
      attrs: { units: "hPa", standard_name: "air_pressure" },
    });
    const [a, b] = [await profile(store, 0), await profile(store, 10)];
    expect([...a.values, ...b.values]).toEqual([10, 14, 11, 15]);
    expect([...a.vertical!.values, ...b.vertical!.values]).toEqual([
      85000, 50000, 84900, 49900,
    ]);
    expect(a.vertical!.positive).toBe("down");
  });

  it("positive DOWN in any case is down, in the result and the export", async () => {
    for (const positive of ["DOWN", "down"]) {
      const store = await newStore();
      await columns(store, "k", {
        name: "depth_m",
        values: [1, 2, 101, 102],
        attrs: { units: "m", standard_name: "depth", positive },
      });
      const [a, b] = [await profile(store, 0), await profile(store, 10)];
      expect([...a.vertical!.values, ...b.vertical!.values]).toEqual([
        1, 101, 2, 102,
      ]);
      expect(a.vertical!.positive).toBe("down");
      const written = exportModel(a).arrays.filter(
        (array) => array.attrs.positive !== undefined
      );
      expect(written.length).toBeGreaterThan(0);
      expect(written.every((array) => array.attrs.positive === "down")).toBe(
        true
      );
    }
  });
});

describe("v15 review: scientific files", () => {
  it("keeps layer bounds when a field is called depth_bnds", async () => {
    const store = await newStore();
    await grid(store);
    await write(store, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(store, "depth", [5, 50], [2], ["depth"], {
      units: "m",
      standard_name: "depth",
      positive: "down",
      bounds: "thickness_edges",
    });
    await write(
      store,
      "thickness_edges",
      [0, 10, 10, 90],
      [2, 2],
      ["depth", "nv"]
    );
    await write(
      store,
      "depth_bnds",
      [1, 2],
      [1, 2, 1, 1],
      ["time", "depth", "lat", "lon"]
    );
    const context = await open(store, "depth_bnds");
    const result = await (
      await planAnalysis(
        context,
        query(ANALYSIS_KINDS.PROFILE, "depth_bnds", POINT, {
          time: { start: 0, stop: 1 },
        }),
        new ReadContext()
      )
    ).execute();
    const { arrays } = exportModel(result);
    const axis = arrays.find((a) => a.attrs.axis === "Z")!;
    const bounds = arrays.find((a) => a.name === axis.attrs.bounds);
    expect(Array.from((bounds?.data ?? []) as ArrayLike<number>)).toEqual([
      0, 10, 10, 90,
    ]);
    expect(
      Array.from(
        arrays.find((a) => a.name === "depth_bnds")!.data as ArrayLike<number>
      )
    ).toEqual([1, 2]);
  });

  it("writes a finite bin centre for a constant field near 1e308", async () => {
    const store = await newStore();
    await write(store, "lat", [0, 1], [2], ["lat"], {
      units: "degrees_north",
      bounds: "lat_b",
    });
    await write(store, "lat_b", [-0.5, 0.5, 0.5, 1.5], [2, 2], ["lat", "nv"]);
    await write(store, "lon", [0], [1], ["lon"], {
      units: "degrees_east",
      bounds: "lon_b",
    });
    await write(store, "lon_b", [-0.5, 0.5], [1, 2], ["lon", "nv"]);
    await write(store, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(
      store,
      "q",
      [1.7e308, 1.7e308],
      [1, 2, 1],
      ["time", "lat", "lon"]
    );
    const context = await open(store, "q");
    const result = await (
      await planAnalysis(
        context,
        query(
          ANALYSIS_KINDS.DISTRIBUTION,
          "q",
          { kind: "box", west: -1, east: 1, south: -1, north: 2 },
          { time: { start: 0, stop: 1 }, valueBins: 4 }
        ),
        new ReadContext()
      )
    ).execute();
    const centres = exportModel(result).arrays.find(
      (a) => a.name === "value_bin"
    )!.data;
    expect(centres.length).toBeGreaterThan(0);
    expect(
      Array.from(centres as ArrayLike<number>).every((v) => Number.isFinite(v))
    ).toBe(true);
  });
});

describe("v15 review: a scalar cell measure", () => {
  async function field(store: TStore, curvilinear: boolean) {
    await write(store, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    const dims = curvilinear ? ["j", "i"] : ["site"];
    const shape = curvilinear ? [2, 2] : [4];
    await write(store, "lat", [0, 0, 1, 1], shape, dims, {
      units: "degrees_north",
      standard_name: "latitude",
    });
    await write(store, "lon", [0, 1, 0, 1], shape, dims, {
      units: "degrees_east",
      standard_name: "longitude",
    });
    await write(store, "cell_area", [100], [], [], { units: "m2" });
    await write(store, "q", [3, 9, 3, 9], [1, ...shape], ["time", ...dims], {
      coordinates: "lat lon",
      cell_measures: "area: cell_area",
    });
  }

  it("weights a curvilinear grid without corners equally (mean 6)", async () => {
    const store = await newStore();
    await field(store, true);
    const context = await open(store, "q");
    expect(context.capabilities[ANALYSIS_KINDS.REGION_SERIES].available).toBe(
      true
    );
    const result = await (
      await planAnalysis(
        context,
        query(
          ANALYSIS_KINDS.REGION_SERIES,
          "q",
          { kind: "box", west: -0.5, east: 1.5, south: -0.5, north: 1.5 },
          { time: { start: 0, stop: 1 } }
        ),
        new ReadContext(),
        undefined,
        true
      )
    ).execute();
    expect(result.values).toEqual([6]);
  });

  it("gives sites no area from one number", async () => {
    const store = await newStore();
    await field(store, false);
    const context = await open(store, "q");
    expect(context.capabilities[ANALYSIS_KINDS.DISTRIBUTION].reason).toMatch(
      /Sites have no implied area/
    );
  });
});

describe("v15 review: wide integers", () => {
  it("applies an exact integer offset before converting", () => {
    const codec = buildValueCodec(
      { add_offset: -(2 ** 53) },
      undefined,
      "int64",
      ZARR_FORMAT.V3
    );
    const raw = [2n ** 53n, 2n ** 53n + 1n, 2n ** 53n + 2n];
    expect(raw.map((v) => decodeStoredBigInt(codec, v))).toEqual([0, 1, 2]);
  });

  it("masks values outside disjoint valid ranges of an int64 with a fill", () => {
    const codec = buildValueCodec(
      {
        _FillValue: -9,
        valid_ranges: [
          [4, 6],
          [11, 13],
        ],
      },
      -9,
      "int64",
      ZARR_FORMAT.V3
    );
    const decoded = [-9n, 2n, 5n, 8n, 12n, 14n].map((v) =>
      decodeStoredBigInt(codec, v)
    );
    expect(decoded).toEqual([NaN, NaN, 5, NaN, 12, NaN]);
  });
});

describe("v15 review: shared coordinate reads", () => {
  /** Six variables over one 12-chunk time axis with bounds. */
  async function sixVariables() {
    const store = await newStore();
    await grid(store);
    const t = [...Array(12).keys()];
    await write(
      store,
      "time",
      t,
      [12],
      ["time"],
      {
        units: "days since 2000-01-01",
        bounds: "tb",
      },
      [1]
    );
    await write(
      store,
      "tb",
      t.flatMap((v) => [v, v + 1]),
      [12, 2],
      ["time", "nv"],
      {},
      [1, 2]
    );
    for (let v = 0; v < 6; v++) {
      await write(store, `v${v}`, t, [12, 1, 1], ["time", "lat", "lon"]);
    }
    const counts = { time: 0, tb: 0 };
    let gate: Promise<void> | undefined;
    const counted = {
      get: async (path: string) => {
        const key = path.replace(/^\//, "");
        const value = store.get(key) ?? store.get(path);
        if (/^time\/c\//.test(key)) {
          counts.time++;
          await gate;
        }
        if (/^tb\/c\//.test(key)) {
          counts.tb++;
        }
        return value;
      },
    };
    const runner = new AnalysisRunner();
    const source = {
      key: `six-${Math.random()}`,
      store: "memory",
      dataset: "",
      format: ZARR_FORMAT.V3,
    };
    (runner as unknown as { datasets: Map<string, unknown> }).datasets.set(
      source.key,
      Promise.resolve(
        zarrAnalysisDatasetFromStore(
          counted as never,
          "",
          ZARR_FORMAT.V3,
          source.key
        )
      )
    );
    return {
      counts,
      hold() {
        let release!: () => void;
        gate = new Promise((resolve) => (release = resolve));
        return () => {
          gate = undefined;
          release();
        };
      },
      describe: (v: number, signal: AbortSignal) =>
        runner.context(source as never, `v${v}`, signal),
    };
  }

  it("six descriptions read the axis and its bounds once", async () => {
    const six = await sixVariables();
    const controllers = [...Array(6)].map(() => new AbortController());
    const contexts = await Promise.all(
      controllers.map((c, v) => six.describe(v, c.signal))
    );
    expect(contexts.every((c) => c.time?.bounds?.length === 24)).toBe(true);
    expect(six.counts).toEqual({ time: 12, tb: 12 });
  });

  it("cancelling the first description leaves one read for the rest", async () => {
    const six = await sixVariables();
    const release = six.hold();
    const controllers = [...Array(6)].map(() => new AbortController());
    const pending = controllers.map((c, v) => six.describe(v, c.signal));
    await new Promise((resolve) => setTimeout(resolve, 20));
    controllers[0].abort(new DOMException("Closed", "AbortError"));
    release();
    await expect(pending[0]).rejects.toMatchObject({ name: "AbortError" });
    const rest = await Promise.all(pending.slice(1));
    expect(rest.every((c) => c.time?.raw.length === 12)).toBe(true);
    expect(six.counts).toEqual({ time: 12, tb: 12 });
  });

  it("closing all six stops the shared read", async () => {
    const six = await sixVariables();
    const release = six.hold();
    const controllers = [...Array(6)].map(() => new AbortController());
    const pending = controllers.map((c, v) =>
      six.describe(v, c.signal).catch((error: Error) => error)
    );
    await new Promise((resolve) => setTimeout(resolve, 20));
    const started = six.counts.time;
    controllers.forEach((c) =>
      c.abort(new DOMException("Closed", "AbortError"))
    );
    release();
    await Promise.all(pending);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(started).toBeGreaterThan(0);
    expect(six.counts.time).toBe(started);
    expect(six.counts.tb).toBe(0);
  });
});

describe("v15 review: a one-column band of a very wide grid", () => {
  it("plans and reads for the selected column, not the whole axis", async () => {
    const store = await newStore();
    const n = 1_000_000;
    const lon = Float64Array.from(
      { length: n },
      (_, j) => (j + 0.5) * (360 / n)
    );
    await write(store, "lat", [0], [1], ["lat"], {
      units: "degrees_north",
      bounds: "lat_b",
    });
    await write(store, "lat_b", [-1, 1], [1, 2], ["lat", "nv"]);
    await write(
      store,
      "lon",
      Array.from(lon),
      [n],
      ["lon"],
      {
        units: "degrees_east",
        bounds: "lon_b",
      },
      [n]
    );
    await write(
      store,
      "lon_b",
      Array.from(lon).flatMap((c) => [c - 180 / n, c + 180 / n]),
      [n, 2],
      ["lon", "nv"],
      {},
      [n, 2]
    );
    await write(store, "time", [0, 1], [2], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(
      store,
      "q",
      Array(2 * n).fill(2),
      [2, 1, n],
      ["time", "lat", "lon"],
      {},
      [1, 1, 1000]
    );
    const context = await open(store, "q");
    const column = lon[500_000];
    const planned = await planAnalysis(
      context,
      query(
        ANALYSIS_KINDS.HOVMOLLER_LON,
        "q",
        {
          kind: "box",
          west: column - 0.0001,
          east: column + 0.0001,
          south: -0.5,
          north: 0.5,
        },
        { time: { start: 0, stop: 2 } }
      ),
      new ReadContext()
    );
    expect(planned.estimate.workingBytes).toBeLessThan(2 ** 20);
    const result = await planned.execute();
    expect(result.values).toEqual([2, 2]);
  }, 60000);
});

describe("v15 review: native geometry work", () => {
  /** Two triangles; face, node and area-weighted face fields. */
  async function meshStore() {
    const store = await newStore();
    await write(store, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(
      store,
      "lat",
      [-0.5, -0.5, 0.5, -0.5, -0.5, 0.5],
      [6],
      ["node"],
      {
        standard_name: "latitude",
        units: "degrees_north",
      }
    );
    await write(store, "lon", [-0.5, 0.5, 0, 1.5, 2.5, 2], [6], ["node"], {
      standard_name: "longitude",
      units: "degrees_east",
    });
    await write(store, "nodes", [0, 1, 2, 3, 4, 5], [2, 3], ["face", "nv"], {
      cf_role: "face_node_connectivity",
      start_index: 0,
    });
    await write(store, "mesh", [0], [], [], {
      cf_role: "mesh_topology",
      topology_dimension: 2,
      node_coordinates: "lon lat",
      face_node_connectivity: "nodes",
      face_dimension: "face",
    });
    await write(store, "area", [1, 1], [2], ["face"], { units: "m2" });
    const at = { mesh: "mesh" };
    await write(store, "tf", [2, 9], [1, 2], ["time", "face"], {
      ...at,
      location: "face",
    });
    await write(store, "tn", [1, 2, 3, 4, 5, 6], [1, 6], ["time", "node"], {
      ...at,
      location: "node",
    });
    await write(store, "tw", [2, 9], [1, 2], ["time", "face"], {
      ...at,
      location: "face",
      cell_measures: "area: area",
    });
    return store;
  }

  it("three views of one mesh read its topology once", async () => {
    const store = await meshStore();
    const reads = new Map<string, number>();
    const counted = {
      get: async (path: string) => {
        const key = path.replace(/^\//, "");
        const name = key.split("/")[0];
        if (/\/c\//.test(key) || /\/c$/.test(key)) {
          reads.set(name, (reads.get(name) ?? 0) + 1);
        }
        return store.get(key) ?? store.get(path);
      },
    };
    const dataset = zarrAnalysisDatasetFromStore(
      counted as never,
      "",
      ZARR_FORMAT.V3,
      `mesh-${Math.random()}`
    );
    const results = await Promise.all(
      ["tf", "tn", "tw"].map(async (variable) => {
        const context = await open(store, variable, dataset);
        const planned = await planAnalysis(
          context,
          query(
            ANALYSIS_KINDS.POINT_SERIES,
            variable,
            {
              kind: "point",
              lat: -0.2,
              lon: 0,
            },
            { time: { start: 0, stop: 1 } }
          ),
          new ReadContext(),
          undefined,
          true
        );
        return (await planned.execute()).values[0];
      })
    );
    expect(results[0]).toBe(2);
    expect(results[2]).toBe(2);
    for (const name of ["lat", "lon", "nodes"]) {
      expect([name, reads.get(name)]).toEqual([name, 1]);
    }
  });

  it("a load whose last waiter left builds no spatial index", async () => {
    const store = await newStore();
    await write(store, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    const n = 50;
    const lats = Array.from({ length: n }, (_, k) => k - 25);
    await write(store, "lat", lats, [n], ["site"], {
      standard_name: "latitude",
      units: "degrees_north",
    });
    await write(
      store,
      "lon",
      lats.map(() => 10),
      [n],
      ["site"],
      {
        standard_name: "longitude",
        units: "degrees_east",
      }
    );
    await write(store, "q", lats, [1, n], ["time", "site"], {
      coordinates: "lat lon",
    });
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    const slow = {
      get: async (path: string) => {
        const key = path.replace(/^\//, "");
        const value = store.get(key) ?? store.get(path);
        if (/^lon\/c/.test(key)) {
          await gate;
        }
        return value;
      },
    };
    const dataset = zarrAnalysisDatasetFromStore(
      slow as never,
      "",
      ZARR_FORMAT.V3,
      `cancel-${Math.random()}`
    );
    const context = await open(store, "q", dataset);
    const build = vi.spyOn(
      SphereIndex.prototype as unknown as { build: () => void },
      "build"
    );
    const builds = build.mock.calls.length;
    const controller = new AbortController();
    const planning = planAnalysis(
      context,
      query(
        ANALYSIS_KINDS.POINT_SERIES,
        "q",
        { kind: "point", lat: 0, lon: 10 },
        {
          time: { start: 0, stop: 1 },
        }
      ),
      new ReadContext(),
      controller.signal,
      true
    ).catch((error: Error) => error);
    await new Promise((resolve) => setTimeout(resolve, 20));
    controller.abort(new DOMException("Closed", "AbortError"));
    release();
    expect(await planning).toMatchObject({ name: "AbortError" });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(build.mock.calls.length).toBe(builds);
    build.mockRestore();
  });
});

describe("cell outlines too large to load (AWI-CM-1-1-MR)", () => {
  it("locates cells by their nearest centre and says why areas are off", async () => {
    const store = await newStore();
    await write(store, "time", [0, 1], [2], ["time"], {
      units: "days since 1850-01-01",
    });
    await write(store, "lat", [0, 0, 0], [3], ["ncells"], {
      standard_name: "latitude",
      units: "degrees_north",
      bounds: "lat_bnds",
    });
    await write(store, "lon", [0, 1, 2], [3], ["ncells"], {
      standard_name: "longitude",
      units: "degrees_east",
      bounds: "lon_bnds",
    });
    // Declared as one huge chunk, never written (and never read here).
    for (const name of ["lat_bnds", "lon_bnds"]) {
      await zarr.create(zarr.root(store).resolve(name), {
        shape: [3, 16],
        chunkShape: [2 ** 22, 16],
        dtype: "float64",
        dimensionNames: ["ncells", "nvertices"],
        fillValue: Number.NaN as never,
      });
    }
    await write(store, "tos", [1, 2, 3, 4, 5, 6], [2, 3], ["time", "ncells"], {
      coordinates: "lat lon",
    });
    const context = await open(store, "tos");
    const reason = context.capabilities[ANALYSIS_KINDS.REGION_SERIES].reason;
    expect(reason).toMatch(/Area means need the cell outlines.*MiB/);
    const planned = await planAnalysis(
      context,
      query(
        ANALYSIS_KINDS.POINT_SERIES,
        "tos",
        { kind: "point", lat: 0.1, lon: 1.1 },
        { time: { start: 0, stop: 2 } }
      ),
      new ReadContext(),
      undefined,
      true
    );
    const result = await planned.execute();
    expect(result.values).toEqual([2, 5]);
    await write(store, "cellarea", [1], [], [], { units: "m2" });
    await write(store, "sst", [1, 2, 3, 4, 5, 6], [2, 3], ["time", "ncells"], {
      coordinates: "lat lon",
      cell_measures: "area: cellarea",
    });
    const measured = await open(store, "sst");
    expect(measured.capabilities[ANALYSIS_KINDS.REGION_SERIES].available).toBe(
      true
    );
  });
});

describe("v20 review: the vertical coordinate lies along the level", () => {
  it("takes actual_pressure(layer), not an unrelated layer(other)", async () => {
    const store = await newStore();
    await grid(store);
    await write(store, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(store, "actual_pressure", [1000, 750, 500], [3], ["layer"], {
      units: "hPa",
      standard_name: "air_pressure",
    });
    // Named like the level dimension, on another dimension and length.
    await write(store, "layer", [60, 61], [2], ["other"], { units: "hPa" });
    await write(
      store,
      "t",
      [280, 270, 260],
      [1, 3, 1, 1],
      ["time", "layer", "lat", "lon"],
      {
        coordinates: "actual_pressure",
      }
    );
    const context = await open(store, "t");
    const result = await (
      await planAnalysis(
        context,
        query(ANALYSIS_KINDS.PROFILE, "t", POINT, { fixed: { time: 0 } }),
        new ReadContext()
      )
    ).execute();
    expect(result.values).toEqual([280, 270, 260]);
    const levels = result.vertical?.values ?? [];
    expect(levels).toHaveLength(3);
    expect(
      levels.map((v) => (result.vertical?.units === "Pa" ? v / 100 : v))
    ).toEqual([1000, 750, 500]);
  });
});

describe("reviews of interim26: a publication renews formula terms", () => {
  it("a hybrid profile follows republished surface pressure", async () => {
    const store = await newStore();
    await grid(store);
    await write(store, "time", [0, 1], [2], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(store, "lev", [0.5, 1], [2], ["lev"], {
      standard_name: "atmosphere_hybrid_sigma_pressure_coordinate",
      formula_terms: "ap: ap b: b ps: ps",
      positive: "down",
    });
    await write(store, "ap", [0, 0], [2], ["lev"], { units: "Pa" });
    await write(store, "b", [0.1, 1], [2], ["lev"], { units: "1" });
    await write(
      store,
      "ps",
      [90000, 90000],
      [2, 1, 1],
      ["time", "lat", "lon"],
      {
        units: "Pa",
      },
      [1, 1, 1]
    );
    await write(
      store,
      "ta",
      [8, 9, 8, 9],
      [2, 2, 1, 1],
      ["time", "lev", "lat", "lon"],
      {
        coordinates: "lev",
      },
      [1, 2, 1, 1]
    );
    const runner = new AnalysisRunner();
    const base = `live-ps-${Math.random()}`;
    const source = {
      key: `${base}|mem|`,
      store: "memory",
      dataset: "",
      format: ZARR_FORMAT.V3,
    };
    (runner as unknown as { datasets: Map<string, unknown> }).datasets.set(
      source.key,
      Promise.resolve(
        zarrAnalysisDatasetFromStore(store as never, "", ZARR_FORMAT.V3, base)
      )
    );
    let run = 0;
    const levels = async () => {
      const id = `ps${++run}`;
      await runner.plan(
        id,
        source as never,
        query(ANALYSIS_KINDS.PROFILE, "ta", POINT, {
          time: { start: 0, stop: 1 },
        })
      );
      return (await runner.execute(id)).vertical!.values;
    };
    expect(await levels()).toEqual([9000, 90000]);
    // Surface pressure of the first date republished: 70,000 Pa.
    await write(
      store,
      "ps",
      [70000, 90000],
      [2, 1, 1],
      ["time", "lat", "lon"],
      {
        units: "Pa",
      },
      [1, 1, 1]
    );
    await runner.forgetPublished(base, 0, 0);
    expect(await levels()).toEqual([7000, 70000]);
  });
});

describe("review of interim26: a failed metadata read is not a missing one", () => {
  it("a 503 on the latitude bounds fails the description (tried again)", async () => {
    const store = await newStore();
    await write(store, "lat", [0, 1], [2], ["lat"], {
      units: "degrees_north",
      bounds: "lat_bnds",
    });
    await write(store, "lon", [0, 1], [2], ["lon"], { units: "degrees_east" });
    await write(
      store,
      "lat_bnds",
      [-0.5, 0.5, 0.5, 1.5],
      [2, 2],
      ["lat", "nv"]
    );
    await write(store, "t", [1, 2, 3, 4], [1, 2, 2], ["time", "lat", "lon"]);
    await write(store, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    const failing = {
      get: async (path: string) => {
        if (path.includes("lat_bnds")) {
          throw new Error("HTTP 503 Service Unavailable");
        }
        return store.get(path.replace(/^\//, "")) ?? store.get(path);
      },
      has: (path: string) => store.has(path),
    };
    const dataset = zarrAnalysisDatasetFromStore(
      failing as never,
      "",
      ZARR_FORMAT.V3,
      `bounds-503-${Math.random()}`
    );
    await expect(open(store, "t", dataset)).rejects.toThrow(/503/);
    // Absent bounds (no such array) still fall back as before.
    store.delete("lat_bnds/zarr.json");
    await expect(open(store, "t")).resolves.toBeDefined();
  });

  it("review of interim30: a 503 on a native grid's bounds is not kept as unsupported", async () => {
    const store = await newStore();
    await write(store, "time", [0], [1], ["time"], {
      units: "days since 2000-01-01",
    });
    await write(store, "lat", [0, 1, 2], [3], ["cell"], {
      units: "degrees_north",
      bounds: "lat_bnds",
    });
    await write(store, "lon", [0, 1, 2], [3], ["cell"], {
      units: "degrees_east",
      bounds: "lon_bnds",
    });
    const corners = (c: number) => [c - 0.5, c + 0.5, c + 0.5, c - 0.5];
    await write(
      store,
      "lat_bnds",
      [0, 1, 2].flatMap(corners),
      [3, 4],
      ["cell", "nv"]
    );
    await write(
      store,
      "lon_bnds",
      [0, 1, 2].flatMap(corners),
      [3, 4],
      ["cell", "nv"]
    );
    await write(store, "t", [5, 6, 7], [1, 3], ["time", "cell"], {
      coordinates: "lat lon",
    });
    let fail = true;
    const flaky = {
      get: async (path: string) => {
        if (fail && path.includes("lat_bnds")) {
          fail = false;
          throw new Error("HTTP 503 Service Unavailable");
        }
        return store.get(path.replace(/^\//, "")) ?? store.get(path);
      },
      has: (path: string) => store.has(path),
    };
    const dataset = zarrAnalysisDatasetFromStore(
      flaky as never,
      "",
      ZARR_FORMAT.V3,
      `native-503-${Math.random()}`
    );
    await expect(open(store, "t", dataset)).rejects.toThrow(/503/);
    // The next description reads it again and finds the cells.
    const context = await open(store, "t", dataset);
    expect(context.grid.kind).toBe("native");
  });
});
