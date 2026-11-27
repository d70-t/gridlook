/* eslint-disable camelcase, max-lines-per-function, @typescript-eslint/no-explicit-any -- store fixtures with CF metadata. */
// Its own module state: other store tests keep shared runs in flight.
import { beforeEach, expect, it, vi } from "vitest";
import * as z from "zarrita";

import { ByteLru } from "@/lib/analysis/byteLru";
import { ReadContext } from "@/lib/analysis/chunkVisitor";
import { planAnalysis } from "@/lib/analysis/planAnalysis";
import { exportModel } from "@/lib/analysis/scientificExport";
import { zarrAnalysisDatasetFromStore } from "@/lib/analysis/sourceAdapter";
import { resolveVariableContext } from "@/lib/analysis/variableContext";
import { ZARR_FORMAT } from "@/lib/types/GlobeTypes";
import { pairSeries, validTimeAxis } from "@/ui/analysis/compare";

const client = vi.hoisted(() => ({
  describeVariable: vi.fn(),
  planRun: vi.fn(),
  executeRun: vi.fn(),
  cancelRun: vi.fn(),
  releaseSource: vi.fn(),
  setRunPaused: vi.fn(),
  sourcePublished: vi.fn(),
}));

vi.mock("@/lib/analysis/analysisClient.ts", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("@/lib/analysis/analysisClient.ts")
  >()),
  ...client,
}));

vi.mock("@/store/store.ts", () => ({
  useGlobeControlStore: () => ({
    varnameSelector: "tas",
    varinfo: { dimRanges: [{ name: "time" }] },
    dimSlidersValues: [3],
  }),
}));

const storage = new Map<string, string>();
vi.stubGlobal("localStorage", {
  getItem: (key: string) => storage.get(key) ?? null,
  setItem: (key: string, value: string) => storage.set(key, value),
});
const page = {
  hash: "#https://example.org/data.zarr",
  pathname: "/",
  search: "",
};
vi.stubGlobal("location", page);
vi.stubGlobal("history", {
  replaceState: (_: unknown, __: string, url: string) => {
    page.hash = url.slice(url.indexOf("#"));
  },
});

const { createPinia, setActivePinia } = await import("pinia");
const { useAnalysisStore } = await import("@/store/analysisStore.ts");
const { ANALYSIS_KINDS } = await import("@/lib/analysis/types.ts");

const summary = {
  variable: "tas",
  dims: ["time", "cell"],
  shape: [100, 768],
  gridLabel: "HEALPix order 3",
  order: 3,
  conflicts: [],
  time: {
    dimension: "time",
    raw: Array.from({ length: 100 }, (_, t) => t),
    units: "days since 2000-01-01",
    calendar: "standard",
    chunk: 10,
  },
  others: [],
  capabilities: {
    [ANALYSIS_KINDS.POINT_SERIES]: { available: true },
    [ANALYSIS_KINDS.REGION_SERIES]: { available: true },
    [ANALYSIS_KINDS.PROFILE]: {
      available: false,
      reason: "The variable has no vertical dimension.",
    },
    [ANALYSIS_KINDS.SECTION]: {
      available: false,
      reason: "The variable has no vertical dimension.",
    },
  },
  decoding: "",
  overviews: [],
};

const modest = {
  chunks: 1,
  decodedBytes: 8,
  workingBytes: 8,
  outputValues: 4,
  modest: true,
  notes: [],
};
const source = {
  key: "src#1",
  store: "https://example.org/data.zarr",
  dataset: "",
  format: 3 as const,
};
const ref = {
  ref: "https://example.org/data.zarr",
  versionStatus: "best-effort" as const,
};
const rect = { x: 0, y: 0, w: 400, h: 300 };
const map = { variable: "tas", indices: { time: 55 } };

beforeEach(() => {
  setActivePinia(createPinia());
  Object.values(client).forEach((fn) => fn.mockReset());
  client.describeVariable.mockResolvedValue(summary);
  client.planRun.mockResolvedValue(modest);
  page.hash = "#https://example.org/data.zarr";
});

async function clockDataset(mode: "aux" | "direct", span: number) {
  const n = 100,
    mem = new Map<string, Uint8Array>(),
    zr = z.root(mem);
  await z.create(zr, { attributes: {} });
  async function put(
    name: string,
    dims: string[],
    shape: number[],
    values: number[],
    attrs: Record<string, unknown> = {}
  ) {
    const a = await z.create(zr.resolve(name), {
      dtype: "float64",
      shape,
      chunkShape: shape,
      dimensionNames: dims,
      attributes: attrs,
      fillValue: NaN,
    } as never);
    await z.set(a as never, null, {
      data: Float64Array.from(values),
      shape,
      stride: shape.map((_, i) =>
        shape.slice(i + 1).reduce((s, x) => s * x, 1)
      ),
    } as never);
  }
  const raw = Array.from({ length: n }, (_, i) => 24 * i),
    valid = raw.map((x) => x + 48),
    units = "hours since 2004-01-01";
  const main = mode === "aux" ? "init" : "valid";
  await put("init", [main], [n], raw, {
    standard_name: "forecast_reference_time",
    units,
  });
  await put("valid", [main], [n], valid, {
    standard_name: "time",
    units,
    bounds: "valid_bounds",
  });
  await put(
    "valid_bounds",
    [main, "nv"],
    [n, 2],
    valid.flatMap((x) => [x - span, x])
  );
  await put("lat", ["lat"], [2], [10, 15], { units: "degrees_north" });
  await put("lon", ["lon"], [2], [19, 21], { units: "degrees_east" });
  await put(
    "tas",
    [main, "lat", "lon"],
    [n, 2, 2],
    Array.from({ length: n * 4 }, (_, i) => 1 + Math.floor(i / 4)),
    {
      coordinates: mode === "aux" ? "valid" : "init",
      units: "m s-1",
      cell_methods: "time: mean",
    }
  );
  return resolveVariableContext(
    zarrAnalysisDatasetFromStore(
      mem as never,
      "",
      ZARR_FORMAT.V3,
      "review64-clock-" + mode + span
    ),
    "tas",
    new ByteLru(1e7)
  );
}
async function actual(mode: "aux" | "direct", span: number) {
  const c = await clockDataset(mode, span),
    requests = new Map<string, any>(),
    rctx = new ReadContext();
  const a = useAnalysisStore(createPinia()),
    src = { ...source, key: "src-clock-" + mode + span };
  a.setActiveSource(src, ref, "one source");
  const descriptor = {
    ...summary,
    variable: "tas",
    time: { ...c.time, chunk: 10 },
    shape: [100, 2, 2],
    dims: [mode === "aux" ? "init" : "valid", "lat", "lon"],
  };
  client.describeVariable.mockResolvedValue(descriptor);
  client.planRun.mockImplementation((id, _src, q) => {
    requests.set(id, q);
    const n = q.time.stop - q.time.start;
    return {
      ...modest,
      chunks: n,
      outputValues: n,
      decodedBytes: n * 2 ** 20,
      modest: n <= 16,
    };
  });
  client.executeRun.mockImplementation(async (id) => {
    const q = requests.get(id);
    return (await planAnalysis(c, q, rctx)).execute();
  });
  await a.openWindow(
    ANALYSIS_KINDS.POINT_SERIES,
    { kind: "point", lat: 12, lon: 20 },
    { ...map, indices: { [descriptor.dims[0]]: 55 } },
    rect
  );
  const w = a.windows[0];
  await vi.waitFor(() => expect(w.status).toBe("done"));
  const n = w.result!.values.length;
  expect(n).toBeLessThan(100);
  a.extendDates(w.id);
  await vi.waitFor(() =>
    expect(w.status === "done" && w.result!.values.length > n).toBe(true)
  );
  const grown = w.result!;
  const one = await (
    await planAnalysis(c, grown.query, new ReadContext())
  ).execute();
  return {
    grown,
    one,
    reads: [...requests.values()].map((q) => q.time),
    oldRows: n,
  };
}
function series(r: any) {
  const t = validTimeAxis(r.time, r.selections);
  return {
    values: r.values,
    time: { ...t, cellMethods: r.cellMethods },
    dates: t.raw.map(String),
  } as any;
}
it("keeps every valid-time cell and run through Extend, as a one-shot read", async () => {
  const group = [];
  for (const [mode, span] of [
    ["aux", 6],
    ["aux", 24],
    ["direct", 24],
  ] as const) {
    const r = await actual(mode, span);
    const { grown, one } = r;
    const m = exportModel(grown),
      control = exportModel(one);
    const variable = (a: any, n: string) =>
      a.arrays.find((v: any) => v.name === n);
    // The download keeps every valid-time cell and run, as a one-shot read's.
    for (const name of ["time", "forecast_reference_time"]) {
      expect(variable(m, name)?.dims, `${mode} ${span} ${name}`).toEqual(
        variable(control, name)?.dims
      );
    }
    const cells = (a: any) =>
      variable(a, variable(a, "time")?.attrs?.bounds)?.data;
    expect(Array.from(cells(m) ?? []), `${mode} ${span}`).toEqual(
      Array.from(cells(control) ?? [])
    );
    expect(grown.values).toEqual(one.values);
    group.push(r);
  }
  for (const [kind, a, b] of [
    ["both-clean", group[0].one, group[1].one],
    ["both-extended", group[0].grown, group[1].grown],
    ["matched-lead-clean-vs-extended", group[0].one, group[0].grown],
  ] as const) {
    const pairs = pairSeries(series(a), series(b));
    // 6- and 24-hour means never pair; the same series always does.
    expect(pairs.reference, kind).toHaveLength(
      kind === "matched-lead-clean-vs-extended" ? 20 : 0
    );
  }
});
