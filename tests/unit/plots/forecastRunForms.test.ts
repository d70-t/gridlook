/* eslint-disable camelcase, max-lines-per-function, @typescript-eslint/no-explicit-any -- CF forecast fixtures. */
import { it, expect, vi } from "vitest";
import * as z from "zarrita";

import { AnalysisRunner } from "@/lib/analysis/analysisRunner";
import { ByteLru } from "@/lib/analysis/byteLru";
import { ReadContext } from "@/lib/analysis/chunkVisitor";
import { partnerQuery } from "@/lib/analysis/companionAlign";
import { planAnalysis } from "@/lib/analysis/planAnalysis";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter";
import { resolveVariableContext } from "@/lib/analysis/variableContext";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes";
vi.mock("@/store/store.ts", () => ({ useGlobeControlStore: () => ({}) }));
vi.stubGlobal("localStorage", { getItem: () => null, setItem: () => {} });
const { windAt } = await import("@/store/analysisStore");
const E = "hours since 2004-01-01";
let id = 0;
async function fixture(
  name: string,
  span: number,
  shift: number,
  layout: "direct" | "aux" | "lead",
  hideBounds = false,
  cycleOffset = 0
) {
  const store = new Map<string, Uint8Array>();
  const root = z.root(store);
  await z.create(root, { attributes: {} });
  async function put(
    n: string,
    dims: string[],
    shape: number[],
    vals: number[],
    attrs = {}
  ) {
    const a = await z.create(root.resolve(n), {
      dtype: "float64",
      shape,
      chunkShape: shape,
      dimensionNames: dims,
      attributes: attrs,
      fillValue: NaN,
    } as never);
    if (!shape.length) {
      await z.set(a as never, null, vals[0] as never);
      return;
    }
    await z.set(a as never, null, {
      data: Float64Array.from(vals),
      shape,
      stride: shape.map((_, i) =>
        shape.slice(i + 1).reduce((v, x) => v * x, 1)
      ),
    } as never);
  }
  const dim = layout === "aux" ? "init" : layout === "lead" ? "lead" : "valid";
  const validName = layout === "aux" ? "valid_" + name : "valid";
  const boundName = "tb_" + name;
  const ends = [48, 72, 96].map((x) => x + shift);
  const init = layout === "lead" ? 120 : 0;
  if (layout === "aux") {
    await put(
      "init",
      ["init"],
      [3],
      [0, 24, 48].map((x) => x + cycleOffset),
      { standard_name: "forecast_reference_time", units: E }
    );
  }
  if (layout === "lead") {
    await put("ref", [], [], [init], {
      standard_name: "forecast_reference_time",
      units: E,
    });
  }
  await put(layout === "lead" ? "lead" : validName, [dim], [3], ends, {
    standard_name: layout === "lead" ? "forecast_period" : "time",
    units: layout === "lead" ? "hours" : E,
    bounds: boundName,
  });
  if (!hideBounds) {
    await put(
      boundName,
      [dim, "nv"],
      [3, 2],
      ends.flatMap((x) => [x - span, x])
    );
  }
  await put("lat", ["lat"], [2], [0, 1], { units: "degrees_north" });
  await put("lon", ["lon"], [2], [0, 1], { units: "degrees_east" });
  const coords =
    layout === "aux"
      ? { coordinates: validName }
      : layout === "lead"
        ? { coordinates: "ref" }
        : {};
  const wind = name !== "rain";
  await put(
    name,
    [dim, "lat", "lon"],
    [3, 2, 2],
    Array.from({ length: 12 }, (_, i) =>
      name === "u" ? 3 : name === "v" ? 4 : [9, 17, 28][Math.floor(i / 4)]
    ),
    {
      ...coords,
      standard_name:
        name === "u"
          ? "eastward_wind"
          : name === "v"
            ? "northward_wind"
            : name === "t"
              ? "air_temperature"
              : "precipitation_amount",
      units: name === "t" ? "K" : wind ? "m s-1" : "kg m-2",
      cell_methods: wind ? "time: mean" : "time: sum",
    }
  );
  return store;
}
async function readStore(
  store: Map<string, Uint8Array>,
  name: string,
  storeKey = "review57-" + ++id
) {
  const c = await resolveVariableContext(
    zarrAnalysisDatasetFromStore(store as never, "", ZARR_FORMAT.V3, storeKey),
    name,
    new ByteLru(1e7)
  );
  const q = {
    version: 1,
    kind: "point-series",
    source: { ref: "fixture.zarr", versionStatus: "session" },
    variable: name,
    geometry: { kind: "point", lat: 0.5, lon: 0.5 },
    time: { start: 0, stop: 3 },
    fixed: {},
  } as any;
  const r = await (await planAnalysis(c, q, new ReadContext())).execute();
  const runner = new AnalysisRunner();
  vi.spyOn(runner as any, "context").mockResolvedValue(c);
  const description = await runner.describe(q.source, name);
  return { c, r, q, description };
}
it("pairs wind components only of one run, in every CF form of the run", async () => {
  async function test(kind: string, otherStart: number) {
    const store = new Map<string, Uint8Array>();
    const root = z.root(store);
    await z.create(root, { attributes: {} });
    async function put(
      n: string,
      dims: string[],
      shape: number[],
      vals: number[],
      attrs = {}
    ) {
      const a = await z.create(root.resolve(n), {
        dtype: "float64",
        shape,
        chunkShape: shape,
        dimensionNames: dims,
        attributes: attrs,
        fillValue: NaN,
      } as never);
      if (!shape.length) {
        await z.set(a as never, null, vals[0] as never);
        return;
      }
      await z.set(a as never, null, {
        data: Float64Array.from(vals),
        shape,
        stride: shape.map((_, i) =>
          shape.slice(i + 1).reduce((v, x) => v * x, 1)
        ),
      } as never);
    }
    await put("lat", ["lat"], [2], [0, 1], { units: "degrees_north" });
    await put("lon", ["lon"], [2], [0, 1], { units: "degrees_east" });
    for (const [name, n] of [
      ["u", 0],
      ["v", otherStart],
    ] as const) {
      const row =
        kind === "rows" ||
        kind === "fixedref" ||
        (kind === "mixed" && name === "v");
      const orig = kind === "unknown" ? "init" : "ref_" + name,
        valid =
          kind === "rows" || kind === "fixedref" ? "time" : "valid_" + name,
        bound = "bounds_" + name;
      const dim = row ? valid : orig;
      const dates = [48, 72, 96];
      const cycles = [0, 24, 48].map((x) =>
        kind === "unknown" && x === 24 ? NaN : x + n
      );
      const scalar = kind === "fixedref";
      await put(
        orig,
        scalar ? [] : [dim],
        scalar ? [] : [3],
        scalar ? [n] : cycles,
        { standard_name: "forecast_reference_time", units: E }
      );
      await put(valid, [dim], [3], dates, {
        standard_name: "time",
        units: E,
        bounds: bound,
      });
      await put(
        bound,
        [dim, "nv"],
        [3, 2],
        dates.flatMap((x) => [x - 24, x])
      );
      await put(
        name,
        [dim, "lat", "lon"],
        [3, 2, 2],
        Array(12).fill(name === "u" ? 3 : 4),
        {
          coordinates: row ? orig : valid,
          standard_name: name === "u" ? "eastward_wind" : "northward_wind",
          units: "m s-1",
          cell_methods: "time: mean",
        }
      );
    }
    const key = "extra64-" + ++id;
    const [u, v] = await Promise.all(
      ["u", "v"].map((n) => readStore(store, n, key))
    );
    partnerQuery(u.q, u.description as never, v.description as never, "v");
    const point = windAt(u.r, { u: "u", v: "v" }, u.r, v.r);
    const speed = (pair: any) =>
      typeof pair === "string"
        ? pair
        : pair.u.values.map((x: number, i: number) =>
            Math.hypot(x, pair.v.values[i])
          );
    const area = async (a: typeof u, b: typeof u) =>
      (
        await planAnalysis(
          a.c,
          {
            ...a.q,
            kind: "region-series",
            geometry: { kind: "box", west: -1, east: 2, south: -1, north: 2 },
            jointWith: b.q.variable,
          },
          new ReadContext(),
          undefined,
          false,
          b.c
        )
      ).execute();
    let region;
    try {
      const [ur, vr] = await Promise.all([area(u, v), area(v, u)]);
      region = speed(windAt(ur, { u: "u", v: "v" }, ur, vr));
    } catch (e) {
      region = String(e);
    }

    return { region, point: speed(point) };
  }
  for (const kind of ["axes", "rows", "mixed", "fixedref"]) {
    for (const start of [0, 12]) {
      const result = await test(kind, start);
      // The same runs make a vector; runs 12 hours apart make none.
      if (start === 0) {
        expect(result.point, kind).toEqual([5, 5, 5]);
        // Two reference dimensions of other names make no joint area.
        if (kind === "rows" || kind === "fixedref") {
          expect(result.region, kind).toEqual([5, 5, 5]);
        }
      } else {
        expect(typeof result.point, kind).toBe("string");
        expect(typeof result.region, kind).toBe("string");
      }
    }
  }
  await expect(test("unknown", 0)).rejects.toThrow(
    /missing or invalid timestamps/
  );
});

it("pairs wind components with each other before a third plotted variable", async () => {
  for (const shift of [0, 24, 168]) {
    const a = await fixture("u", 24, 0, "aux"),
      b = await fixture("v", 24, shift, "aux"),
      t = await fixture("t", 24, 0, "direct");
    const store = new Map([...a, ...b, ...t]);
    const key = "overlay64-" + ++id;
    const [u, v, temp] = await Promise.all(
      ["u", "v", "t"].map((n) => readStore(store, n, key))
    );
    async function resolveRead(c: typeof u) {
      const p = partnerQuery(
        temp.q,
        temp.description as never,
        c.description as never,
        c.q.variable
      );
      return "reason" in p
        ? { reason: p.reason }
        : {
            r: await (await planAnalysis(c.c, p, new ReadContext())).execute(),
            selection: p.time,
          };
    }
    const [pu, pv] = await Promise.all([resolveRead(u), resolveRead(v)]);
    if (!pu.r || !pv.r) {
      expect(shift).toBe(168);
      continue;
    }
    const pair = windAt(temp.r, { u: "u", v: "v" }, pu.r, pv.r);
    const values =
      typeof pair === "string"
        ? pair
        : pair.u.values.map((x, i) => Math.hypot(x, pair.v.values[i]));
    if (shift === 0) {
      expect(values).toEqual([5, 5, 5]);
    } else {
      expect(typeof values).toBe("string");
    }
  }
});

it("refuses a partner before reading when its cells' bounds cannot be read", async () => {
  for (const hidden of [false, true]) {
    const a = await fixture("u", 24, 0, "aux", hidden),
      b = await fixture("v", 24, 0, "aux", hidden);
    const store = new Map([...a, ...b]);
    const key = "unread-" + ++id;
    const [u, v] = await Promise.all(
      ["u", "v"].map((n) => readStore(store, n, key))
    );
    const p = partnerQuery(
      u.q,
      u.description as never,
      v.description as never,
      "v"
    );
    expect("reason" in p, `hidden ${hidden}`).toBe(hidden);
  }
});
