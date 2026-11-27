/* eslint-disable max-lines-per-function, camelcase -- fixture-heavy cases with CF metadata. */
import { vi, expect, it } from "vitest";
import * as zarr from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { partnerQuery } from "@/lib/analysis/companionAlign.ts";
import { idEncoding } from "@/lib/analysis/identifiers.ts";
import { jointAlignment } from "@/lib/analysis/jointComponents.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { exportModel } from "@/lib/analysis/scientificExport.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import type { TAnalysisResult } from "@/lib/analysis/types.ts";
import { resolveVariableContext } from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";
import { validTimeAxis } from "@/ui/analysis/compare.ts";

vi.mock("@/store/store.ts", () => ({ useGlobeControlStore: () => ({}) }));
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
const { windAt } = await import("@/store/analysisStore.ts");

type TStore = Map<string, Uint8Array>;
const HOURS = "hours since 2001-01-01";

async function root() {
  const s: TStore = new Map();
  await zarr.create(zarr.root(s), { attributes: {} });
  return s;
}

async function put(
  s: TStore,
  name: string,
  data: number[],
  shape: number[],
  dims: string[],
  attrs: Record<string, unknown> = {},
  chunks = shape,
  dtype: "float64" | "int32" = "float64"
) {
  const a = await zarr.create(zarr.root(s).resolve(name), {
    dtype,
    shape,
    chunkShape: chunks,
    dimensionNames: dims,
    attributes: attrs,
    fillValue: dtype === "float64" ? Number.NaN : -99999,
  } as never);
  if (!shape.length) {
    await zarr.set(a as never, null, data[0] as never);
    return;
  }
  const stride = shape.map((_, d) =>
    shape.slice(d + 1).reduce((p, n) => p * n, 1)
  );
  await zarr.set(a as never, null, {
    data: dtype === "int32" ? Int32Array.from(data) : Float64Array.from(data),
    shape,
    stride,
  } as never);
}

/** Text identifiers, one vlen-utf8 chunk. */
function putText(s: TStore, name: string, ids: string[], attrs = {}) {
  s.set(
    `/${name}/zarr.json`,
    new TextEncoder().encode(
      JSON.stringify({
        zarr_format: 3,
        node_type: "array",
        shape: [ids.length],
        data_type: "string",
        chunk_grid: {
          name: "regular",
          configuration: { chunk_shape: [ids.length] },
        },
        chunk_key_encoding: { name: "default" },
        fill_value: "",
        codecs: [{ name: "vlen-utf8", configuration: {} }],
        dimension_names: ["member"],
        attributes: attrs,
      })
    )
  );
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  s.set(
    `/${name}/c/0`,
    Uint8Array.from(
      Buffer.concat([
        u32(ids.length),
        ...ids.flatMap((id) => [u32(Buffer.byteLength(id)), Buffer.from(id)]),
      ])
    )
  );
}

async function grid(s: TStore) {
  await put(s, "lat", [0, 1], [2], ["lat"], { units: "degrees_north" });
  await put(s, "lon", [0, 1], [2], ["lon"], { units: "degrees_east" });
}

let unique = 0;
function context(s: TStore, variable: string) {
  return resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      s as never,
      "",
      ZARR_FORMAT.V3,
      `f50-${unique++}`
    ),
    variable,
    new ByteLru(1e7)
  );
}

const point = (variable: string, fixed: Record<string, number> = {}) => ({
  version: 1,
  kind: "point-series" as const,
  source: { ref: "fixture.zarr", versionStatus: "session" as const },
  variable,
  geometry: { kind: "point" as const, lat: 0.5, lon: 0.5 },
  time: { start: 0, stop: 3 },
  fixed,
});

async function run(
  c: Awaited<ReturnType<typeof context>>,
  q: ReturnType<typeof point>
) {
  return (await planAnalysis(c, q as never, new ReadContext())).execute();
}

/** A forecast on reference times with one scalar lead, bounded or not. */
async function scalarForecast(
  variable: string,
  lead: number,
  bounds: [number, number] | "missing" | undefined,
  value: number,
  cellMethods = "time: sum"
) {
  const s = await root();
  await grid(s);
  await put(s, "init", [0, 24, 48], [3], ["init"], {
    standard_name: "forecast_reference_time",
    units: HOURS,
  });
  await put(s, "lead", [lead], [], [], {
    standard_name: "forecast_period",
    units: "hours",
    ...(bounds ? { bounds: "lead_bnds" } : {}),
  });
  if (bounds && bounds !== "missing") {
    await put(s, "lead_bnds", bounds, [2], ["nv"]);
  }
  if (bounds === "missing") {
    // Declared, its array there, its one chunk not written yet.
    await zarr.create(zarr.root(s).resolve("lead_bnds"), {
      dtype: "float64",
      shape: [2],
      chunkShape: [2],
      dimensionNames: ["nv"],
      fillValue: Number.NaN,
    } as never);
  }
  await put(
    s,
    variable,
    new Array(12).fill(value),
    [3, 2, 2],
    ["init", "lat", "lon"],
    {
      units: "m s-1",
      cell_methods: cellMethods,
      coordinates: "lead",
    }
  );
  return s;
}

it("a scalar lead's interval is read, and one not readable is unknown", async () => {
  const day = await run(
    await context(await scalarForecast("rain", 48, [24, 48], 10), "rain"),
    point("rain")
  );
  const lead = day.selections!.find(
    (x) => x.standardName === "forecast_period"
  )!;
  expect(lead.valueBounds).toEqual([24, 48]);
  const valid = validTimeAxis(day.time!, day.selections);
  expect("reason" in valid ? valid : valid.bounds).toEqual([
    24, 48, 48, 72, 72, 96,
  ]);
  // Exported with them.
  const model = exportModel(day);
  expect(model.arrays.some((a) => /^time_bnds/.test(a.name))).toBe(true);
  // Declared, not published: no instant is made of it.
  const store = await scalarForecast("rain", 48, "missing", 10);
  const c = await context(store, "rain");
  const unknown = await run(c, point("rain"));
  const pending = unknown.selections!.find(
    (x) => x.standardName === "forecast_period"
  )!;
  expect(pending.valueBoundsUnknown).toBe(true);
  expect(validTimeAxis(unknown.time!, unknown.selections)).toHaveProperty(
    "reason"
  );
  // Published later: read in the same context at the next plan.
  await put(store, "lead_bnds", [42, 48], [2], ["nv"]);
  const later = await run(c, point("rain"));
  expect(
    later.selections!.find((x) => x.standardName === "forecast_period")!
      .valueBounds
  ).toEqual([42, 48]);
});

it("winds at other scalar leads or supports are not one vector", async () => {
  for (const [label, [ul, ub], [vl, vb]] of [
    ["other dates", [24, undefined], [48, undefined]],
    ["other supports", [48, [24, 48]], [48, [42, 48]]],
  ] as const) {
    const methods = ub ? "time: mean" : "time: point";
    const [cu, cv] = await Promise.all([
      context(await scalarForecast("u", ul, ub as never, 3, methods), "u"),
      context(await scalarForecast("v", vl, vb as never, 4, methods), "v"),
    ]);
    const [u, v] = await Promise.all([
      run(cu, point("u")),
      run(cv, point("v")),
    ]);
    const both = windAt(u, { u: "u", v: "v" }, u, v);
    expect(typeof both, label).toBe("string");
    const area = await jointAlignment(cu, cv, undefined);
    expect(area, label).toHaveProperty("reason");
  }
  // The same lead and interval still combine.
  const [cu, cv] = await Promise.all([
    context(await scalarForecast("u", 48, [24, 48], 3, "time: mean"), "u"),
    context(await scalarForecast("v", 48, [24, 48], 4, "time: mean"), "v"),
  ]);
  const [u, v] = await Promise.all([run(cu, point("u")), run(cv, point("v"))]);
  const both = windAt(u, { u: "u", v: "v" }, u, v);
  expect(typeof both).toBe("object");
});

/** An ensemble with members named by `ids` (numbers or text). */
async function ensemble(
  ids: number[] | string[],
  attrs: Record<string, unknown> = {},
  dtype: "int32" | "text" = "int32"
) {
  const s = await root();
  await grid(s);
  await put(s, "time", [0, 1, 2], [3], ["time"], {
    standard_name: "time",
    units: "days since 2001-01-01",
  });
  if (dtype === "text") {
    putText(s, "member", ids as string[], {
      standard_name: "realization",
      ...attrs,
    });
  } else {
    await put(
      s,
      "member",
      ids as number[],
      [ids.length],
      ["member"],
      {
        standard_name: "realization",
        ...attrs,
      },
      [ids.length],
      "int32"
    );
  }
  const n = ids.length;
  await put(
    s,
    "rain",
    Array.from({ length: 3 * n * 4 }, (_, k) => Math.floor(k / 4) % n),
    [3, n, 2, 2],
    ["time", "member", "lat", "lon"],
    { units: "kg m-2" }
  );
  return context(s, "rain");
}

it("a member named by its declared missing value matches none and exports missing", async () => {
  const source = await ensemble([-9999, 1], {
    _FillValue: -9999,
    add_offset: 100,
  });
  expect(source.others[0].ids).toEqual([undefined, "101"]);
  const peer = await ensemble([-9999, 101]);
  const q = point("rain", { member: 0 });
  const paired = partnerQuery(
    q as never,
    { others: source.others },
    { others: peer.others },
    "rain"
  );
  expect(paired).toHaveProperty("reason");
  const r = await run(source, q);
  const chosen = r.selections!.find((x) => x.dimension === "member")!;
  expect(chosen.idMissing).toBe(true);
  const member = exportModel(r).arrays.find(
    (a) => a.attrs.gridlook_index === 0 && a.dims.length === 0
  )!;
  // Missing, in the family's own encoding.
  const known = exportModel(
    await run(source, point("rain", { member: 1 }))
  ).arrays.find((a) => a.attrs.gridlook_index === 1 && a.dims.length === 0)!;
  expect(member.type).toBe(known.type);
  expect(member.attrs.long_name).toMatch(/missing in the source/);
  // Told apart from a real identifier equal to the fill by a flag beside it.
  const flag = (arrays: ReturnType<typeof exportModel>["arrays"]) =>
    Array.from(
      arrays.find((a) => a.name.endsWith("_known"))!.data as Int32Array
    );
  expect(flag(exportModel(r).arrays)).toEqual([0]);
  expect(
    flag(exportModel(await run(source, point("rain", { member: 1 }))).arrays)
  ).toEqual([1]);
  // Member 1 (stored 1 + 100) still pairs with the peer's 101.
  const one = partnerQuery(
    point("rain", { member: 1 }) as never,
    { others: source.others },
    { others: peer.others },
    "rain"
  );
  expect(one).not.toHaveProperty("reason");
});

it("members are written by their source type in every partition", async () => {
  const low = ["9223372036854775806", "9223372036854775807"];
  const high = ["9223372036854775808", "9223372036854775809"];
  expect(idEncoding(low, "string")).toBe("text");
  expect(idEncoding(high, "string")).toBe("text");
  expect(idEncoding(["1", "control"], "string")).toBe("text");
  expect(idEncoding(["1", "2"], "string")).toBe("text");
  expect(idEncoding(["1", "2"], "int32")).toBe("i8");
  expect(idEncoding(["1", "2"], "uint16")).toBe("u8");
  expect(idEncoding(["0.5", "1.5"], "float64")).toBe("f8");
  // Through a real text coordinate.
  const c = await ensemble(["1", "2"], {}, "text");
  const r = await run(c, point("rain", { member: 0 }));
  expect(r.selections!.find((x) => x.dimension === "member")!.idEncoding).toBe(
    "text"
  );
});

it("both forecast clocks are kept where the source publishes both", async () => {
  // Reference times with valid times published beside them.
  const s = await root();
  await grid(s);
  await put(s, "init", [0, 24, 48], [3], ["init"], {
    standard_name: "forecast_reference_time",
    units: HOURS,
  });
  await put(s, "valid", [24, 36, 120], [3], ["init"], {
    standard_name: "time",
    units: HOURS,
  });
  await put(
    s,
    "t",
    new Array(12).fill(280),
    [3, 2, 2],
    ["init", "lat", "lon"],
    {
      units: "K",
      coordinates: "valid",
    }
  );
  const r = await run(await context(s, "t"), point("t"));
  const valid = validTimeAxis(r.time!, r.selections);
  expect("reason" in valid ? valid : valid.raw).toEqual([24, 36, 120]);
  const time = exportModel(r).arrays.find((a) => a.name === "time")!;
  expect(Array.from(time.data as Float64Array)).toEqual([24, 36, 120]);
  // A valid-time axis keeps its scalar reference time.
  const v = await root();
  await grid(v);
  await put(v, "init", [0], [], [], {
    standard_name: "forecast_reference_time",
    units: HOURS,
  });
  await put(v, "valid", [24, 36, 120], [3], ["valid"], {
    standard_name: "time",
    units: HOURS,
  });
  await put(
    v,
    "t",
    new Array(12).fill(280),
    [3, 2, 2],
    ["valid", "lat", "lon"],
    {
      units: "K",
      coordinates: "init",
    }
  );
  const rv = await run(await context(v, "t"), point("t"));
  expect(rv.referenceTime).toMatchObject({ name: "init", value: 0 });
  const reference = exportModel(rv).arrays.find(
    (a) => a.attrs.standard_name === "forecast_reference_time"
  )!;
  expect(Array.from(reference.data as Float64Array)).toEqual([0]);
  // A lead axis with one scalar reference: dated by both.
  const l = await root();
  await grid(l);
  await put(l, "init", [24], [], [], {
    standard_name: "forecast_reference_time",
    units: HOURS,
  });
  await put(l, "step", [0, 6, 12], [3], ["step"], {
    standard_name: "forecast_period",
    units: "hours",
  });
  await put(
    l,
    "t",
    new Array(12).fill(280),
    [3, 2, 2],
    ["step", "lat", "lon"],
    {
      units: "K",
      coordinates: "init",
    }
  );
  const cl = await context(l, "t");
  expect(cl.capabilities["point-series"].available).toBe(true);
  const rl = await run(cl, point("t"));
  expect(rl.time!.raw).toEqual([24, 30, 36]);
  expect(rl.referenceTime?.value).toBe(24);
});

it("the lead search reads bounds rows once a chunk and says when it gives up", async () => {
  const s = await root();
  await grid(s);
  const n = 128;
  await put(s, "init", [0, 24, 48], [3], ["init"], {
    standard_name: "forecast_reference_time",
    units: HOURS,
  });
  await put(
    s,
    "lead",
    Array.from({ length: n }, (_, k) => k),
    [n],
    ["lead"],
    {
      standard_name: "forecast_period",
      units: "hours",
      bounds: "lead_bnds",
    },
    [n]
  );
  await put(
    s,
    "lead_bnds",
    Array.from({ length: n }, (_, k) => [k - 1, k]).flat(),
    [n, 2],
    ["lead", "nv"],
    {},
    [1, 2]
  );
  await put(
    s,
    "rain",
    new Array(3 * n * 4).fill(1),
    [3, n, 2, 2],
    ["init", "lead", "lat", "lon"],
    { units: "kg m-2", cell_methods: "time: sum" }
  );
  const reads: string[] = [];
  const counted = new Proxy(s, {
    get(target, key) {
      if (key === "get") {
        return (k: string) => {
          if (k.startsWith("/lead_bnds/c/")) {
            reads.push(k);
          }
          return target.get(k);
        };
      }
      const v = Reflect.get(target, key);
      return typeof v === "function" ? v.bind(target) : v;
    },
  });
  const c = await context(counted as never, "rain");
  // Bounds in 128 one-row chunks: lazily read, one per chosen lead.
  const before = reads.length;
  const r = await run(c, point("rain", { lead: 70 }));
  expect(r.selections![0].valueBounds).toEqual([69, 70]);
  await run(c, point("rain", { lead: 70 }));
  expect(new Set(reads.slice(before)).size).toBe(1);
  expect(reads.length - before).toBe(1);
});

it("NetCDF refuses a label it would cut at a NUL", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const { loadNetCDFModule, writeNetCDF } =
    await import("@/lib/analysis/netcdfWriter.ts");
  const dist = path.resolve("node_modules/@earthyscience/netcdf4-wasm/dist");
  const netcdf = await loadNetCDFModule({
    wasmBinary: fs.readFileSync(path.join(dist, "netcdf4-wasm.wasm")),
  });
  const c = await ensemble(["ctl", "ctl\0B"], {}, "text");
  const r = (await run(c, point("rain", { member: 1 }))) as TAnalysisResult;
  expect(() => writeNetCDF(netcdf, exportModel(r))).toThrow(/NUL/);
  // Without one: written.
  const plain = await ensemble(["ctl", "pert"], {}, "text");
  const ok = (await run(
    plain,
    point("rain", { member: 1 })
  )) as TAnalysisResult;
  expect(writeNetCDF(netcdf, exportModel(ok)).length).toBeGreaterThan(0);
}, 60_000);

it("lazy lead bounds of another dimension are no lead's bounds", async () => {
  const s = await root();
  await grid(s);
  const n = 65;
  await put(s, "init", [0, 24, 48], [3], ["init"], {
    standard_name: "forecast_reference_time",
    units: HOURS,
  });
  await put(
    s,
    "lead",
    Array.from({ length: n }, (_, k) => k),
    [n],
    ["lead"],
    { standard_name: "forecast_period", units: "hours", bounds: "lead_bnds" }
  );
  await put(
    s,
    "lead_bnds",
    Array.from({ length: n }, (_, k) => [Math.max(0, k - 24), k]).flat(),
    [n, 2],
    ["other", "nv"],
    {},
    [1, 2]
  );
  await put(
    s,
    "rain",
    new Array(3 * n * 4).fill(1),
    [3, n, 2, 2],
    ["init", "lead", "lat", "lon"],
    { units: "kg m-2", cell_methods: "time: sum" }
  );
  const r = await run(await context(s, "rain"), point("rain", { lead: 48 }));
  const lead = r.selections!.find((x) => x.standardName === "forecast_period")!;
  expect(lead.valueBounds).toBeUndefined();
  expect(lead.valueBoundsUnknown).toBe(true);
});
