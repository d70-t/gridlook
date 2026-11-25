/* eslint-disable camelcase -- CF and UGRID metadata use snake_case keys. */
import { expect, it, vi } from "vitest";
import * as zarr from "zarrita";

import { AnalysisRunner } from "@/lib/analysis/analysisRunner.ts";
import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { alignTo, partnerQuery } from "@/lib/analysis/companionAlign.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { exportModel } from "@/lib/analysis/scientificExport.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import {
  ALGORITHM_VERSION,
  ANALYSIS_KINDS,
  type TAnalysisQuery,
  type TGeometry,
} from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

type TStore = Map<string, Uint8Array>;

async function newStore() {
  const store: TStore = new Map();
  await zarr.create(zarr.root(store), { attributes: {} });
  return store;
}

async function write(
  store: TStore,
  path: string,
  data: number[],
  shape: number[],
  dims: string[],
  attrs: Record<string, unknown> = {},
  dtype: "float64" | "int32" = "float64"
) {
  const array = await zarr.create(zarr.root(store).resolve(path), {
    shape,
    chunkShape: shape,
    dtype,
    dimensionNames: dims,
    attributes: attrs,
    fillValue: (dtype === "int32" ? -1 : Number.NaN) as never,
  });
  if (!shape.length) {
    await zarr.set(array as never, null, data[0] as never);
    return;
  }
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((product, n) => product * n, 1)
  );
  await zarr.set(array as never, null, {
    data: dtype === "int32" ? Int32Array.from(data) : Float64Array.from(data),
    shape,
    stride,
  } as never);
}

function context(store: TStore, variable: string) {
  return resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      store as never,
      "",
      ZARR_FORMAT.V3,
      `native-${Math.random()}`
    ),
    variable,
    new ByteLru<BigInt64Array>(2 ** 20)
  );
}

function q(
  kind: TAnalysisQuery["kind"],
  variable: string,
  geometry: TGeometry,
  extra: Partial<TAnalysisQuery> = {}
): TAnalysisQuery {
  return {
    version: ALGORITHM_VERSION,
    kind,
    source: { ref: "memory", versionStatus: "session" },
    variable,
    geometry,
    fixed: {},
    ...extra,
  };
}

async function run(
  ctx: Awaited<ReturnType<typeof context>>,
  query: TAnalysisQuery
) {
  const planned = await planAnalysis(ctx, query, new ReadContext());
  return planned.execute();
}

/** GEFS-like: init_time × lead_time × lat × lon, valid = init + lead. */
async function forecast() {
  const store = await newStore();
  await write(
    store,
    "init_time",
    [1727740800, 1727827200],
    [2],
    ["init_time"],
    {
      standard_name: "forecast_reference_time",
      units: "seconds since 1970-01-01",
      calendar: "proleptic_gregorian",
    }
  );
  await write(store, "lead_time", [0, 86400, 172800], [3], ["lead_time"], {
    standard_name: "forecast_period",
    units: "seconds",
  });
  await write(store, "lat", [27.75, 28], [2], ["lat"], {
    units: "degrees_north",
  });
  await write(store, "lon", [-82.5, -82.25], [2], ["lon"], {
    units: "degrees_east",
  });
  await write(
    store,
    "t2m",
    Array.from({ length: 24 }, (_, k) => 20 + k),
    [2, 3, 2, 2],
    ["init_time", "lead_time", "lat", "lon"],
    { units: "degC", standard_name: "air_temperature" }
  );
  return store;
}

it("review of interim45: a forecast at a fixed lead exports its valid times", async () => {
  const ctx = await context(await forecast(), "t2m");
  const result = await run(
    ctx,
    q(
      ANALYSIS_KINDS.POINT_SERIES,
      "t2m",
      { kind: "point", lat: 28, lon: -82.5 },
      {
        fixed: { lead_time: 2 },
        time: { start: 0, stop: 2 },
      }
    )
  );
  expect(result.time?.standardName).toBe("forecast_reference_time");
  const model = exportModel(result);
  const byName = (name: string) => model.arrays.find((a) => a.name === name)!;
  // Valid time: 3 and 4 October 2024, two days after the initializations.
  expect(Array.from(byName("time").data as Float64Array)).toEqual([
    1727913600, 1728000000,
  ]);
  expect(byName("time").attrs.standard_name).toBe("time");
  expect(
    Array.from(byName("forecast_reference_time").data as Float64Array)
  ).toEqual([1727740800, 1727827200]);
  const period = byName("lead_time");
  expect(Array.from(period.data as Float64Array)).toEqual([172800]);
  expect(period.attrs).toMatchObject({
    standard_name: "forecast_period",
    units: "seconds",
  });
  const field = byName("t2m");
  expect(String(field.attrs.coordinates).split(" ")).toEqual(
    expect.arrayContaining(["forecast_reference_time", "lead_time"])
  );
});

it("review of interim45: without a fixed lead, reference times are not called valid", async () => {
  const ctx = await context(await forecast(), "t2m");
  const result = await run(
    ctx,
    q(
      ANALYSIS_KINDS.POINT_SERIES,
      "t2m",
      { kind: "point", lat: 28, lon: -82.5 },
      {
        fixed: { lead_time: 2 },
        time: { start: 0, stop: 2 },
      }
    )
  );
  const model = exportModel({ ...result, selections: [] });
  const time = model.arrays.find((a) => a.name === "time")!;
  expect(time.attrs.standard_name).toBe("forecast_reference_time");
  expect(Array.from(time.data as Float64Array)).toEqual([
    1727740800, 1727827200,
  ]);
});

it("review of interim45: the chart and script name initialization times", async () => {
  const { chartSpec } = await import("@/ui/analysis/plotFigure.ts");
  const { pythonScript } = await import("@/lib/analysis/pythonExport.ts");
  const ctx = await context(await forecast(), "t2m");
  const result = await run(
    ctx,
    q(
      ANALYSIS_KINDS.POINT_SERIES,
      "t2m",
      { kind: "point", lat: 28, lon: -82.5 },
      { fixed: { lead_time: 2 }, time: { start: 0, stop: 2 } }
    )
  );
  expect(JSON.stringify(chartSpec(result))).toContain("Initialization time");
  expect(pythonScript(result, "p", "P")).toContain("initialization time");
});

function selectedLead() {
  return q(
    ANALYSIS_KINDS.POINT_SERIES,
    "t2m",
    { kind: "point", lat: 28, lon: -82.5 },
    { fixed: { lead_time: 2 }, time: { start: 0, stop: 2 } }
  );
}

it("interim47: valid times use the decoded CF forecast period", async () => {
  const store = await forecast();
  await write(
    store,
    "lead_time",
    [0, 1, 2],
    [3],
    ["lead_time"],
    {
      standard_name: "forecast_period",
      units: "hours",
      scale_factor: 24,
    },
    "int32"
  );
  const result = await run(await context(store, "t2m"), selectedLead());
  const model = exportModel(result);
  expect(
    Array.from(
      model.arrays.find((a) => a.name === "time")!.data as Float64Array
    )
  ).toEqual([1727913600, 1728000000]);
});

it("interim47: missing lead metadata cannot create a valid date", async () => {
  const store = await forecast();
  await write(
    store,
    "lead_time",
    [0, 1, -9999],
    [3],
    ["lead_time"],
    {
      standard_name: "forecast_period",
      units: "hours",
      _FillValue: -9999,
    },
    "int32"
  );
  const result = await run(await context(store, "t2m"), selectedLead());
  const time = exportModel(result).arrays.find((a) => a.name === "time")!;
  expect([
    time.attrs.standard_name,
    ...Array.from(time.data as Float64Array),
  ]).toEqual(["forecast_reference_time", 1727740800, 1727827200]);
});

it("interim47: a forecast accumulation retains its source interval at valid time", async () => {
  const store = await forecast();
  await write(store, "lead_time", [0, 24, 48], [3], ["lead_time"], {
    standard_name: "forecast_period",
    units: "hours",
    bounds: "lead_bounds",
  });
  await write(
    store,
    "lead_bounds",
    [0, 0, 0, 24, 24, 48],
    [3, 2],
    ["lead_time", "nv"]
  );
  await write(
    store,
    "precip",
    Array.from({ length: 24 }, (_, k) => k),
    [2, 3, 2, 2],
    ["init_time", "lead_time", "lat", "lon"],
    {
      standard_name: "precipitation_amount",
      units: "kg m-2",
      cell_methods: "time: sum",
    }
  );
  const result = await run(await context(store, "precip"), {
    ...selectedLead(),
    variable: "precip",
  });
  const model = exportModel(result);
  const time = model.arrays.find((a) => a.name === "time")!;
  const bounds = model.arrays.find((a) => a.name === time.attrs.bounds);
  const period = model.arrays.find(
    (a) => a.attrs.standard_name === "forecast_period"
  )!;
  const periodBounds = model.arrays.find((a) => a.name === period.attrs.bounds);
  if (!bounds && periodBounds) {
    expect(Array.from(periodBounds.data as Float64Array)).toEqual([24, 48]);
    return;
  }
  expect(bounds && Array.from(bounds.data as Float64Array)).toEqual([
    1727827200, 1727913600, 1727913600, 1728000000,
  ]);
});

it("interim47: companion values come from the same forecast lead after reordering", async () => {
  const store = await forecast();
  const sister = await forecast();
  await write(sister, "lead_time", [48, 24, 0], [3], ["lead_time"], {
    standard_name: "forecast_period",
    units: "hours",
  });
  for (const [key, bytes] of sister) {
    store.set("/other" + key, bytes);
  }
  const a = await context(store, "t2m");
  const b = await context(store, "other/t2m");
  const query = selectedLead();
  const paired = partnerQuery(
    query,
    { others: a.others },
    { others: b.others },
    "other/t2m"
  );
  if ("reason" in paired) {
    throw new Error(paired.reason);
  }
  const result = alignTo(await run(a, query), await run(b, paired));
  // At 28 N, 82.5 W the 48-hour row is 22 and 34 in the partner.
  expect(result).toEqual({ matched: 2, values: [22, 34] });
});

it("interim48: leads in microseconds give valid times", async () => {
  const store = await forecast();
  await write(store, "lead_time", [0, 864e8, 1728e8], [3], ["lead_time"], {
    standard_name: "forecast_period",
    units: "microseconds",
  });
  const result = await run(await context(store, "t2m"), selectedLead());
  const time = exportModel(result).arrays.find((a) => a.name === "time")!;
  expect([
    time.attrs.standard_name,
    ...Array.from(time.data as Float64Array),
  ]).toEqual(["time", 1727913600, 1728000000]);
});

it("interim48: a long lead axis is read at the chosen lead, not described whole", async () => {
  const store = await forecast();
  const n = 8193;
  const lead = await zarr.create(zarr.root(store).resolve("lead_time"), {
    shape: [n],
    chunkShape: [1],
    dtype: "float64",
    dimensionNames: ["lead_time"],
    attributes: { standard_name: "forecast_period", units: "hours" },
  });
  await zarr.set(lead, null, {
    data: Float64Array.from({ length: n }, (_, k) => k),
    shape: [n],
    stride: [1],
  });
  await write(
    store,
    "t2m",
    Array.from({ length: 2 * n * 4 }, (_, k) => k),
    [2, n, 2, 2],
    ["init_time", "lead_time", "lat", "lon"],
    { units: "degC", standard_name: "air_temperature" }
  );
  let gets = 0;
  const counted = new Proxy(store, {
    get(target, key) {
      if (key === "get") {
        return (path: string) => {
          if (path.startsWith("/lead_time/c")) {
            gets++;
          }
          return target.get(path);
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  const ctx = await context(counted as TStore, "t2m");
  const described = gets;
  const result = await run(ctx, {
    ...selectedLead(),
    fixed: { lead_time: 4000 },
  });
  expect([described, gets]).toEqual([0, 1]);
  expect(result.selections?.[0]).toMatchObject({ value: 4000, units: "hours" });
});

it("interim48: vector components match leads by duration, not by label", async () => {
  const { jointAlignment } = await import("@/lib/analysis/jointComponents.ts");
  const store = await forecast();
  const sister = await forecast();
  await write(sister, "lead_time", [2, 1, 0], [3], ["lead_time"], {
    standard_name: "forecast_period",
    units: "days",
  });
  for (const [key, bytes] of sister) {
    store.set("/v" + key, bytes);
  }
  const joint = await jointAlignment(
    await context(store, "t2m"),
    await context(store, "v/t2m"),
    undefined
  );
  if ("reason" in joint) {
    throw new Error(joint.reason);
  }
  expect(Array.from(joint.maps.get(1)!)).toEqual([2, 1, 0]);
});

// The store's queryFor uses worker descriptions, not the internal variable contexts.
it("matches a companion lead through the worker summaries delivered to the plot", async () => {
  const store = await forecast();
  const companion = await forecast();
  await write(companion, "lead_time", [48, 24, 0], [3], ["lead_time"], {
    standard_name: "forecast_period",
    units: "hours",
  });
  for (const [path, bytes] of companion) {
    store.set("/other" + path, bytes);
  }
  const server = "https://example.org/lead-order.zarr";
  vi.stubGlobal("fetch", async (input: Request) => {
    const bytes = store.get(
      new URL(input.url).pathname.slice("/lead-order.zarr".length)
    );
    return bytes
      ? new Response(bytes as BodyInit)
      : new Response(null, { status: 404 });
  });
  const source = {
    key: server,
    store: server,
    dataset: "",
    format: ZARR_FORMAT.V3,
  };
  const runner = new AnalysisRunner();
  try {
    const own = await runner.describe(source, "t2m");
    const other = await runner.describe(source, "other/t2m");
    const query = selectedLead();
    const paired = partnerQuery(query, own, other, "other/t2m");
    if ("reason" in paired) {
      throw new Error(paired.reason);
    }
    await runner.plan("primary", source, query);
    await runner.plan("partner", source, paired);
    const actual = alignTo(
      await runner.execute("primary"),
      await runner.execute("partner")
    );
    expect(actual).toEqual({ matched: 2, values: [22, 34] });
  } finally {
    await runner.release(source.key);
    vi.unstubAllGlobals();
  }
});

async function boundedForecast(leadChunk: number, boundsChunk: number) {
  const store = await forecast();
  const n = 96;
  const leads = await zarr.create(zarr.root(store).resolve("lead_time"), {
    shape: [n],
    chunkShape: [leadChunk],
    dtype: "float64",
    dimensionNames: ["lead_time"],
    attributes: {
      standard_name: "forecast_period",
      units: "hours",
      bounds: "lead_bounds",
    },
  });
  await zarr.set(leads, null, {
    data: Float64Array.from({ length: n }, (_, k) => k),
    shape: [n],
    stride: [1],
  });
  const bounds = await zarr.create(zarr.root(store).resolve("lead_bounds"), {
    shape: [n, 2],
    chunkShape: [boundsChunk, 2],
    dtype: "float64",
    dimensionNames: ["lead_time", "nv"],
  });
  await zarr.set(bounds, null, {
    data: Float64Array.from(
      { length: n * 2 },
      (_, k) => Math.floor(k / 2) - (k % 2 ? 0 : 1)
    ),
    shape: [n, 2],
    stride: [2, 1],
  });
  await write(
    store,
    "rain",
    Array.from({ length: 2 * n * 4 }, (_, k) => k),
    [2, n, 2, 2],
    ["init_time", "lead_time", "lat", "lon"],
    {
      units: "kg m-2",
      standard_name: "precipitation_amount",
      cell_methods: "time: sum",
    }
  );
  return store;
}

const selectedHour = () => ({
  ...selectedLead(),
  variable: "rain",
  fixed: { lead_time: 48 },
});

it("keeps the selected accumulation interval when leads span more than 64 chunks", async () => {
  const eager = await run(
    await context(await boundedForecast(96, 1), "rain"),
    selectedHour()
  );
  const lazy = await run(
    await context(await boundedForecast(1, 1), "rain"),
    selectedHour()
  );
  const interval = (result: typeof lazy) => {
    const model = exportModel(result);
    const time = model.arrays.find((a) => a.name === "time")!;
    const bounds = model.arrays.find((a) => a.name === time.attrs.bounds);
    return bounds && Array.from(bounds.data as Float64Array);
  };
  expect(interval(eager)).toEqual([
    1727910000, 1727913600, 1727996400, 1728000000,
  ]);
  expect(interval(lazy)).toEqual(interval(eager));
});

it("bounds the lead-bound reads before selecting a forecast hour", async () => {
  const store = await boundedForecast(96, 1);
  const get = vi.spyOn(store, "get");
  const ctx = await context(store, "rain");
  const boundsReads = () =>
    get.mock.calls.filter(([key]) => key.startsWith("/lead_bounds/c/")).length;
  const before = boundsReads();
  await run(ctx, selectedHour());
  expect(before).toBeLessThanOrEqual(1);
  expect(boundsReads()).toBeLessThanOrEqual(1);
});

it("declines an Against pair of hourly and daily rain totals sharing a forecast endpoint", async () => {
  const primary = await boundedForecast(96, 96);
  const other = await boundedForecast(96, 96);
  const daily = Array.from({ length: 192 }, (_, k) =>
    Math.max(0, Math.floor(k / 2) - (k % 2 ? 0 : 24))
  );
  await write(other, "lead_bounds", daily, [96, 2], ["lead_time", "nv"]);
  const [left, right] = await Promise.all([
    context(primary, "rain"),
    context(other, "rain"),
  ]);
  const query = selectedHour();
  const next = partnerQuery(
    query,
    { others: left.others },
    { others: right.others },
    "rain"
  );
  if ("reason" in next) {
    return;
  }
  const a = await run(left, query);
  const b = await run(right, next);
  expect(a.selections?.[0].valueBounds).toEqual([47, 48]);
  expect(b.selections?.[0].valueBounds).toEqual([24, 48]);
  const aligned = alignTo(a, b);
  expect("reason" in aligned ? 0 : aligned.matched).toBe(0);
});

it("uses a declared auxiliary lead coordinate when its index dimension has another name", async () => {
  const store = await forecast();
  await write(store, "step", [0, 1, 2], [3], ["step"]);
  await write(store, "forecast_hours", [0, 24, 48], [3], ["step"], {
    standard_name: "forecast_period",
    units: "hours",
  });
  await write(
    store,
    "tas",
    Array.from({ length: 24 }, (_, k) => k),
    [2, 3, 2, 2],
    ["init_time", "step", "lat", "lon"],
    {
      standard_name: "air_temperature",
      units: "K",
      coordinates: "forecast_hours",
    }
  );
  const result = await run(await context(store, "tas"), {
    ...selectedLead(),
    variable: "tas",
    fixed: { step: 2 },
  });
  const fieldTime = exportModel(result).arrays.find((a) => a.name === "time")!;
  expect([
    fieldTime.attrs.standard_name,
    ...Array.from(fieldTime.data as Float64Array),
  ]).toEqual(["time", 1727913600, 1728000000]);
});

it("keeps distinct digit-only text members beyond the range of uint64 in the exported coordinate", async () => {
  const store = await forecast();
  const labels = [
    "18446744073709551616",
    "18446744073709551617",
    "18446744073709551618",
  ];
  await zarr.create(zarr.root(store).resolve("lead_time"), {
    shape: [3],
    chunkShape: [3],
    dtype: "string",
    dimensionNames: ["lead_time"],
    attributes: { standard_name: "realization" },
  });
  const chunk = new Uint8Array(
    4 + labels.reduce((total, s) => total + 4 + s.length, 0)
  );
  const header = new DataView(chunk.buffer);
  header.setUint32(0, labels.length, true);
  let at = 4;
  for (const label of labels) {
    header.setUint32(at, label.length, true);
    chunk.set(new TextEncoder().encode(label), at + 4);
    at += 4 + label.length;
  }
  store.set("/lead_time/c/0", chunk);
  const ctx = await context(store, "t2m");
  const written = [];
  for (const [index, id] of labels.entries()) {
    const result = await run(ctx, {
      ...selectedLead(),
      fixed: { lead_time: index },
    });
    expect(result.selections?.[0].id).toBe(id);
    const coord = exportModel(result).arrays.find(
      (a) => a.name === "lead_time"
    )!;
    written.push(String(coord.data[0]));
  }
  expect(new Set(written).size).toBe(labels.length);
});

it("interim49: packed member codes are paired and exported as their decoded members", async () => {
  const store = await forecast();
  await write(
    store,
    "realization",
    [1, 2],
    [2],
    ["realization"],
    {
      standard_name: "realization",
      add_offset: 100,
    },
    "int32"
  );
  await write(
    store,
    "tas",
    Array.from({ length: 2 * 2 * 3 * 4 }, (_, k) => k),
    [2, 2, 3, 2, 2],
    ["realization", "init_time", "lead_time", "lat", "lon"],
    { units: "K" }
  );
  const ctx = await context(store, "tas");
  expect(ctx.others.find((o) => o.dimension === "realization")?.ids).toEqual([
    "101",
    "102",
  ]);
  const result = await run(ctx, {
    ...selectedLead(),
    variable: "tas",
    fixed: { realization: 0, lead_time: 2 },
  });
  expect(result.selections?.find((s) => s.ensemble)?.id).toBe("101");
});

it("interim49: a scalar forecast period dates a forecast along its reference times", async () => {
  const store = await forecast();
  await write(store, "fp", [48], [], [], {
    standard_name: "forecast_period",
    units: "hours",
  });
  await write(
    store,
    "tas",
    Array.from({ length: 8 }, (_, k) => k),
    [2, 2, 2],
    ["init_time", "lat", "lon"],
    { units: "K", coordinates: "fp" }
  );
  const result = await run(await context(store, "tas"), {
    ...selectedLead(),
    variable: "tas",
    fixed: {},
  });
  const time = exportModel(result).arrays.find((a) => a.name === "time")!;
  expect([
    time.attrs.standard_name,
    ...Array.from(time.data as Float64Array),
  ]).toEqual(["time", 1727913600, 1728000000]);
});

it("interim49: leads pair at a microsecond, and a partner's unread lead is found where it is read", async () => {
  const leads = async (values: number[], units: string, chunk: number) => {
    const store = await forecast();
    const array = await zarr.create(zarr.root(store).resolve("lead_time"), {
      shape: [values.length],
      chunkShape: [chunk],
      dtype: "float64",
      dimensionNames: ["lead_time"],
      attributes: { standard_name: "forecast_period", units },
    });
    await zarr.set(array, null, {
      data: Float64Array.from(values),
      shape: [values.length],
      stride: [1],
    });
    await write(
      store,
      "t2m",
      Array.from({ length: 2 * values.length * 4 }, (_, k) => k),
      [2, values.length, 2, 2],
      ["init_time", "lead_time", "lat", "lon"],
      { units: "K" }
    );
    return context(store, "t2m");
  };
  const own = await leads([0, 24, 48], "hours", 3);
  const query = { ...selectedLead(), fixed: { lead_time: 2 } };
  const near = await leads([0, 86400, 172800.1], "seconds", 3);
  expect("reason" in partnerQuery(query, own, near, "t2m")).toBe(true);
  const days = await leads([0, 1, 2], "days", 3);
  const paired = partnerQuery(query, own, days, "t2m");
  expect("reason" in paired ? paired.reason : paired.fixed.lead_time).toBe(2);
  // 65 one-lead chunks, none read yet: asked for by duration, found there.
  const long = await leads(
    Array.from({ length: 65 }, (_, k) => 64 - k),
    "hours",
    1
  );
  const next = partnerQuery(query, own, long, "t2m");
  if ("reason" in next) {
    throw new Error(next.reason);
  }
  expect(next.leadSeconds).toEqual({ lead_time: 172800 });
  const read = await run(long, next);
  expect(read.selections?.[0]).toMatchObject({ index: 16, value: 48 });
});

it("interim49: a forecast CSV names reference time, valid time and lead apart", async () => {
  const { resultTable, resultProvenance } =
    await import("@/lib/analysis/analysisExport.ts");
  const result = await run(await context(await forecast(), "t2m"), {
    ...selectedLead(),
    fixed: { lead_time: 2 },
  });
  const table = resultTable(result);
  expect(table.header.slice(2, 5)).toEqual([
    "forecast_reference_time (proleptic_gregorian)",
    "valid_time (proleptic_gregorian)",
    "forecast_period (seconds)",
  ]);
  const [first] = [table.row(0)];
  expect(String(first[2])).toMatch(/^2024-10-01/);
  expect(String(first[3])).toMatch(/^2024-10-03/);
  expect(first[4]).toBe(172800);
  expect(resultProvenance(result).selections?.[0]).toMatchObject({
    value: 172800,
    units: "seconds",
    standardName: "forecast_period",
  });
});
