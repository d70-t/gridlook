/* eslint-disable camelcase, max-lines-per-function, @typescript-eslint/no-explicit-any -- CF forecast fixtures. */
import { expect, it, vi } from "vitest";
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
type TMode = "same" | "other" | "one unknown" | "all unknown";
let id = 0;

/**
 * U = 3 and V = 4 m/s on two pressure levels, valid at hours 48, 72 and 96
 * (24-hour means), each row with its own forecast reference time: [0, 24, 48]
 * for U; for V the same, 12 hours later, or with one or all unknown.
 */
async function forecast(mode: TMode, kind: string, shown: "u" | "t") {
  const store = new Map<string, Uint8Array>();
  const root = z.root(store);
  await z.create(root, { attributes: {} });
  const put = async (
    name: string,
    dims: string[],
    shape: number[],
    values: number[],
    attributes = {}
  ) => {
    const a = await z.create(root.resolve(name), {
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
        shape.slice(i + 1).reduce((x, y) => x * y, 1)
      ),
    } as never);
  };
  await put("lat", ["lat"], [2], [0, 1], { units: "degrees_north" });
  await put("lon", ["lon"], [2], [0, 1], { units: "degrees_east" });
  await put("lev", ["lev"], [2], [300, 850], {
    units: "hPa",
    standard_name: "air_pressure",
    positive: "down",
  });
  await put("time", ["time"], [3], [48, 72, 96], {
    standard_name: "time",
    units: E,
    bounds: "time_bounds",
  });
  await put("time_bounds", ["time", "nv"], [3, 2], [24, 48, 48, 72, 72, 96]);
  for (const [n, value, standard, units] of [
    ["u", 3, "eastward_wind", "m s-1"],
    ["v", 4, "northward_wind", "m s-1"],
    ["t", 280, "air_temperature", "K"],
  ] as const) {
    if (n !== "t") {
      const runs = [0, 24, 48].map((a, i) =>
        n === "u"
          ? a
          : mode === "other"
            ? a + 12
            : mode === "all unknown" || (mode === "one unknown" && i === 1)
              ? NaN
              : a
      );
      await put("ref_" + n, ["time"], [3], runs, {
        standard_name: "forecast_reference_time",
        units: E,
      });
    }
    await put(
      n,
      ["time", "lev", "lat", "lon"],
      [3, 2, 2, 2],
      Array(24).fill(value),
      {
        ...(n === "t" ? {} : { coordinates: "ref_" + n }),
        standard_name: standard,
        units,
        cell_methods: "time: mean",
      }
    );
  }
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `forecast-shapes-${++id}`
  );
  const source = { ref: "fixture.zarr", versionStatus: "session" };
  const contexts: Record<string, any> = {};
  const described: Record<string, any> = {};
  for (const n of ["u", "v", "t"]) {
    contexts[n] = await resolveVariableContext(dataset, n, new ByteLru(1e7));
    const runner = new AnalysisRunner();
    vi.spyOn(runner as any, "context").mockResolvedValue(contexts[n]);
    described[n] = await runner.describe(source as never, n);
  }
  const geometry =
    kind === "section"
      ? {
          kind: "polyline",
          vertices: [
            { lat: 0, lon: 0 },
            { lat: 1, lon: 1 },
          ],
        }
      : kind === "region-series"
        ? { kind: "box", west: -1, east: 2, south: -1, north: 2 }
        : { kind: "point", lat: 0.5, lon: 0.5 };
  const single = kind === "section" || kind === "profile";
  const q: any = {
    version: 1,
    kind,
    source,
    variable: shown,
    geometry,
    time: single ? { start: 1, stop: 2 } : { start: 0, stop: 3 },
    fixed: {},
    ...(kind === "point-series" || kind === "region-series"
      ? { level: 0 }
      : {}),
    ...(kind === "section" ? { sectionSamples: 3 } : {}),
  };
  const plotted = await (
    await planAnalysis(contexts[shown], q, new ReadContext())
  ).execute();
  const read: Record<string, any> = {};
  for (const n of ["u", "v"]) {
    const query = partnerQuery(q, described[shown], described[n], n);
    if ("reason" in query) {
      return { refused: query.reason };
    }
    const joint = kind === "region-series";
    if (joint) {
      query.jointWith = n === "u" ? "v" : "u";
    }
    try {
      read[n] = await (
        await planAnalysis(
          contexts[n],
          query,
          new ReadContext(),
          undefined,
          false,
          joint ? contexts[query.jointWith!] : undefined
        )
      ).execute();
    } catch (error) {
      return { refused: String(error) };
    }
  }
  const pair = windAt(
    shown === "u" && kind !== "region-series" ? read.u : plotted,
    { u: "u", v: "v" },
    read.u,
    read.v
  );
  return typeof pair === "string"
    ? { refused: pair }
    : {
        speeds: pair.u.values.map((v: number, i: number) =>
          Math.hypot(v, pair.v.values[i])
        ),
        rows: read.u.shape[0] as number,
      };
}

const KINDS = [
  "point-series",
  "region-series",
  "time-depth",
  "section",
  "profile",
];

it.each(KINDS)(
  "pairs winds of one run only, on every plot shape: %s",
  async (kind) => {
    for (const shown of ["u", "t"] as const) {
      const same = await forecast("same", kind, shown);
      expect(
        same.speeds?.every((s) => s === 5),
        `${shown} same`
      ).toBe(true);
      for (const mode of ["other", "all unknown"] as const) {
        const r = await forecast(mode, kind, shown);
        const none = !r.speeds || r.speeds.every((s) => !Number.isFinite(s));
        expect(none, `${shown} ${mode}: ${JSON.stringify(r)}`).toBe(true);
      }
      // The middle row's run unknown: its vector withheld, the others kept.
      const partial = await forecast("one unknown", kind, shown);
      if (kind === "section" || kind === "profile") {
        const none =
          !partial.speeds || partial.speeds.every((s) => !Number.isFinite(s));
        expect(none, `${shown}: ${JSON.stringify(partial)}`).toBe(true);
      } else {
        const s = partial.speeds!;
        const perRow = s.length / 3;
        const rows = [0, 1, 2].map((row) =>
          s.slice(row * perRow, (row + 1) * perRow).every(Number.isFinite)
        );
        expect(rows, `${shown}: ${JSON.stringify(partial)}`).toEqual([
          true,
          false,
          true,
        ]);
      }
    }
  }
);

/**
 * U or V along initializations [0, 24, 48] h, valid 48 h later (a scalar
 * 48-hour lead named too), each a mean over the `span` hours before; `shift`
 * moves the published valid times off reference plus lead. Stored in hours
 * or days.
 */
async function leadStore(
  store: Map<string, Uint8Array>,
  name: "u" | "v",
  span: number,
  shift: number,
  days: boolean
) {
  const root = z.root(store);
  if (!store.has("/zarr.json")) {
    await z.create(root, { attributes: {} });
  }
  const scale = days ? 1 / 24 : 1;
  const units = days ? "days since 2004-01-01" : E;
  const put = async (
    n: string,
    dims: string[],
    shape: number[],
    values: number[],
    attributes = {}
  ) => {
    if (store.has(`/${n}/zarr.json`)) {
      return;
    }
    const a = await z.create(root.resolve(n), {
      dtype: "float64",
      shape,
      chunkShape: shape.length ? shape : [1],
      dimensionNames: dims,
      attributes,
      fillValue: NaN,
    } as never);
    await z.set(
      a as never,
      null,
      (shape.length
        ? {
            data: Float64Array.from(values),
            shape,
            stride: shape.map((_, i) =>
              shape.slice(i + 1).reduce((x, y) => x * y, 1)
            ),
          }
        : values[0]) as never
    );
  };
  await put("lat", ["lat"], [2], [0, 1], { units: "degrees_north" });
  await put("lon", ["lon"], [2], [0, 1], { units: "degrees_east" });
  await put(
    "init",
    ["init"],
    [3],
    [0, 24, 48].map((h) => h * scale),
    {
      standard_name: "forecast_reference_time",
      units,
    }
  );
  await put("lead", [], [], [48], {
    standard_name: "forecast_period",
    units: "hours",
  });
  const valid = [48, 72, 96].map((h) => h + (name === "v" ? shift : 0));
  await put(
    `valid_${name}`,
    ["init"],
    [3],
    valid.map((h) => h * scale),
    {
      standard_name: "time",
      units,
      bounds: `tb_${name}`,
    }
  );
  await put(
    `tb_${name}`,
    ["init", "nv"],
    [3, 2],
    valid.flatMap((h) => [(h - span) * scale, h * scale])
  );
  await put(
    name,
    ["init", "lat", "lon"],
    [3, 2, 2],
    Array(12).fill(name === "u" ? 3 : 4),
    {
      coordinates: `valid_${name} lead`,
      standard_name: name === "u" ? "eastward_wind" : "northward_wind",
      units: "m s-1",
      cell_methods: "time: mean",
    }
  );
}

async function leadWind(spanV: number, shift: number, days: boolean) {
  const store = new Map<string, Uint8Array>();
  await leadStore(store, "u", 24, 0, days);
  await leadStore(store, "v", spanV, shift, days);
  const dataset = zarrAnalysisDatasetFromStore(
    store as never,
    "",
    ZARR_FORMAT.V3,
    `lead-${++id}`
  );
  const source = { ref: "fixture.zarr", versionStatus: "session" };
  const read: Record<string, any> = {};
  const described: Record<string, any> = {};
  const q: any = {
    version: 1,
    kind: "point-series",
    source,
    variable: "u",
    geometry: { kind: "point", lat: 0.5, lon: 0.5 },
    time: { start: 0, stop: 3 },
    fixed: {},
  };
  const contexts: Record<string, any> = {};
  for (const n of ["u", "v"]) {
    contexts[n] = await resolveVariableContext(dataset, n, new ByteLru(1e7));
    const runner = new AnalysisRunner();
    vi.spyOn(runner as any, "context").mockResolvedValue(contexts[n]);
    described[n] = await runner.describe(source as never, n);
  }
  for (const n of ["u", "v"]) {
    const query = partnerQuery(q, described.u, described[n], n);
    if ("reason" in query) {
      return query.reason;
    }
    read[n] = await (
      await planAnalysis(contexts[n], query, new ReadContext())
    ).execute();
  }
  const pair = windAt(read.u, { u: "u", v: "v" }, read.u, read.v);
  return typeof pair === "string"
    ? pair
    : pair.u.values.map((v: number, i: number) =>
        Math.hypot(v, pair.v.values[i])
      );
}

it.each([false, true])(
  "keeps published averaging intervals beside a redundant lead; days=%s",
  async (days) => {
    expect(await leadWind(24, 0, days)).toEqual([5, 5, 5]);
    // A 6-hour mean is no 24-hour one, however the lead is named.
    const unequal = await leadWind(6, 0, days);
    expect(
      typeof unequal === "string" || unequal.every((s) => !Number.isFinite(s))
    ).toBe(true);
  }
);

it.each([false, true])(
  "refuses clocks that disagree by an hour, in hours or days; days=%s",
  async (days) => {
    for (const shift of [1, 3]) {
      expect(typeof (await leadWind(24, shift, days)), `${shift} h`).toBe(
        "string"
      );
    }
  }
);

it("names each row's forecast run in the series table", async () => {
  const { resultTable } = await import("@/lib/analysis/analysisExport.ts");
  const result = (references: number[]) =>
    ({
      kind: "point-series",
      query: { variable: "u", time: { start: 0, stop: 2 } },
      values: [3, 3],
      shape: [2],
      dims: ["time"],
      notes: [],
      counters: {},
      time: {
        dimension: "time",
        raw: [48, 72],
        units: E,
        calendar: "360_day",
        references,
      },
    }) as never;
  const lines = (references: number[]) => {
    const table = resultTable(result(references));
    return [table.header, table.row(0), table.row(1)].map((r) => r.join(","));
  };
  const [early, late] = [lines([0, 24]), lines([12, 36])];
  expect(early[0]).toMatch(/forecast_reference_time/);
  expect(early).not.toEqual(late);
});
