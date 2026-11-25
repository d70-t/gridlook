/* eslint-disable camelcase, max-lines-per-function -- CF metadata uses snake_case keys. */
import { expect, it, vi } from "vitest";
import * as z from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { partnerQuery } from "@/lib/analysis/companionAlign.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { exportModel } from "@/lib/analysis/scientificExport.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import type { TAnalysisQuery, TAnalysisResult } from "@/lib/analysis/types.ts";
import {
  resolveVariableContext,
  type TVariableContext,
} from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";
import { pairSeries, validTimeAxis } from "@/ui/analysis/compare.ts";

vi.mock("@/store/store.ts", () => ({ useGlobeControlStore: () => ({}) }));
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
const { windAt } = await import("@/store/analysisStore.ts");

type TStore = Map<string, Uint8Array>;

async function root() {
  const s: TStore = new Map();
  await z.create(z.root(s), { attributes: {} });
  return s;
}

async function write(
  s: TStore,
  name: string,
  data: (number | bigint | string)[],
  shape: number[],
  dims: string[],
  attrs: Record<string, unknown> = {},
  chunk = shape,
  type = "float64"
) {
  const a = await z.create(z.root(s).resolve(name), {
    dtype: type,
    shape,
    chunkShape: chunk,
    dimensionNames: dims,
    attributes: attrs,
    fillValue: type === "float64" ? NaN : type === "int32" ? -99999 : undefined,
  } as never);
  if (type === "string") {
    const size = (n: number) => {
      const b = Buffer.alloc(4);
      b.writeUInt32LE(n);
      return b;
    };
    const parts = (data as string[]).flatMap((id) => {
      const bytes = Buffer.from(id);
      return [size(bytes.length), bytes];
    });
    s.set(
      `/${name}/c/0`,
      Uint8Array.from(Buffer.concat([size(data.length), ...parts]))
    );
    return;
  }
  if (!shape.length) {
    await z.set(a as never, null, data[0] as never);
    return;
  }
  const buf =
    type === "int64"
      ? BigInt64Array.from(data as bigint[])
      : type === "int32"
        ? Int32Array.from(data as number[])
        : Float64Array.from(data as number[]);
  await z.set(a as never, null, {
    data: buf,
    shape,
    stride: shape.map((_, k) => shape.slice(k + 1).reduce((x, y) => x * y, 1)),
  } as never);
}

function point(
  fixed: Record<string, number> = {},
  variable = "rain"
): TAnalysisQuery {
  return {
    version: 1,
    kind: "point-series",
    source: { ref: "fixture.zarr", versionStatus: "session" },
    variable,
    geometry: { kind: "point", lat: 0.5, lon: 0.5 },
    time: { start: 0, stop: 3 },
    fixed,
  } as TAnalysisQuery;
}

async function context(s: unknown, variable = "rain") {
  return (await resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      s as never,
      "",
      ZARR_FORMAT.V3,
      `f51-${Math.random()}`
    ),
    variable,
    new ByteLru(1e7)
  )) as TVariableContext;
}

async function run(c: TVariableContext, q: TAnalysisQuery) {
  return (await planAnalysis(c, q, new ReadContext())).execute();
}

async function members(
  ids: (string | number | bigint)[],
  attrs: Record<string, unknown>,
  type: string
) {
  const s = await root();
  await write(s, "time", [0, 1, 2], [3], ["time"], {
    standard_name: "time",
    units: "days since 2001-01-01",
  });
  await write(s, "lat", [0, 1], [2], ["lat"], { units: "degrees_north" });
  await write(s, "lon", [0, 1], [2], ["lon"], { units: "degrees_east" });
  await write(
    s,
    "realization_id",
    ids,
    [ids.length],
    ["member"],
    { standard_name: "realization", ...attrs },
    [ids.length],
    type
  );
  await write(
    s,
    "rain",
    Array.from({ length: 3 * ids.length * 4 }, (_, i) => i),
    [3, ids.length, 2, 2],
    ["time", "member", "lat", "lon"],
    {
      standard_name: "precipitation_amount",
      units: "kg m-2",
      coordinates: "realization_id",
    }
  );
  return context(s);
}

it("treats a declared text marker as a missing member", async () => {
  const a = await members(["NA", "ctl"], { missing_value: "NA" }, "string");
  const peer = await members(["NA", "ctl"], {}, "string");
  expect(a.others[0].ids).toEqual([undefined, "ctl"]);
  const q = point({ member: 0 });
  expect(
    partnerQuery(q, { others: a.others }, { others: peer.others }, "rain")
  ).toHaveProperty("reason");
});

it("writes a missing wide member in its family's own encoding", async () => {
  const wide = await members(
    [9007199254740992n, 9007199254740993n, -9999n],
    { _FillValue: -9999 },
    "int64"
  );
  const types = [];
  for (const member of [0, 1, 2]) {
    const model = exportModel(await run(wide, point({ member })));
    const id = model.arrays.find(
      (a) => a.dims.length === 0 && a.attrs.gridlook_index === member
    );
    types.push(id?.type);
  }
  expect(types).toEqual(["i8", "i8", "i8"]);
});

/** Rain summed over leads of 24 h, at three initializations. */
async function leads({ n = 65, scalar = false } = {}) {
  const s = await root();
  await write(s, "init", [0, 24, 48], [3], ["init"], {
    standard_name: "forecast_reference_time",
    calendar: "proleptic_gregorian",
    units: "hours since 2001-01-01",
  });
  await write(s, "lat", [0, 1], [2], ["lat"], { units: "degrees_north" });
  await write(s, "lon", [0, 1], [2], ["lon"], { units: "degrees_east" });
  const count = scalar ? 1 : n;
  const values = Array.from({ length: count }, (_, k) => (scalar ? 48 : k));
  await write(s, "lead", values, scalar ? [] : [n], scalar ? [] : ["lead"], {
    standard_name: "forecast_period",
    units: "hours",
    bounds: "lead_bnds",
  });
  await write(
    s,
    "lead_bnds",
    values.flatMap((v) => [Math.max(0, v - 24), v]),
    scalar ? [2] : [n, 2],
    scalar ? ["nv"] : ["lead", "nv"],
    {},
    scalar ? [2] : [1, 2]
  );
  await write(
    s,
    "rain",
    Array.from(
      { length: 3 * count * 4 },
      (_, k) => 10 + Math.floor(k / (count * 4)) * 10
    ),
    scalar ? [3, 2, 2] : [3, n, 2, 2],
    scalar ? ["init", "lat", "lon"] : ["init", "lead", "lat", "lon"],
    {
      standard_name: "precipitation_amount",
      units: "kg m-2",
      cell_methods: "time: sum",
      ...(scalar ? { coordinates: "lead" } : {}),
    }
  );
  return s;
}

it("reads lead bounds whose metadata is published after first use", async () => {
  for (const scalar of [false, true]) {
    const s = await leads({ scalar });
    const metadata = s.get("/lead_bnds/zarr.json")!;
    s.delete("/lead_bnds/zarr.json");
    const c = await context(s);
    const q = point(scalar ? {} : { lead: 48 });
    expect((await run(c, q)).selections![0].valueBoundsUnknown).toBe(true);
    s.set("/lead_bnds/zarr.json", metadata);
    expect((await run(c, q)).selections![0].valueBounds).toEqual([24, 48]);
  }
});

const EPOCH = "hours since 2001-01-01";

/** A forecast dated three ways: published valid times, derived, or direct. */
async function dated(
  mode: "published" | "derived" | "standard",
  variable: string,
  span: number,
  options: { shift?: number; n?: number; chunk?: number; missing?: number } = {}
) {
  const { shift = 0, n = 3, missing = -1 } = options;
  const chunk = options.chunk ?? n;
  const s = await root();
  const dim =
    mode === "derived" ? "step" : mode === "standard" ? "valid" : "init";
  const leadsOf =
    n === 3 ? [24, 48, 72] : Array.from({ length: n }, (_, i) => i + 1);
  const end = leadsOf.map((lead) => lead + shift);
  await write(s, "lat", [0, 1], [2], ["lat"], { units: "degrees_north" });
  await write(s, "lon", [0, 1], [2], ["lon"], { units: "degrees_east" });
  if (mode === "derived") {
    await write(s, "init", [100], [], [], {
      standard_name: "forecast_reference_time",
      units: EPOCH,
    });
    await write(
      s,
      "step",
      end.map((v, i) => (i === missing ? -9999 : v)),
      [n],
      ["step"],
      {
        standard_name: "forecast_period",
        units: "hours",
        bounds: "tb",
        _FillValue: -9999,
      },
      [chunk]
    );
  } else {
    if (mode === "published") {
      await write(
        s,
        "init",
        Array.from({ length: n }, (_, i) => i * 24),
        [n],
        ["init"],
        {
          standard_name: "forecast_reference_time",
          units: EPOCH,
        }
      );
    }
    await write(
      s,
      "valid",
      end,
      [n],
      [dim],
      { standard_name: "time", units: EPOCH, bounds: "tb" },
      [chunk]
    );
  }
  await write(
    s,
    "tb",
    end.flatMap((t) => [t - span, t]),
    [n, 2],
    [dim, "nv"]
  );
  const wind = variable !== "rain";
  await write(
    s,
    variable,
    Array.from({ length: 4 * n }, (_, k) =>
      wind ? (variable === "u" ? 3 : 4) : 10 + 10 * Math.floor(k / 4)
    ),
    [n, 2, 2],
    [dim, "lat", "lon"],
    {
      ...(wind
        ? {
            standard_name:
              variable === "u" ? "eastward_wind" : "northward_wind",
            units: "m s-1",
            cell_methods: "time: point",
          }
        : {
            standard_name: "precipitation_amount",
            units: "kg m-2",
            cell_methods: "time: sum",
          }),
      ...(mode === "published"
        ? { coordinates: "valid" }
        : mode === "derived"
          ? { coordinates: "init" }
          : {}),
    },
    [Math.min(8, n), 2, 2]
  );
  return s;
}

function series(r: TAnalysisResult) {
  const axis = validTimeAxis(r.time!, r.selections);
  if ("reason" in axis) {
    return axis;
  }
  return {
    values: r.values,
    dates: axis.raw.map(String),
    time: { ...axis, cellMethods: r.cellMethods },
    calendar: (axis as { calendar?: string }).calendar,
  };
}

it("keeps 6- and 24-hour totals apart under every forecast dating", async () => {
  for (const mode of ["published", "derived", "standard"] as const) {
    const [six, day] = await Promise.all(
      [6, 24].map(async (span) =>
        series(
          await run(await context(await dated(mode, "rain", span)), point())
        )
      )
    );
    expect(pairSeries(six as never, day as never).reference).toEqual([]);
  }
});

it("pairs wind components by their published valid times", async () => {
  const at = async (shift: number) => {
    const [u, v] = await Promise.all(
      ["u", "v"].map(async (name, i) =>
        context(
          await dated("published", name, 0, { shift: i ? shift : 0 }),
          name
        )
      )
    );
    const [ru, rv] = await Promise.all([
      run(u, point({}, "u")),
      run(v, point({}, "v")),
    ]);
    const box = (
      c: TVariableContext,
      own: string,
      partner: string,
      other: TVariableContext
    ) =>
      planAnalysis(
        c,
        {
          ...point({}, own),
          kind: "region-series",
          geometry: { kind: "box", west: -1, east: 2, south: -1, north: 2 },
          jointWith: partner,
        } as TAnalysisQuery,
        new ReadContext(),
        undefined,
        false,
        other
      );
    return {
      point: windAt(ru, { u: "u", v: "v" }, ru, rv),
      region: box(u, "u", "v", v),
    };
  };
  const same = await at(0);
  expect(typeof same.point).not.toBe("string");
  await expect(same.region).resolves.toBeDefined();
  const week = await at(168);
  expect(typeof week.point).toBe("string");
  await expect(week.region).rejects.toThrow(/dates differ/);
});

it("checks competing clocks and keeps each row's initialization", async () => {
  const clocks = async (test: string) => {
    const s = await root();
    const rowwise = test === "rowwise";
    const dim = rowwise ? "valid" : "init";
    const scalar = test === "conflict" || test === "agreement";
    await write(s, "lat", [0, 1], [2], ["lat"], { units: "degrees_north" });
    await write(s, "lon", [0, 1], [2], ["lon"], { units: "degrees_east" });
    const base = "days since 2001-02-01";
    const valid =
      test === "calendar"
        ? [29, 30, 31]
        : test === "conflict"
          ? [5, 6, 7]
          : [2, 3, 4];
    await write(s, "init", [0, 1, 2], [3], [dim], {
      standard_name: "forecast_reference_time",
      units: base,
      calendar: "proleptic_gregorian",
    });
    await write(s, "valid", valid, [3], [dim], {
      standard_name: "time",
      ...(test === "unitless" ? {} : { units: base }),
      calendar: test === "calendar" ? "360_day" : "proleptic_gregorian",
    });
    if (scalar) {
      await write(s, "fp", [48], [], [], {
        standard_name: "forecast_period",
        units: "hours",
      });
    }
    await write(
      s,
      "rain",
      Array.from({ length: 12 }, (_, i) => i),
      [3, 2, 2],
      [dim, "lat", "lon"],
      {
        standard_name: "air_temperature",
        units: "K",
        cell_methods: "time: point",
        coordinates: rowwise ? "init" : scalar ? "valid fp" : "valid",
      }
    );
    return run(await context(s), point());
  };
  const agreement = series(await clocks("agreement"));
  expect("reason" in agreement ? agreement.reason : agreement.dates).toEqual([
    "2",
    "3",
    "4",
  ]);
  for (const test of ["conflict", "calendar", "unitless"]) {
    expect(series(await clocks(test))).toHaveProperty("reason");
  }
  const rowwise = await clocks("rowwise");
  expect(rowwise.time?.references).toEqual([0, 1, 2]);
  const model = exportModel(rowwise);
  expect(
    model.arrays.find(
      (a) => a.attrs.standard_name === "forecast_reference_time"
    )?.dims
  ).toEqual(model.arrays.find((a) => a.name === "time")?.dims);
});

it("dates derived leads within a read budget, keeping a missing one in place", async () => {
  const reads = (s: TStore) => {
    let count = 0;
    const counted = new Proxy(s, {
      get(t, k) {
        if (k === "get") {
          return (key: string) => {
            count += key.startsWith("/step/c/") ? 1 : 0;
            return t.get(key);
          };
        }
        const v = Reflect.get(t, k);
        return typeof v === "function" ? v.bind(t) : v;
      },
    });
    return { counted, count: () => count };
  };
  const long = reads(await dated("derived", "rain", 6, { n: 8193, chunk: 1 }));
  const c = await context(long.counted);
  expect(long.count()).toBe(0);
  expect(c.capabilities["point-series"].available).toBe(false);
  expect(c.capabilities["point-series"].reason).toMatch(/chunks/);
  const gap = await context(await dated("derived", "rain", 6, { missing: 1 }));
  expect(gap.capabilities["point-series"].available).toBe(true);
  expect(gap.time?.raw).toEqual([124, Number.NaN, 172]);
});
