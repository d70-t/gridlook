/* eslint-disable camelcase, max-lines-per-function -- CF fixtures per case. */
import { expect, it, vi } from "vitest";
import * as z from "zarrita";

import { AnalysisRunner } from "@/lib/analysis/analysisRunner.ts";
import { ByteLru } from "@/lib/analysis/byteLru.ts";
import { ReadContext } from "@/lib/analysis/chunkVisitor.ts";
import { partnerQuery } from "@/lib/analysis/companionAlign.ts";
import { planAnalysis } from "@/lib/analysis/planAnalysis.ts";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter.ts";
import type { TAnalysisQuery, TAnalysisResult } from "@/lib/analysis/types.ts";
import {
  resolveVariableContext,
  type TVariableContext,
} from "@/lib/analysis/variableContext.ts";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes.ts";

vi.mock("@/store/store.ts", () => ({ useGlobeControlStore: () => ({}) }));
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
const { windAt } = await import("@/store/analysisStore.ts");

type TStore = Map<string, Uint8Array>;
const EPOCH = "hours since 2004-01-01";
let opened = 0;

/**
 * A 24-hour mean wind component published beside three initializations
 * (0, 24, 48 h), valid `lead` hours later, with its validity bounds `span`
 * hours long (or declared and absent).
 */
async function component(
  store: TStore,
  name: "u" | "v",
  options: {
    lead?: number;
    span?: number;
    hidden?: boolean;
    init?: number;
  } = {}
) {
  const { lead = 48, span = 24, hidden = false, init = 0 } = options;
  const root = z.root(store);
  const put = async (
    path: string,
    dims: string[],
    shape: number[],
    values: number[],
    attributes = {}
  ) => {
    const a = await z.create(root.resolve(path), {
      dtype: "float64",
      shape,
      chunkShape: shape,
      dimensionNames: dims,
      attributes,
      fillValue: NaN,
    } as never);
    await z.set(a as never, null, {
      data: Float64Array.from(values),
      shape,
      stride: shape.map((_, i) =>
        shape.slice(i + 1).reduce((v, x) => v * x, 1)
      ),
    } as never);
  };
  const cycles = [0, 24, 48].map((x) => x + init);
  const ends = cycles.map((x) => x + lead);
  if (!store.has("/init/zarr.json")) {
    await put("init", ["init"], [3], cycles, {
      standard_name: "forecast_reference_time",
      units: EPOCH,
    });
    await put("lat", ["lat"], [2], [0, 1], { units: "degrees_north" });
    await put("lon", ["lon"], [2], [0, 1], { units: "degrees_east" });
  }
  await put(`valid_${name}`, ["init"], [3], ends, {
    standard_name: "time",
    units: EPOCH,
    bounds: `tb_${name}`,
  });
  if (!hidden) {
    await put(
      `tb_${name}`,
      ["init", "nv"],
      [3, 2],
      ends.flatMap((x) => [x - span, x])
    );
  }
  await put(
    name,
    ["init", "lat", "lon"],
    [3, 2, 2],
    Array(12).fill(name === "u" ? 3 : 4),
    {
      coordinates: `valid_${name}`,
      standard_name: name === "u" ? "eastward_wind" : "northward_wind",
      units: "m s-1",
      cell_methods: "time: mean",
    }
  );
}

async function read(store: TStore, name: string, key: string) {
  const c = (await resolveVariableContext(
    zarrAnalysisDatasetFromStore(store as never, "", ZARR_FORMAT.V3, key),
    name,
    new ByteLru(1e7)
  )) as TVariableContext;
  const q = {
    version: 1,
    kind: "point-series",
    source: { ref: "fixture.zarr", versionStatus: "session" },
    variable: name,
    geometry: { kind: "point", lat: 0.5, lon: 0.5 },
    time: { start: 0, stop: 3 },
    fixed: {},
  } as TAnalysisQuery;
  const r = await (await planAnalysis(c, q, new ReadContext())).execute();
  const runner = new AnalysisRunner();
  vi.spyOn(
    runner as unknown as { context: () => Promise<unknown> },
    "context"
  ).mockResolvedValue(c);
  const description = await runner.describe(q.source as never, name);
  return { c, q, r, description };
}

async function wind(v: Parameters<typeof component>[2], separate = false) {
  const stores: TStore[] = [new Map(), new Map()];
  for (const s of stores) {
    await z.create(z.root(s), { attributes: {} });
  }
  await component(stores[0], "u");
  await component(separate ? stores[1] : stores[0], "v", v);
  const key = `runs-${++opened}`;
  const [u, w] = await Promise.all(
    (["u", "v"] as const).map((n, i) =>
      read(separate ? stores[i] : stores[0], n, separate ? `${key}${i}` : key)
    )
  );
  const preflight = partnerQuery(
    u.q,
    u.description as never,
    w.description as never,
    "v"
  );
  const point = windAt(u.r, { u: "u", v: "v" }, u.r, w.r);
  const area = async (a: typeof u, b: typeof u) =>
    (
      await planAnalysis(
        a.c,
        {
          ...a.q,
          kind: "region-series",
          geometry: { kind: "box", west: -1, east: 2, south: -1, north: 2 },
          jointWith: b.q.variable,
        } as TAnalysisQuery,
        new ReadContext(),
        undefined,
        false,
        b.c
      )
    ).execute();
  let region: string | number[];
  try {
    const [ur, vr] = await Promise.all([area(u, w), area(w, u)]);
    const drawn = windAt(ur, { u: "u", v: "v" }, ur, vr);
    region =
      typeof drawn === "string"
        ? drawn
        : speeds(drawn as { u: TAnalysisResult; v: TAnalysisResult });
  } catch (e) {
    region = String(e);
  }
  return { preflight, point, region };
}

const speeds = (pair: { u: TAnalysisResult; v: TAnalysisResult }) =>
  pair.u.values.map((x, i) => Math.hypot(x, pair.v.values[i]));

it("pairs forecast wind components of one run and interval", async () => {
  const same = await wind({});
  expect("reason" in same.preflight).toBe(false);
  expect(same.region).toEqual([5, 5, 5]);
});

it("keeps a component of another run out of a vector", async () => {
  // V 72 h after each initialization, U 48 h: their valid hours overlap,
  // and V valid at hour 72 is the run of hour 0, U's the run of hour 24.
  const other = await wind({ lead: 72 });
  expect("reason" in other.preflight).toBe(true);
  expect(typeof other.point).toBe("string");
  expect(typeof other.region).toBe("string");
});

it("withholds means whose published validity bounds are unread", async () => {
  for (const separate of [false, true]) {
    const unread = await wind({ span: 6, hidden: true }, separate);
    expect(typeof unread.point).toBe("string");
    expect(typeof unread.region).toBe("string");
  }
});
