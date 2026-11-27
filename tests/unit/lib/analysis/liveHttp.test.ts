import { setTimeout as delay } from "node:timers/promises";

/**
 * After a publication the published chunks are read again (no byte cache keeps
 * a half-written chunk or a "no such chunk" answer), only those, and a plan
 * priced before it is planned again.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import * as zarr from "zarrita";

import { AnalysisRunner } from "@/lib/analysis/analysisRunner.ts";
import { ANALYSIS_KINDS } from "@/lib/analysis/types.ts";
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
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((product, n) => product * n, 1)
  );
  await zarr.set(array as never, null, {
    data: Float64Array.from(data),
    shape,
    stride,
  } as never);
}

async function liveStore(u: number[], perChunk = 2, timeChunk = u.length) {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  await write(store, "lat", [0], [1], ["lat"], { units: "degrees_north" });
  await write(store, "lon", [0], [1], ["lon"], { units: "degrees_east" });
  const times = u.map((_, t) => t);
  await write(
    store,
    "time",
    times,
    [u.length],
    ["time"],
    { units: "days since 2000-01-01" },
    [timeChunk]
  );
  await write(store, "u", u, [u.length, 1, 1], ["time", "lat", "lon"], {}, [
    perChunk,
    1,
    1,
  ]);
  return store;
}

const chunkKey = (store: TStore, c: number) =>
  [...store.keys()].find((k) => new RegExp(`^/?u/c/${c}/`).test(k))!;

/** Serve `served` over a stubbed fetch, counting requests and field reads. */
function serve(served: TStore) {
  const counts = { requests: 0, field: 0, time: 0 };
  vi.stubGlobal("fetch", async (input: Request | string) => {
    counts.requests++;
    const request = input instanceof Request ? input : new Request(input);
    const path = decodeURIComponent(new URL(request.url).pathname).replace(
      /^\/s\.zarr\/?/,
      ""
    );
    if (/^u\/c\//.test(path)) {
      counts.field++;
    }
    if (/^time\/c\//.test(path)) {
      counts.time++;
    }
    const bytes = served.get(path) ?? served.get(`/${path}`);
    if (!bytes) {
      return new Response(null, { status: 404 });
    }
    const range = /bytes=(\d*)-(\d*)/.exec(request.headers.get("Range") ?? "");
    if (range) {
      const end = range[2] === "" ? bytes.length : Number(range[2]) + 1;
      const start =
        range[1] === "" ? bytes.length - Number(range[2]) : Number(range[1]);
      const part = bytes.slice(start, range[1] === "" ? bytes.length : end);
      return new Response(part as unknown as BodyInit, { status: 206 });
    }
    return new Response(bytes as unknown as BodyInit, { status: 200 });
  });
  return counts;
}

/** A runner over the served store and a point series of `u`. */
function seriesOf(base: string, steps: number) {
  const runner = new AnalysisRunner();
  const source = {
    key: `${base}|https://live.test/s.zarr|`,
    store: "https://live.test/s.zarr",
    dataset: "",
    format: ZARR_FORMAT.V3,
  };
  let run = 0;
  const query = {
    version: 1,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    source: { ref: source.store, versionStatus: "best-effort" },
    variable: "u",
    fixed: {},
    geometry: { kind: "point", lat: 0, lon: 0 },
    time: { start: 0, stop: steps },
  } as never;
  const plan = async () => {
    const id = `h${++run}`;
    await runner.plan(id, source as never, query);
    return id;
  };
  const series = async () => (await runner.execute(await plan())).values;
  return {
    runner,
    base,
    plan,
    series,
    describe: () => runner.describe(source as never, "u"),
  };
}

afterEach(() => vi.unstubAllGlobals());

// eslint-disable-next-line max-lines-per-function
describe("live HTTP Zarr through the production adapter", () => {
  it("reads published chunks again after a publication", async () => {
    const served = await liveStore([1, NaN, 0, 0]);
    served.delete(chunkKey(served, 1));
    const later = await liveStore([1, 7, 71, 85]);
    const counts = serve(served);
    const { runner, series } = seriesOf("live#http", 4);
    expect(await series()).toEqual([1, NaN, NaN, NaN]);
    // Step 1 written into chunk 0, chunk 1 created.
    served.set(chunkKey(served, 0), later.get(chunkKey(later, 0))!);
    served.set(chunkKey(later, 1), later.get(chunkKey(later, 1))!);
    await runner.forgetPublished("live#http", 1, 3);
    const before = counts.requests;
    expect(await series()).toEqual([1, 7, 71, 85]);
    expect(counts.requests).toBeGreaterThan(before);
  });

  it("re-reads only the published step's chunk (v24 review: 64 of 64 were)", async () => {
    const values = Array.from({ length: 8 }, (_, t) => t);
    const served = await liveStore(values, 1);
    const counts = serve(served);
    const { runner, series } = seriesOf("live#one", 8);
    expect(await series()).toEqual(values);
    const warm = counts.field;
    expect(await series()).toEqual(values);
    expect(counts.field).toBe(warm);
    const later = await liveStore([...values.slice(0, 7), 70], 1);
    served.set(chunkKey(served, 7), later.get(chunkKey(later, 7))!);
    await runner.forgetPublished("live#one", 7, 7);
    expect(await series()).toEqual([...values.slice(0, 7), 70]);
    expect(counts.field - warm).toBe(1);
  });

  it("retains missing field chunks outside the published date range", async () => {
    const values = Array.from({ length: 64 }, (_, day) => day + 1);
    const served = await liveStore(values, 1);
    const publishedKey = chunkKey(served, 1);
    const publishedBytes = served.get(publishedKey)!;
    for (let day = 1; day < values.length; day++) {
      served.delete(chunkKey(served, day));
    }
    const counts = serve(served);
    const { runner, series } = seriesOf("live#sparse", values.length);
    const expected = Array<number>(values.length).fill(Number.NaN);
    expected[0] = 1;
    expect(await series()).toEqual(expected);
    const cold = counts.field;
    expect(cold).toBe(values.length);
    expect(await series()).toEqual(expected);
    expect(counts.field).toBe(cold);

    served.set(publishedKey, publishedBytes);
    await runner.forgetPublished("live#sparse", 1, 1);
    expected[1] = 2;
    expect(await series()).toEqual(expected);
    expect(counts.field - cold).toBe(1);
  });

  it("refuses a plan priced before a publication; planned again it reads the new values", async () => {
    const served = await liveStore([1, NaN, 0, 0]);
    served.delete(chunkKey(served, 1));
    const later = await liveStore([1, 7, 71, 85]);
    serve(served);
    const { runner, plan, series } = seriesOf("live#held", 4);
    expect(await series()).toEqual([1, NaN, NaN, NaN]);
    // Priced, then held (waiting for Compute) while the source publishes.
    const held = await plan();
    served.set(chunkKey(served, 0), later.get(chunkKey(later, 0))!);
    served.set(chunkKey(later, 1), later.get(chunkKey(later, 1))!);
    await runner.forgetPublished("live#held", 1, 3);
    await expect(runner.execute(held)).rejects.toThrow(/plan it again/);
    expect(await series()).toEqual([1, 7, 71, 85]);
  });

  it("a publication does not read the time axis again (v24 review: 4,000 GETs)", async () => {
    const values = Array.from({ length: 50 }, (_, t) => t);
    // The time coordinate stored one value per chunk: 50 reads to describe.
    const served = await liveStore(values, 10, 1);
    const counts = serve(served);
    const { runner, series } = seriesOf("live#axis", 50);
    expect(await series()).toEqual(values);
    expect(counts.time).toBe(50);
    for (let round = 0; round < 3; round++) {
      await runner.forgetPublished("live#axis", 49, 49);
      expect(await series()).toEqual(values);
    }
    // Only the published step's chunk, each time: a corrected timestamp is
    // seen, the other 49 are not read again.
    expect(counts.time).toBe(53);
  });
  it("review of interim30: a missing timestamp, once published, makes the plot usable", async () => {
    const source = "live#time-stamp";
    const served = await liveStore([1, 2], 1);
    await write(
      served,
      "time",
      [0, 1],
      [2],
      ["time"],
      { units: "days since 2000-01-01" },
      [1]
    );
    const timeKey = [...served.keys()].find((key) => /time\/c\/1$/.test(key))!;
    const timeBytes = served.get(timeKey)!;
    served.delete(timeKey);
    serve(served);
    const { runner, plan } = seriesOf(source, 2);
    await expect(plan()).rejects.toThrow();
    served.set(timeKey, timeBytes);
    await runner.forgetPublished(source, 1, 1);
    const refreshed = await runner.execute(await plan());
    expect(refreshed.values).toEqual([1, 2]);
  });

  it("refreshes missing time bounds together with their newly published field step", async () => {
    const source = "live#time-bounds";
    const served = await liveStore([1, 2], 1);
    await write(served, "time", [0, 1], [2], ["time"], {
      units: "days since 2000-01-01",
      bounds: "tb",
    });
    await write(served, "tb", [0, 1, 1, 2], [2, 2], ["time", "nv"], {}, [1, 2]);
    const fieldKey = chunkKey(served, 1);
    const boundsKey = [...served.keys()].find((key) =>
      /tb\/c\/1\/0$/.test(key)
    )!;
    const fieldBytes = served.get(fieldKey)!;
    const boundsBytes = served.get(boundsKey)!;
    served.delete(fieldKey);
    served.delete(boundsKey);
    serve(served);

    const { runner, plan } = seriesOf(source, 2);
    const initial = await runner.execute(await plan());
    expect(initial.values).toEqual([1, NaN]);
    expect(initial.time?.boundsUnread).toMatch(/missing values/);

    served.set(fieldKey, fieldBytes);
    served.set(boundsKey, boundsBytes);
    await runner.forgetPublished(source, 1, 1);
    const refreshed = await runner.execute(await plan());
    expect(refreshed.values).toEqual([1, 2]);
    expect(refreshed.time?.bounds).toEqual([0, 1, 1, 2]);
    expect(refreshed.time?.boundsUnread).toBeUndefined();
  });
});

it("uses corrected timestamps and interval edges when an existing live step is republished", async () => {
  const source = "live#corrected-time";
  const served = await liveStore([10, 20], 1);
  const attrs = { units: "days since 2000-01-01", bounds: "tb" };
  await write(served, "time", [0.5, 1.5], [2], ["time"], attrs, [1]);
  await write(served, "tb", [0, 1, 1, 2], [2, 2], ["time", "nv"], {}, [1, 2]);
  serve(served);
  const active = seriesOf(source, 2);
  const first = await active.runner.execute(await active.plan());
  expect(first.time?.raw).toEqual([0.5, 1.5]);

  const replacement = await liveStore([10, 35], 1);
  await write(replacement, "time", [0.5, 2], [2], ["time"], attrs, [1]);
  await write(
    replacement,
    "tb",
    [0, 1, 1, 3],
    [2, 2],
    ["time", "nv"],
    {},
    [1, 2]
  );
  for (const [key, bytes] of replacement) {
    served.set(key, bytes);
  }
  await active.runner.forgetPublished(source, 1, 1);

  const updated = await active.runner.execute(await active.plan());
  const cold = seriesOf(source, 2);
  const reopened = await cold.runner.execute(await cold.plan());
  expect(reopened.time?.raw).toEqual([0.5, 2]);
  expect(reopened.time?.bounds).toEqual([0, 1, 1, 3]);
  expect(updated.values).toEqual([10, 35]);
  expect({ raw: updated.time?.raw, bounds: updated.time?.bounds }).toEqual({
    raw: reopened.time?.raw,
    bounds: reopened.time?.bounds,
  });
});

/** One float64 shard with two one-value slots, using the default trailing index. */
function timeShard(values: number[]) {
  const payload = new Float64Array(values);
  const index = new BigUint64Array(4).fill(2n ** 64n - 1n);
  values.forEach((_, slot) => {
    index[2 * slot] = BigInt(8 * slot);
    index[2 * slot + 1] = 8n;
  });
  const shard = new Uint8Array(payload.byteLength + index.byteLength);
  shard.set(new Uint8Array(payload.buffer));
  shard.set(new Uint8Array(index.buffer), payload.byteLength);
  return shard;
}

it("a transient failure to reopen a repacked data shard does not cache stale byte offsets", async () => {
  const served = await liveStore([10, 20], 2, 1);
  const path = "/u/zarr.json";
  const meta = JSON.parse(new TextDecoder().decode(served.get(path)));
  const bytes = { name: "bytes", configuration: { endian: "little" } };
  meta.codecs = [
    {
      name: "sharding_indexed",
      configuration: {
        // eslint-disable-next-line camelcase -- Zarr v3 wire format
        chunk_shape: [1, 1, 1],
        codecs: [bytes],
        // eslint-disable-next-line camelcase -- Zarr v3 wire format
        index_codecs: [bytes],
      },
    },
  ];
  served.set(path, new TextEncoder().encode(JSON.stringify(meta)));
  const shardPath = chunkKey(served, 0);
  served.set(shardPath, timeShard([10, 20]));
  serve(served);
  const active = seriesOf("live#repacked-field", 2);
  expect(await active.series()).toEqual([10, 20]);
  // Repack the shard; slot 0 still holds 10, slot 1 now holds 90.
  const repacked = timeShard([90, 10]);
  const index = new BigUint64Array(repacked.buffer, 16);
  index[0] = 8n;
  index[2] = 0n;
  served.set(shardPath, repacked);
  const normal = globalThis.fetch;
  let failures = 0;
  vi.stubGlobal("fetch", (request: Request | string) => {
    const url = request instanceof Request ? request.url : request;
    if (url.endsWith(path) && failures === 0) {
      failures++;
      return Promise.resolve(new Response(null, { status: 503 }));
    }
    return normal(request);
  });
  await active.runner.forgetPublished(active.base, 1, 1).catch(() => {});
  const warm = await active.series().catch(() => active.series());
  const cold = await seriesOf("live#repacked-field-cold", 2).series();
  expect(failures).toBe(1);
  expect(cold).toEqual([10, 90]);
  expect(warm).toEqual(cold);
});

it("refreshes the shard index of a newly published timestamp", async () => {
  const source = "live#sharded-time";
  const served = await liveStore([10, 20], 1);
  const meta = JSON.parse(
    new TextDecoder().decode(served.get("/time/zarr.json"))
  );
  const bytes = { name: "bytes", configuration: { endian: "little" } };
  meta.codecs = [
    {
      name: "sharding_indexed",
      configuration: {
        // eslint-disable-next-line camelcase -- Zarr v3 wire format
        chunk_shape: [1],
        codecs: [bytes],
        // eslint-disable-next-line camelcase -- Zarr v3 wire format
        index_codecs: [bytes],
      },
    },
  ];
  served.set("/time/zarr.json", new TextEncoder().encode(JSON.stringify(meta)));
  served.set("/time/c/0", timeShard([0]));
  serve(served);
  const active = seriesOf(source, 2);
  await expect(active.plan()).rejects.toThrow(/missing or invalid timestamps/);

  served.set("/time/c/0", timeShard([0, 1]));
  await active.runner.forgetPublished(source, 1, 1);
  const cold = seriesOf(source, 2);
  expect(await cold.series()).toEqual([10, 20]);
  await expect(active.series()).resolves.toEqual([10, 20]);
});

it("reads a publication at once while another variable is still being described", async () => {
  const source = "live#pending-other";
  const served = await liveStore([10, 20], 1);
  // A second variable whose metadata does not arrive.
  await write(
    served,
    "v",
    [1, 2],
    [2, 1, 1],
    ["time", "lat", "lon"],
    {},
    [1, 1, 1]
  );
  const counts = serve(served);
  void counts;
  const answer = globalThis.fetch;
  vi.stubGlobal("fetch", (input: Request | string) => {
    const url = input instanceof Request ? input.url : input;
    return /\/v\/zarr\.json$/.test(url) ? new Promise(() => {}) : answer(input);
  });
  const active = seriesOf(source, 2);
  expect(await active.series()).toEqual([10, 20]);
  const other = {
    key: `${source}|https://live.test/s.zarr|`,
    store: "https://live.test/s.zarr",
    dataset: "",
    format: ZARR_FORMAT.V3,
  };
  void active.runner
    .plan(
      "other",
      other as never,
      {
        version: 1,
        kind: ANALYSIS_KINDS.POINT_SERIES,
        source: { ref: other.store, versionStatus: "best-effort" },
        variable: "v",
        fixed: {},
        geometry: { kind: "point", lat: 0, lon: 0 },
        time: { start: 0, stop: 2 },
      } as never
    )
    .catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 10));

  const later = await liveStore([10, 90], 1);
  served.set(chunkKey(served, 1), later.get(chunkKey(later, 1))!);
  void active.runner.forgetPublished(source, 1, 1);
  expect(await active.series()).toEqual([10, 90]);
});

it("refreshes a field published while its previously loaded time coordinate was incomplete", async () => {
  const source = "live#recover-field";
  const served = await liveStore([10, 20], 1);
  serve(served);
  const active = seriesOf(source, 2);
  expect(await active.series()).toEqual([10, 20]);

  // The first publication's two-row time chunk is briefly absent.
  const timeKey = "/time/c/0";
  const timeBytes = served.get(timeKey)!;
  served.delete(timeKey);
  await active.runner.forgetPublished(source, 0, 0);
  await expect(active.plan()).rejects.toThrow(/missing or invalid timestamps/);

  // The second publication restores the time chunk and corrects the field.
  served.set(timeKey, timeBytes);
  const later = await liveStore([10, 90], 1);
  const nextDay = chunkKey(served, 1);
  served.set(nextDay, later.get(nextDay)!);
  await active.runner.forgetPublished(source, 1, 1);
  expect(await seriesOf(source, 2).series()).toEqual([10, 90]);
  await expect(active.series()).resolves.toEqual([10, 90]);
});

it("offers the point series to a window opened during publication of its missing timestamp", async () => {
  const source = "live#describe-publishing";
  const served = await liveStore([10, 20], 1, 1);
  const timeKey = "/time/c/1";
  const timeBytes = served.get(timeKey)!;
  served.delete(timeKey);
  serve(served);
  const active = seriesOf(source, 2);
  const kind = ANALYSIS_KINDS.POINT_SERIES;
  // The published date is offered meanwhile; the second is not yet.
  expect((await active.describe()).time?.raw).toHaveLength(1);

  const original = globalThis.fetch;
  let signalRead!: () => void;
  const entered = new Promise<void>((resolve) => {
    signalRead = resolve;
  });
  let finishRead!: () => void;
  const release = new Promise<void>((resolve) => {
    finishRead = resolve;
  });
  vi.stubGlobal("fetch", async (input: Request | string) => {
    const url = input instanceof Request ? input.url : input;
    if (url.endsWith(timeKey)) {
      signalRead();
      await release;
    }
    return original(input);
  });
  served.set(timeKey, timeBytes);
  const publishing = active.runner.forgetPublished(source, 1, 1);
  await entered;
  const opening = active.describe();
  finishRead();
  await publishing;
  expect(await active.series()).toEqual([10, 20]);
  // A window opened during the publication sees its timestamp.
  expect((await opening).time?.raw).toHaveLength(2);
  expect((await opening).capabilities[kind].available).toBe(true);
});

it("reads the requested complete date when a later live timestamp is still absent", async () => {
  const served = await liveStore([10, 20], 1, 1);
  served.delete("/time/c/1");
  serve(served);
  const active = seriesOf("live#one-available-day", 1);
  await expect(active.series()).resolves.toEqual([10]);
});

it("applies successive publications even with no plot read between them", async () => {
  const source = "live#two-publishes";
  const served = await liveStore([10, 20], 1, 1);
  serve(served);
  const active = seriesOf(source, 2);
  const read = async () => active.runner.execute(await active.plan());
  expect((await read()).values).toEqual([10, 20]);
  const later = await liveStore([60, 90], 1, 1);
  await write(
    later,
    "time",
    [0.25, 1.25],
    [2],
    ["time"],
    {
      units: "days since 2000-01-01",
    },
    [1]
  );
  for (const day of [0, 1]) {
    const time = `/time/c/${day}`;
    const field = chunkKey(served, day);
    served.set(time, later.get(time)!);
    served.set(field, later.get(field)!);
    await active.runner.forgetPublished(source, day, day);
  }
  const cold = seriesOf(source, 2);
  const fresh = await cold.runner.execute(await cold.plan());
  expect([fresh.time?.raw, fresh.values]).toEqual([
    [0.25, 1.25],
    [60, 90],
  ]);
  const warm = await read();
  expect([warm.time?.raw, warm.values]).toEqual([
    fresh.time?.raw,
    fresh.values,
  ]);
});

async function boundedLiveStore(edges: number[]) {
  const served = await liveStore([10, 20], 1, 1);
  const attrs = { units: "days since 2000-01-01", bounds: "tb" };
  await write(served, "time", [0.5, 1.5], [2], ["time"], attrs, [1]);
  await write(served, "tb", edges, [2, 2], ["time", "nv"], {}, [1, 2]);
  return served;
}

it("discovers time bounds published after all declared bound chunks were empty", async () => {
  const source = "live#all-bounds-missing";
  const served = await boundedLiveStore([0, 1, 1, 2]);
  const keys = ["/tb/c/0/0", "/tb/c/1/0"];
  const bytes = keys.map((key) => served.get(key)!);
  keys.forEach((key) => served.delete(key));
  serve(served);
  const active = seriesOf(source, 2);
  expect(
    (await active.runner.execute(await active.plan())).time?.bounds
  ).toBeUndefined();
  keys.forEach((key, at) => served.set(key, bytes[at]));
  await active.runner.forgetPublished(source, 0, 1);
  const cold = seriesOf(source, 2);
  expect((await cold.runner.execute(await cold.plan())).time?.bounds).toEqual([
    0, 1, 1, 2,
  ]);
  expect(
    (await active.runner.execute(await active.plan())).time?.bounds
  ).toEqual([0, 1, 1, 2]);
});

it("retains a rainfall total for a bounded selected date while a future bound is missing", async () => {
  const source = "live#published-prefix-bounds";
  const served = await boundedLiveStore([0, 1, NaN, NaN]);
  await write(
    served,
    "u",
    [10, 20],
    [2, 1, 1],
    ["time", "lat", "lon"],
    // eslint-disable-next-line camelcase -- CF attribute name
    { units: "mm/day", cell_methods: "time: mean" },
    [1, 1, 1]
  );
  serve(served);
  const active = seriesOf(source, 1);
  const first = await active.runner.execute(await active.plan());
  expect(first.time?.bounds).toEqual([0, 1]);
  const { accumulate } = await import("@/ui/analysis/timeViews.ts");
  const time = first.time!;
  expect(
    accumulate(
      time.raw,
      time.units,
      first.values,
      first.units,
      time.bounds,
      time.boundsUnread,
      "mean"
    ).y
  ).toEqual([10]);
});

async function livePressureStore() {
  const served = await liveStore([10, 20], 1);
  await write(served, "lev", [0.5, 1], [2], ["lev"], {
    // eslint-disable-next-line camelcase -- CF attribute name
    standard_name: "atmosphere_hybrid_sigma_pressure_coordinate",
    // eslint-disable-next-line camelcase -- CF attribute name
    formula_terms: "ap: ap b: b ps: ps",
    positive: "down",
  });
  await write(served, "ap", [0, 0], [2], ["lev"], { units: "Pa" });
  await write(served, "b", [0.5, 1], [2], ["lev"], { units: "1" });
  await write(
    served,
    "ps",
    [100000, 100000],
    [2],
    ["time"],
    { units: "Pa" },
    [1]
  );
  const writeField = (values: number[]) =>
    write(
      served,
      "temp",
      values,
      [2, 2, 1, 1],
      ["time", "lev", "lat", "lon"],
      { units: "K" },
      [1, 2, 1, 1]
    );
  await writeField([1, 2, 3, 4]);
  serve(served);
  return { served, writeField };
}

it("keeps a profile on its requested step and refreshes its pressure after temporary timestamp loss", async () => {
  const { served, writeField } = await livePressureStore();
  const base = "live#recover-pressure";
  const active = new AnalysisRunner();
  const source = {
    key: base + "|https://live.test/s.zarr|",
    store: "https://live.test/s.zarr",
    dataset: "",
    format: ZARR_FORMAT.V3,
  };
  const profile = async (runner: AnalysisRunner) => {
    await runner.plan("profile", source, {
      version: 1,
      kind: ANALYSIS_KINDS.PROFILE,
      source: { ref: source.store, versionStatus: "best-effort" },
      variable: "temp",
      fixed: {},
      geometry: { kind: "point", lat: 0, lon: 0 },
      time: { start: 1, stop: 2 },
    });
    return runner.execute("profile");
  };
  expect((await profile(active)).values).toEqual([3, 4]);
  const bytes = served.get("/time/c/0")!;
  served.delete("/time/c/0");
  await active.forgetPublished(base, 0, 0);
  // A failed read is preferable to displaying data from the wrong step.
  const mid = await profile(active).catch(() => undefined);
  if (mid) {
    expect.soft(mid.values).toEqual([3, 4]);
  }
  served.set("/time/c/0", bytes);
  await writeField([1, 2, 8, 9]);
  await write(
    served,
    "ps",
    [100000, 80000],
    [2],
    ["time"],
    { units: "Pa" },
    [1]
  );
  await active.forgetPublished(base, 1, 1);
  const cold = await profile(new AnalysisRunner());
  const warm = await profile(active);
  expect(cold.vertical?.values).toEqual([40000, 80000]);
  expect(warm.values).toEqual([8, 9]);
  expect(warm.vertical?.values).toEqual(cold.vertical?.values);
});

it("refreshes a published field even while its separate bounds chunks return HTTP 503", async () => {
  const served = await boundedLiveStore([0, 1, 1, 2]);
  serve(served);
  const normal = globalThis.fetch;
  let offline = true;
  vi.stubGlobal("fetch", (request: Request | string) => {
    const url = request instanceof Request ? request.url : request;
    return offline && /\/tb\/c\//.test(url)
      ? Promise.resolve(new Response(null, { status: 503 }))
      : normal(request);
  });
  const active = seriesOf("live#outage-bounds", 2);
  const first = await active.runner.execute(await active.plan());
  expect(first.values).toEqual([10, 20]);
  expect(first.time?.boundsUnread).toBeTruthy();
  const updated = await liveStore([10, 90], 1, 1);
  served.set(chunkKey(served, 1), updated.get(chunkKey(updated, 1))!);
  await active.runner.forgetPublished(active.base, 1, 1);
  offline = false;
  const warm = await active.runner.execute(await active.plan());
  const cold = await seriesOf("live#outage-bounds-cold", 2).series();
  expect(cold).toEqual([10, 90]);
  expect(warm.values).toEqual(cold);
});

it("keeps field invalidations after an unsuccessful re-description during a time outage", async () => {
  const served = await liveStore([10, 20], 1, 1);
  serve(served);
  const active = seriesOf("live#outage-description", 2);
  expect(await active.series()).toEqual([10, 20]);
  const normal = globalThis.fetch;
  let offline = true;
  vi.stubGlobal("fetch", (request: Request | string) => {
    const url = request instanceof Request ? request.url : request;
    return offline && /\/time\/c\//.test(url)
      ? Promise.resolve(new Response(null, { status: 503 }))
      : normal(request);
  });
  await active.runner.forgetPublished(active.base, 0, 0);
  await expect(active.series()).rejects.toThrow();
  const updated = await liveStore([10, 90], 1, 1);
  served.set(chunkKey(served, 1), updated.get(chunkKey(updated, 1))!);
  offline = false;
  await active.runner.forgetPublished(active.base, 1, 1);
  const warm = await active.series();
  const cold = await seriesOf("live#outage-description-cold", 2).series();
  expect(cold).toEqual([10, 90]);
  expect(warm).toEqual(cold);
});

it("a plan opened during overlapping publications sees both published date ranges", async () => {
  const served = await liveStore([10, 20], 1, 1);
  serve(served);
  const active = seriesOf("live#concurrent-publications", 2);
  expect(await active.series()).toEqual([10, 20]);
  const updated = await liveStore([60, 90], 1, 1);
  for (const index of [0, 1]) {
    served.set(chunkKey(served, index), updated.get(chunkKey(updated, index))!);
  }
  const normal = globalThis.fetch;
  let entered!: () => void;
  let release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  vi.stubGlobal("fetch", async (request: Request | string) => {
    const url = request instanceof Request ? request.url : request;
    if (first && /\/time\/c\/0$/.test(url)) {
      first = false;
      entered();
      await gate;
    }
    return normal(request);
  });
  const earlier = active.runner.forgetPublished(active.base, 0, 0);
  await started;
  const later = active.runner.forgetPublished(active.base, 1, 1);
  const both = Promise.all([earlier, later]);
  // A reader may wait for both dates. Give already-resolved HTTP requests a
  // chance to settle before completing the older publication.
  const query = later.then(() => active.series());
  const result = await Promise.race([
    query,
    delay(300, undefined, { ref: false }),
  ]);
  release();
  await both;
  const values = result ?? (await query);
  expect(await active.series()).toEqual([60, 90]);
  const cold = await seriesOf("live#concurrent-publications-cold", 2).series();
  expect(cold).toEqual([60, 90]);
  expect(values).toEqual(cold);
});

it("refreshes only the published time-bounds chunk above the decoded matrix retention limit", async () => {
  const length = 1_048_577;
  const chunkSize = 16_384;
  const served = await liveStore([10], 1, 1);
  await write(served, "time", [0.5], [1], ["time"], {
    units: "days since 2000-01-01",
    bounds: "tb",
  });
  await write(served, "tb", [0, 1], [1, 2], ["time", "nv"]);
  const resize = (path: string, shape: number[], chunks: number[]) => {
    const key = `/${path}/zarr.json`;
    const metadata = JSON.parse(new TextDecoder().decode(served.get(key)));
    metadata.shape = shape;
    Reflect.set(metadata.chunk_grid.configuration, "chunk_shape", chunks);
    served.set(key, new TextEncoder().encode(JSON.stringify(metadata)));
  };
  resize("u", [length, 1, 1], [1, 1, 1]);
  resize("time", [length], [chunkSize]);
  resize("tb", [length, 2], [chunkSize, 2]);
  for (let chunk = 0; chunk * chunkSize < length; chunk++) {
    const start = chunk * chunkSize;
    const time = Float64Array.from(
      { length: chunkSize },
      (_, i) => start + i + 0.5
    );
    const edges = Float64Array.from(
      { length: 2 * chunkSize },
      (_, i) => start + Math.floor(i / 2) + (i % 2)
    );
    served.set(`/time/c/${chunk}`, new Uint8Array(time.buffer));
    served.set(`/tb/c/${chunk}/0`, new Uint8Array(edges.buffer));
  }
  const counts = serve(served);
  let bounds = 0;
  const normal = globalThis.fetch;
  vi.stubGlobal("fetch", (request: Request | string) => {
    const url = request instanceof Request ? request.url : request;
    if (url.includes("/tb/c/")) {
      bounds++;
    }
    return normal(request);
  });
  const active = seriesOf("live#large-bounds", 1);
  expect(await active.series()).toEqual([10]);
  const initial = { bounds, field: counts.field };
  await active.runner.forgetPublished(active.base, 1, 1);
  expect(await active.series()).toEqual([10]);
  expect(counts.field - initial.field).toBe(0);
  expect(bounds - initial.bounds).toBeLessThanOrEqual(1);
}, 30_000);

it("invalidates a republished field when its concurrent replacement description fails", async () => {
  const served = await liveStore([10, 20], 1, 1);
  serve(served);
  const active = seriesOf("live#outage-during-publication", 2);
  expect(await active.series()).toEqual([10, 20]);
  const original = globalThis.fetch;
  let arrive!: () => void;
  let release!: () => void;
  const arrived = new Promise<void>((resolve) => {
    arrive = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let hold = false;
  let offline = true;
  vi.stubGlobal("fetch", async (input: Request | string) => {
    const url = input instanceof Request ? input.url : input;
    if (/\/time\/c\//.test(url) && offline) {
      if (hold) {
        arrive();
        await gate;
      }
      return new Response(null, { status: 503 });
    }
    return original(input);
  });
  await active.runner.forgetPublished(active.base, 0, 0);
  hold = true;
  const recovering = active.series().then(
    () => false,
    () => true
  );
  await arrived;
  const update = await liveStore([10, 90], 1, 1);
  served.set(chunkKey(served, 1), update.get(chunkKey(update, 1))!);
  const publication = active.runner.forgetPublished(active.base, 1, 1);
  release();
  expect(await recovering).toBe(true);
  await publication;
  offline = false;
  const warm = await active.series();
  const cold = await seriesOf(
    "live#outage-during-publication-cold",
    2
  ).series();
  expect(cold).toEqual([10, 90]);
  expect(warm).toEqual(cold);
});

function resizeStoreArray(
  served: TStore,
  path: string,
  shape: number[],
  chunks: number[],
  dtype?: string
) {
  const key = `/${path}/zarr.json`;
  const metadata = JSON.parse(new TextDecoder().decode(served.get(key)));
  metadata.shape = shape;
  Reflect.set(metadata.chunk_grid.configuration, "chunk_shape", chunks);
  if (dtype) {
    Reflect.set(metadata, "data_type", dtype);
    Reflect.set(metadata, "fill_value", 0);
  }
  served.set(key, new TextEncoder().encode(JSON.stringify(metadata)));
}

function writeTimeChunks(served: TStore, length: number, chunkSize: number) {
  for (let c = 0; c * chunkSize < length; c++) {
    const times = Float64Array.from(
      { length: chunkSize },
      (_, i) => c * chunkSize + i
    );
    served.set(`/time/c/${c}`, new Uint8Array(times.buffer));
  }
}

it("reads only the republished timestamp chunk on an axis above the retention limit", async () => {
  const length = 2_097_153,
    chunkSize = 16_384;
  const served = await liveStore([10], 1, 1);
  resizeStoreArray(served, "u", [length, 1, 1], [1, 1, 1]);
  resizeStoreArray(served, "time", [length], [chunkSize]);
  writeTimeChunks(served, length, chunkSize);
  const counts = serve(served);
  const active = seriesOf("live#long-axis", 1);
  expect(await active.series()).toEqual([10]);
  const before = counts.time;
  await active.runner.forgetPublished(active.base, 1, 1);
  expect(await active.series()).toEqual([10]);
  expect(counts.time - before).toBeLessThanOrEqual(1);
}, 30_000);

it("finishes a point query with large padded time bounds when their chunk is unavailable", async () => {
  const length = 1_048_577,
    chunkSize = 65_536;
  const served = await boundedLiveStore([0, 1, 1, 2]);
  resizeStoreArray(served, "u", [length, 1, 1], [1, 1, 1]);
  resizeStoreArray(served, "time", [length], [chunkSize]);
  resizeStoreArray(served, "tb", [length, 2], [16_777_216, 2], "uint8");
  writeTimeChunks(served, length, chunkSize);
  serve(served);
  const original = globalThis.fetch;
  vi.stubGlobal("fetch", (input: Request | string) => {
    const url = input instanceof Request ? input.url : input;
    if (url.includes("/tb/c/")) {
      return Promise.resolve(new Response(null, { status: 503 }));
    }
    return original(input);
  });
  const active = seriesOf("live#padded-bounds", 1);
  const task = active.series().then(
    (values) => ({ values }),
    (err) => ({ error: String(err) })
  );
  const result = await Promise.race([
    task,
    delay(5000, "timed out", { ref: false }),
  ]);
  // Cancel the plan so outstanding reads are released on a failing run.
  active.runner.cancel("h1");
  expect(result).toEqual({ values: [10] });
}, 15_000);

// eslint-disable-next-line max-lines-per-function -- keeps the gated HTTP refresh and release in one fixture.
it("stops an obsolete live coordinate refresh when its dataset is released", async () => {
  const values = Array.from({ length: 8 }, (_, i) => i);
  const served = await liveStore(values, 1, 1);
  const counts = serve(served);
  const active = seriesOf("live#released-refresh", values.length);
  expect(await active.series()).toEqual(values);
  const original = globalThis.fetch;
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  vi.stubGlobal(
    "fetch",
    async (input: Request | string, init?: RequestInit) => {
      const request =
        input instanceof Request ? input : new Request(input, init);
      if (/\/time\/c\/0$/.test(request.url)) {
        // This was already dispatched before release; count only later chunks.
        const answer = await original(request);
        entered();
        await Promise.race([
          gate,
          new Promise<void>((resolve) => {
            if (request.signal.aborted) {
              resolve();
            } else {
              request.signal.addEventListener("abort", () => resolve(), {
                once: true,
              });
            }
          }),
        ]);
        request.signal.throwIfAborted();
        return answer;
      }
      return original(request);
    }
  );
  const change = active.runner.forgetPublished(
    active.base,
    0,
    values.length - 1
  );
  await started;
  const before = counts.time;
  const closed = active.runner.release(
    `${active.base}|https://live.test/s.zarr|`
  );
  // Guard the pending response even if the implementation waits for cleanup.
  await Promise.race([closed, delay(150, undefined, { ref: false })]);
  resume();
  await Promise.all([change, closed]);
  expect(counts.time - before).toBe(0);
});

it("settles a cancelled variable description while an independent live refresh is waiting", async () => {
  const served = await liveStore([10, 20], 1, 1);
  serve(served);
  const active = seriesOf("live#cancel-describe", 2);
  expect(await active.series()).toEqual([10, 20]);
  const original = globalThis.fetch;
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  vi.stubGlobal("fetch", async (input: Request | string) => {
    const url = input instanceof Request ? input.url : input;
    if (/\/time\/c\/0$/.test(url)) {
      entered();
      await gate;
    }
    return original(input);
  });
  const change = active.runner.forgetPublished(active.base, 0, 0);
  await started;
  const controller = new AbortController();
  const source = {
    key: `${active.base}|https://live.test/s.zarr|`,
    store: "https://live.test/s.zarr",
    dataset: "",
    format: ZARR_FORMAT.V3,
  };
  const description = active.runner
    .describe(source, "u", controller.signal)
    .then(
      () => "success",
      (error) => (error as Error).name
    );
  controller.abort();
  const outcome = await Promise.race([
    description,
    delay(100, "pending", { ref: false }),
  ]);
  resume();
  await Promise.all([change, description]);
  expect(outcome).toBe("AbortError");
});

it("revises a corrected timestamp on a long axis without downloading every unchanged date", async () => {
  const length = 2_097_153;
  const chunkSize = 16_384;
  const served = await liveStore([10], 1, 1);
  resizeStoreArray(served, "u", [length, 1, 1], [1, 1, 1]);
  resizeStoreArray(served, "time", [length], [chunkSize]);
  writeTimeChunks(served, length, chunkSize);
  const counts = serve(served);
  const active = seriesOf("review45-changed-long-time", 1);
  expect(await active.series()).toEqual([10]);
  const stamp = new Float64Array(served.get("/time/c/0")!.buffer);
  stamp[1] = 1.25;
  const before = counts.time;
  await active.runner.forgetPublished(active.base, 1, 1);
  expect((await active.describe()).time!.raw[1]).toBe(1.25);
  expect(counts.time - before).toBeLessThanOrEqual(1);
}, 30000);

it("releases the shared time axes of sources that have all been closed", async () => {
  const { SharedReads } = await import("@/lib/analysis/sharedRead.ts");
  const count = 131_072;
  const served = await liveStore([10], 1, 1);
  resizeStoreArray(served, "u", [count, 1, 1], [1, 1, 1]);
  resizeStoreArray(served, "time", [count], [count]);
  writeTimeChunks(served, count, count);
  serve(served);
  const cache = vi.spyOn(SharedReads.prototype, "share");
  const axes = [];
  try {
    for (let i = 0; i < 6; i++) {
      const active = seriesOf("review45-released-axes-" + i, 1);
      expect((await active.describe()).time!.raw).toHaveLength(count);
      const at = cache.mock.calls
        .map(([key, bytes]) => key.endsWith("|time") && bytes === count * 8)
        .lastIndexOf(true);
      expect(at).toBeGreaterThanOrEqual(0);
      const key = cache.mock.calls[at][0];
      const shared = cache.mock.contexts[at] as InstanceType<
        typeof SharedReads
      >;
      expect(shared.holds(key)).toBe(true);
      axes.push({ key, shared });
      await active.runner.release(active.base + "|https://live.test/s.zarr|");
    }
    expect(axes.filter(({ key, shared }) => shared.holds(key))).toHaveLength(0);
  } finally {
    cache.mockRestore();
  }
});

it("reuses an unchanged date read that was in flight when a different field chunk was published", async () => {
  const served = await liveStore([10, 20], 1, 1);
  const counts = serve(served);
  const active = seriesOf("review45-independent-inflight", 1);
  const first = await active.plan();
  const original = globalThis.fetch;
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  let held = false;
  vi.stubGlobal("fetch", async (input: Request | string) => {
    const url = input instanceof Request ? input.url : input;
    if (!held && url.includes("/u/c/0/")) {
      held = true;
      entered();
      await gate;
    }
    return original(input);
  });
  const reading = active.runner.execute(first);
  await started;
  await active.runner.forgetPublished(active.base, 1, 1);
  resume();
  expect((await reading).values).toEqual([10]);
  expect(await active.series()).toEqual([10]);
  expect(counts.field).toBe(1);
});

// eslint-disable-next-line max-lines-per-function -- measures a real shard and its plan.
it("accounts for a sharded point read's index before offering the read", async () => {
  const served = await liveStore([10, 20], 1, 1);
  const path = "/u/zarr.json";
  const meta = JSON.parse(new TextDecoder().decode(served.get(path)));
  // A padded shard with one occupied inner slot, followed by a full index.
  Reflect.set(meta.chunk_grid.configuration, "chunk_shape", [65536, 1, 1]);
  const bytes = { name: "bytes", configuration: { endian: "little" } };
  meta.codecs = [
    {
      name: "sharding_indexed",
      configuration: {
        // eslint-disable-next-line camelcase -- Zarr wire key.
        chunk_shape: [1, 1, 1],
        codecs: [bytes],
        // eslint-disable-next-line camelcase -- Zarr wire key.
        index_codecs: [bytes],
      },
    },
  ];
  served.set(path, new TextEncoder().encode(JSON.stringify(meta)));
  const shard = new Uint8Array(8 + 16 * 65536);
  shard.set(new Uint8Array(Float64Array.of(10).buffer));
  const index = new BigUint64Array(shard.buffer, 8);
  index.fill(2n ** 64n - 1n);
  index[0] = 0n;
  index[1] = 8n;
  served.set(chunkKey(served, 0), shard);
  serve(served);
  const original = globalThis.fetch;
  const indexes: string[] = [];
  vi.stubGlobal("fetch", (request: Request | string) => {
    const r = request instanceof Request ? request : new Request(request);
    if (r.url.includes("/u/c/0/")) {
      indexes.push(r.headers.get("Range") ?? "");
    }
    return original(request);
  });
  const runner = new AnalysisRunner();
  const source = {
    key: "review45-shard-index",
    store: "https://live.test/s.zarr",
    dataset: "",
    format: ZARR_FORMAT.V3,
  };
  const estimate = await runner.plan("shard-index-cost", source, {
    version: 1,
    kind: ANALYSIS_KINDS.POINT_SERIES,
    source: { ref: source.store, versionStatus: "best-effort" },
    variable: "u",
    fixed: {},
    geometry: { kind: "point", lat: 0, lon: 0 },
    time: { start: 0, stop: 1 },
  });
  const result = await runner.execute("shard-index-cost");
  expect(result.values).toEqual([10]);
  expect(indexes).toContain("bytes=-1048576");
  expect(result.counters.storeBytes).toBeGreaterThanOrEqual(1048576);
  expect(estimate.workingBytes).toBeGreaterThanOrEqual(1048576);
});

it("releases completed descriptions' replaced timestamp arrays while the live dataset remains open", async () => {
  const { default: v8 } = await import("node:v8");
  const { default: vm } = await import("node:vm");
  v8.setFlagsFromString("--expose-gc");
  const collect = vm.runInNewContext("gc") as () => void;
  const count = 131_072;
  const served = await liveStore([10], 1, 1);
  resizeStoreArray(served, "u", [count, 1, 1], [1, 1, 1]);
  resizeStoreArray(served, "time", [count], [count]);
  writeTimeChunks(served, count, count);
  serve(served);
  const runner = new AnalysisRunner();
  const base = "review45-finished-descriptions";
  const source = {
    key: base + "|https://live.test/s.zarr|",
    store: "https://live.test/s.zarr",
    dataset: "",
    format: ZARR_FORMAT.V3,
  };
  const capture = async () => {
    const s = await runner.describe(source, "u", new AbortController().signal);
    expect(s.time!.raw).toHaveLength(count);
    return new WeakRef(s.time!.raw);
  };
  const old: WeakRef<number[]>[] = [];
  for (let i = 0; i < 6; i++) {
    old.push(await capture());
    const bytes = served.get("/time/c/0")!;
    new Float64Array(bytes.buffer)[0] = 0.01 * (i + 1);
    await runner.forgetPublished(base, 0, 0);
  }
  expect((await runner.describe(source, "u")).time!.raw[0]).toBe(0.06);
  const held = async () => {
    await delay(0);
    collect();
    collect();
    return old.filter((ref) => ref.deref()).length;
  };
  const open = await held();
  await runner.release(source.key);
  const after = await held();
  expect(after).toBe(0);
  expect(open).toBe(0);
});

it("flags the traffic of a second run which starts and finishes while a first chunk is waiting", async () => {
  const served = await liveStore([10, 20], 1, 1);
  serve(served);
  const runner = new AnalysisRunner();
  const source = {
    key: "review45-nested-runs",
    store: "https://live.test/s.zarr",
    dataset: "",
    format: ZARR_FORMAT.V3,
  };
  for (const start of [0, 1]) {
    await runner.plan("nested-" + start, source, {
      version: 1,
      kind: ANALYSIS_KINDS.POINT_SERIES,
      source: { ref: source.store, versionStatus: "best-effort" },
      variable: "u",
      fixed: {},
      geometry: { kind: "point", lat: 0, lon: 0 },
      time: { start, stop: start + 1 },
    });
  }
  const normal = globalThis.fetch;
  let entered!: () => void;
  let resume!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  const gate = new Promise<void>((resolve) => {
    resume = resolve;
  });
  vi.stubGlobal("fetch", async (input: Request | string) => {
    const url = input instanceof Request ? input.url : input;
    if (url.includes("/u/c/0/")) {
      entered();
      await gate;
    }
    return normal(input);
  });
  const reading = runner.execute("nested-0");
  await started;
  const fast = await runner.execute("nested-1");
  resume();
  const slow = await reading;
  expect(fast.values).toEqual([20]);
  expect(slow.values).toEqual([10]);
  expect(fast.counters.overlappingRuns).toBeGreaterThan(0);
  expect(slow.counters.storeBytes).toBe(16);
  expect(slow.counters.overlappingRuns).toBeGreaterThan(0);
});

/** A source just above the shared-axis retention threshold, with two real field values. */
async function review47LongTime(base: string, chunkSize = 16_384) {
  const length = 2_097_153;
  const served = await liveStore([10, 20], 1, 1);
  resizeStoreArray(served, "u", [length, 1, 1], [1, 1, 1]);
  resizeStoreArray(served, "time", [length], [chunkSize]);
  writeTimeChunks(served, length, chunkSize);
  const counts = serve(served);
  const active = seriesOf(base, 1);
  const stamp = (i: number, v: number) => {
    const raw = served.get(`/time/c/${Math.floor(i / chunkSize)}`)!;
    new Float64Array(raw.buffer)[i % chunkSize] = v;
  };
  return { length, chunkSize, served, counts, active, stamp };
}

it("review47 preserves both long-axis corrections published before the next plot", async () => {
  const { active, stamp, chunkSize } = await review47LongTime(
    "review47-sequential"
  );
  await active.describe();
  stamp(1, 1.25);
  await active.runner.forgetPublished(active.base, 1, 1);
  stamp(chunkSize, chunkSize + 0.25);
  await active.runner.forgetPublished(active.base, chunkSize, chunkSize);
  const warm = (await active.describe()).time!.raw;
  const cold = (await seriesOf("review47-sequential-control", 1).describe())
    .time!.raw;
  expect([cold[1], cold[chunkSize]]).toEqual([1.25, chunkSize + 0.25]);
  expect([warm[1], warm[chunkSize]]).toEqual([cold[1], cold[chunkSize]]);
}, 60_000);

it("review47 avoids materializing a per-date Map when one long-axis chunk is polled", async () => {
  const { active, counts } = await review47LongTime(
    "review47-sparse-poll",
    262_144
  );
  await active.describe();
  const before = counts.time;
  const set = Map.prototype.set;
  let entries = 0;
  Map.prototype.set = function (key, value) {
    if (typeof key === "number" && key === value) {
      entries++;
    }
    return set.call(this, key, value);
  };
  try {
    await active.runner.forgetPublished(active.base, 1, 1);
  } finally {
    Map.prototype.set = set;
  }
  expect(counts.time - before).toBe(1);
  expect(entries).toBeLessThan(1024);
}, 60_000);

it("review47 preserves interval bounds on a sparsely published long time coordinate", async () => {
  const length = 2_097_153;
  const chunks = 16_384;
  const served = await liveStore([10, 20], 1, 1);
  await write(served, "time", [0.5, 1.5], [2], ["time"], {
    units: "days since 2000-01-01",
    bounds: "tb",
  });
  await write(served, "tb", [0, 1, 1, 2], [2, 2], ["time", "nv"]);
  resizeStoreArray(served, "u", [length, 1, 1], [1, 1, 1]);
  resizeStoreArray(served, "time", [length], [chunks]);
  resizeStoreArray(served, "tb", [length, 2], [chunks, 2]);
  const time = new Float64Array(chunks).fill(NaN);
  time.set([0.5, 1.5]);
  served.delete("/time/c/1");
  served.set("/time/c/0", new Uint8Array(time.buffer));
  const edges = new Float64Array(chunks * 2).fill(NaN);
  edges.set([0, 1, 1, 2]);
  served.set("/tb/c/0/0", new Uint8Array(edges.buffer));
  serve(served);
  const active = seriesOf("review47-partial-axis", 2);
  expect((await active.describe()).time!.bounds).toEqual([0, 1, 1, 2]);
  time[1] = 1.75;
  await active.runner.forgetPublished(active.base, 1, 1);
  const refreshed = await active.describe();
  expect(refreshed.time!.raw).toEqual([0.5, 1.75]);
  const cold = await seriesOf("review47-partial-control", 2).describe();
  expect(cold.time!.bounds).toEqual([0, 1, 1, 2]);
  expect(refreshed.time!.bounds).toEqual(cold.time!.bounds);
}, 60_000);

it("review48 keeps untouched bounds in the same unit after a live cache miss", async () => {
  const served = await liveStore([10, 20], 1);
  const base = "review48-bounds-units";
  await write(
    served,
    "time",
    [0.5, 1.5],
    [2],
    ["time"],
    {
      units: "days since 2000-01-01",
      bounds: "tb",
    },
    [1]
  );
  await write(
    served,
    "tb",
    [0, 24, 24, 48],
    [2, 2],
    ["time", "nv"],
    {
      units: "hours since 2000-01-01",
    },
    [1, 2]
  );
  serve(served);
  const active = seriesOf(base, 2);
  expect((await active.describe()).time!.bounds).toEqual([0, 1, 1, 2]);
  // Four full-capacity cache entries evict this tiny source's shared axes.
  // Only the first timestamp is populated, so descriptions remain small.
  const pressure = await liveStore([7], 1);
  const n = 2 ** 21,
    chunk = 2 ** 16;
  resizeStoreArray(pressure, "time", [n], [chunk]);
  resizeStoreArray(pressure, "u", [n, 1, 1], [1, 1, 1]);
  const first = new Float64Array(chunk).fill(Number.NaN);
  first[0] = 0;
  pressure.set("/time/c/0", new Uint8Array(first.buffer));
  serve(pressure);
  for (let k = 0; k < 5; k++) {
    await seriesOf(base + "-pressure-" + k, 1).describe();
  }
  serve(served);
  served.set("/tb/c/1/0", new Uint8Array(Float64Array.of(24, 54).buffer));
  await active.runner.forgetPublished(base, 1, 1);
  const warm = (await active.describe()).time!.bounds;
  const cold = (await seriesOf(base + "-fresh", 2).describe()).time!.bounds;
  expect(cold).toEqual([0, 1, 1, 2.25]);
  expect(warm).toEqual(cold);
}, 120_000);

it("review48 admits a large time-coordinate shard index before the first range read", async () => {
  const served = await liveStore([11], 1);
  const key = "/time/zarr.json";
  const meta = JSON.parse(new TextDecoder().decode(served.get(key)));
  const inner = meta.codecs;
  Reflect.set(meta.chunk_grid.configuration, "chunk_shape", [2 ** 23]);
  /* eslint-disable camelcase -- Standard Zarr sharding metadata. */
  meta.codecs = [
    {
      name: "sharding_indexed",
      configuration: {
        chunk_shape: [1],
        codecs: inner,
        index_codecs: [{ name: "bytes", configuration: { endian: "little" } }],
      },
    },
  ];
  /* eslint-enable camelcase */
  served.set(key, new TextEncoder().encode(JSON.stringify(meta)));
  serve(served);
  const normal = fetch;
  const indexReads: string[] = [];
  vi.stubGlobal("fetch", (r: Request) => {
    if (new URL(r.url).pathname.endsWith("/time/c/0")) {
      indexReads.push(r.headers.get("Range") ?? "full object");
      return Promise.resolve(new Response(null, { status: 503 }));
    }
    return normal(r);
  });
  await seriesOf("review48-sharded-coordinate", 1)
    .describe()
    .catch(() => undefined);
  expect(indexReads).toEqual([]);
});

it("review48 polls an unchanged retained axis without copying or checking every date", async () => {
  const length = 131_072,
    chunkSize = 4_096;
  const served = await liveStore([10], 1);
  resizeStoreArray(served, "u", [length, 1, 1], [1, 1, 1]);
  resizeStoreArray(served, "time", [length], [chunkSize]);
  writeTimeChunks(served, length, chunkSize);
  const counts = serve(served);
  const active = seriesOf("review48-retained-axis-poll", 1);
  await active.describe();
  const before = counts.time;
  const slice = Array.prototype.slice;
  let copied = 0;
  Array.prototype.slice = function (
    this: number[],
    start?: number,
    end?: number
  ) {
    const result = slice.call(this, start, end);
    if (this.length === length && this[0] === 0 && this.at(-1) === length - 1) {
      copied += result.length;
    }
    return result;
  };
  try {
    await active.runner.forgetPublished(active.base, 1, 1);
  } finally {
    Array.prototype.slice = slice;
  }
  expect(counts.time - before).toBe(1);
  expect(copied).toBeLessThanOrEqual(chunkSize);
});

it("review48 a coordinate whose name prefixes its bounds rereads only the published timestamp chunk", async () => {
  const n = 2 ** 21 + 1;
  const chunk = 16_384;
  const served = await liveStore([10, 20], 1);
  await write(served, "time", [0.5, 1.5], [2], ["time"], {
    units: "days since 2000-01-01",
    bounds: "time_bnds",
  });
  await write(served, "time_bnds", [0, 1, 1, 2], [2, 2], ["time", "nv"]);
  resizeStoreArray(served, "u", [n, 1, 1], [1, 1, 1]);
  resizeStoreArray(served, "time", [n], [chunk]);
  resizeStoreArray(served, "time_bnds", [n, 2], [chunk, 2]);
  const time = new Float64Array(chunk).fill(Number.NaN);
  time.set([0.5, 1.5]);
  const bounds = new Float64Array(2 * chunk).fill(Number.NaN);
  bounds.set([0, 1, 1, 2]);
  served.set("/time/c/0", new Uint8Array(time.buffer));
  served.set("/time_bnds/c/0/0", new Uint8Array(bounds.buffer));
  const counts = serve(served);
  const active = seriesOf("review48-time-bounds-names", 2);
  expect((await active.describe()).time!.bounds).toEqual([0, 1, 1, 2]);
  const before = counts.time;
  time[1] = 1.75;
  await active.runner.forgetPublished(active.base, 1, 1);
  expect((await active.describe()).time!.raw).toEqual([0.5, 1.75]);
  expect(counts.time - before).toBe(1);
}, 120_000);
it("interim48 keeps the newest timestamp when overlapping long-axis refreshes finish in reverse order", async () => {
  const { active, stamp } = await review47LongTime(
    "review48-reverse-publication"
  );
  await active.describe();
  const ordinaryFetch = globalThis.fetch;
  let announce!: () => void, release!: () => void;
  const captured = new Promise<void>((resolve) => {
    announce = resolve;
  });
  const hold = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  vi.stubGlobal("fetch", async (request: Request | string) => {
    const url = request instanceof Request ? request.url : request;
    const response = await ordinaryFetch(request);
    if (first && url.endsWith("/time/c/0")) {
      first = false;
      const bytes = await response.arrayBuffer();
      announce();
      await hold;
      return new Response(bytes, {
        status: response.status,
        headers: response.headers,
      });
    }
    return response;
  });
  stamp(1, 1.25);
  const slow = active.runner.forgetPublished(active.base, 1, 1);
  await captured;
  stamp(1, 1.75);
  const newer = active.runner.forgetPublished(active.base, 1, 1);
  // A serialized implementation may need the first response to finish; in
  // either order the next plot must agree with a cold reader of the store.
  await Promise.race([newer, delay(1000)]);
  release();
  await Promise.all([slow, newer]);
  const warm = (await active.describe()).time!.raw[1];
  const cold = (await seriesOf("review48-reverse-control", 1).describe()).time!
    .raw[1];
  expect(cold).toBe(1.75);
  expect(warm).toBe(cold);
}, 120000);
